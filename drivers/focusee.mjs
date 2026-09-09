/**
 * FocuSee on macOS — the Windows adapter's twin, stopping at the same place.
 *
 * **The scenario is written into the project, not clicked into the editor**, for the reason
 * drivers/focusee-win.mjs gives and one more that belongs to this build: FocuSee's macOS sliders
 * publish their values to the accessibility API and no setters, so Padding, Roundness and Shadow
 * can be *read* and not written, and the zoom editor exposes no time or scale field at all. Driven
 * through the UI this app would render a cheaper scene than every tool beside it.
 *
 * The format is shared with Windows (lib/focuseeProject.mjs) and it travels unchanged: a project
 * written on that schema — `platform: "Win"`, `display-0.mp4`, `mousemoves-0.json` — opens on this
 * build with the whole scenario in place. Verified against 2.4.1 by opening one and reading the
 * editor back: `Padding 5`, `Roundness 4`, `Shadow 20`, `Clip 1m0s 1X`, `Zoom 1,8X`, and a Layout
 * track where a project without a camera has none. The Cursor, Camera and Audio panels all come up
 * enabled, which is the check that matters — with `projectType: "import"` in metadata.json the same
 * files leave them greyed out and no pointer is composited.
 *
 * That also removes the import from the picture: `open -a FocuSee <project>.focusee` opens an edit
 * directly, where `open -a FocuSee clip.mp4` answers "The source file is damaged and cannot be
 * opened" for every MP4 it is given, and the drop-zone path costs a File menu, an open panel and a
 * minute of transcoding to reach the same editor.
 *
 * What the Windows twin does through UIA, this does through the accessibility API, plus two things
 * that are macOS's alone:
 *
 * · **The export axes are pinned through FocuSee's own preferences, which are JSON inside an
 *   NSData value.** `AppConfiger.exportGlobalConfigure` written as a string is ignored silently
 *   and the sheet comes up on the last run's settings — a leg that had been 60FPS came back at
 *   30FPS, which is half the frames and half the work. Written as data, the sheet shows the pinned
 *   folder, MP4, the source resolution and 60FPS. Every axis is then read back off the sheet,
 *   which names each one on the control itself, before the export is committed.
 * · **The sheet's pop-ups are not menus.** Format, Resolution and Frame Rate open a borderless
 *   window of `AXStaticText` rows with no `AXPress` action, so `click()` does nothing at all; the
 *   row is located by its label and pressed with a real CGEvent. Same lesson as the import drop
 *   zone, in a second place.
 *
 * Export is licence-gated here as it is on Windows, and this build says so in its log before it
 * says so on screen:
 *
 *     Export choose export configer: F:MP4;Res:original;Rate:60FPS;T:1m0s;…
 *     Export free has exported: 1          ← the free tier's one export, already spent
 *     --------- UserRightsManager Export End ---------
 *
 * against the one successful export this machine has on record:
 *
 *     Export free has exported: 0
 *     Export start...
 *     Export end
 *     Export success count: 1
 *
 * So the driver watches the log rather than the screen: `Export start...` means the render is
 * under way and the runner's stopwatch owns the rest, `Export end` is the app's own completion
 * signal (`ctx.observeComplete`, audited against the file and never replacing it), and a refusal
 * is confirmed against the "FocuSee Premium" sheet whose only action is Buy Now. A walk of the
 * editor window costs a second or two of the machine that is meanwhile supposed to be encoding, so
 * it is asked only once the log has something to confirm.
 *
 * Two things take the front on launch and both are answered by name: the update prompt, and — the
 * one worth writing down — "You've reached the maximum number of devices that can be activated for
 * your current account." An account with a current order but no free slot for this machine is
 * refused at export *exactly* like an unlicensed one, `Export free has exported:` included. That
 * notice is the only thing telling the two apart, so it travels with the run and into the error.
 *
 * Install note: the vendor ships a ~5 MB downloader stub rather than the app. It is notarised
 * (iMobie Inc., team 2QJGLWL8Y6) and installs FocuSee.app into /Applications on launch, but it is
 * a GUI installer, so `bench.mjs install` cannot fetch this one unattended.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveFfmpeg } from "../lib/env.mjs";
import { writeFocuseeProject } from "../lib/focuseeProject.mjs";
import { hidClick } from "../lib/hidClick.mjs";
import { sleep } from "../lib/measure.mjs";
import { activateApp, appIsRunning, jxa, osa, quitApp } from "../lib/uiScript.mjs";

const APP = "/Applications/FocuSee.app";
const PROC = "FocuSee";
const DOMAIN = "com.imobie.FocuSee";
const LOGS = join(homedir(), "Library", "Application Support", DOMAIN, "FocuSee", "LogsFolder");
/** The frame-rate list the export sheet offers, in order; the preference stores the index. */
const FRAME_RATES = [60, 50, 30, 25, 24, 20, 15, 10];
/**
 * The editor's composition sliders and their ranges — the same ones drivers/focusee-win.mjs
 * clamps into, so the two platforms composite one rectangle rather than two. The scenario's radius
 * in pixels has no published conversion into FocuSee's own scale on either.
 */
