import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCENARIOS } from "../scenarios/index.mjs";
import { writeFocuseeProject } from "./focuseeProject.mjs";

/**
 * The project is the whole scenario for this app — its zooms, cursor and webcam have no
 * addressable control — so what this guards is the translation, not the file writing: slider
 * units to fractions, seconds to normalised track bounds, normalised cursor samples to pixels,
 * and the one key whose presence silently costs three effects.
 */
describe("writeFocuseeProject", () => {
	let dir;
	let root;
	let source;
	let cursorPath;
	let project;
	let configure;
	let metadata;

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "focusee-"));
		source = join(root, "screen.mp4");
		cursorPath = join(root, "screen.mp4.cursor.json");
		writeFileSync(source, "not really an mp4");
		writeFileSync(
			cursorPath,
			JSON.stringify({
				samples: [
					{ timeMs: 0, cx: 0.5, cy: 0.25, interactionType: "move" },
					{ timeMs: 100, cx: 0.25, cy: 0.5, interactionType: "click" },
					{ timeMs: 200, cx: 0.25, cy: 0.5, interactionType: "mouseup" },
				],
			}),
		);
		dir = join(root, "bench.focusee");
		project = writeFocuseeProject({
			dir,
			sourcePath: source,
			durationSec: 60,
			scenario: SCENARIOS["full-demo"],
			cursorPath,
			paddingControl: 5,
			roundControl: 20,
			// No ffmpeg and no webcam: both channels are optional and must simply not be declared.
			ffmpeg: null,
		});
		configure = JSON.parse(readFileSync(join(dir, "configure.focuseeproj"), "utf8"));
		metadata = JSON.parse(readFileSync(join(dir, "recording", "metadata.json"), "utf8"));
	});

	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("never writes projectType, which greys out cursor, audio and shortcuts", () => {
		expect(metadata).not.toHaveProperty("projectType");
	});

	it("converts slider units into the fractions the file holds", () => {
		expect(configure.background.padding).toBe(0.05);
		expect(configure.background.round).toBe(0.2);
		expect(configure.background.shadowOpacity).toBe(0.2);
	});

	it("normalises each zoom against the clip and keeps its scale and focus", () => {
		const [first, , third] = configure.zoomTracks;
		expect(configure.zoomTracks).toHaveLength(3);
		expect(first.begin).toBeCloseTo(6 / 60, 6);
		expect(first.end).toBeCloseTo(12 / 60, 6);
		expect(first.zoomScale).toBe(1.8);
		expect(first.zoomManualPoint).toEqual({ x: 0.32, y: 0.38 });
		expect(third.zoomScale).toBe(1.6);
		// FocuSee's own dwell-based generator stays off, or it adds zooms nobody asked for.
		expect(configure.zoomTracks.every((z) => !z.isAutoZoom2D && !z.isAutoZoom3D)).toBe(true);
	});

	it("writes cursor samples as pixels, and clicks as down/up pairs", () => {
		const moves = JSON.parse(readFileSync(join(dir, "recording", "mousemoves-0.json"), "utf8"));
		const clicks = JSON.parse(readFileSync(join(dir, "recording", "mouseclicks-0.json"), "utf8"));
		expect(moves).toHaveLength(3);
		expect(moves[0]).toMatchObject({ x: 960, y: 270, cursorId: "arrow", type: "mouseMoved" });
		expect(clicks.map((c) => c.type)).toEqual(["mouseDown", "mouseUp"]);
		// A sample whose cursorId is missing from the table renders nothing at all.
		const table = JSON.parse(readFileSync(join(dir, "recording", "cursor.json"), "utf8"));
		expect(table.map((c) => c.id)).toContain("arrow");
	});

	it("declares only the channels it actually has files for", () => {
		const ids = metadata.recorders.map((r) => r.id);
		expect(ids).toContain("channel-0-input");
		expect(ids).toContain("channel-1-legacy-display");
		expect(ids).not.toContain("channel-3-webcam");
		expect(ids).not.toContain("channel-4-systemAudio");
		expect(project.applied).toContain("cursor");
		expect(project.applied).not.toContain("webcam");
	});
});
