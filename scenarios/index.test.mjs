import { describe, expect, it } from "vitest";
import { fidelity, getScenario, SCENARIOS, TARGET_OUTPUT } from "./index.mjs";

describe("scenario targets", () => {
	it("pins 60 fps, the only rate every app in the set can hit", () => {
		// OpenScreen's MP4 export is fixed at 60 (MP4_EXPORT_FPS); pinning 30 would make
		// "force identical output" impossible rather than merely inconvenient.
		expect(TARGET_OUTPUT.fps).toBe(60);
	});

	it("rejects an unknown id instead of silently measuring nothing", () => {
		expect(() => getScenario("nope")).toThrow(/Unknown scenario/);
	});
});

describe("fidelity", () => {
	const full = SCENARIOS["full-demo"];

	// Derived from the scenario rather than hard-coded, so adding a stage to the demo does not
	// silently leave this asserting the old, lighter definition of "everything".
	const everything = fidelity(full, []).wanted;

	it("demands the stages that make an export expensive", () => {
		// The first version of the scenario had none of these three, and measured decoding and
		// encoding rather than compositing.
		expect(everything).toEqual(expect.arrayContaining(["motionBlur", "cursor", "webcam"]));
	});

	it("scores an app that applied everything as full", () => {
		const f = fidelity(full, everything);
		expect(f.full).toBe(true);
		expect(f.missing).toEqual([]);
		expect(f.score).toBe(1);
	});

	it("names what a partial app skipped, so its row cannot be read as a win", () => {
		const f = fidelity(full, ["targetResolution", "targetFps"]);
		expect(f.full).toBe(false);
		expect(f.missing).toEqual(everything.filter((x) => !x.startsWith("target")));
		expect(f.score).toBeCloseTo(2 / everything.length, 3);
	});

	it("treats an app that claims nothing as having applied nothing", () => {
		expect(fidelity(full, undefined).score).toBeCloseTo(0, 3);
	});

	it("does not demand effects the scenario never asked for", () => {
		const f = fidelity(SCENARIOS.passthrough, ["targetResolution", "targetFps"]);
		expect(f.full).toBe(true);
	});
});
