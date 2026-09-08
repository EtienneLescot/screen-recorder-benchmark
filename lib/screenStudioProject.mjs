/**
 * Builds a `.screenstudio` project that expresses a benchmark scenario.
 *
 * A Screen Studio project is a directory: `project.json` (the edit), `meta.json` (a version
 * stamp) and `recording/` (the media plus the telemetry the compositor renders from). All of it
 * is plain JSON around plain media files, so the scenario is written directly rather than
 * clicked into the editor — the same approach `lib/openscreenProject.mjs` and
 * `lib/recordlyProject.mjs` take, and for the same reason: an edit typed into a UI is not
 * reproducible.
 *
 * ## Why this is built rather than imported
 *
 * The app has its own importer — `import.createProjectFromVideo` — and it was the first thing
 * this adapter used. Two things make it the wrong instrument for a benchmark.
 *
 * It **re-encodes the source**: `libx264 -preset medium -crf 23`, plus `aac -b:a 192k` for the
 * audio. So the clip Screen Studio composites is not the clip every other tool composites, and
 * the difference lands in the decoder — the one stage of the pipeline nothing else here varies.
 * (The re-encode happens during `prepare`, so it costs the measurement nothing; what it costs
 * is the comparison.)
 *
 * And it can only carry a screen track. The scenario asks for a camera inset and a pointer
 * rendered from telemetry, which is most of what a demo export actually costs — an import that
 * cannot express them would leave two of the ten features unapplied for this tool alone.
 *
 * Writing the recording directory directly gives the app the same bytes as everybody else, plus
 * the camera and pointer channels. The shape below is the app's own: the recorder ids, filenames
 * and session fields are what `polyrecorder` writes and what the app's loader reads back
 * (`recorders.find(r => r.type === "webcam")` and friends), and each one was checked against a
 * recording this build produced.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cursorTrack } from "./assets.mjs";
import { resolveFfmpeg } from "./env.mjs";
import { probe } from "./fixture.mjs";

/** Deterministic ids: the same scenario always produces the same project bytes. */
const id = (prefix, n) => `${prefix}${String(n).padStart(6, "0")}`;

/**
 * The files inside `recording/`, named as the app names them.
 *
 * The screen, audio and telemetry names are fixed strings in the app's own importer; the webcam
 * one follows the `channel-<n>-<type>-<session>` convention the recorder uses, and is read back
 * out of the session's `outputFilename` rather than guessed at, so only the metadata has to
 * agree with it.
 */
export const RECORDING_FILES = {
	screen: "channel-1-display-0.mp4",
	systemAudio: "channel-1-system-audio-0.m4a",
	webcam: "channel-2-webcam-0.mp4",
	cursors: "cursors.json",
	keystrokes: "keystrokes-0.json",
	mouseClicks: "mouseclicks-0.json",
	mouseMoves: "mousemoves-0.json",
	metadata: "metadata.json",
};

/**
 * `backgroundPaddingRatio` is the inset control, on the app's own scale — a fresh import sits at
 * 10 and a recording made in the app came back at 17.327, so it is neither a percentage of the
 * frame nor a pixel count. `bench.mjs calibrate` solves the value that produces the scenario's
 * inset, exactly as it does for Cap, OpenScreen and Recordly; this is only where the search
 * starts.
 */
export const defaultPaddingControl = (scenario) => scenario.effects.paddingPercent * 2;

/**
 * Screen Studio's zoom range, recovered from a project the app wrote itself.
 *
 * `startTime` and `endTime` are **milliseconds**, which is the one field here that cannot be got
 * wrong quietly: seconds written into them produce three zooms lasting six, seven and seven
 * milliseconds, and an export that looks untouched while every check that asks "were zooms
 * configured?" passes.
 */