const SLIDERS = { padding: [0, 25], round: [0, 20] };
const clamp = (v, [lo, hi]) => Math.max(lo, Math.min(hi, Math.round(v)));

/** The settings rail down the left of the editor: eleven unnamed buttons of one size. */
const TABS = { video: 0, cursor: 1, camera: 3, audio: 4 };

/* ----------------------------------------------------------------- accessibility --------- */

/**
 * Shared prelude for every accessibility query below.
 *
 * FocuSee is native Cocoa, so unlike the Electron entrants its whole interface is published — but
 * the API has no query language, so each lookup is a depth-first walk. Elements are addressed by
 * their visible label, which survives a moved window and a resized display; a position is read
 * only for the pop-up rows, which publish no action to press.
 */
const PRELUDE = `
	const se = Application("System Events");
	const proc = se.processes["${PROC}"];
	/** Depth-first, and stops as soon as \`visit\` says it has what it came for. */
	function each(el, d, visit) {
		if (d > 16) return false;
		try { if (visit(el)) return true; } catch (e) {}
		try { for (const k of el.uiElements()) { if (each(k, d + 1, visit)) return true; } } catch (e) {}
		return false;
	}
	function role(el) { try { return el.role(); } catch (e) { return ""; } }
	function label(el) {
		try { const v = el.name() || el.value(); return v === null || v === undefined ? "" : String(v); }
		catch (e) { return ""; }
	}
	function windows() { try { return proc.windows(); } catch (e) { return []; } }
	function editWindow() {
		return windows().find(w => { try { return w.name() === "edit"; } catch (e) { return false; } });
	}
	function firstIn(root, pred) {
		let hit = null;
		if (!root) return null;
		each(root, 0, el => { if (pred(el)) { hit = el; return true; } return false; });
		return hit;
	}
	function button(root, name) {
		return firstIn(root, el => role(el) === "AXButton" && label(el) === name);
	}
	/** A sheet is a direct child of its window, so this needs no walk — and it is polled often. */
	function sheetOf(win) {
		if (!win) return null;
		try { for (const k of win.uiElements()) if (role(k) === "AXSheet") return k; } catch (e) {}
		return null;
	}
	function labelsIn(root) {
		const out = [];
		each(root, 0, el => { const l = label(el); if (l) out.push([role(el), l]); return false; });
		return out;
	}
	/** The settings rail: the unnamed 54x52 buttons, in the order they are drawn. */
	function railTabs(win) {
		const out = [];
		each(win, 0, el => {
			try {
				if (role(el) === "AXButton" && label(el) === "") {
					const s = el.size();
					if (s[0] === 54 && s[1] === 52) out.push(el);
				}
			} catch (e) {}
			return false;
		});
		return out;
	}
`;

const ax = (body) => JSON.parse(jxa(`${PRELUDE}\n${body}`));

/** Every [role, label] pair in the editor window, in document order. */
function editorLabels() {
	return ax(`JSON.stringify(labelsIn(editWindow()) || []);`);
}

/**
 * What the editor says the composition is.
 *
 * The sliders are label/value pairs of static text — "Padding" then "5" — so a value is the next
 * numeric text after its label. Read rather than assumed: this is the check that the project
 * written below is the project the app opened.
 */
