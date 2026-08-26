/**
 * Using a real recording instead of the generated one.
 *
 * The generated fixture exists so two machines can prove they measured the same workload from a
 * hash. That is the right default for a benchmark and the wrong thing to show somebody: its
 * "code" is coloured rectangles, its cursor path is synthetic, and its webcam is a drawn face.
 * Nobody looks at an export of it and believes the number.
 *
 * So a run can be pointed at a real recording bundle instead — screen video, its cursor sidecar
 * and its camera track — and the trade is stated rather than hidden: real footage is credible
 * and not reproducible elsewhere; generated footage is reproducible and not credible. Both are
 * fingerprinted, and the report says which was used.
 *
 * A bundle is discovered from the screen video's own neighbours, which is how every one of
 * these apps lays a recording out:
 *
 *   recording-1785525977162.mp4                 ← the screen
 *   recording-1785525977162.mp4.cursor.json     ← OpenScreen's telemetry sidecar
 *   recording-1785525977162-webcam.webm         ← the camera track
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { resolveFfmpeg } from "./env.mjs";
import { probe, sha256 } from "./fixture.mjs";
import { pickH264Encoder } from "./platform.mjs";

/** Find the cursor sidecar and camera track that belong to a screen recording. */
export function discoverBundle(screenPath) {
	if (!existsSync(screenPath)) throw new Error(`source not found: ${screenPath}`);
	const dir = dirname(screenPath);
	const name = basename(screenPath);
	const stem = name.replace(extname(name), "");

	const cursor = [`${name}.cursor.json`, `${stem}.cursor.json`]
		.map((f) => join(dir, f))
		.find((f) => existsSync(f));

	// The camera track keeps the recording's stem with a `-webcam` suffix, in whatever container
	// the platform's capture path produced.
	const webcam = readdirSync(dir)
		.filter((f) => f.startsWith(`${stem}-webcam`) || f.startsWith(`${stem}.webcam`))
		.map((f) => join(dir, f))[0];

	return { screen: screenPath, cursor: cursor ?? null, webcam: webcam ?? null };
}

/**
 * Normalise a bundle into the work directory.
 *
 * The camera track is transcoded to H.264/MP4 when it is not already: capture writes VP8/WebM on
 * some platforms, and while Chromium-based editors decode that happily, a driver that hands it
 * straight to a native compositor gets a decode error rather than a benchmark. Doing it once
 * here means every app gets the same camera bytes.
 */
export function prepareBundle(workDir, screenPath, { log = () => undefined } = {}) {
	const found = discoverBundle(screenPath);
	const dir = join(workDir, "fixture");
	mkdirSync(dir, { recursive: true });

	let webcam = found.webcam;
	if (webcam && !/\.mp4$/i.test(webcam)) {
		const { ffmpeg } = resolveFfmpeg();
		const enc = pickH264Encoder(ffmpeg);
		const out = join(dir, `${basename(webcam, extname(webcam))}.mp4`);
		if (!existsSync(out)) {
			log(`source: transcoding camera track ${basename(webcam)} → mp4`);
			execFileSync(
				ffmpeg,
				[
					"-hide_banner",
					"-loglevel",
					"error",
					"-y",
					"-i",
					webcam,
					"-c:v",
					enc.encoder,
					...enc.rateArgs(6),
					"-pix_fmt",
					"yuv420p",
					"-an",
					"-movflags",
					"+faststart",
					out,
				],
				{ maxBuffer: 32 * 1024 * 1024 },
			);
		}
		webcam = out;
	}

	const p = probe(found.screen);
	const cursorSamples = found.cursor
		? (JSON.parse(readFileSync(found.cursor, "utf8")).samples ?? []).length
		: 0;

	return {
		kind: "recording",
		path: found.screen,
		probe: p,
		sha256: sha256(found.screen),
		cursorPath: found.cursor,
		cursorSamples,
		webcam,
		webcamSha256: webcam ? sha256(webcam) : null,
		// A real recording has no generator spec; drivers that need one fall back to copying the
		// bundle's own telemetry rather than synthesising a path.
		spec: null,
		notes: [
			`real recording: ${basename(found.screen)} (${p.durationSec?.toFixed(2)}s, ${p.video?.width}x${p.video?.height}@${p.video?.fps})`,
			found.cursor
				? `cursor telemetry: ${cursorSamples} samples from the capture itself`
				: "no cursor sidecar beside this recording — the cursor stage cannot run",
			webcam ? `camera track: ${basename(webcam)}` : "no camera track beside this recording",
			"NOT reproducible on another machine: compare the sha256 instead of regenerating.",
		],
	};
}