const zoomRange = (z, i) => ({
	id: id("osbzoom", i),
	zoom: z.scale,
	type: "manual",
	snapToEdgesRatio: 0.25,
	manualTargetPoint: { x: z.focus.x, y: z.focus.y },
	glideDirection: null,
	glideSpeed: 0.5,
	isDisabled: false,
	startTime: Math.round(z.startSec * 1000),
	endTime: Math.round(z.endSec * 1000),
	isSystem: false,
	hasInstantAnimation: false,
});

/**
 * The pointer track, from whichever source this fixture has.
 *
 * A generated fixture carries a spec and the track is derived from it; a public bundle is
 * downloaded footage with no spec, and the harness writes an OpenScreen-shaped sidecar beside
 * the video instead. Both end up as the same samples — see `lib/assets.mjs` — so both are read
 * here rather than only the one this adapter happened to be written against.
 */
export function cursorSamplesFor({ spec, cursorPath }) {
	if (cursorPath && existsSync(cursorPath)) {
		try {
			const samples = JSON.parse(readFileSync(cursorPath, "utf8")).samples ?? [];
			if (samples.length) return samples;
		} catch {
			// A sidecar that will not parse is not worth failing a leg over; the caller reports
			// the cursor as unapplied, which is what actually happened.
		}
	}
	return spec ? cursorTrack(spec) : null;
}

/**
 * The scenario's pointer track in the app's own telemetry shape.
 *
 * `mousemoves-0.json` and `mouseclicks-0.json` hold flat arrays of events in **display points**
 * — `{ x: 934, y: 576 }` against the session's `bounds`, not the 0-1 the scenario carries — with
 * `processTimeMs` as the clock the compositor lines up against the video.
 */
export function buildMouseTelemetry(samples, { width, height, unixStartMs }) {
	const moves = [];
	const clicks = [];
	for (const s of samples) {
		const x = Math.round(s.cx * width);
		const y = Math.round(s.cy * height);
		const common = {
			activeModifiers: [],
			cursorId: "arrow",
			processTimeMs: s.timeMs,
			unixTimeMs: unixStartMs + s.timeMs,
			x,
			y,
		};
		moves.push({ ...common, type: "mouseMoved" });
		if (s.interactionType === "click")
			clicks.push({ ...common, button: "left", type: "mouseDown" });
		if (s.interactionType === "mouseup")
			clicks.push({ ...common, button: "left", type: "mouseUp" });
	}
	return { moves, clicks };
}

const ff = (args) =>
	execFileSync(resolveFfmpeg().ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
		maxBuffer: 32 * 1024 * 1024,
	});

/** Copy an already-conforming H.264 MP4, or convert one that is not, into the recording. */
function placeVideo(source, target) {
	const p = probe(source);
	const conforming = p.container?.includes("mp4") && p.video?.codec === "h264";
	if (conforming) {
		copyFileSync(source, target);
		return { converted: false, probe: p };
	}
	// The app's own importer uses `libx264 -preset medium -crf 23`; matching it keeps a
	// non-conforming source on the path the vendor would have put it on.
	ff(["-i", source, "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-an", target]);
	return { converted: true, probe: p };
}

/**
 * `recording/` — the media and telemetry, in the layout the app's loader expects.
 *
 * Returned rather than written blind: the caller reports what actually landed, so a missing
 * camera track is a note in the results instead of a feature claimed against an empty channel.
 */
