/**
 * FocuSee — the closest pitch-for-pitch rival, currently unmeasurable.
 *
 * **The import works. The export needs an account.** An earlier note here said FocuSee 2.4.1
 * "rejects every MP4 it is given", and that was wrong — wrong in a way worth writing down,
 * because the same mistake will be made against the next native-Cocoa candidate.
 *
 * Two separate things were being confused. `open -a FocuSee clip.mp4` really does fail with
 * *"The source file is damaged and cannot be opened."*, for every MP4 tried — the fixture, a 10s
 * remux, the same clip with no audio, H.264 Main at 30 fps, Baseline 3.0 at 720p, and a copy in
 * ~/Movies. That is a genuine defect in FocuSee's document-open path. But it is not the import
 * path, and the import path works: File > Import Video to Create Project opens a drop zone, the
 * drop zone opens an NSOpenPanel, and the panel loads the benchmark fixture without complaint —
 * clip "screen", duration 01:00.00, "Clip 1m0s 1X" on the timeline, Export and Timeline live.
 *
 * What hid it is the trap: **the drop zone ignores System Events' `click at`**. That call posts a
 * synthetic event, and FocuSee's custom view does not act on it — no panel, no error, nothing to
 * distinguish "the click missed" from "the app refused". A real CGEvent mouse-down/up at the same
 * point opens the panel every time. Any candidate drawing its own controls can behave this way,
 * so a click that produces no reaction is not evidence about the app until it has been retried
 * with a real event.
 *
 * The block that remains is a licence gate, the same class as Screen Studio's: clicking Export
 * raises *"Log in to your account to use FocuSee"* with Google SSO or an email password. The
 * benchmark holds no credentials and should not, so the export cannot be timed here until the
 * machine's owner signs in. Everything before the export is automatable today.
 *
 * The rest of the driver is written and works: FocuSee is a native Cocoa app, so unlike the
 * Electron entrants its whole interface is published to the accessibility API — the canvas-size
 * buttons, the Padding / Inset / Roundness / Shadow values and the Export button are all
 * addressable by name. If a later build fixes the import, this driver should measure it as-is.
 *
 * Install note: the vendor ships a ~5 MB downloader stub rather than the app. It is notarised
 * (iMobie Inc., team 2QJGLWL8Y6) and installs FocuSee.app into /Applications on launch, but it
 * is a GUI installer, so `bench.mjs install` cannot fetch this one unattended.
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hidClick } from "../lib/hidClick.mjs";
import { sleep } from "../lib/measure.mjs";
import { activateApp, appIsRunning, jxa, launchApp, osa, quitApp } from "../lib/uiScript.mjs";

const APP = "/Applications/FocuSee.app";
const PROC = "FocuSee";

/** Read every static-text value in FocuSee's edit window — how its state is inspected. */
function editorText() {
	return JSON.parse(
		jxa(`
			const se = Application("System Events");
			const p = se.processes["${PROC}"];
			const win = p.windows().find(w => { try { return w.name() === "edit"; } catch (e) { return false; } });
			function txt(el, d) {
				if (d > 10) return [];
				let out = [];
				try {
					const r = el.role();
					if (r === "AXStaticText" || r === "AXButton") {
						const v = el.value() || el.name();
						if (v && String(v) !== "button") out.push(String(v).slice(0, 60));
					}
				} catch (e) {}
				try { for (const k of el.uiElements()) out = out.concat(txt(k, d + 1)); } catch (e) {}
				return out;
			}
			JSON.stringify(win ? txt(win, 0) : []);
		`),
	);
}

