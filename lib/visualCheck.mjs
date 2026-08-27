/**
 * Did the app actually render the scenario?
 *
 * Probing an output for resolution and duration only proves a file exists. An app that ignored
 * the background, dropped the zooms, or silently rendered a smaller video rect finishes sooner
 * and looks faster, and no metadata check would notice. So every export is also inspected as
 * pixels:
 *
 *   · the frame's corners must be the scenario's background colour  → background applied
 *   · the content's bounding box gives the real inset               → padding, comparably measured
 *   · the box's corners must be background while its edges are not  → corner radius applied
 *   · temporal activity must spike inside the zoom windows          → zooms applied
 *
 * The measured inset matters as much as the pass/fail: two apps whose padding controls are on
 * different scales end up compositing different-sized rectangles, and the report has to be
 * able to say how close they were.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cursorTrack } from "./assets.mjs";
import { resolveFfmpeg } from "./env.mjs";

/** Decode a single frame to raw RGB at full resolution. */
function frameRgb(file, atSec, width, height) {
	const { ffmpeg } = resolveFfmpeg();
	const buf = execFileSync(
		ffmpeg,
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-ss",
			String(atSec),
			"-i",
			file,
			"-frames:v",
			"1",
			"-vf",
			`scale=${width}:${height}:flags=neighbor`,
			"-pix_fmt",
			"rgb24",
			"-f",
			"rawvideo",
			"-",
		],
		{ maxBuffer: 64 * 1024 * 1024, encoding: "buffer" },
	);
	return { data: buf, width, height };
}

/** Decode the whole clip small and grey, for the temporal-activity trace. */
function greyTrace(file, fps, width, height) {
	const { ffmpeg } = resolveFfmpeg();
	const buf = execFileSync(
		ffmpeg,
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-i",
			file,
			"-vf",
			`fps=${fps},scale=${width}:${height}:flags=bilinear,format=gray`,
			"-f",
			"rawvideo",
			"-",
		],
		{ maxBuffer: 256 * 1024 * 1024, encoding: "buffer" },
	);
	const frameSize = width * height;
	const frames = Math.floor(buf.length / frameSize);
	const activity = [];
	for (let f = 1; f < frames; f++) {
		let sum = 0;
		const a = (f - 1) * frameSize;
		const b = f * frameSize;
		for (let i = 0; i < frameSize; i += 3) sum += Math.abs(buf[b + i] - buf[a + i]);
		activity.push(sum / Math.ceil(frameSize / 3));
	}
	return { activity, fps };
}

const px = (img, x, y) => {
	const i = (y * img.width + x) * 3;
	return [img.data[i], img.data[i + 1], img.data[i + 2]];
};

const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Bounding box of the composited recording against whatever wallpaper is behind it.
 *
 * Relative, not absolute. The first version looked for pixels darker than luminance 90, which
 * only worked while every tool composited the same generated wallpaper *and* that wallpaper
 * happened to be light everywhere: its own dark corner read as content and returned the whole
 * frame as the box. Now that each tool brings its own background, an absolute threshold cannot
 * work at all.
 *
 * Each edge is walked inward from its own outermost pixel, which is background by construction,
 * and the box starts where a short run of pixels sits far from that local reference. Sampling
 * per edge rather than once for the frame keeps it honest on a gradient, where the left border
 * and the right border are legitimately different colours.
 */