function buildRecording({ recordingPath, sourcePath, webcamPath, cursorSamples }) {
	mkdirSync(recordingPath, { recursive: true });
	const screen = placeVideo(sourcePath, join(recordingPath, RECORDING_FILES.screen));
	const p = screen.probe;
	const width = p.video.width;
	const height = p.video.height;
	// A recording the app made itself carries fractional milliseconds here, so this is not
	// rounded to whole ones; it is the clock every session and slice in the document agrees on.
	const durationMs = p.durationSec * 1000;
	const unixStartMs = Date.now();

	// Audio is a separate channel, not a track inside the display file: the app reads the
	// recording's sound from `channel-1-system-audio-0.m4a` and nowhere else, so a project that
	// names none exports a conforming, silent AAC stream — which passes every check that only
	// asks whether audio exists. Cap's adapter carries the same note for the same reason.
	let audio = null;
	if (p.audio) {
		const target = join(recordingPath, RECORDING_FILES.systemAudio);
		try {
			ff(["-i", sourcePath, "-vn", "-c:a", "copy", target]);
		} catch {
			// Not every source's codec can be copied into an .m4a; re-encode rather than shipping
			// a project with no sound. 192k is what the app's own importer uses.
			ff(["-i", sourcePath, "-vn", "-c:a", "aac", "-b:a", "192k", target]);
		}
		audio = RECORDING_FILES.systemAudio;
	}

	let webcam = null;
	if (webcamPath && existsSync(webcamPath)) {
		placeVideo(webcamPath, join(recordingPath, RECORDING_FILES.webcam));
		webcam = RECORDING_FILES.webcam;
	}

	const { moves, clicks } = cursorSamples?.length
		? buildMouseTelemetry(cursorSamples, { width, height, unixStartMs })
		: { moves: [], clicks: [] };
	const write = (name, value) =>
		writeFileSync(join(recordingPath, name), `${JSON.stringify(value)}\n`);
	write(RECORDING_FILES.mouseMoves, moves);
	write(RECORDING_FILES.mouseClicks, clicks);
	write(RECORDING_FILES.keystrokes, []);
	// Empty on purpose: this table maps a recorded `cursorId` onto the PNG the app captured of
	// the *system* pointer at record time, and there is no such capture here. The project sets
	// `alwaysUseDefaultCursor`, so the app draws a sprite from its own bundled set instead —
	// which is what the scenario asks for, a pointer rendered by the tool rather than baked into
	// the footage, and what Cap's adapter does with its own bundled SVG.
	write(RECORDING_FILES.cursors, []);

	const session = (extra) => ({
		durationMs,
		processTimeStartMs: 0,
		processTimeEndMs: durationMs,
		unixStartMs,
		unixEndMs: unixStartMs + durationMs,
		...extra,
	});
	const metadata = {
		logFilename: "polyrecorder.log",
		polyrecorderVersion: "1.9.1",
		recorders: [
			{
				configuration: {},
				cursorImagesFolder: "cursors",
				cursorsInfoFile: RECORDING_FILES.cursors,
				id: "channel-0-cursor",
				type: "cursor",
			},
			{
				configuration: { captureKeyStrokes: true },
				id: "channel-0-input",
				sessions: [
					session({
						keyStrokesFilename: RECORDING_FILES.keystrokes,
						mouseClicksFilename: RECORDING_FILES.mouseClicks,
						mouseMovesFilename: RECORDING_FILES.mouseMoves,
					}),
				],
				type: "input",
			},
			{
				configuration: {
					cropRect: { x: 0, y: 0, width, height, yAxis: "topBasedIncreasingDownwards" },
					displayId: 1,
					excludedWindowIds: [],
					excludeFinderDesktopIcons: false,
				},
				id: "channel-1-display",
				sessions: [
					session({
						bounds: { x: 0, y: 0, width, height },
						displayRefreshRate: Math.round(p.video.fps),
						outputFilename: RECORDING_FILES.screen,
						// 1, not the importer's 0.5: the video's pixels *are* the bounds here, because
						// the source is a file rather than a capture of a Retina display. A recording
						// the app made itself carries 1 for the same reason.
						recordingScale: 1,
					}),
				],
				type: "display",
			},
			...(audio
				? [
						{
							configuration: {},
							id: "channel-1-system-audio",
							sessions: [session({ outputFilename: audio })],
							type: "systemAudio",
						},
					]
				: []),
			...(webcam
				? [
						{
							configuration: {},
							id: "channel-2-webcam",
							sessions: [session({ outputFilename: webcam })],
							type: "webcam",
						},
					]
				: []),
		],
		sessions: [session({})],
	};
	writeFileSync(
		join(recordingPath, RECORDING_FILES.metadata),
		`${JSON.stringify(metadata, null, 2)}\n`,
	);

	return {
		probe: p,
		durationMs,
		width,
		height,
		audio,
		webcam,
		moves: moves.length,
		clicks: clicks.length,
	};
}

