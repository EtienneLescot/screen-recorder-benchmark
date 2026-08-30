/**
 * Fetching a footage bundle from public URLs.
 *
 * The generated fixture is reproducible and looks synthetic; a personal recording looks real
 * and cannot leave the machine it was made on. A public URL is both: every machine downloads
 * the same bytes, checks them against a hash, and normalises them with the same documented
 * parameters — so a run on real footage is comparable across machines without anybody shipping
 * a video file.
 *
 * The normalisation is part of the protocol, not an implementation detail. Commons publishes
 * VP8/VP9/AV1 in WebM and every app here expects H.264 in MP4, so a transcode is unavoidable;
 * making it explicit and identical everywhere is what keeps it honest. Its parameters live in
 * `sources.json` beside the URLs, and the manifest records both hashes — the download's, which
 * must match everywhere, and the normalised file's, which will not, because encoders differ.
 *
 * Three things the first version of this benchmark got wrong and which are checked here:
 *
 *   · **Audio must survive.** Cap shipped a conforming AAC stream carrying digital silence for
 *     an entire round of results. A track existing is not a track working.
 *   · **Cursor telemetry has to be recreated.** A downloaded video never carries a sidecar, and
 *     without one the cursor stage — sprite, smoothing, motion blur, click effects — never
 *     runs. It is generated from the fixture seed, so it is identical on every machine.
 *   · **The bundle has to be verifiable after the fact**, not just at fetch time.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TARGET_OUTPUT } from "../scenarios/index.mjs";
import { writeOpenscreenCursor } from "./assets.mjs";
import { BENCH_ROOT, resolveFfmpeg } from "./env.mjs";
import { probe, sha256 } from "./fixture.mjs";
import { meanVolumeDb } from "./measure.mjs";
import { pickH264Encoder } from "./platform.mjs";

const UA = "openscreen-benchmark/0.1 (+https://github.com/EtienneLescot/screen-recorder-benchmark)";

export function loadSources() {
	const path = join(BENCH_ROOT, "sources.json");
	if (!existsSync(path)) throw new Error(`sources.json not found at ${path}`);
	return JSON.parse(readFileSync(path, "utf8"));
}

function download(url, dest, { log = () => undefined } = {}) {
	if (existsSync(dest)) return { path: dest, cached: true, sha256: sha256(dest) };
	mkdirSync(join(dest, ".."), { recursive: true });
	log(`  downloading ${url.split("/").pop()}`);
	execFileSync(
		"curl",
		[
			"-fL",
			"--retry",
			"3",
			"--retry-delay",
			"2",
			"-C",
			"-",
			"--max-time",
			"1800",
			"-A",
			UA,
			"-o",
			dest,
			url,
		],
		{ stdio: ["ignore", "ignore", "inherit"] },
	);
	return { path: dest, cached: false, sha256: sha256(dest) };
}

/**
 * Normalise a downloaded clip into what every app in the set can open: H.264 in MP4, trimmed,
 * with the audio carried through. Video is re-encoded because the source is WebM; audio is
 * re-encoded to AAC rather than copied, because Vorbis and Opus do not go into an MP4.
 */
function normalise(input, output, { trimSec, encoder, fps, log = () => undefined }) {
	const { ffmpeg } = resolveFfmpeg();
	const src = probe(input);
	if (!src.video) throw new Error(`${input} has no video stream`);

	const args = ["-hide_banner", "-loglevel", "error", "-y", ...(encoder.inputArgs ?? [])];
	if (trimSec) args.push("-t", String(trimSec));
	args.push("-i", input);
	// A hardware encoder whose frames live on the GPU needs the upload filter even here, where
	// there is otherwise no filter chain at all.
	if (encoder.filterSuffix) args.push("-vf", encoder.filterSuffix);
	// Conform the source to the output rate here, once, rather than leaving every app to do
	// it mid-export. Commons footage is 25 fps and the target is 60 — a rate every app must
	// hit because OpenScreen's MP4 path is fixed there. Left alone, each app converts in its
	// own way: duplicate frames costs almost nothing, motion interpolation costs a great
	// deal, and the ratio would then be measuring conversion strategy instead of compositing.
	// ffmpeg does it identically on every machine, before the stopwatch starts.
	if (fps) args.push("-r", String(fps));
	args.push("-c:v", encoder.encoder, ...encoder.rateArgs(12), "-profile:v", "high");
	// `-pix_fmt yuv420p` describes a frame in main memory. With a GPU-frame encoder the format is
	// already fixed by the upload filter, and naming a software pixel format here makes ffmpeg
	// refuse the stream outright.
	if (!encoder.hwFrames) args.push("-pix_fmt", "yuv420p");
	if (src.audio) args.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000");
	else args.push("-an");
	args.push("-movflags", "+faststart", output);

	log(`  normalising → h264/mp4 via ${encoder.encoder}${trimSec ? `, first ${trimSec}s` : ""}`);
	execFileSync(ffmpeg, args, { maxBuffer: 64 * 1024 * 1024 });
	return probe(output);
}

/**
 * Fetch, normalise and assemble a bundle. Returns the same shape `prepareBundle` does, so a run
 * cannot tell a public bundle from a local recording apart from what the manifest says.
 */
