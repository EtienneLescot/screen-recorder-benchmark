import { describe, expect, it } from "vitest";
import floor from "./ffmpeg-baseline.mjs";

/**
 * The floor is measured twice per leg — once on the fixed-function encoder every cost is divided
 * by, once on libx264 to see what the cores were doing at the same moment. Repetition indices
 * restart per leg, so if both wrote to the same name the second would silently overwrite the
 * first and the run would report a hardware floor that was really a software one.
 */
describe("the two floors do not collide on disk", () => {
	const ctx = (floorEncoder) => ({
		outDir: "/out",
		scenario: { id: "full-demo" },
		run: { index: 3 },
		floorEncoder,
	});

	it("gives the software floor its own filename", () => {
		const hw = floor.outputPath(ctx("hardware"));
		const sw = floor.outputPath(ctx("software"));
		expect(sw).not.toBe(hw);
		expect(sw).toMatch(/-sw-/);
	});

	it("leaves the hardware floor's name unchanged when no encoder is named", () => {
		expect(floor.outputPath(ctx(undefined))).toBe(floor.outputPath(ctx("hardware")));
		expect(floor.outputPath(ctx(undefined))).not.toMatch(/-sw-/);
	});
});