/**
 * The edit, as `project.json`'s `config` and `scenes`.
 *
 * Every key is one the app writes itself; nothing is invented. What is *not* set matters as
 * much: the shadow's angle, distance and blur, the springs, and the cursor set are left at the
 * app's defaults, so the scenario pins what it names and the product supplies the rest.
 */
export function buildConfig(scenario, { paddingControl, wantsCursor, wantsCamera, durationMs }) {
	const e = scenario.effects;
	const config = {
		// `source: "tool-default"` — the app composites its own wallpaper, which is what the
		// scenario asks of every tool. `backgroundType: "system"` with the name a fresh import
		// carries is exactly that: no image is supplied and none is imported.
		backgroundType: "system",
		backgroundSystemName: "macOS/tahoe-light.jpg",
		backgroundImage: null,
		backgroundBlur: 0,
		backgroundPaddingRatio: paddingControl,
		windowBorderRadius: e.cornerRadiusPx ?? 0,
		shadowIntensity: e.shadow?.enabled ? e.shadow.intensity : 0,

		// Four separate passes behind one scenario switch. `motionBlurAmount` is the master and
		// the app ships all four at 1; the scenario's 0-1 amount is written straight through, and
		// the pointer's own pass is turned off when the scenario does not ask for it.
		motionBlurAmount: e.motionBlur?.enabled ? e.motionBlur.amount : 0,
		motionBlurScreenMoveAmount: e.motionBlur?.enabled ? e.motionBlur.amount : 0,
		motionBlurScreenZoomAmount: e.motionBlur?.enabled ? e.motionBlur.amount : 0,
		motionBlurCursorAmount: e.cursor?.motionBlur && e.motionBlur?.enabled ? e.motionBlur.amount : 0,

		hideCursor: !wantsCursor,
		hideCamera: !wantsCamera,

		audioVolume: 1,
		muteSystemAudio: false,
		muteMicrophone: false,
		recordingRange: [0, durationMs],
	};

	if (wantsCursor) {
		// A multiplier, not a percentage: a fresh import sits at 1.5, so the scenario's 150 %
		// lands on the app's own default rather than somewhere off its scale.
		config.cursorSize = (e.cursor.sizePercent ?? 100) / 100;
		// The app draws its own sprite rather than a captured one — see the empty cursors table.
		config.alwaysUseDefaultCursor = true;
		// Smoothing is a spring here, not a 0-1 dial: the scenario's `smoothing` selects whether
		// the spring runs, and its stiffness/damping/mass stay at the app's defaults. A single
		// number cannot be honestly translated into three, so the deviation is reported rather
		// than a value invented for it.
		config.disableMouseMovementSpring = !(e.cursor.smoothing > 0);
		// `clickEffect` is an object keyed by type; the app ships it null (no effect at all).
		// "ripple" is the one drawn on the screen layer, which is the click effect the scenario
		// describes.
		config.clickEffect = e.cursor.clickEffects ? { type: "ripple" } : null;
	}

	if (wantsCamera) {
		// A ratio, not a percentage — 0.35 is the app's default.
		config.cameraSize = (e.webcam.sizePercent ?? 25) / 100;
		config.cameraRoundness = e.webcam.shape === "rounded" ? 0.25 : 0;
		config.cameraPosition = e.webcam.position ?? "bottom-right";
		config.cameraPositionPoint = { x: 1, y: 1 };
		// `webcam.shadow` has no control of its own: the camera layer is drawn with the *same*
		// shadowIntensity / shadowDistance / shadowAngle / shadowBlur as the screen layer, only
		// masked to the camera's roundness. So the scenario's camera shadow is already satisfied
		// by `shadowIntensity` above, and a scenario asking for one without the other could not
		// be expressed here at all.
		config.defaultLayout = {
			type: "both",
			cameraSize: (e.webcam.sizePercent ?? 25) / 100,
			cameraPositionPoint: { x: 1, y: 1 },
		};
	}

	const scene = {
		id: id("osbscene", 0),
		name: "Default",
		zoomRanges: (e.zooms ?? []).map(zoomRange),
		type: "recording",
		sessionIndex: 0,
		slices: [
			{
				id: id("osbslice", 0),
				timeScale: 1,
				sourceStartMs: 0,
				sourceEndMs: durationMs,
				volume: 1,
				systemAudioVolume: 1,
				hideCursor: !wantsCursor,
				disableSmoothMouseMovement: !(e.cursor?.enabled && e.cursor.smoothing > 0),
				externalDeviceAudioVolume: 1,
			},
		],
		layouts: [],
		masks: [],
		resolvedTypingSpeedIncreaseSuggestions: [],
		voiceOvers: [],
	};

	return { config, scenes: [scene] };
}

