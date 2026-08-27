/**
 * Recordly, through its own editor.
 *
 * Recordly ships no CLI and no headless export, so this is a GUI-class adapter. It is driven
 * over CDP rather than by clicking pixels: the app is Electron, the editor is a normal renderer,
 * and `window.electronAPI` exposes the app's own bridge — 147 methods on both platforms — so the
 * project can be handed over as data instead of typed into controls.
 *
 * The one place visible text is unavoidable is the export panel, which has no programmatic entry
 * point. That is a liability the driver has to own: **the UI is localised**, and a machine set to
 * French reads "Exporter", not "Export". `EXPORT_LABELS` carries both spellings for every control
 * the panel needs, and a missing control fails the leg loudly rather than exporting at defaults.
 *
 * The measurement ends at the rendered file, not at the saved one. Recordly renders to
 * `$TMPDIR/recordly-export-<id>-final.mp4` and only then opens a native save panel to ask where
 * to put it. Waiting for the saved copy would put a modal dialog — and on macOS an Accessibility
 * grant — inside the measured interval, timing the operator rather than the encoder. So the
 * driver watches the temp render and copies it to the run's output path.
 *
 * That panel is then in the way of everything: the app will not start another export while it is
 * up, and it blocks a polite quit as well, so the app is relaunched — by force if it will not go
 * — before each export. Every leg therefore starts from an identical, empty state, which also
 * settles the panel's open/closed flag; that flag survives a relaunch and made the same Export
 * button open a dialog on one run and start a render on the next.
 *
 * The project is built inside `getProjectsDirectory()`. Recordly resolves media through
 * `resolveAllowedReadableFilePath` and refuses paths outside the directories it owns; building
 * elsewhere and copying does not help, because the document embeds absolute paths and the app
 * then reports "No video to load".
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { CdpSession, DOM_HELPERS, listTargets } from "../lib/cdp.mjs";
import { sleep, waitForStableFile } from "../lib/measure.mjs";
import { appVersion, IS_WIN, resolveAppPath } from "../lib/platform.mjs";
import { buildProject } from "../lib/recordlyProject.mjs";
import { appIsRunning, quitApp } from "../lib/uiScript.mjs";

const RECORDLY = {
	win32: { name: "Recordly", exe: "Recordly.exe" },
	darwin: { name: "Recordly.app" },
};

const APP = IS_WIN ? resolveAppPath(RECORDLY) : "/Applications/Recordly.app";
const BIN = APP ? (IS_WIN ? APP : `${APP}/Contents/MacOS/Recordly`) : null;
const PORT = 9341;

/**
 * Every control the export panel needs, in each spelling seen so far.
 *
 * Pinned explicitly rather than left at defaults, because these settings **persist**:
 * `app-settings.json` carries `exportPipelineModel`, `exportEncodingMode`, `mp4FrameRate` and the
 * rest between launches, so a run that does not pin them measures whatever the last one — or the
 * last human — happened to select. Pinning is what makes the row mean the same thing twice.
 *
 * The pipeline is the axis that matters most. Recordly ships two, and `modern` — labelled
 * "Lightning (Beta)" — is the default and therefore the shipped product. `legacy` is the older
 * WebCodecs path, still selectable, and measuring it would report a route almost nobody takes.
 * The internal values are `legacy` and `modern`; only the labels say Lightning.
 */
const EXPORT_LABELS = {
	open: ["Export", "Exporter"],
	format: ["MP4"],
	resolution: ["Original"],
	encoding: ["Balanced", "Équilibré", "Equilibre"],
	pipeline: ["Lightning (Beta)", "Lightning", "Éclair (Bêta)", "Eclair"],
	go: ["Export Video", "Exporter la vidéo"],
};

/** Internal value the pipeline control must end up at, checked rather than assumed. */
const REQUIRED_PIPELINE = "modern";

const editorTarget = async () =>
	(await listTargets(PORT)).find((t) => t.url.includes("windowType=editor"));
