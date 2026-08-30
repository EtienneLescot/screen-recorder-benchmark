/**
 * Not a competitor — the floor.
 *
 * A straight re-encode of the source at the target settings, with no compositing at all. It
 * answers the question the app-to-app numbers cannot: how much of an export is unavoidable
 * encoding work on this machine, and how much is the app's own pipeline. Every app's time
 * should be read as a multiple of this.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { ffmpegVersion, resolveFfmpeg } from "../lib/env.mjs";
import { pickH264Encoder } from "../lib/platform.mjs";

export default {
	id: "ffmpeg-baseline",
	displayName: "ffmpeg (re-encode floor)",
	vendor: "reference",
	kind: "reference",
	automation: "cli",
	// The sampler matches processes by argv prefix; without this the floor reported 0 CPU
	// seconds while every other row reported real ones.
	get appPath() {
		try {
			return resolveFfmpeg().ffmpeg;
		} catch {
			return null;
		}
	},
	processName: "ffmpeg",
	bundleId: null,
	install: null,

	detect() {
		try {
			const { ffmpeg, source } = resolveFfmpeg();
			const banner = ffmpegVersion().banner;
			const v = /ffmpeg version (\S+)/.exec(banner)?.[1] ?? "unknown";
			return { installed: true, version: `${v} (${source.split(":")[0]})`, path: ffmpeg };
		} catch {
			return {
				installed: false,
				version: null,
				path: null,
				error:
					process.platform === "win32"
						? "ffmpeg not found — `winget install Gyan.FFmpeg`, then reopen the terminal"
						: "ffmpeg not found — `brew install ffmpeg`, or set OSBENCH_FFMPEG/OSBENCH_FFPROBE",
			};
		}
	},

	async prepare(ctx) {
		// ctx.floorEncoder lets the same driver stand in for both floors: the hardware one every
		// cost is divided by, and the software companion that shows what the cores were doing at
		// the same moment. Absent, it behaves exactly as before.
		const enc = pickH264Encoder(resolveFfmpeg().ffmpeg, {
			prefer: ctx?.floorEncoder ?? "hardware",
		});
		if (!enc) throw new Error("no libx264 in this ffmpeg build; the software floor needs one");
		return {
			// The floor deliberately applies nothing. Listing the two output features it *does*
			// honour keeps the fidelity score honest rather than showing a bare zero.
			appliedFeatures: ["targetResolution", "targetFps"],
			notes: [
				`encoder: ${enc.encoder}${enc.hardware ? " (hardware)" : " (SOFTWARE)"}`,
				"No compositing: this row is the encode-only reference, not a product.",
				...(enc.note ? [enc.note] : []),
			],
		};
	},

	outputPath(ctx) {
		// The two floors must not write to the same file: run indices restart per leg, so a
		// software floor would silently overwrite the hardware one measured beside it.
		const kind = ctx.floorEncoder === "software" ? "-sw" : "";
		return join(ctx.outDir, `${this.id}${kind}-${ctx.scenario.id}-run${ctx.run.index}.mp4`);
	},

	async runExport(ctx) {
		const { ffmpeg } = resolveFfmpeg();
		const enc = pickH264Encoder(ffmpeg, { prefer: ctx?.floorEncoder ?? "hardware" });
		const out = this.outputPath(ctx);
		const t = ctx.scenario.output;

		// A hardware encoder may need its device opened before the input and its frames uploaded at
		// the end of the filter chain; on every other path both are empty and this is the same
		// command line as before.
		const args = [
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			...(enc.inputArgs ?? []),
			"-i",
			ctx.source.path,
			"-vf",
			[`scale=${t.width}:${t.height}:flags=bicubic`, "format=yuv420p", enc.filterSuffix]
				.filter(Boolean)
				.join(","),
			"-r",
			String(t.fps),
			"-c:v",
			enc.encoder,
			...enc.rateArgs(20),
			"-profile:v",
			"high",
			"-c:a",
			"aac",
			"-b:a",
			"128k",
			"-movflags",
			"+faststart",
			out,
		];

		return new Promise((resolve, reject) => {
			const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
			let stderr = "";
			child.stderr.on("data", (d) => {
				stderr += d.toString();
			});
			// The process is the export: commit the instant it is live.
			ctx.commit();
			child.on("error", reject);
			child.on("close", (code) => {
				if (code === 0) resolve();
				else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(0, 500)}`));
			});
		});
	},

	async cleanup() {
		// Nothing to tear down: the floor spawns one ffmpeg and it exits.
	},
};