export function buildProject({
	sourcePath,
	scenario,
	outDir,
	title = "export-benchmark",
	paddingControl = null,
	assets = {},
	spec = null,
	cursorPath = null,
	appVersion = "3.7.5-4595",
}) {
	const e = scenario.effects;
	const projectPath = join(outDir, `${title}.screenstudio`);
	rmSync(projectPath, { recursive: true, force: true });
	mkdirSync(projectPath, { recursive: true });

	const cursorSamples = e.cursor?.enabled ? cursorSamplesFor({ spec, cursorPath }) : null;
	const webcamSource = e.webcam?.enabled ? (assets.webcam ?? null) : null;
	const recording = buildRecording({
		recordingPath: join(projectPath, "recording"),
		sourcePath,
		webcamPath: webcamSource,
		cursorSamples,
	});

	const pad = paddingControl ?? defaultPaddingControl(scenario);
	const wantsCursor = Boolean(e.cursor?.enabled && recording.moves > 0);
	const wantsCamera = Boolean(recording.webcam);
	const { config, scenes } = buildConfig(scenario, {
		paddingControl: pad,
		wantsCursor,
		wantsCamera,
		durationMs: recording.durationMs,
	});

	const now = new Date().toISOString();
	// The envelope is the app's own: `{ json, meta }`, where `meta.values` names the fields that
	// are Dates rather than strings. A document without it loads with `createdAt` as a string and
	// the app's date arithmetic silently produces NaN.
	writeFileSync(
		join(projectPath, "project.json"),
		`${JSON.stringify(
			{
				json: {
					id: id("osbproj", 0),
					name: title,
					createdAt: now,
					updatedAt: now,
					lastSavedAt: null,
					config,
					meta: { recordingFlags: [] },
					scenes,
				},
				meta: { values: { createdAt: ["Date"], updatedAt: ["Date"] }, v: 1 },
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(
		join(projectPath, "meta.json"),
		`${JSON.stringify(
			{
				json: { version: appVersion, requiredVersion: "2.4.0-beta", createdAt: now },
				meta: { values: { createdAt: ["Date"] }, v: 1 },
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(join(projectPath, "recording-markers.json"), `${JSON.stringify({ json: [] })}\n`);

	return {
		projectPath,
		recordingPath: join(projectPath, "recording"),
		probe: recording.probe,
		durationMs: recording.durationMs,
		paddingControl: pad,
		config,
		zoomRanges: scenes[0].zoomRanges,
		cursorApplied: wantsCursor,
		cursorSamples: recording.moves,
		cursorClicks: recording.clicks,
		webcamApplied: wantsCamera,
		audioApplied: Boolean(recording.audio),
	};
}