const hudTarget = async () => (await listTargets(PORT)).find((t) => t.url.includes("hud-overlay"));

/**
 * Evaluate in a renderer.
 *
 * `awaitPromise` defaults off because most of what this driver asks is synchronous DOM work, and
 * because `switchToEditor` deliberately never resolves — waiting on it hangs the leg. It has to
 * be turned on for the electronAPI calls that return a promise, or the result comes back as the
 * promise object itself and the caller parses "[object Object]".
 */
const evaluate = async (session, expression, { timeoutMs = 20_000, awaitPromise = false } = {}) => {
	const r = await session.send(
		"Runtime.evaluate",
		{ expression, returnByValue: true, awaitPromise },
		{ timeoutMs },
	);
	if (r.exceptionDetails) throw new Error(`Recordly eval: ${r.exceptionDetails.text}`);
	return r.result?.value;
};

/**
 * Wait until a renderer can actually run code, not merely until its target is listed.
 *
 * Recordly publishes the HUD target while its renderer is still coming up, and an evaluate sent
 * in that window never returns at all — it does not fail, it hangs. That is what made every
 * earlier attempt here look like an authorisation problem: on a warm app the same call answers
 * in under a second, on a cold one it sits for the full timeout. Probing with something trivial
 * separates "not ready yet" from "never going to answer".
 */
async function waitForRenderer(session, { timeoutMs = 90_000, probeMs = 3000 } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			if ((await evaluate(session, "1+1", { timeoutMs: probeMs })) === 2) return;
		} catch {
			/* not up yet */
		}
		await sleep(500);
	}
	throw new Error(
		`Recordly: the renderer accepted a CDP connection but never executed anything within ` +
			`${Math.round(timeoutMs / 1000)}s. On a machine where the app has not been granted screen ` +
			"recording it behaves exactly like this — launch it once by hand, authorise it, and retry.",
	);
}

/**
 * Click the first label that exists, and say which spellings were tried when none do.
 *
 * `exact` matters more than it looks. `find` matches substrings and prefers the smallest hit, so
 * "Export" also matches inside "Export Video" — and which one wins depends on whether the panel
 * happens to be open. That ambiguity made the same call open a settings panel on one run and
 * start an export on the next, which read as the app behaving inconsistently.
 */
async function clickAny(session, labels, what, { exact = false } = {}) {
	for (const label of labels) {
		const r = JSON.parse(
			await evaluate(
				session,
				`JSON.stringify(window.__osbench.click(${JSON.stringify(label)}, { exact: ${exact} }))`,
			),
		);
		if (r.ok) return r.matched;
	}
	throw new Error(
		`Recordly export panel: no control for ${what}. Tried ${labels.join(", ")} — if this app is ` +
			"running in another language, add its spelling to EXPORT_LABELS rather than matching by position.",
	);
}

/** The rendered file, before the save panel is answered. */
const renderedExports = () => {
	const dir = tmpdir();
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => /^recordly-export-.*-final\.mp4$/.test(f))
		.map((f) => join(dir, f));
};

