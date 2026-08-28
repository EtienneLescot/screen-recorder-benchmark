/**
 * Does which wallpaper get composited move OpenScreen's export time?
 *
 * scenarios/index.mjs records the assumption in prose — "Which image it is barely moves the
 * number" — and asks for exactly this check: after the switch to `tool-default`, OpenScreen's
 * per-leg spread went from ±0.01s to ±0.92s and its median rose 13%. Either the wallpaper is
 * responsible, in which case the tolerance is measuring the backdrop rather than the tool, or
 * something else changed in the same window.
 *
 * Two documents identical but for `editor.wallpaper`. Legs alternate A B A B so machine drift
 * lands on both arms equally rather than on whichever ran second.
 */
import { spawn } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wallpaperDataUri } from "../lib/assets.mjs";

const PROJ = "/Users/m1/openscreen-export-benchmark/projects/openscreen-cli";
const OUT = "/Users/m1/openscreen-export-benchmark/out/ab";
const BIN = "/Applications/Openscreen.app/Contents/MacOS/Openscreen";
const WALL = "/Users/m1/openscreen-export-benchmark/fixture/ide-1080p60-60s.wallpaper.jpg";
const LEGS = Number(process.argv[2] ?? 4);

const base = JSON.parse(readFileSync(join(PROJ, "full-demo.openscreen"), "utf8"));
if (base.editor.wallpaper !== undefined) throw new Error("baseline already carries a wallpaper");

// The supplied arm follows the same route the adapter uses: copied in beside the project so the
// run is auditable, referenced inline because a file:// URL renders black.
copyFileSync(WALL, join(PROJ, "ab.wallpaper.jpg"));
const docs = {
	toolDefault: base,
	supplied: { ...base, editor: { ...base.editor, wallpaper: wallpaperDataUri(WALL) } },
};
for (const [arm, doc] of Object.entries(docs))
	writeFileSync(join(PROJ, `ab-${arm}.openscreen`), JSON.stringify(doc, null, 2));

/** Same clock the driver uses: t0 at `started`, t1 at process close. */
const runLeg = (arm, i) =>
	new Promise((resolve, reject) => {
		const out = join(OUT, `${arm}-${i}.mp4`);
		const child = spawn(
			BIN,
			["export", join(PROJ, `ab-${arm}.openscreen`), "-o", out, "--quality", "good", "--json"],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		let t0 = null;
		let tail = "";
		let buf = "";
		child.stdout.on("data", (d) => {
			buf += d.toString();
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				let ev;
				try {
					ev = JSON.parse(line);
				} catch {
					continue;
				}
				if (t0 === null && (ev.event === "started" || ev.event === "progress"))
					t0 = performance.now();
			}
		});
		child.stderr.on("data", (d) => {
			tail = (tail + d.toString()).slice(-800);
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) return reject(new Error(`${arm} leg ${i} exited ${code}: ${tail.trim()}`));
			resolve((performance.now() - (t0 ?? performance.now())) / 1000);
		});
	});

const med = (a) => {
	const s = [...a].sort((x, y) => x - y);
	const h = s.length >> 1;
	return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};
const results = { toolDefault: [], supplied: [] };
for (let i = 0; i < LEGS; i++) {
	for (const arm of ["toolDefault", "supplied"]) {
		const s = await runLeg(arm, i);
		results[arm].push(s);
		console.log(`leg ${i + 1} ${arm.padEnd(11)} ${s.toFixed(2)}s`);
	}
}
console.log("");
for (const [arm, v] of Object.entries(results)) {
	const m = med(v);
	console.log(
		`${arm.padEnd(11)} median ${m.toFixed(2)}s  spread ±${((Math.max(...v) - Math.min(...v)) / 2).toFixed(2)}s  legs ${v.map((x) => x.toFixed(2)).join(" ")}`,
	);
}
const d = med(results.supplied) - med(results.toolDefault);
console.log(
	`\nsupplied − tool-default: ${d >= 0 ? "+" : ""}${d.toFixed(2)}s (${((d / med(results.toolDefault)) * 100).toFixed(1)}%)`,
);
