import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TARGET_OUTPUT } from "../scenarios/index.mjs";
import {
	aggregate,
	buildKey,
	compareBuilds,
	newestBuilds,
	normaliseVersion,
	submissionWeight,
} from "./aggregate.mjs";
import { sameMachine } from "./calibrate.mjs";
import { isThirdPartyRemoteHost } from "./platform.mjs";
import { renderBuilds, renderSite } from "./site.mjs";

/** One machine, two tools, a known ratio. */
function submission(costs, { at = "2026-01-01T00:00:00.000Z" } = {}) {
	return {
		submittedAt: at,
		conditions: { driftRatio: 1 },
		scenario: { step: "S4" },
		// Only public-bundle footage contributes an edge, so the fixture has to carry a source
		// like a real submission does.
		source: { kind: "public-bundle", bundle: "commons-upload" },
		measurements: Object.entries(costs).map(([tool, cost]) => ({
			tool,
			version: "1.0.0",
			step: "S4",
			verified: true,
			exportMs: cost * 10_000,
			localFloorMs: 10_000,
		})),
	};
}

describe("aggregate", () => {
	it("is byte-stable across runs", () => {
		// The published docs/ is diffed against a fresh build in CI. Anything that reaches
		// the output from the clock, the filesystem order or an unrounded float turns that
		// check into a daily false alarm.
		const subs = [submission({ a: 1.2, b: 1.5 }), submission({ a: 1.1, b: 1.4 })];
		const once = JSON.stringify(aggregate(subs, { step: "S4" }));
		const twice = JSON.stringify(aggregate(subs, { step: "S4" }));
		expect(twice).toBe(once);
	});

	it("publishes no float carrying more precision than the measurement has", () => {
		// Math.log and Math.exp are explicitly allowed to differ between platforms. A raw
		// one in the output makes macOS and Linux disagree on a file they both regenerate.
		const json = JSON.stringify(aggregate([submission({ a: 1.2, b: 1.5 })], { step: "S4" }));
		expect(json).not.toMatch(/\d\.\d{10,}/);
	});

	it("treats one machine spelled two ways as one machine", () => {
		// WMI pads Win32_Processor.Name to a fixed width, so this laptop reported its chip padded
		// under Windows and trimmed under Linux. Every node then listed one more machine than had
		// measured it — and the site decides its "1 machine — no independent confirmation" tag on
		// that count, so the inflation reads as corroboration that does not exist.
		const chip = "AMD Ryzen 5 7520U with Radeon Graphics";
		const subs = [
			{
				...submission({ a: 1.2, b: 1.5 }),
				machine: { chip: `${chip}         `, platform: "win32" },
			},
			{ ...submission({ a: 1.1, b: 1.4 }), machine: { chip, platform: "linux" } },
		];
		for (const t of aggregate(subs, { step: "S4" }).tools)
			expect(t.machines, `${t.node} rests on one machine, whatever it is called`).toEqual([chip]);
	});

	it("still recognises a machine whose stamp was written before the name was trimmed", () => {
		// calibration.json stores the chip it was solved on. This laptop's stamp was written while
		// the probe still recorded WMI's padding, so once the probe started trimming, a byte
		// comparison called it a different machine — `run` warned that a perfectly good padding
		// solve was stale, and `saveCalibration` would have dropped every other app's entry as
		// belonging to other hardware. Trimming the probe is not enough: stamps already on disk
		// cannot be re-probed.
		const stamped = {
			chip: "AMD Ryzen 5 7520U with Radeon Graphics         ",
			osVersion: "10.0.26200",
		};
		const here = { chip: "AMD Ryzen 5 7520U with Radeon Graphics", osVersion: "10.0.26200" };
		expect(sameMachine(stamped, here)).toBe(true);
		// And it still has to say no when it is genuinely a different machine.
		expect(sameMachine(stamped, { ...here, chip: "Apple M1" })).toBe(false);
		expect(sameMachine(stamped, { ...here, osVersion: "10.0.22631" })).toBe(false);
	});

	it("recovers a ratio the machines never measured together", () => {
		// a vs b on one machine, b vs c on another, and no machine sees a and c. The graph
		// has to close the gap, or a roster that fractures by platform tells us nothing.
		const result = aggregate([submission({ a: 1.0, b: 2.0 }), submission({ b: 4.0, c: 8.0 })], {
			step: "S4",
		});
		const cost = Object.fromEntries(result.tools.map((t) => [t.tool, t.relativeCost]));
		expect(cost.c / cost.a).toBeCloseTo(4, 1);
	});

	it("publishes nothing that identifies the machine that built it", () => {
		// The aggregate is served from a public page and rebuilt by anyone who runs the
		// benchmark. A submitter's home directory reaching it is both a leak and the reason
		// two machines produce different bytes from the same data.
		const published = readFileSync(new URL("../docs/aggregate.json", import.meta.url), "utf8");
		expect(published).not.toMatch(/\/(Users|home)\/[^"/]+/);
		expect(published).not.toMatch(/[A-Z]:\\\\Users/);
	});

	it("names no winner in prose, however clear the numbers are", () => {
		// The page publishes figures and a chart; the reader draws the conclusion. A sentence
		// naming a leader collapses four figures, their error, their machine coverage and the
		// spread between machines into the one thing a reader carries away — and it is the one
		// claim this benchmark is least placed to make, being published by the author of an
		// entrant. Deriving the sentence more carefully is not the fix: a derived verdict is
		// still a verdict, and the next inversion in the data makes it wrong in a new way.
		const html = renderSite(aggregate([submission({ a: 1.05, b: 9.0 })], { step: "S4" }), {
			submissions: [],
			generatedAt: "2026-01-01",
			roster: [],
		});
		expect(html).not.toMatch(/exports fastest (across|on)/);
		expect(html).not.toMatch(/class="lead-line"/);
		// The figures themselves are of course still there.
		expect(html).toMatch(/rank-row/);
	});

	it("claims no agreement when nothing was cross-checked", () => {
		// One edge fits perfectly because nothing contradicts it. Reporting that 0% residual
		// as "the machines agree" advertises a cross-check that never happened.
		const result = aggregate([submission({ a: 1.2, b: 1.5 })], { step: "S4" });
		expect(result.consistency.measurable).toBe(false);

		const html = renderSite(result, { submissions: [], generatedAt: "2026-01-01", roster: [] });
		expect(html).not.toMatch(/disagree by/);
		expect(html).toMatch(/Cross-check: none/);
	});

	it("conforms every bundle source to the rate the apps must output", () => {
		// Commons footage is 25 fps; the target is 60 because OpenScreen's MP4 path is fixed
		// there. If the bundle shipped at 25, each app would convert the rate itself during the
		// very interval being timed, and duplicating frames against interpolating motion is not
		// the same work. The conversion belongs in preparation, where it is done once.
		const sources = JSON.parse(readFileSync(new URL("../sources.json", import.meta.url), "utf8"));
		const prep = readFileSync(new URL("./publicSource.mjs", import.meta.url), "utf8");
		expect(prep).toMatch(/args\.push\("-r", String\(fps\)\)/);
		for (const [name, b] of Object.entries(sources.bundles)) {
			expect(b.conformedFps, `${name} declares no conformed rate`).toBe(TARGET_OUTPUT.fps);
		}
	});

	it("sources every bundle at the rate the apps must output", () => {
		// A 25 fps source against a 60 fps target leaves each app converting the rate inside
		// the interval being timed, and duplicating frames is not the same work as
		// interpolating motion. Conforming in preparation makes the input equal; sourcing at
		// 60 natively means the conform has nothing to repeat.
		const sources = JSON.parse(readFileSync(new URL("../sources.json", import.meta.url), "utf8"));
		for (const [name, b] of Object.entries(sources.bundles)) {
			expect(b.conformedFps, `${name} declares no conformed rate`).toBe(TARGET_OUTPUT.fps);
			for (const track of ["screen", "webcam"]) {
				if (!b[track]) continue;
				expect(b[track].fpsNative, `${name}.${track} is not sourced at the target rate`).toBe(
					TARGET_OUTPUT.fps,
				);
				// The LGPL ffmpeg decodes no AV1 in software — an AV1 source yields zero frames.
				expect(b[track].codec, `${name}.${track} is AV1`).not.toBe("av1");
			}
		}
	});

	it("conforms the source rate in preparation, not during the measured export", () => {
		const prep = readFileSync(new URL("./publicSource.mjs", import.meta.url), "utf8");
		expect(prep).toMatch(/args\.push\("-r", String\(fps\)\)/);
	});

	it("credits every track the manifest names", () => {
		// The footage carries attribution requirements; the credits file is generated so it
		// cannot quietly fall behind the manifest.
		const sources = JSON.parse(readFileSync(new URL("../sources.json", import.meta.url), "utf8"));
		const credits = readFileSync(new URL("../CREDITS.md", import.meta.url), "utf8");
		for (const b of Object.values(sources.bundles)) {
			for (const track of ["screen", "webcam"]) {
				if (!b[track]) continue;
				expect(credits).toContain(b[track].licence);
				expect(credits).toContain(b[track].attribution);
			}
		}
	});

	it("uses only cell values the roster legend defines", () => {
		// The legend is what stops a meaningful cell being mistaken for a typo. "surplus" — ships
		// here but sits outside a full table — once lived in this file as "6th" and was deleted as
		// a stray value, which silently turned a positioning decision into a claim that the product
		// did not exist on the platform.
		const roster = JSON.parse(readFileSync(new URL("../roster.json", import.meta.url), "utf8"));
		const allowed = new Set(Object.keys(roster._legend).filter((k) => k !== "sources"));
		for (const t of roster.tools) {
			for (const key of ["macos", "windows", "linux"]) {
				expect(allowed, `${t.tool}.${key} = "${t[key]}" is not in the legend`).toContain(t[key]);
			}
			for (const key of Object.keys(t.sources ?? {})) {
				expect(["macos", "windows", "linux"]).toContain(key);
				expect(t[key], `${t.tool}.${key} is ✓, so it needs no citation`).not.toBe("✓");
			}
			// A free-prose column describing each competitor cannot be written neutrally by a
			// maintainer of one of them, however carefully it is worded. Citations only.
			expect(t.note, `${t.tool} carries a prose note; the roster takes citations only`).toBe(
				undefined,
			);
		}
	});

	it("keeps every roster tool nameable by an adapter", () => {
		// apps.mjs entries point at the roster by name; a rename on one side must not silently
		// orphan the other, because the status table is built from that join.
		const roster = JSON.parse(readFileSync(new URL("../roster.json", import.meta.url), "utf8"));
		const names = new Set(roster.tools.map((t) => t.tool));
		const apps = readFileSync(new URL("../apps.mjs", import.meta.url), "utf8");
		for (const [, name] of apps.matchAll(/roster:\s*"([^"]+)"/g)) {
			expect(names, `apps.mjs names "${name}", which is not in roster.json`).toContain(name);
		}
	});
});

describe("version reporting", () => {
	it("treats one build spelled two ways as one build", () => {
		// Windows pads to four parts, macOS does not: the same Recordly 1.3.3 arrived as "1.3.3.0"
		// from one machine and "1.3.3" from the other, and the page warned about mixed versions
		// over a difference that did not exist.
		expect(normaliseVersion("1.3.3.0")).toBe("1.3.3");
		expect(normaliseVersion("1.3.3")).toBe("1.3.3");
		expect(normaliseVersion("1.10.0.0")).toBe("1.10.0");
	});

	it("does not count absence as a build", () => {
		// A failed lookup recorded the literal string "unknown", which then appeared on the page
		// as one of the builds a figure rested on.
		for (const v of [null, undefined, "", "  ", "unknown", "Unknown", "n/a"])
			expect(normaliseVersion(v), `${JSON.stringify(v)} is absence, not a build`).toBe(null);
	});

	it("leaves a genuine four-part version alone", () => {
		expect(normaliseVersion("1.3.3.4")).toBe("1.3.3.4");
	});
});

describe("a version is a competitor, not a label", () => {
	/** The shared fixture, with the version of one tool under test. */
	const versioned = (costs, version) => {
		const sub = submission(costs);
		for (const m of sub.measurements) if (m.tool === "recordly") m.version = version;
		return sub;
	};

	it("folds iterations of one prerelease, and nothing else", () => {
		// A leaderboard with four rc rows for one release is noise, and an rc series reads as one
		// thing outside the vendor. Two *releases* are never folded — that is the whole design.
		expect(buildKey("1.11.0-rc.1")).toBe("1.11.0-rc");
		expect(buildKey("1.11.0-rc.4")).toBe("1.11.0-rc");
		expect(buildKey("1.11.0-RC1")).toBe("1.11.0-rc");
		expect(buildKey("1.11.0-beta.2")).toBe("1.11.0-beta");
		expect(buildKey("1.11.0")).toBe("1.11.0");
		expect(buildKey("1.10.0")).not.toBe(buildKey("1.11.0"));
		// Windows' fourth zero is still one build, not a second one.
		expect(buildKey("1.3.3.0")).toBe("1.3.3");
	});

	it("orders a release above the candidates for it", () => {
		expect(compareBuilds("1.11.0", "1.10.0")).toBeGreaterThan(0);
		expect(compareBuilds("1.11.0", "1.11.0-rc")).toBeGreaterThan(0);
		expect(compareBuilds("1.11.0-rc", "1.10.0")).toBeGreaterThan(0);
		expect(compareBuilds("1.11.0-beta", "1.11.0-rc")).toBeLessThan(0);
	});

	/**
	 * The regression this whole design exists to prevent. A release that got three times faster
	 * is the thing being reported; averaging it with the release it replaced erases exactly that,
	 * and a vendor who ships a faster build would be right to call the number meaningless.
	 */
	it("ranks two builds of one tool separately instead of averaging them", () => {
		const r = aggregate(
			[
				submission({ openscreen: 4.0, cap: 3.0 }),
				(() => {
					const s = submission({ openscreen: 1.1, cap: 3.0 });
					for (const m of s.measurements) if (m.tool === "openscreen") m.version = "1.11.0-rc.1";
					return s;
				})(),
			],
			{ step: "S4" },
		);
		const cost = Object.fromEntries(r.tools.map((t) => [t.node, t.relativeCost]));
		expect(Object.keys(cost).sort()).toEqual([
			"cap@1.0.0",
			"openscreen@1.0.0",
			"openscreen@1.11.0-rc",
		]);
		// The old build keeps its own figure, and the new one keeps the improvement whole.
		expect(cost["openscreen@1.0.0"] / cost["openscreen@1.11.0-rc"]).toBeCloseTo(4 / 1.1, 1);
	});

	it("shows the newest build of each tool, and keeps the rest in the graph", () => {
		const tools = [
			{ tool: "openscreen", build: "1.10.0" },
			{ tool: "openscreen", build: "1.11.0-rc" },
			{ tool: "cap", build: "0.5.9" },
		];
		expect(
			newestBuilds(tools)
				.map((t) => t.build)
				.sort(),
		).toEqual(["0.5.9", "1.11.0-rc"]);
	});

	it("names a prerelease line that rests on more than one candidate", () => {
		// The one fold the design keeps, and therefore the one place a node can still average two
		// builds. It is disclosed rather than hidden: two candidates for a release can differ as
		// much as two releases do.
		const r = aggregate(
			[
				versioned({ recordly: 2.4, cap: 1.3 }, "1.3.4-rc.1"),
				versioned({ recordly: 2.1, cap: 1.2 }, "1.3.4-rc.2"),
			],
			{ step: "S4" },
		);
		expect(r.tools.filter((t) => t.tool === "recordly")).toHaveLength(1);
		expect(r.buildSpread).toHaveLength(1);
		expect(r.buildSpread[0].versions).toEqual(["1.3.4-rc.1", "1.3.4-rc.2"]);
		expect(r.tools.find((t) => t.tool === "recordly").prerelease).toBe(true);
	});

	it("stays quiet when every submission reported the same build, spelled either way", () => {
		const r = aggregate(
			[
				versioned({ recordly: 2.4, cap: 1.3 }, "1.3.3"),
				versioned({ recordly: 2.1, cap: 1.2 }, "1.3.3.0"),
			],
			{ step: "S4" },
		);
		expect(r.buildSpread).toEqual([]);
		expect(r.tools.filter((t) => t.tool === "recordly")).toHaveLength(1);
	});

	it("excludes a measurement that records no build, rather than folding it into one", () => {
		// The node *is* the build, so a measurement with no version has nowhere to go. It used to
		// be folded into the tool under a caveat that a figure might rest on two builds without
		// saying which — which no reader could act on.
		const r = aggregate(
			[
				versioned({ recordly: 2.4, cap: 1.3 }, "1.3.3"),
				versioned({ recordly: 2.1, cap: 1.2 }, "unknown"),
			],
			{ step: "S4" },
		);
		expect(r.unplaceable.map((u) => u.tool)).toEqual(["recordly"]);
		expect(r.tools.map((t) => t.node).sort()).toEqual(["cap@1.0.0", "recordly@1.3.3"]);
	});

	/**
	 * The two pages answer two questions and must not answer each other's. The ranking is "what
	 * should I install", so it carries one row per tool; the builds page is "what has been
	 * measured", so a superseded build has to survive somewhere the reader can reach.
	 */
	it("ranks the newest build on the front page and every build on the builds page", () => {
		const older = submission({ openscreen: 4.0, cap: 3.0 });
		const newer = submission({ openscreen: 1.1, cap: 3.0 });
		for (const m of newer.measurements) if (m.tool === "openscreen") m.version = "1.11.0";
		const r = aggregate([older, newer], { step: "S4" });

		const front = renderSite(r, { submissions: [], generatedAt: "2026-01-01", roster: [] });
		expect(front).toContain('data-node="openscreen@1.11.0"');
		expect(front).not.toMatch(/class="rank-row" data-node="openscreen@1\.0\.0"/);
		// Superseded, not deleted: the front page says so and points at the other page.
		expect(front).toContain("builds.html");
		// The ranking compares a tool to its competitors and to nothing else. A row that also
		// carried its own previous build would be answering two questions in one place.
		expect(front).not.toMatch(/% (faster|slower)/);

		const builds = renderBuilds(r, { generatedAt: "2026-01-01" });
		for (const node of ["openscreen@1.0.0", "openscreen@1.11.0", "cap@1.0.0"]) {
			expect(builds, `${node} is missing from the builds page`).toContain(`data-node="${node}"`);
		}
	});

	it("drops a submission left with fewer than two placeable builds", () => {
		const sub = submission({ recordly: 2.4, cap: 1.3 });
		for (const m of sub.measurements) m.version = "unknown";
		const r = aggregate([sub], { step: "S4" });
		expect(r.tools).toEqual([]);
		expect(r.skipped[0].why).toMatch(/which build/);
	});
});

describe("remote-desktop host matching", () => {
	it("does not mistake Apple's own parsecd for the streaming host", () => {
		// /System/Library/PrivateFrameworks/CoreParsec.framework/parsecd is the Siri and Spotlight
		// suggestions daemon and runs on every Mac. Matched by basename, it made `hosts` non-empty
		// everywhere, which sent the check to an NVENC query no Apple GPU can answer — so
		// `remoteDesktopActive` came back null on every macOS submission, always, whatever was
		// installed. That is not a tri-state, it is a dead field.
		expect(
			isThirdPartyRemoteHost("/System/Library/PrivateFrameworks/CoreParsec.framework/parsecd"),
		).toBe(false);
		expect(isThirdPartyRemoteHost("/Applications/Parsec.app/Contents/MacOS/parsecd")).toBe(true);
	});

	it("still counts the remote-management daemons Apple ships", () => {
		// These live under /System too, and unlike CoreParsec they really do stream this screen.
		for (const p of [
			"/System/Library/CoreServices/RemoteManagement/screensharingd.bundle/Contents/MacOS/screensharingd",
			"/System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/MacOS/ARDAgent",
		])
			expect(isThirdPartyRemoteHost(p), p).toBe(true);
	});
});

/** One machine with a named GPU, so the consistency tiers can be told apart. */
function onMachine(costs, { platform, chip, gpu, at = "2026-01-01T00:00:00.000Z" }) {
	return {
		submittedAt: at,
		conditions: { driftRatio: 1 },
		scenario: { step: "S4" },
		source: { kind: "public-bundle", bundle: "commons-upload" },
		machine: { platform, chip, gpu },
		measurements: Object.entries(costs).map(([tool, cost]) => ({
			tool,
			version: "1.0.0",
			step: "S4",
			verified: true,
			exportMs: cost * 10_000,
			localFloorMs: 10_000,
		})),
	};
}

describe("consistency separates a repeat from a change of hardware", () => {
	const win = { platform: "win32", chip: "Ryzen 7 5800X", gpu: "NVIDIA GeForce RTX 4070 Ti" };
	const igpu = { platform: "win32", chip: "Ryzen 5 7520U", gpu: "AMD Radeon(TM) Graphics" };

	it("reads two runs of one machine as the repeatability figure", () => {
		const r = aggregate(
			[
				onMachine({ a: 1.2, b: 2.4 }, win),
				onMachine({ a: 1.2, b: 2.5 }, { ...win, at: "2026-01-02T00:00:00.000Z" }),
			],
			{ step: "S4" },
		);
		expect(r.consistency.byPlatform.sameGpuPairs).toBe(1);
		expect(r.consistency.byPlatform.sameGpuSpreadPercent).toBeGreaterThan(0);
	});

	/**
	 * The regression this tier exists for. Two Windows machines with different GPUs are not a
	 * repeated measurement: the floor divides out the encoder block while the compositing under
	 * test is shader-bound, so the cost moves for a hardware reason. Counting that as
	 * same-platform disagreement reports a fact about the GPUs as a fault in the harness.
	 */
	it("does not count two different GPUs as a repeat", () => {
		const r = aggregate([onMachine({ a: 1.2, b: 2.4 }, win), onMachine({ a: 1.2, b: 8.0 }, igpu)], {
			step: "S4",
		});
		expect(r.consistency.byPlatform.sameGpuPairs).toBe(0);
		expect(r.consistency.byPlatform.samePlatformPairs).toBe(1);
		expect(r.consistency.byPlatform.samePlatformSpreadPercent).toBeGreaterThan(50);
	});

	it("keeps a same-GPU repeat tighter than the same-platform spread around it", () => {
		const r = aggregate(
			[
				onMachine({ a: 1.2, b: 2.4 }, win),
				onMachine({ a: 1.2, b: 2.5 }, { ...win, at: "2026-01-02T00:00:00.000Z" }),
				onMachine({ a: 1.2, b: 8.0 }, igpu),
			],
			{ step: "S4" },
		);
		const bp = r.consistency.byPlatform;
		expect(bp.sameGpuPairs).toBe(1);
		expect(bp.sameGpuSpreadPercent).toBeLessThan(bp.samePlatformSpreadPercent);
	});
});

/**
 * The weighting used to charge a submission for drift between legs, which the per-repetition
 * paired floors already remove. Of the five submissions published before this changed, the two
 * desktops and the Apple part weighted x1 and the only thermally-limited laptop weighted x0.6
 * and x0.25 — drift the sole reason in every case, on a benchmark whose whole claim is that a
 * cost in units of the floor travels between machines.
 *
 * Noise is now weighted by how much of it there is; bias stays categorical.
 */
describe("submissionWeight separates noise from bias", () => {
	const sub = (conditions, measurements = []) => ({
		submittedAt: "2026-01-01T00:00:00.000Z",
		conditions: { onACPower: true, remoteDesktopActive: false, ...conditions },
		measurements,
	});
	/** One tool, 0.3% export scatter, and whatever floor spread is being asked about. */
	const withFloorSpread = (floorSpreadPercent) => [
		{ exportMs: 100_000, madMs: 300, floorSpreadPercent },
	];

	it("ignores run-wide drift when the per-leg floors held", () => {
		// The run that prompted this: 19.9% drift across the run, 0.28-4.26% within each leg, and a
		// software floor that moved 0.8% over the same ninety minutes.
		const w = submissionWeight(
			sub({ driftRatio: 1.1987 }, [
				{ exportMs: 77_163, madMs: 220, floorSpreadPercent: 1.8 },
				{ exportMs: 57_339, madMs: 160, floorSpreadPercent: 0.28 },
				{ exportMs: 321_826, madMs: 1100, floorSpreadPercent: 4.26 },
			]),
		);
		expect(w.weight).toBe(1);
		expect(w.reasons).toEqual([]);
	});

	it("discounts a noisy denominator in proportion, not in steps", () => {
		const at = (fs) => submissionWeight(sub({}, withFloorSpread(fs))).weight;
		expect(at(2)).toBe(1); // ordinary scatter costs nothing
		expect(at(6)).toBeLessThan(at(4)); // and it is monotonic, not a cliff
		expect(at(20)).toBeLessThan(at(10));
		expect(at(20)).toBeGreaterThan(0);
	});

	/** Both terms are reported in different statistics and must reach σ before being combined. */
	it("counts export scatter as well as floor scatter", () => {
		const quiet = submissionWeight(
			sub({}, [{ exportMs: 100_000, madMs: 0, floorSpreadPercent: 6 }]),
		);
		const noisy = submissionWeight(
			sub({}, [{ exportMs: 100_000, madMs: 6000, floorSpreadPercent: 6 }]),
		);
		expect(noisy.weight).toBeLessThan(quiet.weight);
	});

	/**
	 * Nothing published before the paired floor carries either term, and those runs really were
	 * divided by a floor that did not age with the numerator — so drift is the only evidence
	 * there is, rather than a double count.
	 */
	it("falls back to drift for a submission from before paired floors", () => {
		const old = submissionWeight(sub({ driftRatio: 1.097 }));
		expect(old.weight).toBe(0.25);
		expect(old.reasons[0]).toMatch(/drift/);
	});

	/** Bias: no number of repetitions removes these, so they stay categorical. */
	it("keeps the penalties for conditions nothing corrects", () => {
		expect(submissionWeight(sub({ remoteDesktopActive: true })).weight).toBe(0.3);
		expect(submissionWeight(sub({ onACPower: false })).weight).toBe(0.5);
		expect(submissionWeight(sub({ loadSpreadPercentagePoints: 70 })).weight).toBe(0.5);
	});
});

/**
 * A cost is an export divided by a floor, and which floor decides what the number means. The
 * hardware floor is a fixed-function encode; the tools composite on the shader array and hand
 * the encoder a fraction of the work, so the denominator can move while the numerator does not.
 * Measured on one machine, two runs an hour apart: hardware-floor costs moved 19-27 % while
 * software-floor costs moved 1-4 % and the exports themselves agreed to 0.4 %.
 */
describe("aggregate can be solved against either floor", () => {
	const sub = (costs) => ({
		submittedAt: "2026-01-01T00:00:00.000Z",
		scenario: { step: "S4" },
		source: { kind: "public-bundle" },
		machine: { platform: "linux", chip: "test", gpu: "test" },
		conditions: { onACPower: true, remoteDesktopActive: false },
		measurements: Object.entries(costs).map(([tool, [hw, sw]]) => ({
			tool,
			version: "1",
			verified: true,
			exportMs: 100_000,
			localFloorMs: 100_000 / hw,
			softwareFloorMs: sw == null ? null : 100_000 / sw,
		})),
	});

	it("uses the hardware floor by default and the software floor on request", () => {
		const subs = [sub({ a: [2, 4], b: [4, 6] })];
		const hw = aggregate(subs, { step: "S4" });
		const sw = aggregate(subs, { step: "S4", basis: "software" });
		// Only ratios survive the solve, so compare those rather than absolute levels.
		const ratio = (r) => {
			const by = Object.fromEntries(r.tools.map((t) => [t.tool, t.relativeCost]));
			return by.b / by.a;
		};
		expect(ratio(hw)).toBeCloseTo(2, 3); // 4/2
		expect(ratio(sw)).toBeCloseTo(1.5, 3); // 6/4
	});

	/** Everything published before the paired floor landed carries no software floor at all. */
	it("skips a submission that cannot report the requested floor, rather than inventing one", () => {
		const subs = [sub({ a: [2, null], b: [4, null] })];
		expect(aggregate(subs, { step: "S4" }).tools).toHaveLength(2);
		const sw = aggregate(subs, { step: "S4", basis: "software" });
		expect(sw.tools).toHaveLength(0);
		expect(sw.skipped[0].why).toMatch(/software floor/);
	});
});

/**
 * What the ranking is allowed to imply.
 *
 * Two failures shipped together on the published page and are the reason these exist. A scope
 * cut to one machine came apart into two disconnected groups and still numbered them 01 to 04
 * in a single list, so a tool at 3.04× sat above one at 1.15× and read as a sorting bug. And a
 * build measured on one machine showed a page-wide figure of 1.22× while every run of it
 * measured between 1.145× and 1.157×, with nothing on the row saying the number was a placement
 * rather than a measurement — which is exactly the reading a reader will make of it.
 */
describe("the ranking says what its figures are", () => {
	it("numbers each disconnected group from 01 and marks the break", () => {
		// Two pairs, no tool in common: a and b were measured together, c and d were measured
		// together, and nothing joins the pairs. The cheap pair solves below the dear one, so a
		// single list would put the dear pair's leader at 01 above a cheaper row further down.
		const r = aggregate([submission({ a: 4.0, b: 5.0 }), submission({ c: 1.1, d: 1.3 })], {
			step: "S4",
		});
		expect(r.components).toHaveLength(2);

		const html = renderSite(r, { submissions: [], generatedAt: "2026-01-01", roster: [] });
		expect(html).toMatch(/class="rank-split"/);
		// Each group starts again at 01, so no row claims to outrank one it never met.
		expect(html.match(/class="rank-no">01</g)).toHaveLength(2);
	});

	it("marks a figure the graph placed outside everything measured for it", () => {
		// `lonely` is held into the graph only by `bridge`, and `bridge` is dear on a second
		// machine that `lonely` never ran on. The solve keeps their ratio and lifts the level,
		// so `lonely` lands above its own runs.
		const fast = { platform: "win32", chip: "Ryzen 7 5800X", gpu: "NVIDIA GeForce RTX 4070 Ti" };
		const slow = { platform: "linux", chip: "Ryzen 5 7520U", gpu: "AMD Radeon(TM) Graphics" };
		const r = aggregate(
			[
				onMachine({ lonely: 1.15, bridge: 1.25 }, fast),
				onMachine({ bridge: 4.0, other: 6.0 }, { ...slow, at: "2026-01-02T00:00:00.000Z" }),
			],
			{ step: "S4" },
		);
		const lonely = r.tools.find((t) => t.tool === "lonely");
		expect(lonely.observedCostRange).toEqual([1.15, 1.15]);
		expect(lonely.relativeCost).toBeGreaterThan(1.15 * 1.01);

		const html = renderSite(r, { submissions: [], generatedAt: "2026-01-01", roster: [] });
		expect(html).toMatch(/above its run</);
		expect(html).toContain("1.15× in its only run");
	});

	it("leaves a figure that sits inside its own runs unmarked", () => {
		// The mark is a warning, not decoration. One machine, two tools: each solves onto its
		// own measurements and neither row may claim to be anything else.
		const r = aggregate([submission({ a: 1.2, b: 2.4 })], { step: "S4" });
		const html = renderSite(r, { submissions: [], generatedAt: "2026-01-01", roster: [] });
		expect(html).not.toMatch(/its (run|runs)</);
		expect(html).not.toMatch(/class="rank-split"/);
	});
});

/**
 * One product, one competitor, whatever the harness that measured it called the leg.
 *
 * The registry used to key OpenScreen by how it was driven, and the id reached the submissions
 * and the page. A run arriving from an older harness still carries the old spelling, and it has
 * to join the node it belongs to rather than stand up as a rival of the same product.
 */
describe("the driving mode is not part of a competitor's name", () => {
	it("lands an old submission on the same node as a new one", () => {
		const old = submission({ "openscreen-cli": 1.2, cap: 2.4 });
		const now = submission({ openscreen: 1.2, cap: 2.4 });
		const r = aggregate([old, now], { step: "S4" });
		expect(r.tools.map((t) => t.tool).sort()).toEqual(["cap", "openscreen"]);
		// Both legs counted, rather than one of them silently becoming a second product.
		expect(r.tools.find((t) => t.tool === "openscreen").submissions).toBe(2);
	});

	it("keeps a mode that moves the clock apart", () => {
		// Recordly's CUDA switch is a different export path, not a different way of pressing the
		// same button, so it stays its own row. Folding every suffix would erase that.
		const r = aggregate([submission({ recordly: 3.4, "recordly-cuda": 1.8 })], { step: "S4" });
		expect(r.tools.map((t) => t.tool).sort()).toEqual(["recordly", "recordly-cuda"]);
	});
});
