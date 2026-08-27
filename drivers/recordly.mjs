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
 * driver watches the temp render, copies it to the run's output path, and lets the dialog be
 * discarded on cleanup.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** Click the first label that exists, and say which spellings were tried when none do. */
async function clickAny(session, labels, what) {
	for (const label of labels) {
		const r = JSON.parse(
			await evaluate(session, `JSON.stringify(window.__osbench.click(${JSON.stringify(label)}))`),
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

	async prepare(ctx) {
		const outDir = join(ctx.workDir, "projects", "recordly");
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

		// Stale renders would be indistinguishable from this run's, since the watcher picks the
		// newest match.
		for (const f of renderedExports()) rmSync(f, { force: true });

		if (appIsRunning(this.processName)) await quitApp(this.processName, { force: true });
		await sleep(2000);
		// `open -a Recordly --args …` silently drops the flag and the app comes up with no
		// debugging port, which looks like a hang rather than a mistake. Launch the binary.
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

		return {
			version: appVersion(APP),
			appliedFeatures: [
				"wallpaper",
				"padding",
				"cornerRadius",
				"shadow",
				"zooms",
				"cursor",
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
		const s = ctx.state.cdp;
		const out = this.outputPath(ctx);
		if (existsSync(out)) rmSync(out, { force: true });
		for (const f of renderedExports()) rmSync(f, { force: true });

		await clickAny(s, EXPORT_LABELS.open, "the export panel");
		await sleep(1500);

		// Pin all four axes. Defaults are not a fixed target: they persist between runs and differ
		// between installs, so an unpinned row is not comparable with any other.
		for (const [what, labels] of [
			["format", EXPORT_LABELS.format],
			["resolution", EXPORT_LABELS.resolution],
			["encoding mode", EXPORT_LABELS.encoding],
			["pipeline", EXPORT_LABELS.pipeline],
		]) {
			await clickAny(s, labels, what);
			await sleep(300);
		}
		// The frame-rate control is a bare number, so it is matched exactly to avoid hitting a
		// timeline label that happens to read the same.
		const fps = String(ctx.scenario.output.fps);
		const gotFps = JSON.parse(
			await evaluate(
				s,
				`JSON.stringify(window.__osbench.click(${JSON.stringify(fps)}, { exact: true }))`,
			),
		);
		if (!gotFps.ok) throw new Error(`Recordly export panel: no ${fps} fps control`);
		await sleep(300);

		// Read the settings back rather than trusting the clicks. A label that no longer matches —
		// a rename, a translation, a control that moved behind a disclosure — makes `click` report
		// a hit on the wrong element, and the export then runs on whatever was already selected.
		// Since these settings persist, that would be silent and would survive into later runs.
		const settings = JSON.parse(
			(await evaluate(s, `localStorage.getItem("recordly.editor.preferences")`)) ?? "null",
		);
		if (!settings) throw new Error("Recordly: could not read back the export settings");
		const mismatches = Object.entries({
			exportPipelineModel: REQUIRED_PIPELINE,
			exportFormat: "mp4",
			mp4FrameRate: ctx.scenario.output.fps,
			exportEncodingMode: "balanced",
		})
			.filter(([k, want]) => settings[k] !== want)
			.map(([k, want]) => `${k} is ${JSON.stringify(settings[k])}, wanted ${JSON.stringify(want)}`);
		if (mismatches.length) {
			throw new Error(
				`Recordly export settings did not take: ${mismatches.join("; ")}. The panel's labels ` +
					"have probably changed — fix EXPORT_LABELS rather than letting the row measure a " +
					"different export path.",
			);
		}
		ctx.state.exportSettings = {
			pipeline: settings.exportPipelineModel,
			encodingMode: settings.exportEncodingMode,
			backendPreference: settings.exportBackendPreference,
			quality: settings.exportQuality,
		};

		await clickAny(s, EXPORT_LABELS.go, "the export button");
		ctx.commit();

		// The runner watches `out`, and Recordly never writes there: it renders to the temp file
		// and then asks a native save panel where to put it. So the wait happens here, on the
		// render, and the settled instant is handed back through markComplete — which the runner
		// only accepts when it is *earlier* than the filesystem's answer, so the copy below can
		// never inflate the result.
		// The temp name carries a timestamp the driver cannot predict, so the path is resolved
		// first and only then handed to the runner's own stability watcher.
		let rendered = null;
		for (let i = 0; i < 300 && !rendered; i++) {
			rendered = renderedExports()
				.map((p) => ({ p, mtime: statSync(p).mtimeMs }))
				.sort((a, b) => b.mtime - a.mtime)[0]?.p;
			if (!rendered) await sleep(1000);
		}
		if (!rendered) {
			throw new Error(
				`Recordly: no rendered export appeared in ${tmpdir()} within 5 minutes — the export ` +
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
