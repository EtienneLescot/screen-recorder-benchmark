/**
 * Screen Studio — the app that defined this category.
 *
 * Every step below runs unattended up to the point where it stops being possible: **export is
 * gated behind account activation.** Pressing Export on an unactivated install opens a separate
 * "Activate Screen Studio" window asking for the email address behind a licence key or
 * subscription. There is no trial export and no watermark path — the bundle carries no "trial"
 * or "watermark" string at all. Both routes to an export end at the same wall: the command menu
 * lists "Export…" whether or not the app has a token, and choosing it raises that window instead
 * of opening the next level. With a licence activated once (during preflight) the rest of this
 * driver runs unattended and the app becomes a full peer in the table.
 *
 * ## What makes it drivable
 *
 * 1. **It cannot be screenshotted.** The editor window is marked `kCGWindowSharingNone`, so
 *    macOS excludes it from every capture API: plainly visible to the person at the machine and
 *    invisible to `screencapture`, ScreenCaptureKit, and any agent driving pixels.
 * 2. **It publishes no accessibility tree.** `System Events` sees a window containing three
 *    traffic-light buttons and nothing else.
 * 3. Its only documented automation is three `screen-studio://record-*` deeplinks; the bundle
 *    carries a few undocumented ones (`export-to-clipboard`, `copy-and-zip-project`,
 *    `open-projects-folder`), none of which exports to a file.
 *
 * `--remote-debugging-port` puts the renderer within reach, and then every control can be found
 * by its visible text. That is *more* reproducible than pixel clicking, not less — it survives a
 * moved window, a different display and a resized UI — and the flag only opens an inspector: the
 * renderer, the compositor and the export pipeline are the shipping ones.
 *
 * The composition is not clicked at all. A `.screenstudio` project is a directory of plain JSON
 * around plain media, so the scenario is written straight into it — see
 * `lib/screenStudioProject.mjs`, which also explains why the project is built rather than run
 * through the app's own importer. The project is then opened the way a double-click opens it:
 * `open -a`, which reaches the app's `open-file` handler.
 *
 * ## Findings that shape the code below
 *
 * **The editor window's CDP target is `about:blank`, and it carries no bridge.** Only the
 * launcher window has the app's IPC bridge on `window`, and only it has the bundle URL — so a
 * driver that picks "the first page target" for one job or the other talks to the wrong window.
 * Targets are matched on what they *are* here: the editor by its content, the launcher by
 * having a bridge.
 *
 * **Every button's text carries an SF Symbols glyph** from Unicode plane 16 — Export reads as
 * `"\u{100203}\nExport"`, the command menu's button is `U+100A7F`. Exact-text matching finds
 * nothing; substring matching finds it every time.
 *
 * **The activation wall is its own window**, not an overlay in the editor DOM. A driver looking
 * for "Activate Screen Studio" in the editor's `innerText` would wait forever and then report
 * something else as the cause.
 *
 * **The app does not rewrite the project when it opens it.** Written, opened, and read back
 * through the app's own `project.loadProject`, every pinned value came back unchanged — padding,
 * radius, shadow, both motion-blur passes, cursor size, click effect, camera size and roundness,
 * and all three zoom ranges. That is worth stating because the tool beside it in this table
 * (Recordly) normalises the scene away on open, and the same check is what caught it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CdpSession, DOM_HELPERS, listTargets } from "../lib/cdp.mjs";
import { sleep } from "../lib/measure.mjs";
import { appVersion } from "../lib/platform.mjs";
import { buildProject, defaultPaddingControl } from "../lib/screenStudioProject.mjs";
import { fileDialogTo } from "../lib/ui.mjs";
import { appIsRunning, quitApp } from "../lib/uiScript.mjs";

const APP = "/Applications/Screen Studio.app";
const BIN = `${APP}/Contents/MacOS/Screen Studio`;
const PORT = 9333;

/**
 * The export, as the app's own command menu spells it.
 *
 * The menu nests one axis per level and re-labels its filter field at each step — "Export
 * to…", "Export as…", "Export resolution…", "Export quality…", "Export framerate…" — so the
 * driver can check *which question it is answering* before it answers, rather than clicking a
 * name and hoping. A renamed item then fails loudly instead of exporting down a path nobody
 * chose, which is the failure this whole benchmark is most exposed to: the app remembers the
 * last export's format, resolution, frame rate and quality ("Your latest export settings will
 * be used as default", in its own words), so an axis left unpinned measures whatever the last
 * run happened to leave selected.
 *
 * The names and the order come from the app's own action table, and the first level is as far
 * as an unactivated machine can confirm them: choosing "Export…" there raises the activation
 * window rather than opening the level below it. Everything past that point is written from the
 * app's definitions and is unverified — which is exactly why each step asserts the question it
 * has been asked before answering it.
 *
 * `quality` is the one axis the scenario does not pin. "Studio" is the highest of the four the
 * app offers (studio / social-media / web-high / web-low) and is the closest thing it has to
 * Cap's `--quality maximum`, which is what the CLI leg beside it uses; the app's own default is
 * `social-media`. Changing it changes the encoder's work, so it is named here rather than
 * inherited from whatever the machine last did.
 */
