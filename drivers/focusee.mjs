/**
 * FocuSee on macOS — the closest pitch-for-pitch rival, driven end to end and stopped at the till.
 *
 * **Everything except the export now runs unattended, and the scenario is applied rather than
 * approximated.** The earlier version of this driver claimed only `targetResolution` and
 * `targetFps` because FocuSee's composition controls are sliders the app draws itself: their
 * values are published to the accessibility API, no setter is. That was the wrong place to look.
 * A `.focusee` project is a *document package* — `configure.focuseeproj` beside a `recording/`
 * folder — and the configure file is plain JSON that the app reads back on open, exactly like
 * Screen Studio's `project.json`. So the edit is written, not clicked.
 *
 * That it is honoured is not assumed. Writing padding 0.05 / round 0.037 / shadowOpacity 0.2 and
 * three zoom tracks, then reopening the package, gives an editor reading `Padding 5`,
 * `Roundness 4`, `Shadow 20` and a timeline showing `Zoom 1,8X` — the scenario's first zoom, by
 * its scale. Nothing was normalised away on open; this is not Recordly, which rewrites a project
 * with its own defaults the moment it reads one.
 *
 * The zoom schema was recovered from the app rather than guessed: FocuSee's own
 * `AppData/shortcut.plist` binds `editAddZoom` to ⌘O, so pressing it at 0s and again at 10.1s
 * and reading the file back gives the units — `begin` and `end` are fractions of `duration`,
 * which is the clip's length in seconds, `zoomScale` is the factor, and `zoomManualPoint` is the
 * focus in normalised coordinates. Two zooms, two timestamps, no ambiguity left.
 *
 * What blocks the row is commercial, and it survived signing in. The export dialog is reached
 * with every axis the scenario pins — MP4, `Original (1920 * 1080)`, 60FPS — and pressing Export
 * there raises a **FocuSee Premium** sheet whose only action is *Buy Now*. Nothing is written,
 * CPU stays at zero, and the app's own log records the refusal in the same breath as the
 * configuration it would have used:
 *
 *     Export choose export configer: F:MP4;Res:original;Rate:60FPS;T:1m0s;W:0;SP:0;Z:1;M:1;…
 *     Export free has exported: 1
 *     --------- UserRightsManager Export End ---------
 *
 * That line is read back onto the run record (`observed.exportConfigure`), because it is the
 * app's own statement of what it was about to render — `Z` was `0` before the zoom tracks were
 * written and `1` after, and `C` went from `Online` to `Off` with the subtitle pass turned off.
 * A licensed install logs `Export vip has exported:` instead and proceeds; activate one during
 * preflight and this driver measures FocuSee like any other row, with no other step to repeat.
 *
 * Four traps, each of which cost a session before it was named:
 *
 * · **The export axes are not pinned by their preferences unless you write them the way FocuSee
 *   stores them.** `AppConfiger.exportGlobalConfigure` is JSON inside an **NSData** value, not a
 *   string. Written as a string it is ignored silently and the sheet comes up on whatever was
 *   used last — a run that had been 60FPS came back at 30FPS, which is half the frames and half
 *   the work. Written as data, the sheet shows the pinned folder, MP4, the source resolution and
 *   60FPS, and every one of those is read back off the sheet before the export is committed.
 * · **The pop-ups are not menus.** Format, Resolution and Frame Rate open a borderless window of
 *   `AXStaticText` rows with no `AXPress` action, so `click()` does nothing at all. A real
 *   CGEvent at the row's own accessibility position selects it, and the sheet then reports the
 *   new value — the same lesson the import drop zone taught, in a second place.
 * · **The editor window is excluded from screen capture.** A screenshot of its frame shows the
 *   desktop behind it; only the update prompt and the recorder HUD are visible. Diagnose FocuSee
 *   through the accessibility tree, never a picture.
 * · **Two things steal the front on launch, and neither is the editor.** 2.4.1 opens "Please
 *   update FocuSee to explore more", and an account whose device slots are all used opens "You've
 *   reached the maximum number of devices that can be activated for your current account." Both
 *   are answered by name — an unrecognised sheet is left alone rather than confirmed blind — and
 *   the second one is worth reading before anyone buys a licence twice: an account that *has* a
 *   current order but no free slot for this machine is refused at export exactly like an
 *   unlicensed one, log line included (`Export free has exported:`). The notice is the only thing
 *   that tells the two apart, so it travels with the run and into the error.
 *
 * Not applied, and reported as missing rather than skipped quietly: the webcam inset. Adding a
 * `webcam` recorder session to an imported project's `metadata.json`, with the camera clip beside
 * the screen recording, leaves the app's own export line at `W:0` — FocuSee composites a camera
 * only for footage it recorded itself. The pointer *is* written, in FocuSee's own schema (see
 * `writeFocuseeCursor` in lib/assets.mjs), because an import leaves `mousemoves.json` empty and
 * a demo export without a pointer is not the same work as one with it.
 *
 * Install note: the vendor ships a ~5 MB downloader stub rather than the app. It is notarised
 * (iMobie Inc., team 2QJGLWL8Y6) and installs FocuSee.app into /Applications on launch, but it
 * is a GUI installer, so `bench.mjs install` cannot fetch this one unattended.
 */
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { convertCursorForFocusee, writeFocuseeCursor } from "../lib/assets.mjs";
import { hidClick } from "../lib/hidClick.mjs";
import { sleep } from "../lib/measure.mjs";
import { activateApp, appIsRunning, jxa, launchApp, osa, quitApp } from "../lib/uiScript.mjs";

