/**
 * Does the floor's bitrate change what the floor costs?
 *
 * The question behind it is whether `cost vs floor` is fair to a tool that encodes at a different
 * bitrate from the reference. On this run's own outputs the three sit a factor of two apart —
 * FocuSee 16.4 Mb/s, the floor 11.5, OpenScreen 8.0 — and FocuSee's export came in *below* the
 * floor it is divided by, which is the kind of result that deserves a measurement rather than an
 * explanation.
 *
 * So: the floor's exact command line, at four bitrates, alternating so machine drift lands on all
 * four rather than on whichever ran last. If the encode time barely moves, matching bitrates buys
 * nothing and the honest disclosure is the output size already carried in every submission. If it
 * moves, the denominator is measuring something the numerator did not ask for.
 *
 *   node scratch/floor-bitrate-ab.mjs [source.mp4] [rounds]
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveFfmpeg, WORK_DIR } from "../lib/env.mjs";
import { pickH264Encoder } from "../lib/platform.mjs";

const SOURCE = process.argv[2] ?? join(WORK_DIR, "sources", "commons-upload", "screen.mp4");
const ROUNDS = Number(process.argv[3] ?? 3);
const RATES = [8, 12, 16, 20];
const OUT = join(WORK_DIR, "out", "floor-bitrate-ab");

const { ffmpeg } = resolveFfmpeg();
const enc = pickH264Encoder(ffmpeg, { prefer: "hardware" });
if (!enc) throw new Error("no h264 encoder available");
mkdirSync(OUT, { recursive: true });

/** The floor's own command line, with only the rate moved. */
const encode = (mbps, tag) =>
	new Promise((resolve, reject) => {
		const args = [
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			...(enc.inputArgs ?? []),
			"-i",
			SOURCE,
			"-vf",
			["scale=1920:1080:flags=bicubic", "format=yuv420p", enc.filterSuffix]
				.filter(Boolean)
				.join(","),
			"-r",
			"60",
			"-c:v",
			enc.encoder,
			...enc.rateArgs(mbps),
			"-profile:v",
			"high",
			"-c:a",
			"aac",
			"-b:a",
			"128k",
			"-movflags",
			"+faststart",
			join(OUT, `floor-${mbps}M-${tag}.mp4`),
		];
		const t0 = performance.now();
		const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (d) => {
			stderr += d.toString();
		});
		child.on("error", reject);
		child.on("close", (code) =>
			code === 0
				? resolve((performance.now() - t0) / 1000)
				: reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 300)}`)),
		);
	});

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const times = new Map(RATES.map((r) => [r, []]));

console.log(`encoder ${enc.encoder}${enc.hardware ? " (hardware)" : " (software)"}`);
console.log(`source  ${SOURCE}\n`);
for (let round = 0; round < ROUNDS; round++) {
	// Reverse on odd rounds: a monotonic drift then falls on the low rates as often as the high.
	const order = round % 2 ? [...RATES].reverse() : RATES;
	for (const mbps of order) {
		const secs = await encode(mbps, `r${round}`);
		times.get(mbps).push(secs);
		console.log(`round ${round}  ${String(mbps).padStart(2)} Mb/s  ${secs.toFixed(2)}s`);
	}
}

console.log("\nrate     median   all");
for (const mbps of RATES) {
	const xs = times.get(mbps);
	console.log(
		`${String(mbps).padStart(2)} Mb/s  ${median(xs).toFixed(2)}s   ${xs.map((x) => x.toFixed(2)).join(" ")}`,
	);
}
const lo = median(times.get(RATES[0]));
const hi = median(times.get(RATES[RATES.length - 1]));
console.log(
	`\n${RATES[0]} -> ${RATES[RATES.length - 1]} Mb/s moves the floor by ${(((hi - lo) / lo) * 100).toFixed(1)}%`,
);