const exportSteps = (target) => [
	{ label: "Export...", expect: /Export to/i },
	{ label: "File...", expect: /Export as/i },
	{ label: "MP4...", expect: /Export resolution/i },
	// The app offers 720, 1080 and 2160 for MP4, and names the last one "4K" rather than
	// "2160p" — its own `height === 2160 ? "4K" : height + "p"`.
	{ label: `${target.height === 2160 ? "4K" : `${target.height}p`}...`, expect: /Export quality/i },
	{ label: "Studio...", expect: /Export framerate/i },
	{ label: `${target.fps}fps`, expect: null },
];

/**
 * Find a window by what it *is*, not by its URL.
 *
 * `probe` is evaluated in each page target and its result is handed to `test`. Every probe
 * carries a short timeout of its own, because an Electron target is published while its renderer
 * is still coming up and an evaluate sent into that window does not fail — it hangs, for the
 * whole timeout. Probing separates "not ready yet" from "never going to answer".
 */
async function findWindow(port, probe, test, { timeoutMs = 60_000, what = "window" } = {}) {
	const t0 = Date.now();
	let seen = [];
	while (Date.now() - t0 < timeoutMs) {
		seen = [];
		// The port is not open the instant the process is: until it is, `listTargets` throws
		// ECONNREFUSED, which is "not yet", not "never".
		let targets = [];
		try {
			targets = (await listTargets(port)).filter((x) => x.type === "page");
		} catch {
			await sleep(1000);
			continue;
		}
		for (const t of targets) {
			const s = new CdpSession(t.webSocketDebuggerUrl);
			try {
				await s.open();
				const value = await s.eval(probe, { timeoutMs: 8000 });
				seen.push(String(value).replace(/\s+/g, " ").slice(0, 60));
				if (test(value)) return { session: s, value };
			} catch {
				/* the renderer may still be coming up */
			}
			s.close();
		}
		await sleep(1000);
	}
	throw new Error(
		`no Screen Studio ${what} appeared within ${timeoutMs}ms. Saw: ${seen.join(" | ") || "no page targets"}`,
	);
}

const TEXT_PROBE = 'document.body ? document.body.innerText : ""';
/** The launcher window is the only one with the app's IPC bridge on `window`. */
const BRIDGE_PROBE = 'typeof window.bridge === "object" && !!window.bridge?.client';

/** Strip the SF Symbols glyphs (Unicode plane 16) the app puts inside every control's text. */
const readable = (text) => text.replace(/[\u{100000}-\u{10FFFD}]/gu, "").replace(/\n{2,}/g, "\n");

