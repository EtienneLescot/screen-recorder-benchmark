import { describe, expect, it } from "vitest";
import { getScenario } from "../scenarios/index.mjs";
import { buildConfig, buildMouseTelemetry, defaultPaddingControl } from "./screenStudioProject.mjs";

const scenario = getScenario("full-demo");
const config = (overrides = {}) =>
	buildConfig(scenario, {
		paddingControl: defaultPaddingControl(scenario),
		wantsCursor: true,
		wantsCamera: true,
		durationMs: 60_000,
		...overrides,
	});

/**
 * The zoom ranges are the one field in this document that cannot be got wrong loudly. Seconds
 * written into a millisecond field produce three zooms lasting six, seven and seven milliseconds:
 * an export that looks untouched, while every check that asks "were zooms configured?" passes,
 * and the adapter goes on claiming the feature.
 */
describe("zoom ranges are written in milliseconds", () => {
	it("scales the scenario's seconds by a thousand", () => {
		const { scenes } = config();
		expect(scenes[0].zoomRanges.map((z) => [z.startTime, z.endTime, z.zoom])).toEqual([
			[6000, 12000, 1.8],
			[22000, 29000, 2.2],
			[41000, 48000, 1.6],
		]);
	});

	it("keeps the focus point the scenario asked for, un-normalised", () => {
		const [first] = config().scenes[0].zoomRanges;
		expect(first.manualTargetPoint).toEqual({ x: 0.32, y: 0.38 });
		expect(first.type).toBe("manual");
	});
});

/**
 * The app's telemetry is in display points against the recording's `bounds`; the scenario's
 * track is normalised 0-1. Handing it the normalised values puts every pointer sample in the
 * top-left pixel, which renders a cursor that never moves — and still counts as a cursor.
 */
describe("pointer telemetry is converted into display points", () => {
	const samples = [
		{ timeMs: 0, cx: 0.5, cy: 0.25, interactionType: "move" },
		{ timeMs: 16, cx: 1, cy: 1, interactionType: "click" },
		{ timeMs: 32, cx: 0, cy: 0, interactionType: "mouseup" },
	];
	const { moves, clicks } = buildMouseTelemetry(samples, {
		width: 1920,
		height: 1080,
		unixStartMs: 1_000_000,
	});

	it("scales normalised coordinates against the recording's bounds", () => {
		expect(moves.map((m) => [m.x, m.y])).toEqual([
			[960, 270],
			[1920, 1080],
			[0, 0],
		]);
	});

	it("gives every sample a move and only the interactions a click", () => {
		expect(moves).toHaveLength(3);
		expect(moves.every((m) => m.type === "mouseMoved")).toBe(true);
		expect(clicks.map((c) => c.type)).toEqual(["mouseDown", "mouseUp"]);
	});

	it("keeps the recording clock and the wall clock in step", () => {
		expect(moves.map((m) => m.processTimeMs)).toEqual([0, 16, 32]);
		expect(moves.map((m) => m.unixTimeMs)).toEqual([1_000_000, 1_000_016, 1_000_032]);
	});
});

/**
 * Every effect the scenario names, in the app's own units — checked against a project the app
 * wrote itself, and read back through its `project.loadProject` before this was written.
 */
describe("the scenario is expressed in Screen Studio's units", () => {
	it("asks for the tool's own wallpaper rather than supplying one", () => {
		const { config: c } = config();
		expect(c.backgroundType).toBe("system");
		expect(c.backgroundSystemName).toMatch(/\.jpg$/);
		expect(c.backgroundImage).toBeNull();
		expect(c.backgroundBlur).toBe(0);
	});

	it("writes the radius in pixels and the shadow on the app's 0-1 scale", () => {
		const { config: c } = config();
		expect(c.windowBorderRadius).toBe(40);
		expect(c.shadowIntensity).toBe(0.2);
	});

	it("turns the camera inset into ratios, not percentages", () => {
		const { config: c } = config();
		expect(c.hideCamera).toBe(false);
		expect(c.cameraSize).toBe(0.25);
		expect(c.cameraRoundness).toBe(0.25);
		expect(c.cameraPosition).toBe("bottom-right");
	});

	it("renders the pointer from telemetry with the app's own sprite", () => {
		const { config: c } = config();
		expect(c.hideCursor).toBe(false);
		expect(c.cursorSize).toBe(1.5);
		expect(c.alwaysUseDefaultCursor).toBe(true);
		expect(c.disableMouseMovementSpring).toBe(false);
		expect(c.clickEffect).toEqual({ type: "ripple" });
	});

	it("drives all four motion-blur passes from the one scenario switch", () => {
		const { config: c } = config();
		expect(c.motionBlurAmount).toBe(0.5);
		expect(c.motionBlurScreenMoveAmount).toBe(0.5);
		expect(c.motionBlurScreenZoomAmount).toBe(0.5);
		expect(c.motionBlurCursorAmount).toBe(0.5);
	});

	/**
	 * A camera or pointer the recording does not carry must not be claimed by the config: the
	 * app would hide nothing and the driver would report a feature against an empty channel.
	 */
	it("hides what the recording has no track for", () => {
		const { config: c } = config({ wantsCursor: false, wantsCamera: false });
		expect(c.hideCursor).toBe(true);
		expect(c.hideCamera).toBe(true);
		expect(c.cursorSize).toBeUndefined();
		expect(c.cameraSize).toBeUndefined();
	});

	it("gives the slice the whole recording, in milliseconds", () => {
		const [scene] = config().scenes;
		expect(scene.slices[0].sourceStartMs).toBe(0);
		expect(scene.slices[0].sourceEndMs).toBe(60_000);
		expect(config().config.recordingRange).toEqual([0, 60_000]);
	});
});

/** The passthrough rung has to come out as a scene with nothing in it, not as a broken one. */
describe("the passthrough scenario asks for no effects", () => {
	const s0 = getScenario("passthrough");
	const { config: c, scenes } = buildConfig(s0, {
		paddingControl: defaultPaddingControl(s0),
		wantsCursor: false,
		wantsCamera: false,
		durationMs: 60_000,
	});

	it("leaves the geometry and the pointer alone", () => {
		expect(c.backgroundPaddingRatio).toBe(0);
		expect(c.windowBorderRadius).toBe(0);
		expect(c.shadowIntensity).toBe(0);
		expect(c.motionBlurAmount).toBe(0);
		expect(c.hideCursor).toBe(true);
		expect(scenes[0].zoomRanges).toEqual([]);
	});
});
