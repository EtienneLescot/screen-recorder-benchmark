import { describe, expect, it } from "vitest";
import { mad, median, ProcessTreeSampler } from "./measure.mjs";
import { parseProcStatJiffies } from "./platform.mjs";

describe("ProcessTreeSampler.parseCpuTime", () => {
	// `ps` prints cumulative CPU as [[dd-]hh:]mm:ss[.ff]. Every one of these forms turns up in
	// practice, and a missed one silently reports 0 CPU seconds for a busy process.
	it.each([
		["0:00.00", 0],
		["12:34.56", 754.56],
		["1:02:03", 3723],
		["1-02:03:04.55", 93784.55],
	])("parses %s", (input, expected) => {
		expect(ProcessTreeSampler.parseCpuTime(input)).toBeCloseTo(expected, 2);
	});

	it("returns 0 rather than NaN for anything unparseable", () => {
		expect(ProcessTreeSampler.parseCpuTime("-")).toBe(0);
		expect(ProcessTreeSampler.parseCpuTime("")).toBe(0);
	});
});

describe("median and mad", () => {
	it("takes the middle of an odd sample and the mean of the middle two of an even one", () => {
		expect(median([3, 1, 2])).toBe(2);
		expect(median([4, 1, 3, 2])).toBe(2.5);
	});

	it("is null for no samples, so a failed app cannot masquerade as a fast one", () => {
		expect(median([])).toBeNull();
		expect(mad([])).toBeNull();
	});

	it("reports spread as the median absolute deviation", () => {
		expect(mad([10, 10, 10])).toBe(0);
		expect(mad([8, 10, 12])).toBe(2);
	});

	it("is not dragged by a single outlier the way a mean would be", () => {
		expect(median([10, 10, 10, 10, 1000])).toBe(10);
	});
});

/**
 * A process's name sits in a parenthesised field that may itself contain spaces and
 * parentheses, so every field after it lands at an offset that depends on the name. Splitting
 * the line on whitespace produces numbers that are wrong but entirely plausible.
 */
describe("parseProcStatJiffies", () => {
	/** A real line, trimmed to the fields that matter: utime 1234, stime 567. */
	const line = (comm) =>
		`4242 (${comm}) S 1 4242 4242 0 -1 4194304 9999 0 0 0 1234 567 0 0 20 0 12 0 99999`;

	it("reads utime + stime", () => {
		expect(parseProcStatJiffies(line("recordly"))).toBe(1234 + 567);
	});

	it("is not thrown off by a name containing spaces or parentheses", () => {
		expect(parseProcStatJiffies(line("my app (beta)"))).toBe(1234 + 567);
		expect(parseProcStatJiffies(line("Web Content"))).toBe(1234 + 567);
	});

	it("returns null rather than a wrong number for a line it cannot read", () => {
		expect(parseProcStatJiffies("nonsense")).toBeNull();
		expect(parseProcStatJiffies("4242 (x) S 1 2 3")).toBeNull();
	});
});