export default {
	id: "screen-studio",
	displayName: "Screen Studio",
	vendor: "Screen Studio",
	kind: "gui",
	automation: "cdp+menu",
	processName: "Screen Studio",
	appPath: APP,
	bundleId: "com.timpler.screenstudio",
	install: {
		method: "page",
		page: "https://screen.studio/download",
		assetPattern: /https:\/\/screenstudioassets\.com\/releases\/[^"' ]*Apple%20Silicon\.dmg/,
		appName: "Screen Studio.app",
		approxMB: 349,
		licence: "commercial — a licence is REQUIRED to export; there is no trial export",
	},

	detect() {
		if (!existsSync(BIN)) return { installed: false, version: null, path: null };
		return { installed: true, version: appVersion(APP), path: APP };
	},

	defaultPaddingControl,

	async prepare(ctx) {
		// A stale instance holds the debugging port, and a new one launched two seconds after the
		// quit races the old process's helpers for it: the new renderer then never answers, which
		// looks exactly like a broken app.
		if (appIsRunning(this.processName)) await quitApp(this.processName, { force: true });
		for (let i = 0; i < 20 && appIsRunning(this.processName); i++) await sleep(500);
		if (appIsRunning(this.processName)) {
			throw new Error("Screen Studio would not quit; its debugging port is still held");
		}
		// `open -a App --args …` silently drops the flags, so the binary inside the bundle is
		// launched directly.
		execFileSync("/bin/sh", [
			"-c",
			`nohup ${JSON.stringify(BIN)} --remote-debugging-port=${PORT} >/dev/null 2>&1 &`,
		]);
		// The launcher window is the one that carries the app's IPC bridge; waiting for it is also
		// what proves the debugging port came up.
		const launcher = await findWindow(PORT, BRIDGE_PROBE, (v) => v === true, {
			timeoutMs: 90_000,
			what: "window with an IPC bridge",
		});
		ctx.state.launcher = launcher.session;

		const outDir = join(ctx.workDir, "projects", "screen-studio");
		mkdirSync(outDir, { recursive: true });
		const built = buildProject({
			sourcePath: ctx.source.path,
			scenario: ctx.scenario,
			outDir,
			title: ctx.scenario.id,
			paddingControl: ctx.paddingControl ?? undefined,
			// A public bundle's own camera clip wins over the generated one, exactly as every
			// other driver here chooses it.
			assets: { ...(ctx.assets ?? {}), webcam: ctx.source.webcam ?? ctx.assets?.webcam },
			spec: ctx.source.spec,
			cursorPath: ctx.source.cursorPath ?? null,
			appVersion: this.detect().version ?? undefined,
		});
		ctx.state.projectPath = built.projectPath;

		// Opened the way a double-click opens it: `open -a` reaches the app's own `open-file`
		// handler, which is the documented route for a .screenstudio document and needs no menu.
		execFileSync("/usr/bin/open", ["-a", APP, built.projectPath]);
		const editor = await findWindow(
			PORT,
			TEXT_PROBE,
			(t) => t.includes(ctx.scenario.id) && /Export/.test(t) && /Presets/.test(t),
			{ timeoutMs: 120_000, what: `editor window for "${ctx.scenario.id}"` },
		);
		ctx.state.cdp = editor.session;
		await editor.session.eval(DOM_HELPERS);

		// Read back what the app parsed, not what was written: a value the app drops or
		// normalises is a feature this adapter must not claim. `project.loadProject` is the
		// query the app's own editor uses to open a document.
		const loaded = JSON.parse(
			await launcher.session.eval(
				`(async () => {
					try {
						const r = await window.bridge.client.query("project.loadProject", { projectPath: ${JSON.stringify(built.projectPath)} });
						const c = r?.projectData?.config ?? {};
						const rec = r?.recordingData ?? {};
						const s0 = rec.sessions?.[0] ?? {};
						return JSON.stringify({
							config: c,
							zooms: (r?.projectData?.scenes?.[0]?.zoomRanges ?? []).length,
							webcam: !!rec.webcamMeta,
							systemAudio: !!rec.systemAudioMeta,
							moves: (s0.mousemoves ?? []).length,
							clicks: (s0.mouseclicks ?? []).length,
						});
					} catch (e) { return JSON.stringify({ error: String(e).slice(0, 300) }); }
				})()`,
				{ timeoutMs: 60_000 },
			),
		);
		if (loaded.error) throw new Error(`Screen Studio could not load the project: ${loaded.error}`);
		const c = loaded.config ?? {};
		const e = ctx.scenario.effects;

		const applied = ["targetResolution", "targetFps"];
		if (c.backgroundType === "system" && c.backgroundSystemName) applied.push("background");
		if (c.backgroundPaddingRatio > 0) applied.push("padding");
		if (c.windowBorderRadius > 0) applied.push("cornerRadius");
		if (c.shadowIntensity > 0) applied.push("shadow");
		if (loaded.zooms === (e.zooms ?? []).length && e.zooms?.length) applied.push("zooms");
		if (c.motionBlurAmount > 0) applied.push("motionBlur");
		if (c.hideCursor === false && loaded.moves > 0) applied.push("cursor");
		if (c.hideCamera === false && loaded.webcam) applied.push("webcam");

		// What the app's *interface* says, which is not always what the document says. Read
		// through the documented sidebar shortcuts — ⌘1 Background & Screen, ⌘2 Cursor,
		// ⌘3 Camera — so a reader can check the numbers against the product rather than against
		// this file.
		const panels = {};
		for (const [name, digit] of [
			["screen", "1"],
			["cursor", "2"],
			["camera", "3"],
		]) {
			try {
				await this.pressCommandDigit(editor.session, digit);
				await sleep(700);
				// The sidebar's own component, not a slice of the page's text: `innerText` of the
				// whole body would have to be cut free of the toolbar above it and the timeline
				// ruler below, and both move.
				const raw = await editor.session.eval(
					`(() => { const el = document.querySelector('[class*="SidebarNavigation__UISidebarHolder"]'); return el ? el.innerText : ""; })()`,
				);
				panels[name] = readable(raw).replace(/\n/g, " · ").trim().slice(0, 260);
			} catch {
				/* a panel that will not open is a note, not a failed leg */
			}
		}

		return {
			appliedFeatures: applied,
			notes: [
				`project: ${built.projectPath}`,
				`app read back: padding ${c.backgroundPaddingRatio}, radius ${c.windowBorderRadius}, ` +
					`shadow ${c.shadowIntensity}, motion blur ${c.motionBlurAmount}, cursor ${c.cursorSize}× ` +
					`(${loaded.moves} moves, ${loaded.clicks} clicks), camera ${c.cameraSize} ` +
					`${c.cameraPosition}, ${loaded.zooms} zoom ranges, audio ${loaded.systemAudio}`,
				// Measured, not assumed: config 0.75 / 1.5 / 3.0 read back in the panel as
				// 1.5× / 3.0× / 6.0× on this machine, with the recording's own scale changed under
				// them and no effect. So the panel shows twice the document's number, and the
				// document is written in the unit the app itself ships (a fresh import is 1.5).
				`cursor size is written as ${e.cursor?.sizePercent ?? 100}% → ${c.cursorSize}; the app's ` +
					"Cursor panel displays twice that, and its own default for an imported project is 1.5",
				// A single 0-1 dial cannot be turned into three spring constants honestly, so it
				// selects whether the spring runs at all and the app's own stiffness/damping/mass
				// stand.
				`cursor smoothing is a spring here, not a scalar: ${e.cursor?.smoothing ?? 0} enables it ` +
					"and the app's own spring constants are left alone",
				`panels — screen: ${panels.screen ?? "(not read)"}`,
				`panels — cursor: ${panels.cursor ?? "(not read)"}`,
				`panels — camera: ${panels.camera ?? "(not read)"}`,
			],
		};
	},

	/** ⌘<digit>, the app's documented sidebar shortcuts. */
	async pressCommandDigit(session, digit) {
		const key = {
			modifiers: 4,
			key: digit,
			code: `Digit${digit}`,
			windowsVirtualKeyCode: 48 + Number(digit),
			nativeVirtualKeyCode: 48 + Number(digit),
			text: "",
		};
		await session.send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
		await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
	},

	outputPath(ctx) {
		return join(ctx.outDir, `${this.id}-${ctx.scenario.id}-run${ctx.run.index}.mp4`);
	},

	async runExport(ctx) {
		const s = ctx.state.cdp;
		const out = this.outputPath(ctx);
		if (existsSync(out)) rmSync(out);

		// The gate the app itself reads. Asking it directly costs one IPC round trip and gives a
		// precise answer; pressing Export first would only produce the same answer as a modal.
		const activated =
			(await ctx.state.launcher?.eval(
				`(async () => { try { return !!(await window.bridge.client.query("auth.hasToken")); } catch { return null; } })()`,
				{ timeoutMs: 30_000 },
			)) ?? null;

		if (activated !== true) {
			// Let the app state its own case rather than paraphrasing it: pressing Export raises
			// the activation window, and its text goes into the error.
			await s.eval(`JSON.stringify(window.__osbench.click("Export"))`).catch(() => undefined);
			let wall = "";
			try {
				const w = await findWindow(PORT, TEXT_PROBE, (t) => /Activate Screen Studio/i.test(t), {
					timeoutMs: 20_000,
					what: "activation window",
				});
				wall = readable(w.value).replace(/\n+/g, " ").trim().slice(0, 200);
				// It closes the window that is answering, so the reply to this evaluate never
				// arrives. Fire it and move on.
				w.session
					.eval(`JSON.stringify(window.__osbench.click("Go back"))`, { timeoutMs: 4000 })
					.catch(() => undefined);
				w.session.close();
			} catch {
				/* the wall did not appear; the message below still holds */
			}
			throw new Error(
				"Screen Studio requires an activated licence to export — there is no trial export " +
					`and no watermark path. Pressing Export opened its activation window${wall ? `: “${wall}”` : ""}. ` +
					"Activate it once during preflight and re-run; every other step of this driver is unattended.",
			);
		}

		// Pin every axis inside the run through the app's own command menu, checking at each step
		// which question the menu is asking before answering it.
		await this.openCommandMenu(s);
		for (const step of exportSteps(ctx.scenario.output)) {
			const r = JSON.parse(
				await s.eval(`JSON.stringify(window.__osbench.click(${JSON.stringify(step.label)}))`),
			);
			if (!r.ok) {
				throw new Error(
					`Screen Studio's command menu has no “${step.label}” — either the export path has been ` +
						"renamed, or the menu closed under the driver, which is what an activation wall does " +
						"to it.",
				);
			}
			await sleep(600);
			if (step.expect) {
				const placeholder = await s.eval(
					`JSON.stringify([...document.querySelectorAll("input")].map((i) => i.placeholder))`,
				);
				if (!step.expect.test(placeholder)) {
					throw new Error(
						`after “${step.label}” the command menu asked ${placeholder} rather than ${step.expect} — ` +
							"refusing to answer a question it was not asked",
					);
				}
			}
		}

		// The save panel comes *before* the render, not after it: the exporter asks "Where to save
		// new recording export?" and only then initialises. So the clock starts once the panel is
		// answered — anything earlier would be timing a modal dialog and the typing into it.
		//
		// `fileDialogTo` rather than the panel helpers directly, because it owns the rule that
		// bit the OpenScreen adapter: the AppKit save panel appends the format's extension
		// itself, so a typed "…run0.mp4" comes back as "…run0.mp4.mp4" and the runner then waits
		// out its timeout on a path nothing will ever write. It answers a replace-confirmation on
		// the way out too, which is sub-second and lands just inside the measured interval.
		await fileDialogTo(this.processName, out, { timeoutMs: 60_000 });
		ctx.commit();
	},

	/** The ⌘ button in the editor's toolbar; the menu it opens filters by visible text. */
	async openCommandMenu(session) {
		const opened = await session.eval(`(() => {
			const b = [...document.querySelectorAll("button")].find((el) => el.innerText.includes("\\u{100A7F}"));
			if (!b) return false;
			const r = b.getBoundingClientRect();
			for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
				b.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window,
					clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
			}
			return true;
		})()`);
		if (!opened) throw new Error("Screen Studio: no command-menu button in the editor toolbar");
		await sleep(1200);
		const ready = await session.eval(
			`[...document.querySelectorAll("input")].some((i) => /find a command/i.test(i.placeholder || ""))`,
		);
		if (!ready) throw new Error("Screen Studio: the command menu did not open");
	},

	async cleanup(ctx) {
		ctx.state?.cdp?.close();
		ctx.state?.launcher?.close();
		if (appIsRunning(this.processName)) await quitApp(this.processName, { force: true });
	},
};