const APP = "/Applications/FocuSee.app";
const PROC = "FocuSee";
const DOMAIN = "com.imobie.FocuSee";
/** Where FocuSee puts every project, recorded or imported. Not configurable in 2.4.1. */
const PROJECTS = join(homedir(), "Movies", "FocuSee Project");
const LOGS = join(homedir(), "Library", "Application Support", DOMAIN, "FocuSee", "LogsFolder");
/** The frame-rate list the export sheet offers, in order; the preference stores the index. */
const FRAME_RATES = [60, 50, 30, 25, 24, 20, 15, 10];

/* ----------------------------------------------------------------- accessibility --------- */

/**
 * Shared prelude for every accessibility query below.
 *
 * FocuSee publishes its whole interface — it is native Cocoa, not Electron — but the API has no
 * query language, so each lookup is a depth-first walk. Elements are addressed by their visible
 * label, which survives a moved window and a resized display; positions are read only for the
 * two controls that need a real mouse event.
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
	function windowNamed(name) {
		return windows().find(w => { try { return w.name() === name; } catch (e) { return false; } });
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
`;

const ax = (body) => JSON.parse(jxa(`${PRELUDE}\n${body}`));

/** Every [role, label] pair in the editor window, in document order. */
function editorLabels() {
	return ax(`JSON.stringify(labelsIn(windowNamed("edit")) || []);`);
}

/**
 * What the editor says the composition is.
 *
 * The sliders are label/value pairs of static text — "Padding" then "5" — so the value is the
 * next numeric text after the label. Read rather than assumed: this is the only check that the
 * project file written below was the file the app opened.
 */
function editorSettings() {
	const labels = editorLabels();
	const value = (name) => {
		const i = labels.findIndex(([role, l]) => role === "AXStaticText" && l === name);
		if (i < 0) return null;
		for (let j = i + 1; j < Math.min(i + 4, labels.length); j++) {
			if (/^-?\d+(\.\d+)?$/.test(labels[j][1])) return Number(labels[j][1]);
		}
		return null;
	};
	return {
		padding: value("Padding"),
		inset: value("Inset"),
		roundness: value("Roundness"),
		shadow: value("Shadow"),
		duration: labels.find(([, l]) => /^\d\d:\d\d\.\d\d$/.test(l) && l !== "00:00.00")?.[1] ?? null,
		zooms: labels.filter(([, l]) => /^Zoom /i.test(l)).map(([, l]) => l),
		clip: labels.find(([, l]) => /^Clip /i.test(l))?.[1] ?? null,
	};
}