export default {
	id: "recordly",
	displayName: "Recordly",
	vendor: "Recordly",
	kind: "gui",
	automation: "cdp",
	processName: "Recordly",
	appPath: APP,
	bundleId: "dev.recordly.app",
	install: null, // registered in apps.mjs

	detect() {
		if (!BIN || !existsSync(BIN)) return { installed: false, version: null, path: null };
		return { installed: true, version: appVersion(APP), path: BIN };
	},

	/**
	 * Padding is four sides on the app's own scale, not a percentage of the frame. A document
	 * written with 20 a side comes back as "46%" in the panel, so this is only where `calibrate`
	 * starts searching.
	 */
	defaultPaddingControl(scenario) {
		return Math.round(Math.min(250, Math.max(0, scenario.effects.paddingPercent * 4)));
	},

	/**
	 * Bring the app up on the scenario's project, from nothing.
	 *
	 * Run once per export rather than once per leg. Recordly leaves a native save panel open when
	 * a render finishes — there is no way to answer it without Accessibility, and the app will not
	 * start another export while it is up, so runs 2 and beyond failed against a window that was
	 * waiting for a click nobody was going to give it. A fresh instance also erases the panel
	 * open/closed flag that survives a relaunch, so every run starts from one state instead of
	 * inheriting the last one's.
	 *
	 * None of this is measured: the clock starts at the export trigger, well after this returns.
	 */
	async open(ctx) {
		// Stale renders would be indistinguishable from this run's, since the watcher picks the
		// newest match.
		for (const f of renderedExports()) rmSync(f, { force: true });

		// Wait for the old instance to be *gone*, not merely asked to leave. Relaunching two
		// seconds after a quit races the previous process's helpers and the debugging port they
		// still hold, and the new instance then comes up with a renderer that never runs anything
		// — which is indistinguishable, from the outside, from an app that is broken.
		// A polite quit is not enough here. The save panel left open by the previous export is a
		// modal, and the app will not act on a quit request while it is up — so every second run
		// found the port still held and failed. Ask nicely, then insist.
		if (appIsRunning(this.processName)) await quitApp(this.processName, { force: true });
		for (let i = 0; i < 10 && appIsRunning(this.processName); i++) await sleep(1000);
		if (appIsRunning(this.processName)) {
			try {
				execFileSync(
					IS_WIN ? "taskkill" : "/usr/bin/pkill",
					IS_WIN ? ["/F", "/IM", "Recordly.exe"] : ["-9", "-f", "MacOS/Recordly"],
					{ stdio: "ignore" },
				);
			} catch {
				/* already gone between the check and the signal */
			}
			for (let i = 0; i < 20 && appIsRunning(this.processName); i++) await sleep(1000);
		}
		if (appIsRunning(this.processName)) {
			throw new Error("Recordly: a previous instance survived SIGKILL; the port is still held");
		}
		await sleep(2000);

		// `open -a Recordly --args …` silently drops the flag and the app comes up with no
		// debugging port, which looks like a hang rather than a mistake. Launch the binary.
		//
		// The project is *not* passed as an argument: the app accepts it and still opens only the
		// HUD, so the editor has to be asked for over the bridge either way.
		execFileSync("/bin/sh", [
			"-c",
			`nohup ${JSON.stringify(BIN)} --remote-debugging-port=${PORT} >/dev/null 2>&1 &`,
		]);

		// The app opens on the HUD overlay; the editor is a second window that only exists once
		// switchToEditor has run.
		let hud = null;
		for (let i = 0; i < 40 && !hud; i++) {
			await sleep(1000);
			hud = await hudTarget().catch(() => null);
		}
		if (!hud) throw new Error(`Recordly: no CDP HUD target on port ${PORT}`);

		const h = new CdpSession(hud.webSocketDebuggerUrl);
		await h.open();
		await waitForRenderer(h);

		// Build inside the app's own projects directory, not ours — and build it there rather than
		// building elsewhere and copying, because the document embeds absolute media paths and a
		// copy leaves them pointing at the old location. The app then loads the project, refuses
		// the media, and shows "No video to load".
		//
		// Recordly resolves readable media through `resolveAllowedReadableFilePath` and rejects
		// anything outside the directories it owns; the app log says so plainly
		// (`[get-local-media-url] Blocked disallowed path: …/screen.system.wav`). A project whose
		// video happens to load can still have its audio sidecars blocked, and the export then
		// starts and produces nothing, which reads as a hang rather than a refusal.
		//
		// Recordly resolves readable media through `resolveAllowedReadableFilePath` and refuses
		// anything outside the directories it owns — the app log says so plainly
		// (`[get-local-media-url] Blocked disallowed path: …/screen.system.wav`). A project whose
		// video happens to load can still have its audio sidecars blocked, and the export then
		// starts and produces nothing, which reads as a hang rather than a refusal.
		const projectsDir = await evaluate(
			h,
			`window.electronAPI.getProjectsDirectory().then((r) => JSON.stringify(r)).catch(() => null)`,
			{ timeoutMs: 20_000, awaitPromise: true },
		);
		const allowedRoot = (() => {
			try {
				const r = JSON.parse(projectsDir);
				return typeof r === "string" ? r : (r?.path ?? r?.directory ?? null);
			} catch {
				return null;
			}
		})();
		const outDir = allowedRoot
			? join(allowedRoot, "openscreen-benchmark")
			: join(ctx.workDir, "projects", "recordly");
		mkdirSync(outDir, { recursive: true });
		const built = buildProject({
			sourcePath: ctx.source.path,
			scenario: ctx.scenario,
			outDir,
			title: ctx.scenario.id,
			paddingControl: ctx.paddingControl ?? this.defaultPaddingControl(ctx.scenario),
			assets: {
				...(ctx.assets ?? {}),
				webcam: ctx.source.webcam ?? ctx.assets?.webcam,
				cursorPath: ctx.source.cursorPath ?? null,
			},
			spec: ctx.source.spec,
		});
		ctx.state.project = built;

		let opened;
		try {
			opened = JSON.parse(
				(await evaluate(
					h,
					`window.electronAPI.openProjectFileAtPath(${JSON.stringify(built.projectPath)})
					   .then(r => JSON.stringify(r)).catch(e => JSON.stringify({ success: false, error: String(e) }))`,
					{ timeoutMs: 60_000, awaitPromise: true },
				)) ?? "{}",
			);
		} catch (e) {
			throw new Error(`Recordly: could not open the project over CDP — ${e.message}`);
		}
		if (opened?.success === false) {
			throw new Error(`Recordly could not open the project: ${opened.error ?? "unknown"}`);
		}

		// Hand the pointer track over *after* the project is open.
		//
		// `setCursorTelemetry` refuses while no video is loaded — it answers
		// `{"success":false,"message":"No video path available for cursor telemetry"}` — so calling
		// it first silently does nothing. That is how the first working runs exported with no
		// rendered cursor while the driver went on declaring "cursor" as applied: a leg doing less
		// work than the scenario asks, reported as if it had done it.
		//
		// The scenario's cursor is data, not pixels. The apps hide the system pointer and re-render
		// from this track, so an export showing only the pointer baked into the source footage has
		// exercised none of the smoothing, scaling or motion blur the row exists to measure.
		ctx.state.cursorApplied = false;
		if (built.cursorTelemetry) {
			const set = JSON.parse(
				(await evaluate(
					h,
					`window.electronAPI.setCursorTelemetry(${JSON.stringify(built.cursorTelemetry)})
					   .then((r) => JSON.stringify(r ?? { success: true }))
					   .catch((e) => JSON.stringify({ success: false, error: String(e) }))`,
					{ timeoutMs: 60_000, awaitPromise: true },
				)) ?? "{}",
			);
			if (set?.success === false) {
				throw new Error(
					`Recordly refused the cursor telemetry: ${set.message ?? set.error ?? "unknown"}. ` +
						"Measuring without it would compare a rendered cursor against none.",
				);
			}
			ctx.state.cursorApplied = true;
		}

		await sleep(1500);
		// switchToEditor tears the HUD renderer down, so its reply may never arrive: fire it and
		// wait on the target list instead.
		try {
			await h.send(
				"Runtime.evaluate",
				{ expression: "window.electronAPI.switchToEditor()", awaitPromise: false },
				{ timeoutMs: 5000 },
			);
		} catch {
			/* expected: the renderer goes away mid-call */
		}
		h.close();

		let ed = null;
		for (let i = 0; i < 30 && !ed; i++) {
			await sleep(1000);
			ed = await editorTarget().catch(() => null);
		}
		if (!ed) throw new Error("Recordly: the editor window never opened");

		const s = new CdpSession(ed.webSocketDebuggerUrl);
		await s.open();
		// The editor window races the same way the HUD does.
		await waitForRenderer(s);
		await evaluate(s, DOM_HELPERS);
		ctx.state.cdp = s;
	},

	async prepare(ctx) {
		await this.open(ctx);
		const built = ctx.state.project;
		return {
			version: appVersion(APP),
			// Names come from `fidelity()` in scenarios/index.mjs, not from Recordly's own vocabulary.
			// An earlier version reported "wallpaper" for what the scenario calls "background" and
			// never mentioned the output target at all, so a correct export was scored partial at
			// 70% — and a partial row is excluded from the ranking. Mislabelling costs a
			// measurement just as surely as a bad export does.
			appliedFeatures: [
				"background",
				"padding",
				"cornerRadius",
				"shadow",
				"zooms",
				...(ctx.state.cursorApplied ? ["cursor"] : []),
				"targetResolution",
				"targetFps",
				...(built.webcamApplied ? ["webcam"] : []),
				...(ctx.scenario.effects.motionBlur?.enabled ? ["motionBlur"] : []),
			],
			notes: [
				"Driven over CDP through the app's own electronAPI; the export panel is the only part read by visible text.",
				...(built.zoomDeviations.length
					? built.zoomDeviations.map(
							(d) =>
								`zoom ${d.requested}x is not one of Recordly's presets and was applied at ${d.applied}x`,
						)
					: []),
			],
		};
	},

	outputPath(ctx) {
		return join(ctx.outDir, `${this.id}-${ctx.scenario.id}-run${ctx.run.index}.mp4`);
	},

	async runExport(ctx) {
		// Every export starts from a fresh instance — see `open`.
		if (ctx.run.index > 0 || !ctx.state.cdp) await this.open(ctx);
		const s = ctx.state.cdp;
		const out = this.outputPath(ctx);
		if (existsSync(out)) rmSync(out, { force: true });
		for (const f of renderedExports()) rmSync(f, { force: true });

		// The Export button does one of two things, and which one is not predictable from here.
		//
		// There is a single control carrying the word — one 112x32 button; `find` returns the span
		// inside it and `click` walks up to the button, so exact and loose matching are the same
		// thing here. What varies is the app's own state: the settings panel's open/closed flag
		// survives a relaunch, so the click opens the panel when it was left shut and starts the
		// render when it was left open. Chasing that as if it were a selector problem cost most of
		// a day.
		//
		// So the settings are verified *first* — the direct-render branch offers no dialog to fix
		// them in — and then the click waits for whichever of the two outcomes actually arrives.
		const readSettings = async () =>
			JSON.parse(
				(await evaluate(s, `localStorage.getItem("recordly.editor.preferences")`)) ?? "null",
			);
		const wanted = {
			exportPipelineModel: REQUIRED_PIPELINE,
			exportFormat: "mp4",
			mp4FrameRate: ctx.scenario.output.fps,
			exportEncodingMode: "balanced",
		};
		const mismatchesIn = (cfg) =>
			Object.entries(wanted)
				.filter(([k, want]) => cfg?.[k] !== want)
				.map(([k, want]) => `${k} is ${JSON.stringify(cfg?.[k])}, wanted ${JSON.stringify(want)}`);

		const before = await readSettings();
		if (!before) throw new Error("Recordly: could not read the export settings");
		const preMismatch = mismatchesIn(before);

		const panelOpen = () =>
			evaluate(
				s,
				`!!window.__osbench.find(${JSON.stringify(EXPORT_LABELS.go[0])}, { exact: true })`,
			);
		const rendering = () =>
			evaluate(
				s,
				`/exporting|rendering your file|preparing export/i.test(document.body.innerText)`,
			);

		let panelUp = await panelOpen();
		let started = false;
		if (!panelUp) {
			// Nothing can be corrected once a direct render begins, so refuse before pressing.
			if (preMismatch.length) {
				throw new Error(
					`Recordly is not configured for this scenario: ${preMismatch.join("; ")}. The Export ` +
						"button may start the render immediately, with no dialog to correct it in.",
				);
			}
			await clickAny(s, EXPORT_LABELS.open, "the export control", { exact: true });
			ctx.commit(); // harmless if the panel opens instead — the clock restarts below
			for (let i = 0; i < 40 && !panelUp && !started; i++) {
				await sleep(500);
				panelUp = await panelOpen();
				if (!panelUp) started = await rendering();
			}
		}

		if (panelUp) {
			// The panel is up: pin every axis, because these persist and an unpinned one measures
			// whatever the last run — or the last human — left selected.
			for (const [what, labels] of [
				["format", EXPORT_LABELS.format],
				["resolution", EXPORT_LABELS.resolution],
				["encoding mode", EXPORT_LABELS.encoding],
				["pipeline", EXPORT_LABELS.pipeline],
			]) {
				await clickAny(s, labels, what);
				await sleep(300);
			}
			const fps = String(ctx.scenario.output.fps);
			const gotFps = JSON.parse(
				await evaluate(
					s,
					`JSON.stringify(window.__osbench.click(${JSON.stringify(fps)}, { exact: true }))`,
				),
			);
			if (!gotFps.ok) throw new Error(`Recordly export panel: no ${fps} fps control`);
			await sleep(500);

			// Read back rather than trust the clicks: a renamed or translated label makes `click`
			// report success against the wrong element, silently and persistently.
			const after = mismatchesIn(await readSettings());
			if (after.length)
				throw new Error(`Recordly export settings did not take: ${after.join("; ")}`);

			await clickAny(s, EXPORT_LABELS.go, "the export button", { exact: true });
			ctx.commit();
			for (let i = 0; i < 40 && !started; i++) {
				await sleep(500);
				started = await rendering();
			}
		}

		if (!started) {
			const seen = await evaluate(s, `document.body.innerText.slice(-240)`);
			throw new Error(`Recordly: the export never started. Screen reads: ${JSON.stringify(seen)}`);
		}
		ctx.state.exportSettings = {
			pipeline: before.exportPipelineModel,
			encodingMode: before.exportEncodingMode,
			backendPreference: before.exportBackendPreference,
			quality: before.exportQuality,
		};

		// The runner watches `out`, and Recordly never writes there: it renders to the temp file
		// and then asks a native save panel where to put it. So the wait happens here, on the
		// render, and the settled instant is handed back through markComplete — which the runner
		// only accepts when it is *earlier* than the filesystem's answer, so the copy below can
		// never inflate the result.
		// The temp name carries a timestamp the driver cannot predict, so the path is resolved
		// first and only then handed to the runner's own stability watcher.
		let rendered = null;
		for (let i = 0; i < 900 && !rendered; i++) {
			rendered = renderedExports()
				.map((p) => ({ p, mtime: statSync(p).mtimeMs }))
				.sort((a, b) => b.mtime - a.mtime)[0]?.p;
			if (!rendered) await sleep(1000);
		}
		if (!rendered) {
			throw new Error(
				`Recordly: no rendered export appeared in ${tmpdir()} within 15 minutes — the export ` +
					"panel accepted the click but nothing started.",
			);
		}

		const wait = await waitForStableFile(rendered, {
			timeoutMs: ctx.timeoutMs ?? 45 * 60 * 1000,
			stableMs: ctx.stableMs ?? 2500,
			onTick: ctx.onTick,
		});
		if (!wait.ok) throw new Error(`Recordly: the render never settled (${wait.reason})`);

		ctx.markComplete(wait.completedAt);
		copyFileSync(rendered, out);
		rmSync(rendered, { force: true });
	},

	async cleanup(ctx) {
		ctx.state?.cdp?.close();
		// Quitting discards the save panel and the temp render with it.
		if (appIsRunning(this.processName)) await quitApp(this.processName, { force: true });
		for (const f of renderedExports()) rmSync(f, { force: true });
	},
};