function contentBoxAgainstBorder(img, { tolerance = 90, run = 4 } = {}) {
	const midY = Math.floor(img.height / 2);
	const midX = Math.floor(img.width / 2);
	const far = (ref) => (x, y, dx, dy) => {
		for (let k = 0; k < run; k++) {
			const xx = x + dx * k;
			const yy = y + dy * k;
			if (xx < 0 || yy < 0 || xx >= img.width || yy >= img.height) return false;
			if (dist(px(img, xx, yy), ref) <= tolerance) return false;
		}
		return true;
	};

	const leftRef = px(img, 0, midY);
	const rightRef = px(img, img.width - 1, midY);
	const topRef = px(img, midX, 0);
	const bottomRef = px(img, midX, img.height - 1);

	let left = 0;
	const fromLeft = far(leftRef);
	while (left < img.width - run && !fromLeft(left, midY, 1, 0)) left++;
	let right = img.width - 1;
	const fromRight = far(rightRef);
	while (right > left && !fromRight(right, midY, -1, 0)) right--;
	let top = 0;
	const fromTop = far(topRef);
	while (top < img.height - run && !fromTop(midX, top, 0, 1)) top++;
	let bottom = img.height - 1;
	const fromBottom = far(bottomRef);
	while (bottom > top && !fromBottom(midX, bottom, 0, -1)) bottom--;

	return {
		left,
		top,
		right,
		bottom,
		width: right - left + 1,
		height: bottom - top + 1,
		border: { left: leftRef, right: rightRef, top: topRef, bottom: bottomRef },
	};
}

/**
 * Is the border an image, or a flat fill?
 *
 * What the scenario actually asks for is "an image, not a flat colour" — a texture fetch per
 * pixel rather than one clear. That is a property of the border's variation, not of its
 * brightness, so it holds for any tool's own wallpaper. A gradient or a photograph spreads
 * across the samples; a fill does not move at all.
 */
function borderVariation(img, { samples = 24 } = {}) {
	const points = [];
	for (let i = 0; i < samples; i++) {
		const t = (i + 0.5) / samples;
		points.push(px(img, Math.floor(t * (img.width - 1)), 1));
		points.push(px(img, Math.floor(t * (img.width - 1)), img.height - 2));
		points.push(px(img, 1, Math.floor(t * (img.height - 1))));
		points.push(px(img, img.width - 2, Math.floor(t * (img.height - 1))));
	}
	let worst = 0;
	for (const a of points) for (const b of points) worst = Math.max(worst, dist(a, b));
	return worst;
}

/**
 * Is a pointer being drawn where the telemetry says it is?
 *
 * The first version of this compared the cursor's window against three windows in the frame's
 * corners, and passed videos with no cursor at all — because the corners are static sidebar
 * while the cursor path crosses the scrolling code, so it was measuring "is this region busier
 * than the edges". Verified against exports that draw no pointer at all: both scored 78×.
 *
 * The fix is to compare like with like. Control windows are spread *across the content*, over
 * the same scrolling material the cursor travels on, and the baseline is their 90th percentile
 * rather than their mean — so "the busiest ordinary place in the frame" is what a real cursor
 * has to beat.
 */
function cursorRendered(file, track, box, atSec, { W, H }) {
	const dt = 0.1;
	const a = frameRgb(file, atSec, W, H);
	const b = frameRgb(file, atSec + dt, W, H);
	// Sidecars are not always sampled at 60 Hz — a real capture wrote 1521 samples over 66 s —
	// so the sample nearest the wanted time is looked up rather than indexed by rate.
	const at = (t) => {
		const ms = t * 1000;
		let best = track[0];
		let bestD = Number.POSITIVE_INFINITY;
		for (const s of track) {
			const d = Math.abs(s.timeMs - ms);
			if (d < bestD) {
				bestD = d;
				best = s;
			}
		}
		return best;
	};

	const energy = (cx, cy, r = 26) => {
		const x0 = Math.max(0, Math.round(cx) - r);
		const y0 = Math.max(0, Math.round(cy) - r);
		const x1 = Math.min(W - 1, Math.round(cx) + r);
		const y1 = Math.min(H - 1, Math.round(cy) + r);
		let sum = 0;
		let n = 0;
		for (let y = y0; y <= y1; y += 2) {
			for (let x = x0; x <= x1; x += 2) {
				sum += Math.abs(luminance(px(a, x, y)) - luminance(px(b, x, y)));
				n++;
			}
		}
		return n ? sum / n : 0;
	};

	// Telemetry is normalised against the source frame, so it maps into the composited rect.
	const toFrame = (p) => [box.left + p.cx * box.width, box.top + p.cy * box.height];
	const [ax, ay] = toFrame(at(atSec));
	const [bx, by] = toFrame(at(atSec + dt));
	const onPath = Math.max(energy(ax, ay), energy(bx, by), energy((ax + bx) / 2, (ay + by) / 2));

	// A grid of controls over the content itself, skipping any that land near the cursor path.
	const controls = [];
	for (let gx = 1; gx <= 5; gx++) {
		for (let gy = 1; gy <= 3; gy++) {
			const cx = box.left + (box.width * gx) / 6;
			const cy = box.top + (box.height * gy) / 4;
			if (Math.hypot(cx - ax, cy - ay) < 90 || Math.hypot(cx - bx, cy - by) < 90) continue;
			controls.push(energy(cx, cy));
		}
	}
	controls.sort((x, y) => x - y);
	const p90 = controls.length ? controls[Math.floor(controls.length * 0.9)] : 0;
	const baseline = Math.max(0.5, p90);

	return {
		ratio: +(onPath / baseline).toFixed(2),
		onPath: +onPath.toFixed(2),
		baseline: +baseline.toFixed(2),
		controls: controls.length,
	};
}

