/**
 * A `.focusee` project, written directly.
 *
 * FocuSee's editor is driven through its project rather than through its timeline, for the same
 * reason Cap's and OpenScreen's are: an edit typed into a UI is not reproducible, and the parts
 * of this scenario that cost the most — three animated zooms, a cursor rendered from telemetry,
 * a webcam inset — have no addressable control at all. The zoom editor exposes no time or scale
 * field, and FocuSee derives its cursor and its auto-zooms from the telemetry of a recording it
 * made itself, which an imported file has none of. Driven through the UI, FocuSee would render a
 * cheaper scene than every tool beside it and the comparison would be meaningless.
 *
 * A project is a directory, not a file:
 *
 *   <name>.focusee/
 *     configure.focuseeproj     the edit: background, cursor, motion, camera, zoomTracks
 *     recording/
 *       metadata.json           which channels exist, which file each one is, and when
 *       display-0.mp4           the screen recording
 *       webcam-0.mp4            the camera, if there is one
 *       systemaudio-0.m4a       the recording's sound, split out
 *       mousemoves-0.json       the pointer path, in screen pixels
 *       mouseclicks-0.json      down/up pairs, same coordinates
 *       keystrokes-0.json       required to exist, may be empty
 *       cursor.json             the sprite table the moves index by `cursorId`
 *
 * Two things about this format cost a day to find, and neither is guessable:
 *
 *   · **`projectType: "import"` disables half the editor.** Written into metadata.json — which
 *     is what FocuSee's own import path does — the Cursor, Audio and Shortcut panels come up
 *     greyed out and the cursor is not composited, however much telemetry sits beside them.
 *     Omit the key and the same files light all three up. This is the difference between
 *     measuring FocuSee on this scenario and measuring it on a fraction of it.
 *
 *   · **Timestamps are absolute, and matched against the session.** Samples carry
 *     `processTimeMs` and `unixTimeMs`, and the display session carries `processTimeStartMs` /
 *     `unixStartMs`. Both are written zero-based here so a sample's time is its offset into the
 *     clip; a recording's own values are the machine's uptime in milliseconds, and only the
 *     difference is ever read.
 *
 * Values in `configure.focuseeproj` are fractions where the editor's sliders are integers:
 * padding 5 on the slider is 0.05 in the file, roundness 20 is 0.2, shadow 20 is 0.2. The
 * driver holds slider units because that is what `bench.mjs calibrate` solves in; the
 * conversion is here.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cursorTrack } from "./assets.mjs";

/** Slider units (what the editor shows, and what calibration solves) → file fractions. */
export const SLIDER_TO_FILE = 100;

const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

/**
 * One channel session. Every recorder in metadata.json publishes the same shape, so the
 * differences between a display, a webcam and an audio channel are just the extra keys.
 */
const session = (durationMs, extra = {}) => ({
	durationMs,
	processTimeStartMs: 0,
	processTimeEndMs: durationMs,
	unixStartMs: 0,
	unixEndMs: durationMs,
	deviceFrameRate: 0,
	recordingScale: 1,
	displayRefreshRate: 0,
	loseInputDuration: 0,
	...extra,
});

/**
 * The pointer path, in FocuSee's schema.
 *
 * Coordinates are absolute pixels inside the display session's `bounds`, where the benchmark's
 * sidecar is normalised — so this is the same trajectory every other tool is given, expressed in
 * the units this one reads. `cursorId` indexes cursor.json; one entry named "arrow" is enough,
 * because the scenario asks for a themed sprite (`styleId`) rather than the captured system
 * pointer, and a sample whose id is not in the table renders nothing at all.
 */
function writeCursorTelemetry(recordingDir, samples, { width, height }) {
	const px = (s) => ({ x: Math.round(s.cx * width), y: Math.round(s.cy * height) });
	const moves = samples.map((s) => ({
		cursorId: "arrow",
		processTimeMs: s.timeMs,
		type: "mouseMoved",
		unixTimeMs: s.timeMs,
		...px(s),
	}));
	const clicks = samples
		.filter((s) => s.interactionType && s.interactionType !== "move")
		.map((s) => ({
			button: "left",
			cursorId: "arrow",
			processTimeMs: s.timeMs,
			type: s.interactionType === "click" ? "mouseDown" : "mouseUp",
			unixTimeMs: s.timeMs,
			...px(s),
		}));
	writeFileSync(join(recordingDir, "mousemoves-0.json"), JSON.stringify(moves));
	writeFileSync(join(recordingDir, "mouseclicks-0.json"), JSON.stringify(clicks));
	// Required to exist even when nothing was typed: the input channel names all three files,
	// and a missing one takes the whole channel down with it.
	writeFileSync(join(recordingDir, "keystrokes-0.json"), "[]");
	writeFileSync(
		join(recordingDir, "cursor.json"),
		JSON.stringify([
			{
				hotSpot: { x: 0, y: 0 },
				id: "arrow",
				standardSize: { height: 32, width: 32 },
				systemCursor: true,
			},
		]),
	);
	return { moves: moves.length, clicks: clicks.length };
}

