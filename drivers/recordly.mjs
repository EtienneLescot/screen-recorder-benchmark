/**
 * Recordly (recordly.dev) — Electron and PixiJS, the third open-source entrant.
 *
 * No CLI and no headless export, so this is a GUI-class adapter and its row is not comparable
 * to `openscreen-cli`'s. What it does have is `window.electronAPI`: a contextBridge over
 * `ipcRenderer.invoke` with 147 methods, reachable once the app is launched with
 * `--remote-debugging-port`. That is the app's own API rather than control-name archaeology,
 * which matters here more than usual — Recordly's interface is localised, and on the machine
 * this was written on the HUD reads "Masquer le HUD", not "Hide HUD".
 *
 * The project is written as JSON rather than built in the editor, for the same reason
 * OpenScreen's and Cap's are: an edit typed into a UI is not reproducible. See
 * lib/recordlyProject.mjs, and the two places the scenario does not map cleanly.
 *
 * The export itself is deliberately *not* driven through `nativeStaticLayoutExport` directly.
 * That call takes explicit geometry and a per-frame zoom track, so calling it would mean
 * reimplementing the app's layout maths and easing curves — and measuring that reimplementation
 * instead of the product. The editor's own export action is triggered instead, and the app
 * routes, composites and encodes exactly as it would for a user.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CdpSession, DOM_HELPERS, listTargets } from "../lib/cdp.mjs";
import { sleep, waitForStableFile } from "../lib/measure.mjs";
import {
	appVersion,
	IS_LINUX,
	IS_MAC,
	IS_WIN,
	killProcesses,
	LINUX_APP_ROOT,
	resolveAppPath,
} from "../lib/platform.mjs";
import { buildProject, defaultPaddingControl } from "../lib/recordlyProject.mjs";
import { fileDialogTo } from "../lib/ui.mjs";

export const RECORDLY = {
	macPath: "/Applications/Recordly.app",
	winPaths: [
		"%LOCALAPPDATA%\\Programs\\Recordly\\Recordly.exe",
		"%ProgramFiles%\\Recordly\\Recordly.exe",
	],
	// The AppImage unpacks to a lowercase `recordly` binary beside its resources.
	linuxPaths: [`${LINUX_APP_ROOT}/Recordly/recordly`, "/opt/Recordly/recordly"],
};

const resolveApp = () => (IS_MAC ? RECORDLY.macPath : resolveAppPath(RECORDLY));
/** Resolved per call: on Windows and Linux the path is discovered, and install runs after import. */
const bin = () => {
	const app = resolveApp();
	if (!app) return null;
	return IS_MAC ? `${app}/Contents/MacOS/Recordly` : app;
};
const PORT = 9444;
const PROC = "Recordly";

/**
 * Extra arguments this platform needs to launch the app at all.
 *
 * `--no-sandbox` is not a workaround invented here: it is the command line the vendor's own
 * desktop entry ships (`Exec=AppRun --no-sandbox %U`). Chromium's sandbox needs a setuid helper,
 * and an AppImage unpacked into a user directory cannot carry one — without this the app exits
 * before it opens a debugging port, so the adapter would report "the editor never appeared"
 * for something that is not an editor problem.
 */
const LAUNCH_ARGS = IS_LINUX ? ["--no-sandbox"] : [];

const editorTarget = async () =>
	(await listTargets(PORT)).find((t) => String(t.url).includes("windowType=editor"));
const anyPage = async () => (await listTargets(PORT)).find((t) => t.type === "page");

/**
 * Wait for a CDP target — sleeping *before* the first look, which is not a detail.
 *
 * A target is listed before its renderer has finished deciding what it can encode with, and
 * attaching a session that early leaves the app on its WebCodecs path, where `VideoEncoder` is
 * undefined and every export dies. Polling immediately made this adapter fail every time while
 * the identical sequence run by hand — which happened to pause here — took the native WebGPU
 * path at ~185 fps every time. Isolated by giving the hand-driven sequence this loop's timing:
 * it started failing too.
 */