/**
 * A handful of instants worth testing for a rendered pointer.
 *
 * Ranked by how far the pointer travels over a fixed ~150 ms span — measured over a span rather
 * than between adjacent samples, so the answer does not depend on the sidecar's rate: the
 * generated track is 60 Hz and a real capture wrote 23 Hz. Zoom windows and the clip's ends are
 * excluded, and the candidates are spread out so they cannot all land inside one glide.
 */
function cursorSampleTimes(track, effects, durationSec, { count = 5 } = {}) {
	const zoomWindows = (effects.zooms ?? []).map((z) => [z.startSec - 1, z.endSec + 1]);
	const span = 150;
	const scored = [];
	for (let i = 0; i < track.length; i++) {
		const t = track[i].timeMs / 1000;
		if (t < 1.5 || t > durationSec - 1.5) continue;
		if (zoomWindows.some(([a, b]) => t >= a && t <= b)) continue;
		let j = i;
		while (j < track.length - 1 && track[j].timeMs - track[i].timeMs < span) j++;
		if (j === i) continue;
		scored.push({ t, v: Math.hypot(track[j].cx - track[i].cx, track[j].cy - track[i].cy) });
	}
	scored.sort((a, b) => b.v - a.v);

	const picked = [];
	for (const { t } of scored) {
		if (picked.length >= count) break;
		// Keep them apart, or five candidates describe one moment.
		if (picked.every((p) => Math.abs(p - t) > durationSec / (count * 2))) picked.push(t);
	}
	return picked.length ? picked : [Math.min(2, durationSec / 2)];
}

/** A frame's broad colours, quantised so encode noise does not split one colour into many. */
function palette(img, keep = 6) {
	const bins = new Map();
	let n = 0;
	for (let y = 0; y < img.height; y += 2) {
		for (let x = 0; x < img.width; x += 2) {
			const [r, g, b] = px(img, x, y);
			const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
			const e = bins.get(key);
			if (e) {
				e.n++;
				e.r += r;
				e.g += g;
				e.b += b;
			} else {
				bins.set(key, { n: 1, r, g, b });
			}
			n++;
		}
	}
	return [...bins.values()]
		.sort((a, b) => b.n - a.n)
		.slice(0, keep)
		.map((e) => ({
			rgb: [Math.round(e.r / e.n), Math.round(e.g / e.n), Math.round(e.b / e.n)],
			share: +(e.n / Math.max(1, n)).toFixed(3),
		}));
}

/** A third of the frame, tucked into the named corner. */
function cornerBox(corner, W, H, frac = 0.34) {
	const rw = Math.round(W * frac);
	const rh = Math.round(H * frac);
	return {
		x0: corner.includes("right") ? W - rw : 0,
		y0: corner.includes("bottom") ? H - rh : 0,
		rw,
		rh,
	};
}

/** The control corner: mirrored horizontally, so it keeps the wallpaper's own vertical band. */
const mirrorCorner = (corner) =>
	corner.includes("right") ? corner.replace("right", "left") : corner.replace("left", "right");