function editorSettings() {
	const labels = editorLabels();
	const value = (name) => {
		const i = labels.findIndex(([r, l]) => r === "AXStaticText" && l === name);
		if (i < 0) return null;
		for (let j = i + 1; j < Math.min(i + 4, labels.length); j++) {
			if (/^-?\d+(\.\d+)?$/.test(labels[j][1])) return Number(labels[j][1]);
		}
		return null;
	};
	return {
		padding: value("Padding"),
		roundness: value("Roundness"),
		shadow: value("Shadow"),
		duration: labels.find(([, l]) => /^\d\d:\d\d\.\d\d$/.test(l) && l !== "00:00.00")?.[1] ?? null,
		zooms: labels.filter(([, l]) => /^Zoom /i.test(l)).map(([, l]) => l),
		clip: labels.find(([, l]) => /^Clip /i.test(l))?.[1] ?? null,
	};
}

/**
 * Open one settings tab and report whether the control named in it is live.
 *
 * The macOS half of the Windows adapter's `enabled("Cursor_Btn")` check, answering the same
 * question: FocuSee will open a project whose telemetry it has decided not to use, and a greyed-out
 * panel is the only place it says so.
 */
function panelEnabled(tab, needle) {
	return ax(`
		proc.frontmost = true;
		const win = editWindow();
		const tabs = railTabs(win);
		if (tabs[${tab}]) tabs[${tab}].click();
		delay(1.2);
		let state = null;
		each(win, 0, el => {
			if (label(el).indexOf(${JSON.stringify(needle)}) !== 0) return false;
			try { state = el.enabled(); } catch (e) { state = null; }
			return true;
		});
		JSON.stringify(state);
	`);
}

/**
 * Clear what FocuSee puts in front of its own windows on launch, and say what was there. Only
 * alerts matched by their own text are answered — an unrecognised sheet is left alone rather than
 * confirmed blind.
 */
function dismissBlockingAlerts() {
	return ax(`
		const out = { update: null, notice: null };
		for (const w of windows()) {
			for (const name of ["Skip this version", "Remind me later"]) {
				const b = button(w, name);
				if (b) { b.click(); out.update = name; break; }
			}
			if (out.update) break;
		}
		for (const w of windows()) {
			const line = labelsIn(w)
				.map(p => p[1])
				.find(t => /maximum number of devices|activation rights/i.test(t));
			if (!line) continue;
			const ok = button(w, "OK");
			if (ok) { ok.click(); out.notice = line.slice(0, 240); }
			break;
		}
		JSON.stringify(out);
	`);
}

/**
 * The export sheet republishes every axis as the name of its own control — the folder button is
 * named for the folder, the frame-rate button for the frame rate — so reading it back is reading
 * the app's state rather than believing a click.
 */
function sheetSettings() {
	const pairs = ax(`
		const sheet = sheetOf(editWindow());
		JSON.stringify(sheet ? labelsIn(sheet) : null);
	`);
	if (!pairs) return null;
	const after = (caption) => {
		const i = pairs.findIndex(([r, l]) => r === "AXStaticText" && l === caption);
		if (i < 0) return null;
		return pairs.slice(i + 1).find(([r]) => r === "AXButton" || r === "AXTextField")?.[1] ?? null;
	};
	return {
		name: after("Name"),
		saveTo: after("Save to"),
		format: after("Format"),
		resolution: after("Resolution"),
		frameRate: after("Frame Rate"),
		quality: after("Quality"),
	};
}

/** The name field is a real AXTextField, so the output name needs no save panel at all. */
function setSheetName(stem) {
	return ax(`
		proc.frontmost = true;
		const field = firstIn(sheetOf(editWindow()), el => role(el) === "AXTextField");
		if (!field) JSON.stringify(null);
		else { field.value = ${JSON.stringify(stem)}; delay(0.4); JSON.stringify(String(field.value())); }
	`);
}