/** One zoom, in the shape FocuSee's timeline round-trips: normalised begin/end, absolute scale. */
const zoomTrack = (z, durationSec) => ({
	zoomScale: z.scale,
	zoomOpen: true,
	type: 1,
	type1: "2d",
	zoomManualPoint: { x: z.focus.x, y: z.focus.y },
	customAnchor3D: { x: 0.5, y: 0.5 },
	autoEffect: "normal",
	// The scenario's zooms are pinned, so FocuSee's own dwell-based generator is off: with it on
	// the app would add zooms of its own from the telemetry and no two tools would be rendering
	// the same edit.
	isAutoZoom2D: false,
	isAutoZoom3D: false,
	begin: z.startSec / durationSec,
	end: z.endSec / durationSec,
	duration: durationSec,
});

/**
 * Write a complete project, replacing whatever was there.
 *
 * `paddingControl` and `roundControl` are in slider units; everything else comes from the
 * scenario. Returns what was actually written, so the driver reports applied features from this
 * rather than from its intentions.
 */
export function writeFocuseeProject({
	dir,
	sourcePath,
	durationSec,
	width = 1920,
	height = 1080,
	scenario,
	webcamPath = null,
	cursorPath = null,
	spec = null,
	paddingControl,
	roundControl,
	ffmpeg,
}) {
	const e = scenario.effects;
	const durationMs = Math.round(durationSec * 1000);
	rmSync(dir, { recursive: true, force: true });
	const rec = join(dir, "recording");
	mkdirSync(join(rec, "cursors"), { recursive: true });

	copyFileSync(sourcePath, join(rec, "display-0.mp4"));

	const applied = ["targetResolution", "targetFps"];
	const recorders = [
		{
			id: "channel-0-cursor",
			type: "cursor",
			cursorImagesFolder: "cursors",
			cursorsInfoFile: "cursor.json",
		},
	];

	let telemetry = { moves: 0, clicks: 0 };
	if (e.cursor?.enabled) {
		const samples =
			cursorPath && existsSync(cursorPath)
				? (JSON.parse(readFileSync(cursorPath, "utf8")).samples ?? [])
				: spec
					? cursorTrack(spec)
					: [];
		if (samples.length) {
			telemetry = writeCursorTelemetry(rec, samples, { width, height });
			recorders.push({
				configuration: { captureKeyStrokes: true },
				id: "channel-0-input",
				type: "input",
				sessions: [
					session(durationMs, {
						keyStrokesFilename: "keystrokes-0.json",
						mouseClicksFilename: "mouseclicks-0.json",
						mouseMovesFilename: "mousemoves-0.json",
					}),
				],
			});
			applied.push("cursor");
		}
	}

	if (e.webcam?.enabled && webcamPath && existsSync(webcamPath)) {
		copyFileSync(webcamPath, join(rec, "webcam-0.mp4"));
		recorders.push({
			configuration: { deviceId: "123123", captureKeyStrokes: false },
			id: "channel-3-webcam",
			type: "webcam",
			sessions: [session(durationMs, { outputFilename: "webcam-0.mp4" })],
		});
		applied.push("webcam");
	}

	// The scenario counts the recording's audio, and FocuSee only offers its audio stage when a
	// channel names a file — the sound inside display-0.mp4 is not enough.
	if (ffmpeg) {
		try {
			execFileSync(
				ffmpeg,
				[
					"-y",
					"-i",
					sourcePath,
					"-vn",
					"-c:a",
					"aac",
					"-b:a",
					"192k",
					join(rec, "systemaudio-0.m4a"),
				],
				{ stdio: "ignore" },
			);
			recorders.push({
				configuration: { deviceId: null, captureKeyStrokes: false, displayId: "123123" },
				id: "channel-4-systemAudio",
				type: "systemAudio",
				sessions: [session(durationMs, { outputFilename: "systemaudio-0.m4a" })],
			});
			applied.push("audio");
		} catch {
			/* a source with no audio track: the channel is simply not declared */
		}
	}

	recorders.push({
		configuration: { displayId: "123123", captureKeyStrokes: false },
		id: "channel-1-legacy-display",
		type: "legacyDisplay",
		sessions: [
			session(durationMs, {
				outputFilename: "display-0.mp4",
				displayRefreshRate: 60,
				bounds: { x: 0, y: 0, width, height },
			}),
		],
	});

	json(join(rec, "metadata.json"), {
		// No `projectType` — see the header. "import" greys out the cursor, audio and shortcut
		// stages, which is most of what this scenario is made of.
		autoZoomStyle: "D2",
		uniqueID: "6f8c1f2e-0000-4000-8000-5265636f7264",
		typingToZoom: false,
		isFullScreen: true,
		polyrecorderVersion: "2.4.3.0",
		platform: "Win",
		recorders,
		sessions: [session(durationMs)],
	});

	const zooms = (e.zooms ?? []).map((z) => zoomTrack(z, durationSec));
	if (zooms.length) applied.push("zooms");
	if (e.motionBlur?.enabled) applied.push("motionBlur");
	if (e.shadow?.enabled) applied.push("shadow");
	applied.push("padding", "cornerRadius", "background");

	json(join(dir, "configure.focuseeproj"), {
		version: "2.0",
		projectname: dir
			.replace(/\\/g, "/")
			.split("/")
			.pop()
			.replace(/\.focusee$/i, ""),
		background: {
			aspectFill: false,
			ratio: "ratio_16_9",
			isZoomFixed: false,
			padding: paddingControl / SLIDER_TO_FILE,
			inset: 0,
			round: roundControl / SLIDER_TO_FILE,
			shadowOpacity: e.shadow?.enabled ? e.shadow.intensity : 0,
			insetColorString: "#59FFFFFF",
			crop: { rect: { x: 0, y: 0, width: 1, height: 1 }, ratio: "auto" },
			// One of FocuSee's own shipped wallpapers, which is what
			// `background: { source: "tool-default" }` asks every tool for.
			content: { id: 33 },
		},
		cursor: {
			isEnable: !!e.cursor?.enabled,
			// FocuSee's own scale, not a percentage: 3.0 is what its recorder writes. The
			// scenario's 150% has no conversion into it, so the product's value is kept rather
			// than a number invented for it.
			size: 3.0,
			styleId: "1001",
			effect: { style: "regular" },
			clickSound: { volume: 1.0, soundID: 1, isEnable: false },
			isHideWhenIdle: false,
		},
		motion: {
			mouseAnimationStyle: 2,
			mouseMovementSpring: { stiffness: 470.0, damping: 70.0, mass: 3.0 },
			screenAnimationStyle: 1,
			screenMovementSpring: { stiffness: 170.0, damping: 50.0, mass: 3.0 },
			isMouseMoveSpringEnable: (e.cursor?.smoothing ?? 0) > 0,
			blur: {
				isEnable: !!e.motionBlur?.enabled,
				cursorMoveBlur: e.motionBlur?.amount ?? 0,
				screenZoomBlur: e.motionBlur?.amount ?? 0,
				screenMoveBlur: e.motionBlur?.amount ?? 0,
			},
		},
		camera: {
			aiPortrait: { isEnable: false, avatarProgress: 0.5 },
			isEnable: applied.includes("webcam"),
			size: (e.webcam?.sizePercent ?? 25) / 100,
			layoutIndex: 0,
			round: e.webcam?.shape === "rounded" ? 0.5 : 0,
			isScaledWhenZoom: true,
			scale: 0.8,
			layoutFlip: false,
			horizontalMirror: false,
			filter: "none",
			avatarProgress: 0.5,
			intensity: 0.29292929292929293,
			isBeauty: false,
		},
		audio: {
			isMuted: false,
			isMutedSystem: false,
			isMutedDevice: false,
			volumeEnhancer: 1.0,
			volumeEnhancerSystem: 1.0,
			volumeEnhancerDevice: 1.0,
			isDenoise: false,
			isBeauty: false,
		},
		// Left as the product ships it. The trial watermark is a fact about the licence, not a
		// setting this benchmark gets to switch off.
		waterMark: { isEnable: true, size: 0.1, opacity: 1.0, position: 2 },
		playTracks: [
			{
				speed: 1.0,
				type: 0,
				isDisplayCursor: !!e.cursor?.enabled,
				begin: 0.0,
				end: 1.0,
				duration: durationSec,
			},
		],
		zoomTracks: zooms,
		layoutTracks: [],
		typingTracks: [],
		trackZoom: 0.38197145356086126,
		trackVersion: "2.4.3.0",
		operateSystem: "win",
		annotationTracks: [],
	});

	return { dir, applied: [...new Set(applied)], zooms: zooms.length, ...telemetry };
}