/** How much of a box sits within `tol` of one colour. */
function nearFraction(img, b, rgb, tol = 90) {
	let hits = 0;
	let n = 0;
	for (let y = b.y0; y < b.y0 + b.rh; y += 3) {
		for (let x = b.x0; x < b.x0 + b.rw; x += 3) {
			n++;
			if (dist(px(img, x, y), rgb) < tol) hits++;
		}
	}
	return +(hits / Math.max(1, n)).toFixed(4);
}

/**
 * Is the camera track composited into the expected corner?
 *
 * This counted pixels near a hardcoded skin tone until 2026-08-27, which held only because the
 * generated fixture's camera is a face on a flat backdrop. Public bundles carry real footage —
 * commons-upload's camera clip opens on a green title card — and the check returned a false
 * negative on a render whose inset was plainly there, 105x100 px of it, bottom right.
 *
 * So the signature colour is read from the camera source itself, at the instant the export is
 * sampled, and it is trusted only once it has been shown to be *rare* elsewhere in the same
 * frame. The horizontally opposite corner is the control: same wallpaper band, same class of
 * screen content, no inset. Where nothing the camera is made of is rare there, this frame
 * cannot separate inset from background, and the check declines instead of guessing — the skin
 * tone that used to be hardcoded covers 22.7% of the control corner on one real export.
 */
function webcamRendered(img, { W, H }, corner, camFrame) {
	const control = cornerBox(mirrorCorner(corner), W, H);

	// Only colours the camera is broadly made of. A colour it barely contains would read as
	// absent from a correctly rendered inset too, and prove nothing either way.
	const candidates = palette(camFrame)
		.filter((c) => c.share >= 0.05)
		.map((c) => ({ ...c, control: nearFraction(img, control, c.rgb) }));

	// Distinctive: essentially absent from the corner that cannot hold the inset. Measured on
	// real exports — the camera's green title card scores 0 there, its own dark backdrop
	// 0.008 to 0.016, so 0.005 separates a usable signature from an ambiguous one.
	const usable = candidates.filter((c) => c.control < 0.005);
	if (!usable.length) return { decided: false };

	// One candidate, the one the camera holds most of — not the best-scoring of them. Trying
	// them all and keeping the strongest was tried on 2026-08-27 and is more sensitive but
	// less specific: it turns a mid blue-grey the camera barely contains into a positive
	// against a blue wallpaper, because the control corner is only a control for the content,
	// not for a wallpaper that differs left to right. Measured, that flipped a known-negative
	// export to "rendered". The cost of one candidate is a camera whose main colour the inset
	// crops away, which would read as absent; that has not been observed, and a false negative
	// is the safer of the two errors here.
	const pick = usable.sort((a, b) => b.share - a.share)[0];
	const inCorner = nearFraction(img, cornerBox(corner, W, H), pick.rgb);
	return {
		decided: true,
		// Measured: 0.0387 for Recordly's inset and 0.3671 for Cap's much larger one, against 0
		// for an export carrying none. 0.01 sits clear of both ends, and the ratio guards the
		// case where the signature turns out to be common in the target corner alone.
		rendered: inCorner > 0.01 && inCorner > 4 * pick.control,
		signature: pick.rgb,
		signatureShare: pick.share,
		inCorner,
		inControl: pick.control,
	};
}

const hexRgb = (hex) => {
	const h = (hex ?? "#000000").replace("#", "");
	return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
};

/**
 * Bounding box of everything that is not the background colour. Scanned from the middle rows
 * and columns so a drop shadow — which is background-ish but not exactly background — does not
 * drag the box outwards.
 */