/** Choose a row in one of the sheet's pop-ups — static text with no action, so a real click. */
async function pickPopupRow(currentLabel, wanted) {
	const opened = ax(`
		proc.frontmost = true;
		let hit = null;
		for (const w of windows()) { const b = button(w, ${JSON.stringify(currentLabel)}); if (b) { hit = b; break; } }
		if (!hit) JSON.stringify({ ok: false });
		else { hit.click(); JSON.stringify({ ok: true }); }
	`);
	if (!opened.ok) return { ok: false, reason: `no control labelled "${currentLabel}"` };
	await sleep(1200);

	const rows = ax(`
		const out = [];
		for (const w of windows()) {
			let n = "?"; try { n = w.name(); } catch (e) {}
			if (n === "edit") continue;
			each(w, 0, el => {
				if (role(el) === "AXStaticText" && label(el)) {
					try {
						const p = el.position(), s = el.size();
						out.push({ label: label(el), x: p[0] + s[0] / 2, y: p[1] + s[1] / 2 });
					} catch (e) {}
				}
				return false;
			});
		}
		JSON.stringify(out);
	`);
	const row = rows.find((r) => wanted.test(r.label));
	if (!row) {
		osa(`tell application "System Events" to key code 53`);
		return { ok: false, reason: `no row matching ${wanted}`, seen: rows.map((r) => r.label) };
	}
	hidClick(row.x, row.y);
	await sleep(1200);
	return { ok: true, picked: row.label };
}

/** The upsell that ends an export on an install without a licence — or without a device slot. */
function premiumWall() {
	return ax(`
		const sheet = sheetOf(editWindow());
		if (!sheet) JSON.stringify(null);
		else {
			const text = labelsIn(sheet).map(p => p[1]).join(" · ");
			JSON.stringify(/FocuSee Premium|Buy Now|Upgrade to remove/i.test(text) ? text.slice(0, 400) : null);
		}
	`);
}

/**
 * Close whatever sheet is up, by its own close control. The Premium wall is strictly modal —
 * Escape and a click outside are both ignored — and the next repetition would otherwise click
 * Export straight into it.
 */
function dismissSheet() {
	return ax(`
		proc.frontmost = true;
		const sheet = sheetOf(editWindow());
		const closer = sheet && firstIn(sheet, el => {
			try { return role(el) === "AXButton" && el.description() === "close button"; } catch (e) { return false; }
		});
		if (!closer) JSON.stringify(false);
		else { closer.click(); JSON.stringify(true); }
	`);
}

/* ------------------------------------------------------------------ app plumbing --------- */

/**
 * FocuSee keeps these preferences as a JSON document inside an NSData value. Written as a string
 * they are undecodable, the app falls back to whatever it used last, and the export runs at a
 * frame rate nobody chose — so they go in as data, and the sheet is read back afterwards.
 */
function writeJsonPref(key, value) {
	execFileSync("/usr/bin/defaults", [
		"write",
		DOMAIN,
		key,
		"-data",
		Buffer.from(JSON.stringify(value), "utf8").toString("hex"),
	]);
}

/**
 * A position in FocuSee's own log, and what it has written since.
 *
 * This is how the export is watched after it is committed: reading the tail of a 10 KB text file
 * costs nothing, where asking the accessibility API takes a second or two of the machine that is
 * supposed to be rendering — and the app says more here than it shows on screen.
 */
function logCursor() {
	try {
		const newest = readdirSync(LOGS)
			.filter((f) => f.endsWith(".log"))
			.map((f) => ({ path: join(LOGS, f), m: statSync(join(LOGS, f)).mtimeMs }))
			.sort((a, b) => b.m - a.m)[0];
		return newest ? { path: newest.path, offset: statSync(newest.path).size } : null;
	} catch {
		return null;
	}
}

function logSince(cursor) {
	if (!cursor) return "";
	try {
		return readFileSync(cursor.path, "utf8").slice(cursor.offset);
	} catch {
		return "";
	}
}