export function fetchBundle(workDir, name, { log = () => undefined, force = false } = {}) {
	const { bundles } = loadSources();
	const spec = bundles?.[name];
	if (!spec) {
		throw new Error(`Unknown bundle "${name}". Known: ${Object.keys(bundles ?? {}).join(", ")}`);
	}

	const dir = join(workDir, "sources", name);
	mkdirSync(dir, { recursive: true });
	const { ffmpeg } = resolveFfmpeg();
	const encoder = pickH264Encoder(ffmpeg);

	const check = (what, got, want, prefix) => {
		if (!want) return { verified: false, note: "no hash recorded in sources.json" };
		const ok = prefix ? got.startsWith(want) : got === want;
		if (!ok) {
			throw new Error(
				`${what}: downloaded bytes do not match sources.json (got ${got.slice(0, 16)}, expected ${want}). ` +
					"The upstream file changed, or the download was corrupted — either way the run would not be comparable.",
			);
		}
		return { verified: true };
	};

	/* ---- screen ------------------------------------------------------------------------ */
	const rawScreen = join(dir, `screen.raw${spec.screen.url.match(/\.\w+$/)?.[0] ?? ".webm"}`);
	const dl = download(spec.screen.url, rawScreen, { log });
	check("screen", dl.sha256, spec.screen.sha256, spec.screen.shaPrefix);
	const screen = join(dir, "screen.mp4");
	if (force || !existsSync(screen)) {
		normalise(rawScreen, screen, { trimSec: spec.trimSec, encoder, fps: TARGET_OUTPUT.fps, log });
	}
	const screenProbe = probe(screen);

	/* ---- camera ------------------------------------------------------------------------ */
	let webcam = null;
	if (spec.webcam) {
		const rawCam = join(dir, `camera.raw${spec.webcam.url.match(/\.\w+$/)?.[0] ?? ".webm"}`);
		const dlc = download(spec.webcam.url, rawCam, { log });
		check("camera", dlc.sha256, spec.webcam.sha256, spec.webcam.shaPrefix);
		webcam = join(dir, "camera.mp4");
		if (force || !existsSync(webcam)) {
			normalise(rawCam, webcam, { trimSec: spec.trimSec, encoder, fps: TARGET_OUTPUT.fps, log });
		}
	}

	/* ---- audio, verified rather than assumed -------------------------------------------- */
	const audioDb = screenProbe.audio ? meanVolumeDb(screen) : null;
	if (screenProbe.audio && (audioDb == null || audioDb < -60)) {
		throw new Error(
			`the normalised screen track is silent (mean ${audioDb} dBFS). The source has audio, so ` +
				"something dropped it — a run from this bundle would measure less work than it claims.",
		);
	}

	/* ---- cursor telemetry, recreated ---------------------------------------------------- */
	// A downloaded clip carries none, and without it the whole cursor stage of every
	// compositor sits idle. Generated from the fixture seed so it is identical everywhere;
	// it does not follow the pointer visible in the footage, and the manifest says so.
	let cursorPath = null;
	if (spec.cursor === "generated") {
		const genSpec = { seed: 20260825, durationSec: screenProbe.durationSec ?? spec.trimSec ?? 60 };
		cursorPath = writeOpenscreenCursor(screen, genSpec);
	}

	const manifest = {
		bundle: name,
		fetchedAt: new Date().toISOString(),
		protocol: {
			normalisation: `h264 (${encoder.encoder}) / mp4, aac 192k 48kHz${spec.trimSec ? `, first ${spec.trimSec}s` : ""}`,
			encoderIsHardware: encoder.hardware,
			ffmpeg: (() => {
				try {
					return execFileSync(ffmpeg, ["-hide_banner", "-version"], { encoding: "utf8" }).split(
						"\n",
					)[0];
				} catch {
					return null;
				}
			})(),
		},
		screen: {
			url: spec.screen.url,
			downloadSha256: dl.sha256,
			normalisedSha256: sha256(screen),
			probe: screenProbe,
			meanVolumeDb: audioDb,
			licence: spec.screen.licence,
			attribution: spec.screen.attribution,
		},
		webcam: webcam
			? {
					url: spec.webcam.url,
					normalisedSha256: sha256(webcam),
					probe: probe(webcam),
					licence: spec.webcam.licence,
					attribution: spec.webcam.attribution,
				}
			: null,
		cursor: cursorPath ? { path: cursorPath, origin: "generated from seed 20260825" } : null,
		notes: spec.notes ?? [],
	};
	writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

	return {
		kind: "public-bundle",
		name,
		path: screen,
		probe: screenProbe,
		sha256: manifest.screen.normalisedSha256,
		downloadSha256: dl.sha256,
		audioDb,
		cursorPath,
		webcam,
		spec: null,
		manifest,
		notes: [
			`public bundle "${name}": ${spec.description ?? ""}`,
			`screen ${spec.screen.attribution} (${spec.screen.licence})`,
			...(spec.webcam ? [`camera ${spec.webcam.attribution} (${spec.webcam.licence})`] : []),
			`normalised: ${manifest.protocol.normalisation}`,
			...(spec.notes ?? []),
		],
	};
}
