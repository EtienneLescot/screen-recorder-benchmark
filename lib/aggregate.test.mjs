import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TARGET_OUTPUT } from "../scenarios/index.mjs";
import { aggregate } from "./aggregate.mjs";
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

		const html = renderSite(result, { submissions: 1, generatedAt: "2026-01-01", roster: [] });
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
});