/**
 * Where Recordly will agree to read a project from.
 *
 * The app resolves media through `resolveAllowedReadableFilePath` and refuses anything outside
 * the directories it owns. A project written to the harness's own work directory loads its video
 * — that path is handed over explicitly — but its audio sidecars are rejected, and the app log
 * says so plainly: `[get-local-media-url] Blocked disallowed path: …/screen.system.wav`. The
 * export then starts and produces nothing, which reads as a hang rather than a refusal.
 *
 * Building elsewhere and copying does not help either: the document embeds absolute paths, so a
 * copied project opens with "No video to load".
 *
 * This is the location the app reports through `getProjectsDirectory()`; `prepare` asserts they
 * still agree once the bridge is up, so a change of layout fails loudly instead of silently
 * costing the audio.
 */
function projectsRoot() {
	if (IS_WIN) {
		return join(
			process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
			"Recordly",
			"recordings",
			"Projects",
		);
	}
	// Electron's userData on Linux is XDG_CONFIG_HOME/<productName>, which is ~/.config/Recordly
	// — not ~/Library/Application Support, and not the lowercase package name. `prepare` asserts
	// this against the app's own getProjectsDirectory(), so a wrong guess fails loudly here
	// rather than costing the audio sidecars silently.
	if (IS_LINUX) {
		return join(
			process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
			"Recordly",
			"recordings",
			"Projects",
		);
	}
	return join(homedir(), "Library", "Application Support", "Recordly", "recordings", "Projects");
}

/**
 * Move the export the app streamed to its own temporary file into the harness's output path.
 *
 * The Linux stand-in for answering the save dialog — see the call site for why no dialog can be
 * driven on this platform. The app writes to `$TMPDIR/recordly-export-XXXXXX/…-final.mp4` and
 * completes that file before it asks where to put it, so this is a placement, not a rescue: a
 * partially written file would fail `waitForStableFile` here rather than be copied and verified.
 *
 * Scoped by mtime to the export that was just measured. Without that, a leftover temp from an
 * earlier repetition — the app does not always clean them up — would be copied into this run's
 * output and verified as if it were this run's work, which is the one failure mode that would
 * produce a plausible wrong number instead of an error.
 */
async function placeStreamedExport(out, notBefore) {
	const { copyFileSync, readdirSync, statSync } = await import("node:fs");
	const tmp = process.env.TMPDIR || "/tmp";
	const deadline = Date.now() + 120_000;
	let found = null;
	while (Date.now() < deadline && !found) {
		const candidates = [];
		for (const dir of readdirSync(tmp)) {
			if (!/^recordly-export/i.test(dir)) continue;
			let entries = [];
			try {
				entries = readdirSync(join(tmp, dir));
			} catch {
				continue;
			}
			for (const f of entries) {
				if (!/-final\.mp4$/i.test(f)) continue;
				const p = join(tmp, dir, f);
				try {
					const st = statSync(p);
					// A second of slack: the app creates the file at the start of the stream, so its
					// mtime is the last write, but its birth time can precede the click.
					if (st.mtimeMs >= notBefore - 1000) candidates.push({ path: p, mtimeMs: st.mtimeMs });
				} catch {
					/* it may vanish under us as the app tidies up */
				}
			}
		}
		candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
		found = candidates[0]?.path ?? null;
		if (!found) await sleep(1000);
	}
	if (!found) {
		throw new Error(
			`the export announced its save step but left no streamed file in ${tmp}/recordly-export-*. ` +
				"Either the app changed where it streams, or this build writes only through the dialog.",
		);
	}
	const stable = await waitForStableFile(found, { timeoutMs: 120_000, stableMs: 2000 });
	if (!stable.ok) throw new Error(`${found} never stopped growing (${stable.reason})`);
	copyFileSync(found, out);
	// Copied rather than renamed: /tmp is frequently a different filesystem from the work
	// directory, where rename() fails with EXDEV, and leaving the original also lets a failed
	// verification be investigated against exactly what the app produced.
	return { path: out, streamedFrom: found, sizeBytes: stable.sizeBytes ?? null };
}

async function waitFor(find, { timeoutMs = 60_000, pollMs = 1500, label = "target" } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await sleep(pollMs);
		try {
			const t = await find();
			if (t) return t;
		} catch {
			/* the app is not listening yet */
		}
	}
	throw new Error(`${label} never appeared within ${Math.round(timeoutMs / 1000)}s`);
}