export default {
	id: "focusee",
	displayName: "FocuSee",
	vendor: "iMobie",
	kind: "gui",
	automation: "ax+project",
	processName: PROC,
	appPath: APP,
	bundleId: DOMAIN,
	install: {
		method: "manual",
		url: "https://focusee.imobie.com/go/download.php?product=fs",
		appName: "FocuSee.app",
		approxMB: 5,
		licence: "commercial — export requires a licence; there is no trial export",
		notes: [
			"The download is a GUI installer stub, not the app, so this one cannot be installed unattended.",
			"Run the stub once during preflight; it places FocuSee.app in /Applications itself.",
			"A licence also needs a free device slot on the account: with none, export is refused exactly as it is without a licence.",
		],
	},

	detect() {
		if (!existsSync(APP)) return { installed: false, version: null, path: null };
		let version = null;
		try {
			version = execFileSync(
				"/usr/bin/defaults",
				["read", `${APP}/Contents/Info.plist`, "CFBundleShortVersionString"],
				{ encoding: "utf8" },
			).trim();
		} catch {
			/* keep null */
		}
		return { installed: true, version, path: APP };
	},

	projectPath(ctx) {
		return join(ctx.workDir ?? ctx.outDir, "projects", `focusee-${ctx.scenario.id}.focusee`);
	},

	/** FocuSee's padding slider is 0-25 on its own scale; `bench.mjs calibrate` solves it. */
	defaultPaddingControl(scenario) {
		return scenario.effects.paddingPercent;
	},

	async prepare(ctx) {
		if (!existsSync(APP)) throw new Error("FocuSee is not installed");
		// Before the project is rewritten, not after: an open editor holds every file in it.
		await this.cleanup();
		await sleep(2500);

		// Pin every export axis while the app is down, so the sheet cannot come up on the last
		// run's settings. Written as data — see writeJsonPref.
		mkdirSync(ctx.outDir, { recursive: true });
		const fps = ctx.scenario.output.fps;
		const frameRateIndex = FRAME_RATES.indexOf(fps);
		if (frameRateIndex < 0) {
			throw new Error(`FocuSee offers no ${fps} fps export; it has ${FRAME_RATES.join(", ")}`);
		}
		writeJsonPref("AppConfiger.customExportFilePath", [ctx.outDir]);
		writeJsonPref("AppConfiger.exportGlobalConfigure", [
			{
				path: ctx.outDir,
				format: 0, // MP4, the first entry of the format list
				resolution: "original",
				frameRate: frameRateIndex,
				name: `${this.id}-${ctx.scenario.id}`,
				quality: "medium", // the sheet's "Recommended" — the setting the product ships with
			},
		]);

		const e = ctx.scenario.effects;
		const durationSec = ctx.source.probe?.durationSec ?? ctx.source.spec?.durationSec ?? 60;
		const paddingControl = clamp(
			ctx.paddingControl ?? this.defaultPaddingControl(ctx.scenario),
			SLIDERS.padding,
		);
		const roundControl = clamp(e.cornerRadiusPx, SLIDERS.round);
		const project = this.projectPath(ctx);
		const written = writeFocuseeProject({
			dir: project,
			sourcePath: ctx.source.path,
			durationSec,
			width: ctx.source.probe?.video?.width ?? ctx.scenario.output.width,
			height: ctx.source.probe?.video?.height ?? ctx.scenario.output.height,
			scenario: ctx.scenario,
			webcamPath: ctx.source.webcam ?? ctx.assets?.webcam ?? null,
			cursorPath: ctx.source.cursorPath ?? ctx.assets?.cursorPath ?? null,
			spec: ctx.source.spec ?? null,
			paddingControl,
			roundControl,
			ffmpeg: resolveFfmpeg().ffmpeg,
		});
		ctx.state.projectPath = project;

		// A `.focusee` package is a document type this app opens; a bare MP4 is not.
		execFileSync("/usr/bin/open", ["-a", APP, project]);
		const t0 = Date.now();
		while (Date.now() - t0 < 120_000 && !appIsRunning(PROC)) await sleep(500);
		if (!appIsRunning(PROC)) throw new Error("FocuSee did not start");
		await sleep(18_000);
		activateApp(PROC);
		const alerts = dismissBlockingAlerts();
		// The device-slot notice outlives the launch that raised it, and it is the difference
		// between "no licence" and "a licence this machine has no slot for".
		ctx.state.activationNotice = alerts.notice ?? null;
		await sleep(800);

		// Read back what the app made of the project rather than what was asked of it.
		const shown = editorSettings();
		if (!shown.duration) {
			throw new Error(
				`FocuSee opened the project with no clip on the timeline. Editor: ${editorLabels()
					.map(([, l]) => l)
					.slice(0, 12)
					.join(" · ")}`,
			);
		}
		const live = {
			cursor: panelEnabled(TABS.cursor, "Cursor Style") === true,
			webcam: panelEnabled(TABS.camera, "Camera Layout") === true,
			audio: panelEnabled(TABS.audio, "System Audio") === true,
		};
		// Back to the canvas tab, so a repetition starts where this one did.
		panelEnabled(TABS.video, "Canvas Size");

		const applied = written.applied.filter((f) => {
			if (f === "cursor" || f === "webcam" || f === "audio") return live[f];
			if (f === "zooms") return shown.zooms.length > 0;
			if (f === "padding") return shown.padding != null && shown.padding > 0;
			if (f === "cornerRadius") return shown.roundness != null && shown.roundness > 0;
			if (f === "shadow") return shown.shadow != null && shown.shadow > 0;
			return true;
		});
		const dropped = written.applied.filter((f) => !applied.includes(f));

		return {
			appliedFeatures: applied,
			notes: [
				`project: ${project}`,
				`timeline: ${shown.duration}, ${shown.clip ?? "no clip label"}, zooms ${shown.zooms.join(" ") || "none"} — the tracks scrolled off the timeline are not published, so this counts what is on screen`,
				`editor reads back padding ${shown.padding}, roundness ${shown.roundness}, shadow ${shown.shadow}`,
				`telemetry: ${written.moves} moves, ${written.clicks} clicks; panels live — cursor ${live.cursor}, camera ${live.webcam}, audio ${live.audio}`,
				`padding=${paddingControl}/25, roundness=${roundControl}/20 in FocuSee's own slider units, the same clamp the Windows adapter uses so both platforms composite one rectangle; the scenario's ${e.cornerRadiusPx}px has no published conversion into that range`,
				dropped.length
					? `the app did not take: ${dropped.join(", ")} — the panel came up disabled`
					: "the app took every channel the project declares",
				alerts.update ? `dismissed the update prompt via "${alerts.update}"` : "no update prompt",
				...(alerts.notice ? [`FocuSee raised an account notice on launch: ${alerts.notice}`] : []),
			],
		};
	},

	outputPath(ctx) {
		return join(ctx.outDir, `${this.id}-${ctx.scenario.id}-run${ctx.run.index}.mp4`);
	},

	async runExport(ctx) {
		const out = this.outputPath(ctx);
		if (existsSync(out)) rmSync(out);
		mkdirSync(ctx.outDir, { recursive: true });
		const stem = out
			.split("/")
			.pop()
			.replace(/\.mp4$/i, "");

		activateApp(PROC);
		dismissBlockingAlerts();
		dismissSheet();
		await sleep(600);

		const clicked = ax(`
			proc.frontmost = true;
			const b = button(editWindow(), "Export");
			if (!b) {
				const seen = labelsIn(editWindow()).filter(p => p[0] === "AXButton").map(p => p[1]);
				JSON.stringify({ ok: false, seen: seen.slice(0, 25) });
			} else { b.click(); JSON.stringify({ ok: true }); }
		`);
		if (!clicked.ok)
			throw new Error(`FocuSee: no Export button. Present: ${(clicked.seen ?? []).join(", ")}`);

		let sheet = null;
		for (let i = 0; i < 12 && !sheet; i++) {
			await sleep(800);
			sheet = sheetSettings();
		}
		if (!sheet) throw new Error("FocuSee: the export dialog never opened");

		// Name the output rather than driving a save panel: the field is a real text field, and
		// the folder came from the pinned preference.
		const named = setSheetName(stem);
		if (named !== stem)
			throw new Error(`FocuSee: the export name stayed "${named}", not "${stem}"`);

		// Pin what the preference did not, and pin nothing that is already right — every pop-up
		// opened is a chance for the sheet to close on its own.
		const t = ctx.scenario.output;
		const axes = [
			{ name: "format", want: /^MP4$/i, label: "MP4" },
			{
				name: "resolution",
				// "1080P", or the single "Original (1920 * 1080)" entry the list collapses to when
				// the project is already at the target. Either is the target; the read-back records
				// which one the app offered.
				want: new RegExp(`^(Original \\(${t.width} \\* ${t.height}\\)|${t.height}P)$`, "i"),
				label: `${t.height}P or Original`,
			},
			{ name: "frameRate", want: new RegExp(`^${t.fps}FPS$`, "i"), label: `${t.fps}FPS` },
		];
		for (const axis of axes) {
			sheet = sheetSettings();
			if (sheet[axis.name] && axis.want.test(sheet[axis.name])) continue;
			const picked = await pickPopupRow(sheet[axis.name], axis.want);
			if (!picked.ok) {
				throw new Error(
					`FocuSee: could not set ${axis.name} to ${axis.label} — ${picked.reason}` +
						(picked.seen ? `. Offered: ${picked.seen.join(", ")}` : ""),
				);
			}
		}

		// Read every axis back before committing: a click that lands on a renamed control reports
		// success while the export goes down a path nobody chose.
		sheet = sheetSettings();
		const wrong = axes.filter((a) => !(sheet[a.name] && a.want.test(sheet[a.name])));
		if (wrong.length) {
			throw new Error(
				`FocuSee: the export dialog reads ${wrong.map((a) => `${a.name}="${sheet[a.name]}"`).join(", ")}, ` +
					`not ${wrong.map((a) => a.label).join(", ")}`,
			);
		}
		if (!sheet.saveTo || !out.startsWith(sheet.saveTo)) {
			throw new Error(`FocuSee: the export folder reads "${sheet.saveTo}", not "${ctx.outDir}"`);
		}
		ctx.observe("exportDialog", sheet);

		// Taken before the click, not after: FocuSee writes its verdict the moment Export is
		// pressed, so a cursor read afterwards starts past the very lines it is looking for.
		const cursor = logCursor();
		const go = ax(`
			proc.frontmost = true;
			const b = button(sheetOf(editWindow()), "Export");
			if (!b) JSON.stringify({ ok: false });
			else { b.click(); JSON.stringify({ ok: true }); }
		`);
		if (!go.ok) throw new Error("FocuSee: the export dialog has no Export button");
		ctx.commit();

		// From here the app is either rendering or refusing, and it says which in its log first.
		const deadline = Date.now() + 45_000;
		let refusedAt = null;
		let configure = null;
		let started = false;
		while (Date.now() < deadline && !started) {
			const fresh = logSince(cursor);
			configure =
				[...fresh.matchAll(/Export choose export configer: (.+)/g)].pop()?.[1].trim() ?? configure;
			// "Export start..." is the render beginning; the runner's stopwatch owns the rest.
			if (/Export start\.\.\./.test(fresh) || existsSync(out)) {
				started = true;
				break;
			}
			const spent = /Export (?:vip|free) has exported: \d+/.exec(fresh);
			if (spent) {
				refusedAt ??= Date.now();
				const wall = premiumWall();
				if (wall) {
					ctx.observe("licenceTier", spent[0]);
					ctx.observe("premiumWall", wall);
					if (configure) ctx.observe("exportConfigure", configure);
					// Leave the app on the editor: the wall is modal, and the next repetition would
					// otherwise click Export into a sheet that answers nothing.
					dismissSheet();
					throw new Error(
						"FocuSee raised its “FocuSee Premium” panel instead of exporting — its only action is " +
							`Buy Now, and nothing is written. Its own log agrees ("${spent[0]}")` +
							(configure ? `, against the configuration it read back as "${configure}"` : "") +
							". Nothing else in this adapter is blocked; activate a licence and the same run measures." +
							(ctx.state?.activationNotice
								? ` A purchase is not the same as a slot, though: this install answered "${ctx.state.activationNotice}" ` +
									"on launch, and until a device is freed on the account it reports the free tier here."
								: ""),
					);
				}
				// The free tier's *first* export is allowed, and the wall takes a moment to draw
				// when it comes at all, so a few seconds of neither decides nothing.
				if (Date.now() - refusedAt > 12_000) break;
			}
			await sleep(500);
		}
		if (configure) ctx.observe("exportConfigure", configure);

		// "Export end" is FocuSee's own completion signal: it audits the stop, and the filesystem
		// is still what stops the clock. Nothing here waits on it beyond the render itself.
		if (started) {
			for (let i = 0; i < 2400; i++) {
				if (/Export end/.test(logSince(cursor))) {
					ctx.observeComplete();
					return;
				}
				await sleep(500);
			}
		}
	},

	async cleanup() {
		if (appIsRunning(PROC)) await quitApp(PROC, { force: true });
	},
};