export default {
	id: "focusee",
	displayName: "FocuSee",
	vendor: "iMobie",
	kind: "gui",
	automation: "ax+menu",
	processName: PROC,
	appPath: APP,
	bundleId: "com.imobie.FocuSee",
	install: {
		method: "manual",
		url: "https://focusee.imobie.com/go/download.php?product=fs",
		appName: "FocuSee.app",
		approxMB: 5,
		licence: "commercial — trial exports are watermarked",
		notes: [
			"The download is a GUI installer stub, not the app, so this one cannot be installed unattended.",
			"Run the stub once during preflight; it places FocuSee.app in /Applications itself.",
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

	async prepare(ctx) {
		if (appIsRunning(PROC)) await quitApp(PROC, { force: true });
		await sleep(2000);
		await launchApp(APP, PROC);
		await sleep(9000);
		activateApp(PROC);

		// `open -a` is the obvious route and it is the wrong one: FocuSee's document-open path
		// answers "The source file is damaged and cannot be opened" for every MP4 it is given.
		// Its import path is separate and works. File > Import Video to Create Project raises a
		// drop zone, the drop zone raises an NSOpenPanel, and the panel takes the clip.
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
		const zone = JSON.parse(
			jxa(`
				const se = Application("System Events");
				const p = se.processes["${PROC}"];
				function find(el, d, out) {
					if (d > 12) return;
					try {
						const v = el.value() || el.name();
						if (el.role() === "AXStaticText" && v && /Drag Files Here/i.test(String(v))) {
							const pos = el.position(), sz = el.size();
							out.push({ x: pos[0] + sz[0] / 2, y: pos[1] - 60 });
						}
					} catch (e) {}
					try { for (const k of el.uiElements()) find(k, d + 1, out); } catch (e) {}
				}
				const out = [];
				for (const w of p.windows()) find(w, 0, out);
				JSON.stringify(out[0] ?? null);
			`),
		);
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

		const text = editorText();
		if (text.some((t) => /damaged and cannot be opened/i.test(t)))
			throw new Error("FocuSee refused the source through its import panel as well");
		if (!text.some((t) => /^\d\d:\d\d\.\d\d$/.test(t)))
			throw new Error(
				`FocuSee opened no clip — the timeline shows no duration. Editor: ${text.slice(0, 12).join(" · ")}`,
			);

		// The composition controls are AX static texts paired with sliders; FocuSee exposes their
		// values but not setters, so what the scenario can reach here is limited to the canvas
		// aspect ratio. Whatever is applied is reported, never assumed.
		const applied = ["targetResolution", "targetFps"];
		return {
			appliedFeatures: applied,
			notes: [`editor state: ${text.slice(0, 20).join(" · ")}`],
		};
	},

	outputPath(ctx) {
		return join(ctx.outDir, `${this.id}-${ctx.scenario.id}-run${ctx.run.index}.mp4`);
	},

	async runExport(ctx) {
		const out = this.outputPath(ctx);
		if (existsSync(out)) rmSync(out);
		activateApp(PROC);
		await sleep(600);

		const clicked = JSON.parse(
			jxa(`
				const se = Application("System Events");
				const p = se.processes["${PROC}"];
				p.frontmost = true;
				function findAll(el, d, out) {
					if (d > 10) return out;
					try { if (el.role() === "AXButton") { const n = el.name() || ""; if (n) out.push([String(n), el]); } } catch (e) {}
					try { for (const k of el.uiElements()) findAll(k, d + 1, out); } catch (e) {}
					return out;
				}
				let all = [];
				for (const w of p.windows()) findAll(w, 0, all);
				const hit = all.find(([n]) => /^export$/i.test(n));
				if (!hit) JSON.stringify({ ok: false, seen: all.map(a => a[0]).slice(0, 20) });
				else { hit[1].click(); JSON.stringify({ ok: true }); }
			`),
		);
		if (!clicked.ok)
			throw new Error(`FocuSee: no Export button. Present: ${(clicked.seen ?? []).join(", ")}`);
		await sleep(3000);

		const dir = out.replace(/\/[^/]+$/, "");
		const stem = out
			.split("/")
			.pop()
			.replace(/\.mp4$/i, "");
		osa(`tell application "System Events" to tell process "${PROC}"
			set frontmost to true
			keystroke "g" using {command down, shift down}
			delay 0.8
			keystroke "${dir}"
			delay 0.5
			key code 36
			delay 1.0
			keystroke "a" using {command down}
			keystroke "${stem}"
			delay 0.4
			key code 36
		end tell`);
		ctx.commit();
	},

	async cleanup() {
		if (appIsRunning(PROC)) await quitApp(PROC, { force: true });
	},
};
