/**
 * Builds a `.recordly` project that expresses a benchmark scenario.
 *
 * The document is `EditorProjectData` — `{ version, videoPath, editor }` — and `editor` is a
 * *partial* `ProjectEditorState`, so only what the scenario pins is written and the app fills
 * the rest from its own defaults. Writing it directly rather than driving the editor is what
 * makes the leg reproducible, and it is the same approach `lib/openscreenProject.mjs` takes
 * against the same interface name; the two products share a lineage and, as it happens, the
 * path `src/components/video-editor/projectPersistence.ts`.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { cursorTrack } from "./assets.mjs";
import { probe } from "./fixture.mjs";

/** Deterministic ids: the same scenario always produces the same project bytes. */
const id = (prefix, n) => `${prefix}_${String(n).padStart(8, "0")}`;

/**
 * Recordly's zoom scale is a preset, not a number.
 *
 * `ZOOM_DEPTH_SCALES` in src/components/video-editor/types.ts. The scenario's 1.8× and 2.2×
 * land exactly on depths 3 and 4; its 1.6× lands on nothing, and the nearest rung is 1.5×.
 * The deviation is returned so the driver can report it rather than let the frame quietly
 * differ — the scenario's own comment says its values are picked to sit on each app's presets,
 * which 1.6 does not for this one.
 */
export const ZOOM_DEPTH_SCALES = { 1: 1.25, 2: 1.5, 3: 1.8, 4: 2.2, 5: 3.5, 6: 5.0 };

export function nearestZoomDepth(scale) {
	let best = null;
	for (const [depth, value] of Object.entries(ZOOM_DEPTH_SCALES)) {
		const delta = Math.abs(value - scale);
		if (!best || delta < best.delta) best = { depth: Number(depth), value, delta };
	}
	return best;
}

/**
 * Padding is four sides on the app's own scale, not a percentage — `DEFAULT_PADDING` is 20 a
 * side and the advanced vertical maximum is 250. `bench.mjs calibrate` solves the control that
 * produces the scenario's inset, exactly as it does for Cap and OpenScreen; this is only the
 * starting point it searches from.
 */
export const defaultPaddingControl = (scenario) =>
	Math.round(Math.min(250, Math.max(0, scenario.effects.paddingPercent * 4)));

/**
 * The pointer track, from whichever source this fixture has.
 *
 * A generated fixture carries a spec and the track is derived from it. A public bundle has no
 * spec — it is downloaded footage — but the harness still writes a sidecar beside the video, and
 * `lib/openscreenProject.mjs` reads it. This did not, so on every bundle run Recordly was handed
 * no pointer at all and was then scored as having declined to draw one, while OpenScreen was
 * given the track for the same scenario. The two files hold the same samples.
 */
export function cursorTelemetryFor({ spec, cursorPath }) {
	if (spec) return buildCursorTelemetry(spec);
	if (!cursorPath || !existsSync(cursorPath)) return null;
	try {
		const samples = JSON.parse(readFileSync(cursorPath, "utf8")).samples ?? [];
		return samples.map((s) => ({
			timeMs: s.timeMs,
			cx: s.cx,
			cy: s.cy,
			...(s.interactionType ? { interactionType: s.interactionType } : {}),
		}));
	} catch {
		// A sidecar that will not parse is not worth failing a leg over; the driver reports
		// cursor as unapplied, which is what actually happened.
		return null;
	}
}

/** The scenario's cursor telemetry, in the shape `setCursorTelemetry` expects. */
export function buildCursorTelemetry(spec) {
	// CursorTelemetryPoint is { timeMs, cx, cy, interactionType } — the same shape OpenScreen's
	// sidecar uses, so the generated track carries across without translation.
	return cursorTrack(spec).map((s) => ({
		timeMs: s.timeMs,
		cx: s.cx,
		cy: s.cy,
		...(s.interactionType ? { interactionType: s.interactionType } : {}),
	}));
}