function contentBox(img, bg, { contentTol = 120, run = 4 } = {}) {
	const midY = Math.floor(img.height / 2);
	const midX = Math.floor(img.width / 2);
	// A drop shadow is background-ish but not background, so "anything that is not exactly the
	// background" would find the shadow's outer edge. Requiring a short run of pixels that are
	// *far* from the background finds the video itself.
	const solid = (x, y, dx, dy) => {
		for (let k = 0; k < run; k++) {
			const xx = x + dx * k;
			const yy = y + dy * k;
			if (xx < 0 || yy < 0 || xx >= img.width || yy >= img.height) return false;
			if (dist(px(img, xx, yy), bg) <= contentTol) return false;
		}
		return true;
	};
	let left = 0;
	while (left < img.width - run && !solid(left, midY, 1, 0)) left++;
	let right = img.width - 1;
	while (right > left && !solid(right, midY, -1, 0)) right--;
	let top = 0;
	while (top < img.height - run && !solid(midX, top, 0, 1)) top++;
	let bottom = img.height - 1;
	while (bottom > top && !solid(midX, bottom, 0, -1)) bottom--;
	return { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 };
}

/**
 * @param {string} file            the exported video
 * @param {object} scenario        the scenario it was supposed to render
 * @param {object} opts.probe      ffprobe output for `file`
 */