/**
 * Launch the app, load the project, and park in the editor with a session open.
 *
 * Called before *every* export, not once per leg. The editor does not return to a usable state
 * after an export: the panel never reopens, so the second and later repetitions of a leg failed
 * where the first had succeeded. Resetting the application is the only way to make a repetition
 * mean the same thing as the one before it.
 *
 * It costs about thirteen seconds a repetition and none of it is measured — ctx.commit() is
 * called at the export click, so everything here is warm-up. That is the trade a GUI adapter
 * should make: pay wall-clock for a known state rather than reason about a residual one.
 */
async function launchAndOpen(ctx, built, useCuda, logPath) {
	killProcesses([PROC]);
	await sleep(1500);

	// The app's own stderr is kept, not discarded. Every earlier failure here was diagnosed from
	// the outside — CDP traces, DOM scraping, window lists — while the process was being spawned
	// with stdio "ignore" and was saying exactly what was wrong the whole time.
	const { spawn } = await import("node:child_process");
	const { appendFileSync } = await import("node:fs");
	const exe = bin();
	if (!exe) throw new Error("Recordly is not installed");
	const child = spawn(exe, [...LAUNCH_ARGS, `--remote-debugging-port=${PORT}`], {
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const keep = (d) => {
		try {
			appendFileSync(logPath, d);
		} catch {
			/* the run matters more than its log */
		}
	};
	child.stdout.on("data", keep);
	child.stderr.on("data", keep);
	child.unref();

	const page = await waitFor(anyPage, { label: "Recordly's CDP page" });
	const s = new CdpSession(page.webSocketDebuggerUrl);
	await s.open();
	await s.eval(DOM_HELPERS);

	const call = async (expr) => {
		const raw = await s.eval(`Promise.resolve(${expr}).then(r => JSON.stringify(r ?? null))`);
		return raw ? JSON.parse(raw) : null;
	};

	const set = await call(
		`window.electronAPI.setCurrentVideoPath(${JSON.stringify(built.mediaPath)})`,
	);
	if (set?.success === false) throw new Error(`setCurrentVideoPath refused: ${set.error}`);

	// The pointer is data, not pixels: without this the whole cursor stage — sprite, smoothing,
	// its own motion blur, click effect — never runs.
	if (built.cursorTelemetry?.length) {
		await call(`window.electronAPI.setCursorTelemetry(${JSON.stringify(built.cursorTelemetry)})`);
	}

	const opened = await call(
		`window.electronAPI.openProjectFileAtPath(${JSON.stringify(built.projectPath)})`,
	);
	if (opened?.success === false) {
		throw new Error(`openProjectFileAtPath refused: ${opened.error ?? "no reason given"}`);
	}

	await call("window.electronAPI.switchToEditor()");
	const ed = await waitFor(editorTarget, { label: "the editor window" });
	const es = new CdpSession(ed.webSocketDebuggerUrl);
	await es.open();
	await es.eval(DOM_HELPERS);

	// The CUDA path is a persisted product setting, not an argument: ExportSettingsMenu renders
	// it as an "NVIDIA CUDA / Experimental" toggle and useNvidiaCudaExportOptIn stores it under
	// this key. Setting it is what separates the two rows — the export action is identical.
	await call(
		`window.electronAPI.setAppSetting("recordly.export.experimentalNvidiaCuda", ${useCuda})`,
	);
	await sleep(4000);

	return { cdp: s, editor: es, call };
}

export default {
	id: "recordly",
	displayName: "Recordly",
	vendor: "webadderall",
	roster: "Recordly",
	kind: "gui",
	// The app's own IPC bridge, driven over CDP. Higher on the ladder than named controls,
	// and immune to the localisation that would break a name match.
	automation: "cdp",
	processName: PROC,
	appPath: resolveApp(),
	/**
	 * Where the app is *now*, re-resolved on each call.
	 *
	 * `appPath` above is computed once at import, which is before the installer has run — so
	 * install used it, found null, and reported "installed but its executable was not found where
	 * expected" for an app it had just installed correctly. This is the hook installApp already
	 * looked for and nothing supplied.
	 */
	resolveInstalledPath: () => resolveApp(),
	bundleId: "dev.recordly.app",
	install: {
		method: "winget",
		id: "Webadderall.Recordly",
		url: "https://github.com/webadderallorg/Recordly/releases",
		appName: "Recordly.exe",
		approxMB: 201,
		licence: "AGPL-3.0 — free",
		notes: ["Installs per-user through winget; no elevation and no interactive installer."],
	},

	/** CUDA is off unless a variant asks for it — see `recordly-cuda`. */
	useCuda: false,

	detect() {
		const b = bin();
		if (!b || !existsSync(b)) return { installed: false, version: null, path: null };
		return { installed: true, version: appVersion(b), path: b };
	},

	defaultPaddingControl,

	async prepare(ctx) {
		const outDir = join(projectsRoot(), "openscreen-benchmark");
		mkdirSync(outDir, { recursive: true });
		const built = buildProject({
			sourcePath: ctx.source.path,
			scenario: ctx.scenario,
			outDir,
			title: ctx.scenario.id,
			paddingControl: ctx.paddingControl ?? defaultPaddingControl(ctx.scenario),
			assets: { ...(ctx.assets ?? {}), webcam: ctx.source.webcam ?? ctx.assets?.webcam },
			spec: ctx.source.spec,
			// Downloaded footage has no spec but does carry a generated pointer track.
			cursorPath: ctx.source.cursorPath ?? ctx.assets?.cursorPath ?? null,
		});
		ctx.state.built = built;

		const logPath = join(ctx.outDir, `${this.id}-app.log`);
		ctx.state.appLog = logPath;
		(await import("node:fs")).writeFileSync(logPath, "");

		// Opened once here so the leg can report what the app can do and prove the project
		// loads; runExport opens it again, fresh, before each export.
		const { cdp, editor, call } = await launchAndOpen(ctx, built, this.useCuda, logPath);
		ctx.state.cdp = cdp;

		// Confirm the app reads projects from where this driver wrote one. A silent disagreement
		// costs the audio sidecars and nothing else — the video still loads — so it would surface
		// as an export that starts and never finishes rather than as a path error.
		const reported = await call("getProjectsDirectory()").catch(() => null);
		const root =
			typeof reported === "string" ? reported : (reported?.path ?? reported?.directory ?? null);
		if (root && !built.projectPath.startsWith(root)) {
			throw new Error(
				`Recordly reads projects from ${root}, but this one was written to ${built.projectPath}. ` +
					"Media outside the app's own directories is refused, so the export would start and stall.",
			);
		}

		ctx.state.editor = editor;

		const caps = await call("window.electronAPI.getNativeExportCapabilities()");
		const cuda = caps?.capabilities?.nvidiaCuda ?? {};

		const e = ctx.scenario.effects;
		const zoomNote = built.zoomDeviations.length
			? built.zoomDeviations
					.map(
						(d) => `zoom ${d.requested}x is not a preset; applied ${d.applied}x (depth ${d.depth})`,
					)
					.join("; ")
			: null;

		return {
			appliedFeatures: [
				"background",
				"padding",
				"cornerRadius",
				"shadow",
				"zooms",
				...(e.motionBlur?.enabled ? ["motionBlur"] : []),
				...(e.cursor?.enabled && built.cursorTelemetry?.length ? ["cursor"] : []),
				...(built.webcamApplied ? ["webcam"] : []),
				"targetResolution",
				"targetFps",
			],
			notes: [
				`project: ${built.projectPath}`,
				`CUDA export path: available=${cuda.available === true}, requested=${this.useCuda}`,
				...(zoomNote ? [zoomNote] : []),
				"Export is triggered through the editor's own action, so the app picks its pipeline, backend and encoder as it would for a user; the backend it actually used is recorded from its progress events.",
			],
		};
	},

	outputPath(ctx) {
		return join(ctx.outDir, `${this.id}-${ctx.scenario.id}-run${ctx.run.index}.mp4`);
	},

	async runExport(ctx) {
		const out = this.outputPath(ctx);
		if (existsSync(out)) rmSync(out, { force: true });

		// A fresh application for every repetition.
		//
		// The editor does not come back to a usable state once an export has run through it —
		// the settings panel never reopens, however long it is waited for or however many times
		// the button is clicked. Measured: the first repetition of a leg succeeded at 62 s and
		// the next three failed identically. Relaunching is the only way to make repetition two
		// mean what repetition one meant, and it is free where it matters, because ctx.commit()
		// is not called until the export click below.
		if (!ctx.state.built) throw new Error("prepare() did not complete: no project was built");
		ctx.state.cdp?.close?.();
		ctx.state.editor?.close?.();
		const fresh = await launchAndOpen(ctx, ctx.state.built, this.useCuda, ctx.state.appLog);
		ctx.state.cdp = fresh.cdp;
		ctx.state.editor = fresh.editor;
		const es = fresh.editor;

		// Nothing is subscribed to the app's export events here, deliberately. Registering a
		// listener through onNativeStaticLayoutExportProgress was the difference between this
		// adapter failing and the same sequence run by hand succeeding: with it, every export
		// died on "VideoEncoder is not defined" — the WebCodecs fallback — while without it the
		// native WebGPU path ran normally. The route is read off the editor's own progress text
		// instead, which costs the app nothing.

		const onScreen = async () =>
			es.eval(
				"JSON.stringify(window.__osbench.controls().map(c => c.text).filter(Boolean).slice(0, 60))",
			);

		/**
		 * Click the first label that matches, and return which one did.
		 *
		 * Which one matters: several spellings are offered per control because the interface is
		 * localised, and reading the state back against a label that did *not* match returns
		 * null and reads as a failed click when the click was fine.
		 */
		const clickAny = async (labels, what) => {
			for (const label of labels) {
				const r = JSON.parse(
					await es.eval(`JSON.stringify(window.__osbench.click(${JSON.stringify(label)}))`),
				);
				if (r.ok) return label;
			}
			throw new Error(
				`no control matched ${labels.join(" / ")} for ${what}; on screen: ${await onScreen()}`,
			);
		};

		/**
		 * Is an option currently selected? The panel marks its buttons with aria-pressed.
		 *
		 * Resolved through `__osbench.find` — the same matcher `click` uses — rather than a
		 * second implementation. Its labels wrap child elements, so "Originale 1920 x 1080"
		 * arrives from raw textContent without the spaces a hand-rolled comparison expects.
		 */
		const pressed = async (label) =>
			JSON.parse(
				await es.eval(`
					(function () {
						const el = window.__osbench.find(${JSON.stringify(label)});
						if (!el) return JSON.stringify(null);
						const btn = el.closest("button,[role='button'],[role='radio']") || el;
						return JSON.stringify(btn.getAttribute("aria-pressed") === "true");
					})()
				`),
			);

		/**
		 * Set an option and read it back.
		 *
		 * Nothing here is assumed from a default. Measured on the shipped build, this panel opens
		 * on MP4 / Originale / Balanced but at **30 fps** and on the **Legacy** pipeline — so a
		 * driver that trusted the defaults would have measured the old WebCodecs path at half the
		 * frame rate the scenario pins, and would never have seen the CUDA toggle at all, since
		 * that card only renders when the pipeline is not Legacy.
		 */
		const pin = async (labels, what) => {
			// Always click, even when the control already reads as selected. Skipping that was
			// what broke this adapter: the panel shows state restored from preferences, but the
			// export appears to read a value only committed on click, so a pin that trusted
			// aria-pressed left the pipeline on Legacy — and Legacy is the WebCodecs path, which
			// dies here with "VideoEncoder is not defined". The identical sequence clicking
			// unconditionally takes the native WebGPU path every time.
			const used = await clickAny(labels, what);
			await sleep(400);
			const now = await pressed(used);
			if (now !== true) {
				throw new Error(
					`${what}: clicked "${used}" but aria-pressed came back ${now}; on screen: ${await onScreen()}`,
				);
			}
			return used;
		};

		// "Exporter" opens the settings panel; it does not start anything.
		//
		// Waited for, not slept through, and retried. The first export of a leg opens it
		// promptly; the ones after it did not, because prepare() runs once per leg and every
		// repetition inherits an editor that has already been through an export and a save
		// dialog. A fixed 2 s pause then clicked "MP4" into a panel that was not there, and the
		// run reported "aria-pressed came back null" three times in a row after a first
		// repetition that had worked.
		const panelOpen = async () => (await pressed("Lightning (Beta)")) !== null;
		let opened = false;
		for (let attempt = 0; attempt < 3 && !opened; attempt++) {
			await clickAny(["Exporter", "Export"], "the export panel");
			for (let i = 0; i < 10 && !opened; i++) {
				await sleep(600);
				opened = await panelOpen();
			}
		}
		if (!opened) {
			throw new Error(
				`the export panel never opened after three attempts; on screen: ${await onScreen()}`,
			);
		}

		const t = ctx.scenario.output;
		await pin(["MP4"], "container");
		// Matched on the resolution rather than the localised word beside it.
		await pin([`Originale ${t.width}`, `Original ${t.width}`, String(t.width)], "output size");
		await pin([String(t.fps)], "frame rate");
		// Kept: pin() throws unless the control reads back as selected, so this is the label the
		// app confirmed, not the one that was asked for. Recorded because "is it really on
		// Lightning?" is the first thing anyone asks of a 0.96x-realtime number.
		//
		// Which pipeline to ask for is a per-platform question, and pinning Lightning everywhere
		// was wrong on Linux. The panel there offers the button and accepts the click — aria-pressed
		// comes back true — and then the export refuses to start, raising the app's own dialog:
		// "the available encoder path depends on WebCodecs support, GPU drivers, and the bundled
		// FFmpeg encoders … check that the packaged FFmpeg build includes a compatible Breeze
		// encoder path for Linux". So the control is real and the path behind it is not shipped.
		//
		// Legacy is the WebCodecs path, and WebCodecs is genuinely available in this build: the
		// renderer reports `typeof VideoEncoder === "function"` and
		// `VideoEncoder.isConfigSupported({codec:"avc1.640028",1920x1080@60})` resolves supported.
		// That is the pipeline a user on this platform actually gets, so it is the one measured —
		// and `pipeline` is recorded on every run, so a Linux row can never be read as a Lightning
		// row.
		const PIPELINE = IS_LINUX ? ["Legacy", "Héritage"] : ["Lightning (Beta)", "Lightning"];
		const pipelinePinned = await pin(PIPELINE, "export pipeline");
		// And the other one, to prove the panel is not showing both as selected.
		const legacyStillOn = await pressed("Legacy");

		// The CUDA opt-in is a switch, not one of the pressed buttons above: it carries
		// aria-checked, it is only rendered once the pipeline is not Legacy, and it is addressed
		// by its accessible name because the visible text is split across "NVIDIA CUDA" and
		// "Experimental" — no leaf of the DOM holds the whole label.
		const CUDA_EL = `[...document.querySelectorAll("[aria-label]")].find(e => /CUDA/i.test(e.getAttribute("aria-label") || ""))`;
		const cudaState = async () =>
			JSON.parse(
				await es.eval(
					`JSON.stringify((() => { const el = ${CUDA_EL}; return el ? el.getAttribute("aria-checked") === "true" : null; })())`,
				),
			);

		/**
		 * Set the toggle, rather than clicking it.
		 *
		 * It used to be clicked unconditionally whenever the CUDA variant ran, which is wrong in
		 * a way that hid itself: the switch writes recordly.export.experimentalNvidiaCuda to
		 * disk, the app hydrates the next launch from it, and this driver relaunches for every
		 * repetition. So the first repetition turned CUDA on, the second launched with it
		 * already on and clicked it *off*, and the leg alternated between the two paths while
		 * reporting one. Both variants now state the value they want and read it back — the
		 * plain row has to turn it off for the same reason.
		 *
		 * Writing the setting through setAppSetting does not do this: the value lands on disk
		 * and getAppSetting agrees, but the panel's switch still reads false, because the store
		 * behind it is hydrated at mount and does not watch the file. Verified directly.
		 */
		const setCuda = async (want) => {
			const before = await cudaState();
			if (before === null) {
				if (want) {
					throw new Error(`the CUDA toggle is not on screen; on screen: ${await onScreen()}`);
				}
				return null;
			}
			if (before !== want) {
				await es.eval(`(() => { const el = ${CUDA_EL}; if (el) el.click(); })()`);
				await sleep(600);
			}
			const after = await cudaState();
			if (after !== want) {
				throw new Error(`the CUDA toggle reads ${after} after being set to ${want}`);
			}
			return after;
		};

		const cudaApplied = await setCuda(this.useCuda);
		ctx.observe("pinned", {
			container: "MP4",
			size: `${t.width}x${t.height}`,
			fps: t.fps,
			// The label the panel confirmed as selected, and Legacy's own state beside it.
			pipeline: pipelinePinned,
			legacySelected: legacyStillOn,
			cudaRequested: this.useCuda,
			// Read back off the switch, not inferred from the request.
			cudaApplied,
		});

		await clickAny(["Exporter en Video", "Export Video", "Exporter la vidéo"], "the export action");
		ctx.commit();
		// Where the measured window actually goes. The leg reports ~62 s against a 60 s source
		// while the panel shows render speeds around 185 fps, which would be ~19 s of rendering —
		// so most of the number is something other than compositing, and a headline that does not
		// say which is not worth publishing. Answering the save dialog happens inside this window
		// too, and it is driven over UIA, which is not free.
		const commitAt = Date.now();

		// Wait for the render in the DOM, not by polling for the native window.
		//
		// Handing that wait to fileDialogTo means it polls listWindows every 400 ms, and each of
		// those is a PowerShell spawn plus a UIA descendant walk of about a second — hundreds of
		// them, competing with the very export being timed, and it showed up as 560 % background
		// load. One CDP eval every two seconds costs nothing and is exact: the editor prints its
		// own progress, and says "Opening save dialog" when it reaches that step.
		//
		// On this build and this path — Lightning, on Windows — the dialog does come after the
		// render, and this ordering has produced a correct 60 s export. It is NOT assumed to
		// hold elsewhere: a parallel macOS run of this benchmark found the dialog arriving
		// before or during the render on Lightning and blocking it, which is the opposite. That
		// was a generalisation from one observation of the *Legacy* path, and this comment used
		// to make the same mistake. If a leg here ever stalls with no progress, read
		// `ctx.state.appLog` and check whether a dialog is already waiting.
		//
		// Only "opening save dialog" means finished. `Path:` does *not*: the editor prints the
		// route it picked beside the percentage while it is still rendering — at 45 % complete
		// the panel already reads "45 % terminé / Render speed 185.4 FPS / Path: WebGPU + Breeze
		// (h264-stream-copy)" — so matching on it declares the render done halfway through. It
		// is captured there instead, while it is still on screen.
		const body = async () =>
			es
				.eval('JSON.stringify((document.body.innerText || "").replace(/\\s+/g, " "))')
				.then((r) => JSON.parse(r))
				.catch(() => "");

		// The export panel is unmistakable while it runs: it shows the render speed and asks for
		// bug reports about Lightning. Requiring that within a minute turns "no export started"
		// into a fast, readable failure — the first version waited twenty minutes and then
		// reported a percentage scraped off the editor's own sidebar ("Rayon 46.5px", "MARGE
		// INTÉRIEURE"), which is not progress at all.
		const started = Date.now();
		let running = false;
		while (Date.now() - started < 60_000 && !running) {
			await sleep(1500);
			running = /render speed|report bugs with lightning/i.test(await body());
		}
		if (!running) {
			throw new Error(
				`the export did not start within 60s of clicking the export action. On screen: ${(await body()).slice(-400)}`,
			);
		}

		const RENDER_DEADLINE_MS = 20 * 60_000;
		const renderStart = Date.now();
		let backend = null;
		let sawDialogCue = false;
		let lastSeen = "";
		while (Date.now() - renderStart < RENDER_DEADLINE_MS) {
			const text = await body();
			const progress = text.match(
				/[\d.]+\s*%\s*termin\S*|[\d.]+\s*%\s*complete|Render speed[^A-Z]*/i,
			);
			if (progress) lastSeen = progress[0].trim().slice(0, 120);
			// Read the route while the panel still shows it — by the time the save dialog has
			// been answered it is gone, which is why the first version recorded null.
			const route = text.match(/Path:\s*([^|]{3,60}?)\s*(?:Annuler|Cancel|$)/i);
			// Per run, not per leg: this used to guard on ctx.state.backend, which survives the
			// whole leg, so only the first repetition ever recorded a route.
			if (route && !backend) {
				backend = route[1].trim();
				ctx.observe("backend", backend);
			}
			if (/opening save dialog/i.test(text)) {
				sawDialogCue = true;
				// Stop the clock here, not when the saved file settles.
				//
				// Measured on macOS before trusting it, because stopping early would quietly
				// flatter this tool: trigger at t=0, the rendered file appears at +45.6 s, and
				// the cue arrives at +48.7 s with the panel reading 100% — the same instant the
				// file stops growing. The undercount is zero.
				//
				// Note this contradicts the 72% figure recorded elsewhere in this file, which
				// came from Windows. Either the two platforms announce at different points or
				// the earlier reading caught a different phase; on macOS the cue means finished.
				//
				// Everything after this cue is the save panel: the app raising a native dialog,
				// and this harness filling a filename and finding a commit button. On Windows
				// that was measured at 36.1 s against a 28.7 s render — more than half the
				// reported number was the dialog. macOS shows the same shape: four legs at
				// 50.99 / 50.52 / 50.53 / 50.49 s, a 0.02 s spread across scoring legs, which is
				// a fixed cost sitting on top of a render rather than a render being measured.
				//
				// The runner only accepts this instant when it is *earlier* than the
				// filesystem's answer, so it can never inflate a result — it can only stop
				// charging the encoder for the operator.
				ctx.markComplete();
				break;
			}
			await sleep(2000);
		}
		if (!sawDialogCue) {
			throw new Error(
				`the render never reached its save step within ${RENDER_DEADLINE_MS / 60_000} minutes` +
					`${lastSeen ? `; last progress seen: "${lastSeen}"` : "; no progress was ever shown"}`,
			);
		}

		ctx.observe("renderMs", Date.now() - commitAt);
		if (lastSeen) ctx.observe("lastProgress", lastSeen);

		const dialogAt = Date.now();
		if (IS_LINUX) {
			// No native dialog is driven here, because on this platform none can be.
			//
			// A GTK save dialog is not reachable by any of the mechanisms the other two platforms
			// use: there is no AppleScript and no UI Automation, and under Wayland — which is what
			// this app runs on, it selects ozone/wayland itself — an outside process cannot
			// synthesise input into another client's window at all. xdotool sees only X11, and the
			// virtual-keyboard protocols ydotool and wtype need are not implemented by GNOME's
			// compositor. This is a property of the session, not a gap in effort.
			//
			// It does not have to be driven. The Legacy pipeline streams the export to its own
			// temporary file and *finishes writing it before* announcing "opening save dialog" —
			// verified here: h264 1920x1080@60, 3600 frames, 60.000 s, with its AAC track, sitting
			// complete on disk while the dialog waits. The dialog only chooses where that file goes.
			// Placing it is therefore the same operation `fileDialogTo` performs elsewhere, and it
			// happens entirely after ctx.markComplete(), so it cannot move the measured number.
			await placeStreamedExport(out, commitAt);

			// Then put the application down, rather than leaving it holding the dialog.
			//
			// This is where the platforms genuinely differ, and it is not free. Elsewhere
			// `fileDialogTo` answers the panel and the app settles back into an idle editor;
			// here nothing answers it, so without this the process sits with a modal open, its
			// toast still reading "Rendering your file", holding the export buffer — 2363 MiB of
			// peak RSS — until the *next* repetition's launchAndOpen kills it.
			//
			// The paired floor for that next repetition is measured inside exactly that window,
			// and it shows: Recordly's floors averaged 24.01s against 22.96s for Cap and 23.22s
			// for OpenScreen in the same run, 4.6% slower than the quietest leg. That direction
			// matters — a cost is an export divided by its floor, so a floor slowed by the
			// tool's own abandoned instance makes that tool look *cheaper*. It is a bias in the
			// tool's favour, not noise around it.
			//
			// The app is discarded after every repetition anyway, for reasons the relaunch
			// comment above explains, so nothing is lost by discarding it now instead of in a
			// minute. The sampler keeps the highest cumulative CPU it saw per pid, so a process
			// killed here still contributes its full cost to cpuSeconds.
			ctx.state.editor?.close?.();
			ctx.state.cdp?.close?.();
			killProcesses([PROC]);
		} else {
			try {
				const dlg = await fileDialogTo(PROC, out, { timeoutMs: 120_000 });
				// Split, because the whole of it lands inside the export clock. `appearedMs` is
				// mostly the app: it announces "opening save dialog" at about 72% and the window
				// only shows once it has finished. What comes after is this harness — filling the
				// field and finding the commit button, a PowerShell and UIA round trip each.
				if (dlg?.timings) ctx.observe("saveDialogPhases", dlg.timings);
			} catch (e) {
				throw new Error(`could not point the save dialog at ${out}: ${e.message}`);
			}
		}
		ctx.observe("saveDialogMs", Date.now() - dialogAt);

		// The route was recorded during the render, above, through ctx.observe — what the app
		// says it did rather than what it was asked to do, and more trustworthy than the flag
		// that requested it.
	},

	async cleanup(ctx) {
		ctx.state?.editor?.close?.();
		ctx.state?.cdp?.close?.();
		killProcesses([PROC]);
	},
};