/**
 * Clear what FocuSee puts in front of its own windows on launch, and say what was there.
 *
 * Two of these exist and both take the front until they are answered: the update prompt 2.4.1
 * opens over the editor, and the account notice that appears when a licensed account has no
 * device slot left. Only alerts matched by their own text are answered — an unrecognised sheet
 * is left alone rather than confirmed blind.
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

function clickEditorButton(name) {
	return ax(`
		proc.frontmost = true;
		const b = button(windowNamed("edit"), ${JSON.stringify(name)});
		if (!b) {
			const seen = labelsIn(windowNamed("edit")).filter(p => p[0] === "AXButton").map(p => p[1]);
			JSON.stringify({ ok: false, seen: seen.slice(0, 25) });
		} else { b.click(); JSON.stringify({ ok: true }); }
	`);
}

/**
 * The export sheet republishes every axis as the name of its own control — the folder button is
 * named for the folder, the frame-rate button for the frame rate — so reading it back is reading
 * the app's own state rather than believing a click.
 */
function sheetSettings() {
	const pairs = ax(`
		const sheet = sheetOf(windowNamed("edit"));
		JSON.stringify(sheet ? labelsIn(sheet) : null);
	`);
	if (!pairs) return null;
	// Each row is a static-text caption followed by the control carrying the current value.
	const after = (caption) => {
		const i = pairs.findIndex(([role, l]) => role === "AXStaticText" && l === caption);
		if (i < 0) return null;
		const hit = pairs.slice(i + 1).find(([role]) => role === "AXButton" || role === "AXTextField");
		return hit?.[1] ?? null;
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
		const sheet = sheetOf(windowNamed("edit"));
		const field = firstIn(sheet, el => role(el) === "AXTextField");
		if (!field) JSON.stringify(null);
		else { field.value = ${JSON.stringify(stem)}; delay(0.4); JSON.stringify(String(field.value())); }
	`);
}

/**
 * Choose a row in one of the sheet's pop-ups.
 *
 * The pop-up opens as a borderless window of static text with no `AXPress` action — a synthetic
 * click is ignored, in the same way the import drop zone ignores one — so the row is located by
 * its label through the accessibility API and then pressed with a real CGEvent.
 */
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
				if (role(el) !== "AXStaticText") return;
				const l = label(el);
				if (!l) return;
				try {
					const p = el.position(), s = el.size();
					out.push({ label: l, x: p[0] + s[0] / 2, y: p[1] + s[1] / 2 });
				} catch (e) {}
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

/**
 * Close whatever sheet is up, by its own close control.
 *
 * The Premium wall is strictly modal — Escape and a click outside it are both ignored — and the
 * next repetition would click Export straight into it. Its close dot is a plain AX button, so
 * this needs no coordinates.
 */
function dismissSheet() {
	return ax(`
		proc.frontmost = true;
		const sheet = sheetOf(windowNamed("edit"));
		const closer = sheet && firstIn(sheet, el => {
			try { return role(el) === "AXButton" && el.description() === "close button"; } catch (e) { return false; }
		});
		if (!closer) JSON.stringify(false);
		else { closer.click(); JSON.stringify(true); }
	`);
}

/** The upsell that ends every export on an unlicensed install. */
function premiumWall() {
	return ax(`
		const sheet = sheetOf(windowNamed("edit"));
		if (!sheet) JSON.stringify(null);
		else {
			const text = labelsIn(sheet).map(p => p[1]).join(" · ");
			JSON.stringify(/FocuSee Premium|Buy Now|Upgrade to remove/i.test(text) ? text.slice(0, 400) : null);
		}
	`);
}

/* ------------------------------------------------------------------ app plumbing --------- */

/**
 * FocuSee keeps these preferences as a JSON document inside an NSData value. Writing a string
 * leaves them undecodable, the app falls back to whatever it used last, and the export runs at
 * a frame rate nobody chose — so they go in as data, and the sheet is read back afterwards.
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
 * This is how the export is watched after it is committed. The alternative — asking the
 * accessibility API whether the upsell is up — walks the whole editor window, takes a second or
 * two, and would spend that on the machine that is supposed to be rendering. Reading the tail of
 * a 10 KB text file costs nothing, and the app says more there than it shows on screen anyway.
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

/**
 * How long the source is, in the order the harness can actually answer it: the probe of the file
 * on disk, then the spec it was generated from. The zoom tracks are written as fractions of this,
 * so getting it wrong moves every zoom rather than failing.
 */
function sourceDurationSec(ctx) {
	const seconds = ctx.source.probe?.durationSec ?? ctx.source.spec?.durationSec;
	if (!seconds)
		throw new Error("FocuSee: the source's duration is unknown, so zooms cannot be placed");
	return seconds;
}

/** The project the import just created: the newest package in FocuSee's projects folder. */
function newestProject(after = 0) {
	if (!existsSync(PROJECTS)) return null;
	const dirs = readdirSync(PROJECTS)
		.filter((d) => d.endsWith(".focusee"))
		.map((d) => ({ path: join(PROJECTS, d), m: statSync(join(PROJECTS, d)).mtimeMs }))
		.filter((d) => d.m >= after)
		.sort((a, b) => b.m - a.m);
	return dirs[0]?.path ?? null;
}

/**
 * Write the scenario into the project.
 *
 * Only the axes FocuSee actually exposes are touched, and each one keeps the app's own units:
 * `padding`, `round` and `shadowOpacity` are fractions the editor displays as percentages, and
 * the zoom tracks carry times as fractions of the clip.
 */
function applyScenario(projectDir, ctx, paddingControl) {
	const file = join(projectDir, "configure.focuseeproj");
	const doc = JSON.parse(readFileSync(file, "utf8"));
	const e = ctx.scenario.effects;
	const durationSec = sourceDurationSec(ctx);
	const height = ctx.scenario.output.height;

	doc.background = {
		...doc.background,
		// Left on FocuSee's own catalogue, as the scenario's `tool-default` tolerance allows.
		// Its wallpapers are a uniform 2000x2000 — 4.0 Mpx, against Cap's 10.0 and OpenScreen's
		// 9.3-36.2 — so it samples less texture per frame than they do. That is the tolerance
		// showing, not a measurement, and it is why the note travels with every run.
		inset: 0,
		padding: paddingControl / 100,
		// FocuSee's roundness is a fraction, not pixels; the scenario's radius is expressed
		// against the frame's short side. Unsolved, because solving it needs an export.
		round: e.cornerRadiusPx / height,
		shadowOpacity: e.shadow?.enabled ? e.shadow.intensity : 0,
	};
	doc.motion = {
		...doc.motion,
		blur: {
			isEnable: !!e.motionBlur?.enabled,
			cursorMoveBlur: e.motionBlur?.amount ?? 0,
			screenMoveBlur: e.motionBlur?.amount ?? 0,
			screenZoomBlur: e.motionBlur?.amount ?? 0,
		},
	};
	// `size` is deliberately not set: it is on a scale of FocuSee's own that no exported frame has
	// measured yet, and writing the scenario's 150 into a field that may mean "1.5x" or "150x"
	// would be a guess dressed as a setting. The pointer is drawn at the size the product ships
	// with, its style and smoothing likewise, and the click *sound* is silenced because the
	// scenario asks for a click effect, not a soundtrack.
	doc.cursor = {
		...doc.cursor,
		isEnable: !!e.cursor?.enabled,
		isHideWhenIdle: false,
		clickSound: { ...doc.cursor?.clickSound, isEnable: false },
	};
	// The camera is left off: an imported project has no camera track, and giving it one is not
	// enough — see the header. Claiming `webcam` here would be claiming work nobody does.
	doc.camera = { ...doc.camera, isEnable: false };
	doc.subtitles = { ...doc.subtitles, isEnable: !!e.captions };
	doc.zoomTracks = (e.zooms ?? []).map((z) => ({
		autoEffect: "normal",
		begin: z.startSec / durationSec,
		end: z.endSec / durationSec,
		duration: durationSec,
		isAutoZoom2D: false,
		isAutoZoom3D: false,
		type1: "2d",
		zoomOpen: true,
		zoomScale: z.scale,
		zoomManualPoint: { x: z.focus.x, y: z.focus.y },
		customAnchor3D: { x: z.focus.x, y: z.focus.y },
		transform: {
			fov: 35,
			rotateX: 0,
			rotateY: 25,
			rotateZ: 0,
			translateX: 0,
			translateY: 0,
			translateZ: 0,
		},
	}));
	writeFileSync(file, JSON.stringify(doc, null, 2));
	return doc;
}

export default {
	id: "focusee",
	displayName: "FocuSee",
	vendor: "iMobie",
	kind: "gui",
	automation: "ax+menu+project",
	processName: PROC,
	appPath: APP,
	bundleId: DOMAIN,
	install: {
		method: "manual",
		url: "https://focusee.imobie.com/go/download.php?product=fs",
		appName: "FocuSee.app",
		approxMB: 5,
		licence: "commercial — export requires a licence; the free tier allows one export, ever",
		notes: [
			"The download is a GUI installer stub, not the app, so this one cannot be installed unattended.",
			"Run the stub once during preflight; it places FocuSee.app in /Applications itself.",
			"Each leg imports the source into ~/Movies/FocuSee Project, which copies the clip — budget the source's size per leg.",
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

	/**
	 * FocuSee's padding is a fraction of the frame that the editor shows as a percentage, so the
	 * scenario's percentage goes in as-is. Whether its 5% is the same rectangle as another app's
	 * 5% is what `bench.mjs calibrate` exists to settle — and it cannot run here until an export
	 * is possible, so this is a documented default rather than a solved one.
	 */
	defaultPaddingControl(scenario) {
		return scenario.effects.paddingPercent;
	},

	async prepare(ctx) {
		if (appIsRunning(PROC)) await quitApp(PROC, { force: true });
		await sleep(2000);

		// Pin every export axis before the app is running, so the sheet cannot come up on the
		// last run's settings. Written as data — see writeJsonPref.
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

		const importedAfter = Date.now();
		await launchApp(APP, PROC);
		await sleep(9000);
		activateApp(PROC);
		const launchAlerts = dismissBlockingAlerts();
		await sleep(600);

		// `open -a` is the obvious route for the *source* and it is the wrong one: FocuSee's
		// document-open path answers "The source file is damaged and cannot be opened" for every
		// MP4 it is given. Its import path is separate and works. File > Import Video to Create
		// Project raises a drop zone, the drop zone raises an NSOpenPanel, and the panel takes
		// the clip. (The same `open -a` *is* the right route for a .focusee package, below.)
		jxa(`
			const se = Application("System Events");
			const p = se.processes["${PROC}"];
			p.frontmost = true;
			delay(1);
			const file = p.menuBars()[0].menuBarItems().find(m => {
				try { return m.name() === "File"; } catch (e) { return false; }
			});
			const items = file.menus()[0].menuItems();
			let hit = null;
			for (let i = 0; i < items.length; i++) {
				let n = ""; try { n = items[i].name() || ""; } catch (e) {}
				if (/import video/i.test(n)) { hit = items[i]; break; }
			}
			if (!hit) throw new Error("no Import Video menu item");
			hit.click();
			"ok";
		`);
		await sleep(3000);

		// The drop zone ignores a synthetic click, so it is pressed with a real event. It is
		// located by its own label rather than by window geometry: the import window is a
		// different size signed in than signed out.
		const zone = ax(`
			const out = [];
			for (const w of windows()) {
				each(w, 0, el => {
					if (role(el) !== "AXStaticText") return;
					if (!/Drag Files Here/i.test(label(el))) return;
					try {
						const p = el.position(), s = el.size();
						out.push({ x: p[0] + s[0] / 2, y: p[1] - 60 });
					} catch (e) {}
				});
			}
			JSON.stringify(out[0] ?? null);
		`);
		if (!zone) throw new Error("FocuSee: the import drop zone never appeared");
		hidClick(zone.x, zone.y);
		await sleep(3000);

		osa(`tell application "System Events" to tell process "${PROC}"
			set frontmost to true
			delay 0.5
			keystroke "g" using {command down, shift down}
			delay 1.5
			keystroke "${ctx.source.path}"
			delay 1.5
			key code 36
			delay 1.5
			key code 36
		end tell`);
		await sleep(20000);

		const imported = editorSettings();
		const importedText = editorLabels().map(([, l]) => l);
		if (importedText.some((t) => /damaged and cannot be opened/i.test(t)))
			throw new Error("FocuSee refused the source through its import panel as well");
		if (!imported.duration)
			throw new Error(
				`FocuSee opened no clip — the timeline shows no duration. Editor: ${importedText.slice(0, 12).join(" · ")}`,
			);

		const project = newestProject(importedAfter);
		if (!project) throw new Error(`no .focusee project appeared in ${PROJECTS}`);
		ctx.state.projectPath = project;

		// The app owns the file while it is open, so the edit is written to a closed project and
		// the package reopened. FocuSee saves on quit; writing underneath it would be racing that.
		await quitApp(PROC, { force: true });
		await sleep(3000);
		applyScenario(project, ctx, ctx.paddingControl ?? this.defaultPaddingControl(ctx.scenario));
		const wantsCursor = !!ctx.scenario.effects.cursor?.enabled;
		let cursor = null;
		if (wantsCursor) {
			// A downloaded bundle carries a real pointer track and no spec; a generated fixture
			// carries the spec the track is drawn from. The clip's own duration decides how long
			// the generated one runs, so a bundle without a spec still gets the right length.
			const spec = { ...ctx.source.spec, durationSec: sourceDurationSec(ctx) };
			cursor =
				ctx.source.cursorPath && existsSync(ctx.source.cursorPath)
					? convertCursorForFocusee(ctx.source.cursorPath, project)
					: writeFocuseeCursor(project, spec);
		}

		// A .focusee package *is* a document type FocuSee opens, unlike the MP4 above.
		execFileSync("/usr/bin/open", ["-a", APP, project]);
		const t0 = Date.now();
		while (Date.now() - t0 < 90_000 && !appIsRunning(PROC)) await sleep(500);
		await sleep(18000);
		activateApp(PROC);
		const alerts = dismissBlockingAlerts();
		// An account notice outlives the launch that raised it, and it is the difference between
		// "no licence" and "a licence this machine has no slot for" — so it travels with the run.
		const activation = alerts.notice ?? launchAlerts.notice ?? null;
		ctx.state.activationNotice = activation;
		await sleep(800);

		// What the app says it opened, not what was written to it.
		const shown = editorSettings();
		const e = ctx.scenario.effects;
		const applied = ["background", "targetResolution", "targetFps"];
		if (shown.padding != null && shown.padding > 0) applied.push("padding");
		if (shown.roundness != null && shown.roundness > 0) applied.push("cornerRadius");
		if (e.shadow?.enabled && shown.shadow != null && shown.shadow > 0) applied.push("shadow");
		if ((e.zooms ?? []).length && shown.zooms.length) applied.push("zooms");
		if (e.motionBlur?.enabled) applied.push("motionBlur");
		if (wantsCursor && cursor?.moves) applied.push("cursor");

		return {
			appliedFeatures: [...new Set(applied)],
			notes: [
				`project: ${project}`,
				`editor reads back padding ${shown.padding}, roundness ${shown.roundness}, shadow ${shown.shadow}`,
				`${(e.zooms ?? []).length} zoom tracks written; the timeline publishes the ${shown.zooms.length} on screen${shown.zooms.length ? ` (${shown.zooms.join(", ")})` : ""} — the rest sit outside the scrolled view, which is a fact about the accessibility tree, not about the project`,
				cursor
					? `pointer written into the project: ${cursor.moves} moves, ${cursor.clicks} clicks, at FocuSee's default cursor size`
					: "no pointer written",
				"webcam not applied: FocuSee composites a camera only for footage it recorded itself — a webcam recorder added to an imported project leaves its own export line at W:0",
				"background is FocuSee's own catalogue (2000x2000 wallpapers, 4.0 Mpx), as the scenario's tool-default tolerance allows",
				launchAlerts.update || alerts.update
					? `dismissed the update prompt via "${launchAlerts.update ?? alerts.update}"`
					: "no update prompt",
				...(activation ? [`FocuSee raised an account notice on launch: ${activation}`] : []),
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

		const clicked = clickEditorButton("Export");
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
		const wantResolution = new RegExp(
			`^(Original \\(${t.width} \\* ${t.height}\\)|${t.height}P)$`,
			"i",
		);
		const axes = [
			{ name: "format", want: /^MP4$/i, label: "MP4" },
			{ name: "resolution", want: wantResolution, label: `${t.height}P or Original` },
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

		// Read every axis back off the sheet before committing: a click that lands on a renamed
		// control reports success while the export goes somewhere nobody chose.
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
			const b = button(sheetOf(windowNamed("edit")), "Export");
			if (!b) JSON.stringify({ ok: false });
			else { b.click(); JSON.stringify({ ok: true }); }
		`);
		if (!go.ok) throw new Error("FocuSee: the export dialog has no Export button");
		ctx.commit();

		// From here the app is either rendering or refusing, and the difference is in its log
		// before it is anywhere else: `Export vip has exported:` on a licensed install, `free` on
		// one whose single free export is spent. The accessibility tree is asked only once the
		// log has something to confirm — a walk of the editor window takes a second or two of the
		// machine that is meanwhile supposed to be encoding.
		const deadline = Date.now() + 45_000;
		let refusedAt = null;
		let configure = null;
		while (Date.now() < deadline) {
			if (existsSync(out)) break;
			const fresh = logSince(cursor);
			configure =
				[...fresh.matchAll(/Export choose export configer: (.+)/g)].pop()?.[1].trim() ?? configure;
			const tier = [...fresh.matchAll(/Export (vip|free) has exported: (\d+)/g)].pop();
			// A licence: the render is under way and the runner's stopwatch owns the rest.
			if (tier?.[1] === "vip") break;
			if (tier?.[1] === "free") {
				refusedAt ??= Date.now();
				const wall = premiumWall();
				if (wall) {
					ctx.observe("licenceTier", { tier: tier[1], exported: Number(tier[2]) });
					ctx.observe("premiumWall", wall);
					if (configure) ctx.observe("exportConfigure", configure);
					// Leave the app on the editor: the wall is modal, and the next repetition would
					// otherwise click Export into a sheet that answers nothing.
					dismissSheet();
					throw new Error(
						"FocuSee refuses to export without a licence: pressing Export raises the FocuSee Premium " +
							"sheet, whose only action is Buy Now, and nothing is written. The app's own log agrees — " +
							`"Export ${tier[1]} has exported: ${tier[2]}" inside a UserRightsManager block` +
							(configure ? `, against the configuration it read back as "${configure}"` : "") +
							". Every other step of this driver is unattended; activate a licence once during preflight " +
							"and this row measures like any other." +
							// A paid account with no free device slot lands here too, saying `free`, which is
							// how a purchase that is already made gets chased twice.
							(ctx.state?.activationNotice
								? ` Note that a purchase is not the same as a slot: this install answered "${ctx.state.activationNotice}" ` +
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
		// Last word to the screen: if nothing was written and the wall is up anyway — a log that
		// moved, rotated, or said something this driver has not seen — say so plainly rather than
		// returning and letting the runner report a file that never appeared.
		if (!existsSync(out)) {
			const wall = premiumWall();
			if (wall) {
				ctx.observe("premiumWall", wall);
				dismissSheet();
				throw new Error(
					"FocuSee refuses to export without a licence: the FocuSee Premium sheet is up, its only " +
						"action is Buy Now, and nothing was written" +
						(configure ? `, against the configuration it read back as "${configure}"` : "") +
						". Activate a licence once during preflight and every other step of this driver is unattended.",
				);
			}
		}
	},

	async cleanup() {
		if (appIsRunning(PROC)) await quitApp(PROC, { force: true });
	},
};