export function buildProject({
	sourcePath,
	scenario,
	outDir,
	title = "export-benchmark",
	paddingControl = null,
	assets = {},
	spec = null,
	/** A pointer track written beside the video, for fixtures that have no spec. */
	cursorPath = null,
}) {
	mkdirSync(outDir, { recursive: true });

	// Copied in beside the project: the main process resolves readable media through
	// `resolveAllowedReadableFilePath`, so a path elsewhere on the filesystem is not a given.
	const localMedia = join(outDir, basename(sourcePath));
	if (localMedia !== sourcePath) copyFileSync(sourcePath, localMedia);

	const p = probe(localMedia);

	const e = scenario.effects;

	// The pointer track goes beside the video as <video>.cursor.json, which is where the app
	// puts its own — see AppData/Roaming/Recordly/recordings/*.mp4.cursor.json, the same
	// { version, samples } shape this writes.
	//
	// Handing it over through setCurrentVideoPath + setCursorTelemetry is not enough, though it
	// returns success: openProjectFileAtPath runs afterwards and the export came out
	// byte-identical to one built with no telemetry at all — sha256 d64c3467…, the same file
	// four earlier runs had produced — so nothing had reached the compositor. The fidelity score
	// rose to 1.0 all the same, because the driver claims what it supplied and the pixel check
	// declines to judge a cursor on real footage. A claim nothing can contradict has to be one
	// the adapter has actually earned. lib/openscreenProject.mjs writes its sidecar for the
	// same reason.
	const cursorSamples = e.cursor?.enabled ? cursorTelemetryFor({ spec, cursorPath }) : null;
	if (cursorSamples?.length) {
		const withType = cursorSamples.map((c) => ({ ...c, cursorType: "arrow" }));
		writeFileSync(
			`${localMedia}.cursor.json`,
			`${JSON.stringify({ version: 2, samples: withType })}\n`,
		);
	}
	const pad = paddingControl ?? defaultPaddingControl(scenario);

	const zoomDeviations = [];
	const zoomRegions = (e.zooms ?? []).map((z, i) => {
		const near = nearestZoomDepth(z.scale);
		if (Math.abs(near.value - z.scale) > 0.01) {
			zoomDeviations.push({ requested: z.scale, applied: near.value, depth: near.depth });
		}
		return {
			id: id("zoom", i + 1),
			startMs: Math.round(z.startSec * 1000),
			endMs: Math.round(z.endSec * 1000),
			depth: near.depth,
			focus: { cx: z.focus.x, cy: z.focus.y },
			mode: "manual",
		};
	});

	const webcamEnabled = Boolean(e.webcam?.enabled && (assets.webcam || null));
	const editor = {
		// `wallpaper` is deliberately not set: the scenario asks for the tool's own background,
		// so leaving the key out lets normalizeProjectEditor fill DEFAULT_WALLPAPER_PATH.
		//
		// It is also the only thing that works. `wallpaper` is not a path — BUILT_IN_WALLPAPERS
		// in src/lib/wallpapers.ts holds bare filenames like "tahoe-light.jpg", which the app
		// joins onto its own asset base. Given an absolute Windows path it produced
		//   C:\C%3A%5CUsers%5Cetien%5C...%5Cide-1080p60-60s.wallpaper.png
		// its base, then the whole path percent-encoded as one segment, logged "Failed to read
		// local file", rendered no background at all, and on the second read attempt crashed the
		// network service — which is what left the export dying on "VideoEncoder is not defined"
		// three steps downstream. A file:// URL fares no better.
		shadowIntensity: e.shadow?.enabled ? e.shadow.intensity : 0,
		borderRadius: e.cornerRadiusPx ?? 0,
		padding: { top: pad, bottom: pad, left: pad, right: pad, linked: true },
		cropRegion: { x: 0, y: 0, width: 1, height: 1 },
		zoomRegions,
		// Motion blur is split here into the composited-frame pass and the pointer's own.
		zoomMotionBlur: e.motionBlur?.enabled ? e.motionBlur.amount : 0,
		cursorMotionBlur: e.cursor?.motionBlur ? (e.motionBlur?.amount ?? 0.5) : 0,
		...(e.cursor?.enabled
			? {
					cursorSize: e.cursor.sizePercent / 100,
					cursorSmoothing: e.cursor.smoothing,
					cursorClickEffect: e.cursor.clickEffects ? "ripple" : "none",
				}
			: {}),
		...(webcamEnabled
			? {
					webcam: {
						enabled: true,
						sourcePath: assets.webcam,
						corner: e.webcam.position ?? "bottom-right",
						positionPreset: e.webcam.position ?? "bottom-right",
						size: (e.webcam.sizePercent ?? 25) / 100,
						cropRegion: { x: 0, y: 0, width: 1, height: 1 },
					},
				}
			: {}),
	};

	const doc = { version: 1, projectId: title, videoPath: localMedia, editor };
	const projectPath = join(outDir, `${title}.recordly`);
	writeFileSync(projectPath, `${JSON.stringify(doc, null, 2)}\n`);

	return {
		projectPath,
		mediaPath: localMedia,
		probe: p,
		paddingControl: pad,
		zoomDeviations,
		cursorTelemetry: cursorSamples,
		webcamApplied: webcamEnabled,
	};
}
