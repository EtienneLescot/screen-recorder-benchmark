import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aggregate } from "./aggregate.mjs";
import { renderSite } from "./site.mjs";

/** One machine, two tools, a known ratio. */
function submission(costs, { at = "2026-01-01T00:00:00.000Z" } = {}) {
	return {
		submittedAt: at,
		conditions: { driftRatio: 1 },
		scenario: { step: "S4" },
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
});
