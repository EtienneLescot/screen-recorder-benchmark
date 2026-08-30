import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TARGET_OUTPUT } from "../scenarios/index.mjs";
import { aggregate, normaliseVersion, submissionWeight } from "./aggregate.mjs";
import { isThirdPartyRemoteHost } from "./platform.mjs";
import { renderSite } from "./site.mjs";

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

	it("claims no agreement when nothing was cross-checked", () => {
		// One edge fits perfectly because nothing contradicts it. Reporting that 0% residual
		// as "the machines agree" advertises a cross-check that never happened.
		const result = aggregate([submission({ a: 1.2, b: 1.5 })], { step: "S4" });
		expect(result.consistency.measurable).toBe(false);

		const html = renderSite(result, { submissions: [], generatedAt: "2026-01-01", roster: [] });
		expect(html).not.toMatch(/disagree by/);
		expect(html).toMatch(/Not cross-checked yet/);
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

describe("an unreported version is a gap, not a build", () => {
	/** The shared fixture, with the version of one tool under test. */
	const versioned = (costs, version) => {
		const sub = submission(costs);
		for (const m of sub.measurements) if (m.tool === "recordly") m.version = version;
		return sub;
	};

	it("does not report a half-known tool as a single known build", () => {
		// normaliseVersion drops "unknown" so it is never listed as a build. Filtering it out and
		// stopping there produced the opposite lie: measured once at 1.3.3 and once at an
		// unrecorded version, recordly read as one known build and raised no warning at all.
		const r = aggregate(
			[
				versioned({ recordly: 2.4, cap: 1.3 }, "1.3.3"),
				versioned({ recordly: 2.1, cap: 1.2 }, "unknown"),
			],
			{ step: "S4" },
		);
		const rec = r.tools.find((t) => t.tool === "recordly");
		expect(rec.versions).toEqual(["1.3.3"]);
		expect(rec.versionsUnreported).toBe(1);
		expect(r.versionSpread.map((v) => v.tool)).toContain("recordly");
	});

	it("stays quiet when every submission reported the same build, spelled either way", () => {
		const r = aggregate(
			[
				versioned({ recordly: 2.4, cap: 1.3 }, "1.3.3"),
				versioned({ recordly: 2.1, cap: 1.2 }, "1.3.3.0"),
			],
			{ step: "S4" },
		);
		expect(r.versionSpread).toEqual([]);
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
