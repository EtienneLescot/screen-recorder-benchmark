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
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CdpSession, DOM_HELPERS, listTargets } from "../lib/cdp.mjs";
import { sleep } from "../lib/measure.mjs";
import { appVersion, IS_WIN, killProcesses, resolveAppPath } from "../lib/platform.mjs";
import { buildProject, defaultPaddingControl } from "../lib/recordlyProject.mjs";
import { fileDialogTo } from "../lib/ui.mjs";

export const RECORDLY = {
	macPath: "/Applications/Recordly.app",
	winPaths: [
		"%LOCALAPPDATA%\\Programs\\Recordly\\Recordly.exe",
		"%ProgramFiles%\\Recordly\\Recordly.exe",
	],
};

const APP = IS_WIN ? resolveAppPath(RECORDLY) : RECORDLY.macPath;
const BIN = APP ? (IS_WIN ? APP : `${APP}/Contents/MacOS/Recordly`) : null;
const PORT = 9444;
const PROC = "Recordly";

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
	appPath: APP,
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
		if (!BIN || !existsSync(BIN)) return { installed: false, version: null, path: null };
		return { installed: true, version: appVersion(BIN), path: BIN };
	},

	defaultPaddingControl,

	async prepare(ctx) {
		const outDir = join(ctx.workDir, "projects", this.id);
		const built = buildProject({
			sourcePath: ctx.source.path,
			scenario: ctx.scenario,
			outDir,
			title: ctx.scenario.id,
			paddingControl: ctx.paddingControl ?? defaultPaddingControl(ctx.scenario),
			assets: { ...(ctx.assets ?? {}), webcam: ctx.source.webcam ?? ctx.assets?.webcam },
			spec: ctx.source.spec,
		});
		ctx.state.built = built;

		// A stale instance would answer CDP with the previous project still loaded.
		killProcesses([PROC]);
		await sleep(1500);

		// The app's own stderr is kept, not discarded. Every earlier failure here was diagnosed
		// from the outside — CDP traces, DOM scraping, window lists — while the process was
		// being spawned with stdio "ignore" and was saying exactly what was wrong the whole
		// time. It costs nothing and it is the first thing to read when a leg fails.
		const logPath = join(ctx.outDir, `${this.id}-app.log`);
		ctx.state.appLog = logPath;
		const { spawn } = await import("node:child_process");
		const { appendFileSync, writeFileSync } = await import("node:fs");
		writeFileSync(logPath, "");
		const child = spawn(BIN, [`--remote-debugging-port=${PORT}`], {
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
		ctx.state.cdp = s;

		const call = async (expr) => {
			const raw = await s.eval(`Promise.resolve(${expr}).then(r => JSON.stringify(r ?? null))`);
			return raw ? JSON.parse(raw) : null;
		};

		const media = JSON.stringify(built.mediaPath);
		const set = await call(`window.electronAPI.setCurrentVideoPath(${media})`);
		if (set?.success === false) throw new Error(`setCurrentVideoPath refused: ${set.error}`);

		// The pointer is data, not pixels: without this the whole cursor stage — sprite,
		// smoothing, its own motion blur, click effect — never runs.
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
		ctx.state.editor = es;

		// The CUDA path is a persisted product setting, not an argument: ExportSettingsMenu
		// renders it as an "NVIDIA CUDA / Experimental" toggle and useNvidiaCudaExportOptIn
		// stores it under this key. Setting it here is what separates the two rows — the export
		// action itself is identical.
		await call(
			`window.electronAPI.setAppSetting("recordly.export.experimentalNvidiaCuda", ${this.useCuda})`,
		);

		// Let the editor settle before anything touches it.
		//
		// The CDP target exists well before the renderer has finished deciding what it can
		// encode with. Driven immediately, every export died on "VideoEncoder is not defined" —
		// the WebCodecs fallback — while the identical sequence run by hand, which happened to
		// pause here, took the native WebGPU path every time. This is the difference between
		// those two, and it is warm-up rather than measurement: the clock has not started.
		await sleep(8000);

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

		const es = ctx.state.editor;
		if (!es) throw new Error("the editor session is not open — prepare() did not complete");

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
		await clickAny(["Exporter", "Export"], "the export panel");
		await sleep(2000);

		const t = ctx.scenario.output;
		await pin(["MP4"], "container");
		// Matched on the resolution rather than the localised word beside it.
		await pin([`Originale ${t.width}`, `Original ${t.width}`, String(t.width)], "output size");
		await pin([String(t.fps)], "frame rate");
		await pin(["Lightning (Beta)", "Lightning"], "export pipeline");

		if (this.useCuda) {
			// Only offered once the pipeline is not Legacy, which is why it is set after it.
			await clickAny(["NVIDIA CUDA"], "the CUDA toggle");
			await sleep(400);
		}
		ctx.state.pinned = {
			container: "MP4",
			size: `${t.width}x${t.height}`,
			fps: t.fps,
			pipeline: "Lightning (Beta)",
			cudaRequested: this.useCuda,
		};

		await clickAny(["Exporter en Video", "Export Video", "Exporter la vidéo"], "the export action");
		ctx.commit();

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
			if (route && !ctx.state.backend) ctx.state.backend = route[1].trim();
			if (/opening save dialog/i.test(text)) {
				sawDialogCue = true;
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

		try {
			await fileDialogTo(PROC, out, { timeoutMs: 120_000 });
		} catch (e) {
			throw new Error(`could not point the save dialog at ${out}: ${e.message}`);
		}

		// ctx.state.backend was captured during the render, above — what the app says it did
		// rather than what it was asked to do, and more trustworthy than the flag that
		// requested it.
	},

	async cleanup(ctx) {
		ctx.state?.editor?.close?.();
		ctx.state?.cdp?.close?.();
		killProcesses([PROC]);
	},
};