export function inspectExport(
	file,
	scenario,
	{ probe, tolerance = 42, spec = null, cursorPath = null, webcamPath = null } = {},
) {
	const e = scenario.effects;
	const W = probe?.video?.width ?? scenario.output.width;
	const H = probe?.video?.height ?? scenario.output.height;
	const duration = probe?.durationSec ?? 0;

	// A reference instant that no zoom window covers, so the geometry read is of the resting
	// composition rather than a mid-animation frame.
	const zoomWindows = (e.zooms ?? []).map((z) => [z.startSec - 1, z.endSec + 1]);
	let refSec = 2;
	for (let t = 2; t < duration - 2; t += 0.5) {
		if (!zoomWindows.some(([a, b]) => t >= a && t <= b)) {
			refSec = t;
			break;
		}
	}

	const img = frameRgb(file, refSec, W, H);
	const result = { refSec, checks: {}, measured: {} };

	/* ---- background ------------------------------------------------------------------- */
	// An image background cannot be checked by colour equality, so geometry switches to
	// luminance: the composited recording is a dark editor and every wallpaper this benchmark
	// generates is light, which separates them cleanly. Skipping the check when the background
	// is an image — which is what the first version did — meant the padding, radius and
	// background stages went unverified precisely when they got more expensive.
	if (e.background?.kind === "image") {
		const box = contentBoxAgainstBorder(img);
		result.measured.contentBox = { ...box, border: undefined };
		result.measured.contentFraction = +((box.width * box.height) / (W * H)).toFixed(4);
		result.measured.insetPercentShortSide = +(
			(Math.min(box.left, box.top, W - 1 - box.right, H - 1 - box.bottom) / Math.min(W, H)) *
			100
		).toFixed(2);

		// A background was applied if the border varies like an image rather than sitting flat.
		// Nothing here assumes a particular wallpaper: each tool composites its own, and the
		// scenario asks only that it be an image.
		const variation = borderVariation(img);
		result.measured.borderVariation = Math.round(variation);
		result.checks.background = variation > 30;

		result.checks.padding = e.paddingPercent > 0 ? box.left > 2 && box.top > 2 : true;
		if (e.cornerRadiusPx > 0 && box.width > 40) {
			// At the box's own corner a rounded rect still shows background; a quarter along its
			// top edge it must show the recording. Both are judged against the border beside them
			// rather than against a fixed luminance.
			const ref = box.border.top;
			const atCorner = px(img, box.left + 1, box.top + 1);
			const alongEdge = px(img, box.left + Math.floor(box.width / 4), box.top + 3);
			result.measured.cornerIsBackground = dist(atCorner, ref) <= 90;
			result.measured.edgeIsContent = dist(alongEdge, ref) > 90;
			result.checks.cornerRadius =
				result.measured.cornerIsBackground && result.measured.edgeIsContent;
		}
	} else if (e.background?.kind === "solid") {
		const bg = hexRgb(e.background.color);
		const corners = [px(img, 2, 2), px(img, W - 3, 2), px(img, 2, H - 3), px(img, W - 3, H - 3)];
		const worst = Math.max(...corners.map((c) => dist(c, bg)));
		result.measured.cornerColor = corners[0];
		result.measured.cornerColorDistance = worst;
		result.checks.background = worst <= tolerance;

		/* ---- padding ------------------------------------------------------------------ */
		const box = contentBox(img, bg);
		result.measured.contentBox = box;
		result.measured.contentFraction = +((box.width * box.height) / (W * H)).toFixed(4);
		// Inset as a percent of the frame's short side — the same unit the scenario uses.
		result.measured.insetPercentShortSide = +(
			(Math.min(box.left, box.top, W - 1 - box.right, H - 1 - box.bottom) / Math.min(W, H)) *
			100
		).toFixed(2);
		result.checks.padding = e.paddingPercent > 0 ? box.left > 2 && box.top > 2 : true;

		/* ---- corner radius -------------------------------------------------------------- */
		if (e.cornerRadiusPx > 0 && box.width > 40) {
			// At the box's own corner a rounded rect still shows background; a quarter of the
			// way along its top edge it must show content. Both conditions together separate a
			// radius from a plain rectangle and from a missing video.
			const atCorner = px(img, box.left + 1, box.top + 1);
			const alongEdge = px(img, box.left + Math.floor(box.width / 4), box.top + 2);
			result.measured.cornerIsBackground = dist(atCorner, bg) <= tolerance;
			result.measured.edgeIsContent = dist(alongEdge, bg) > tolerance;
			result.checks.cornerRadius =
				result.measured.cornerIsBackground && result.measured.edgeIsContent;
		}
	}

	/* ---- zooms ------------------------------------------------------------------------ */
	if ((e.zooms ?? []).length) {
		const traceFps = 10;
		const { activity } = greyTrace(file, traceFps, 192, 108);
		const at = (sec) => Math.round(sec * traceFps);
		const windowMax = (a, b) =>
			Math.max(0, ...activity.slice(Math.max(0, at(a)), Math.min(activity.length, at(b))));

		// Baseline: the median of the whole trace. A zoom transition has to stand well clear of
		// it — the source itself is always moving, so an absolute threshold would not do.
		const sorted = [...activity].sort((x, y) => x - y);
		const baseline = sorted[Math.floor(sorted.length / 2)] || 1e-6;
		const spikes = e.zooms.map((z) => {
			const inRamp = Math.max(
				windowMax(z.startSec - 0.4, z.startSec + 1.2),
				windowMax(z.endSec - 0.4, z.endSec + 1.2),
			);
			return +(inRamp / baseline).toFixed(2);
		});
		result.measured.activityBaseline = +baseline.toFixed(3);
		result.measured.zoomSpikeRatios = spikes;
		// Every zoom must produce a transition at least 1.8× the resting activity.
		result.checks.zooms = spikes.every((s) => s >= 1.8);
	}

	/* ---- rendered cursor --------------------------------------------------------------- */
	// The track comes from the recording's own sidecar when there is one, and from the
	// generator's seed otherwise. Requiring a spec — as the first version did — meant this
	// check silently did not run for exactly the runs people look at, the ones driven from a
	// real recording.
	const track =
		cursorPath && existsSync(cursorPath)
			? (JSON.parse(readFileSync(cursorPath, "utf8")).samples ?? [])
			: spec
				? cursorTrack(spec)
				: null;
	// Only run this where it has been validated. On a real recording the check is unsound and
	// the reason is worth stating: the pointer's position correlates with content change even
	// when no pointer is drawn, because the UI under it reacts to hover. Cap scored 17.9 at an
	// instant whose frame contains no arrow at all — only a YouTube sidebar row lighting up
	// where the cursor had been during capture. The generated fixture has no hover states, so
	// there the motion at the pointer's position can only be the pointer.
	//
	// The sound fix is to diff the export against the *source* at that position rather than
	// against itself over time: a hover highlight appears in both and cancels, a drawn cursor
	// does not. That needs the source resampled through the same transform, and is not worth
	// guessing at a third time — so until it exists, a real-recording run reports the cursor
	// stage as unverified rather than answering it wrongly.
	if (e.cursor?.enabled && !track?.length) {
		result.measured.cursorNote = "no cursor telemetry available";
	} else if (e.cursor?.enabled && !spec) {
		result.measured.cursorNote =
			"not verified: on a real recording, hover states baked into the source are " +
			"indistinguishable from a rendered pointer by motion alone";
	} else if (e.cursor?.enabled && track?.length && result.measured.contentBox) {
		// Several candidate instants, best ratio wins.
		//
		// One sample is not enough, and the two obvious choices are both wrong. The resting
		// instant catches a real pointer sitting still (0.08 on an export whose cursor is
		// plainly in frame). Peak pointer velocity is worse on the generated clip, because the
		// scroll is fastest at the same moment — the controls rise with the signal and it
		// scored 0.49 with the arrow visible. Trying a spread and keeping the strongest is
		// sound: a false positive would need the content to be busier at the pointer's own
		// position than anywhere else, at some instant, which the controls already guard.
		const candidates = cursorSampleTimes(track, e, duration);
		try {
			// The same resting instant the geometry check uses, so both stages describe one
			// moment of the composition.
			let c = { ratio: 0, onPath: 0, baseline: 0 };
			let at = null;
			for (const t of candidates) {
				const trial = cursorRendered(file, track, result.measured.contentBox, t, { W, H });
				if (trial.ratio > c.ratio) {
					c = trial;
					at = t;
				}
			}
			result.measured.cursorSampledAtSec = at == null ? null : +at.toFixed(2);
			result.measured.cursorCandidates = candidates.length;
			result.measured.cursorMotionRatio = c.ratio;
			result.measured.cursorOnPath = c.onPath;
			result.measured.cursorBaseline = c.baseline;
			// Calibrated against real exports rather than guessed. Measured on this fixture:
			// OpenScreen 2.72 (its pointer and motion-blur trail are visible in the frame),
			// a tool that does draw one scores 2.7, and exports with no pointer score 1.15-1.27.
			// 2.0 sits between the confirmed positive and the confirmed negatives; the ratio
			// itself is recorded on every run so the margin is auditable rather than implied.
			result.checks.cursor = c.ratio >= 2;
		} catch (err) {
			result.measured.cursorError = err.message?.slice(0, 160);
		}
	}

	/* ---- webcam inset ------------------------------------------------------------------ */
	if (e.webcam?.enabled) {
		if (!webcamPath || !existsSync(webcamPath)) {
			result.measured.webcamNote =
				"not verified: the camera source was not supplied, so there is no signature to look for";
		} else {
			try {
				// Sampled at the same instant as the export, which assumes the app laid the camera
				// on the same timeline as the screen. A tool that offset it would read as absent.
				const cam = frameRgb(webcamPath, refSec, 320, 180);
				const wc = webcamRendered(img, { W, H }, e.webcam.position ?? "bottom-right", cam);
				if (wc.decided) {
					result.measured.webcamSignature = wc.signature;
					result.measured.webcamSignatureShare = wc.signatureShare;
					result.measured.webcamCornerFraction = wc.inCorner;
					result.measured.webcamControlFraction = wc.inControl;
					result.checks.webcam = wc.rendered;
				} else {
					// Left unset rather than false, the way the cursor check declines on a real
					// recording: an undecidable frame is not evidence that the app skipped it.
					result.measured.webcamNote =
						"not verified: no colour the camera is broadly made of is rare enough elsewhere in this frame to tell its inset apart from the background";
				}
			} catch (err) {
				result.measured.webcamError = err.message?.slice(0, 160);
			}
		}
	}

	/* ---- motion blur -------------------------------------------------------------------- */
	// Deliberately not asserted. Motion blur changes edge softness by an amount that depends on
	// the app's implementation and on local motion, and every threshold tried here passed some
	// correct renders and failed others. It is reported as configured, never as verified —
	// saying so is more useful than a check that means nothing.

	const failed = Object.entries(result.checks)
		.filter(([, v]) => v === false)
		.map(([k]) => k);
	result.allPassed = failed.length === 0;
	result.failed = failed;
	return result;
}
