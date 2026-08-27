/**
 * Cap (cap.so) — the other open-source entrant in this category.
 *
 * The only competitor here with a real command line: `Cap.app/Contents/MacOS/cap-cli export`
 * renders a `.cap` project with the app's full compositor, and takes `--fps`, `--resolution`
 * and `--quality`, so it can be pinned to the same output as everything else.
 *
 * A `.cap` project is a directory — `recording-meta.json` plus the media — and the editor
 * state lives beside it in `project-config.json`. Both are written directly, for the same
 * reason OpenScreen's project is: an edit typed into a UI is not reproducible.
 */
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { convertCursorForCap, writeCapCursor } from "../lib/assets.mjs";
import { resolveFfmpeg } from "../lib/env.mjs";
import { appVersion, IS_WIN, killProcesses, resolveAppPath } from "../lib/platform.mjs";

export const CAP = {
	macPath: "/Applications/Cap.app",
	winPaths: [
		"%LOCALAPPDATA%\\Programs\\Cap\\Cap.exe",
		"%ProgramFiles%\\Cap\\Cap.exe",
		"%LOCALAPPDATA%\\Cap\\Cap.exe",
	],
};

const APP = IS_WIN ? resolveAppPath(CAP) : "/Applications/Cap.app";
// The CLI sits beside the desktop binary on Windows and inside the bundle on macOS.
const CLI = APP
	? IS_WIN
		? APP.replace(/Cap\.exe$/i, "cap-cli.exe")
		: `${APP}/Contents/MacOS/cap-cli`
	: null;

/** #RRGGBB → the [r,g,b] triple Cap's colour background expects. */
const rgb = (hex) => {
	const h = hex.replace("#", "");
	return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
};

export default {
	id: "cap",
	displayName: "Cap",
	vendor: "Cap Software",
	kind: "cli",
	automation: "cli",
	processName: "Cap",
	appPath: APP,
	bundleId: "so.cap.desktop",
	install: {
		method: "dmg",
		url: "https://cap.so/download/apple-silicon",
		appName: "Cap.app",
		approxMB: 123,
		licence: "AGPL-3.0 — free",
	},

	detect() {
		if (!existsSync(CLI)) return { installed: false, version: null, path: null };
		// appVersion() already branches on platform; the inline `defaults` call this replaces
		// left every Windows row without a version, which the report prints as "—".
		const version = appVersion(APP);
		return { installed: true, version, path: CLI };
	},

	/** Cap's `background.padding` is 0-100 on its own scale; see `bench.mjs calibrate`. */
	defaultPaddingControl(scenario) {
		return scenario.effects.paddingPercent;
	},

	async prepare(ctx) {
		const e = ctx.scenario.effects;
		const dir = join(ctx.workDir, "projects", "cap");
		const project = join(dir, `${ctx.scenario.id}.cap`);
		rmSync(project, { recursive: true, force: true });
		mkdirSync(join(project, "content"), { recursive: true });
		copyFileSync(ctx.source.path, join(project, "content", "display.mp4"));

		// A demo export composites more than the screen: a camera track to mask and shadow, and
		// a pointer rendered from telemetry rather than baked into the recording.
		// Cap does not read audio out of the display video: a segment names its audio tracks
		// separately, and a project that names none exports a conforming AAC stream carrying
		// digital silence. Every metadata check passes it and every listener notices — which is
		// how this went unseen until somebody played the file.
		let hasAudio = false;
		if (ctx.source.probe.audio) {
			const audioPath = join(project, "content", "system-audio.m4a");
			try {
				execFileSync(
					resolveFfmpeg().ffmpeg,
					[
						"-hide_banner",
						"-loglevel",
						"error",
						"-y",
						"-i",
						ctx.source.path,
						"-vn",
						"-c:a",
						"copy",
						audioPath,
					],
					{ maxBuffer: 32 * 1024 * 1024 },
				);
				hasAudio = true;
			} catch {
				// Not every source's codec can be copied into an .m4a; re-encode rather than
				// silently shipping a project with no sound.
				execFileSync(
					resolveFfmpeg().ffmpeg,
					[
						"-hide_banner",
						"-loglevel",
						"error",
						"-y",
						"-i",
						ctx.source.path,
						"-vn",
						"-c:a",
						"aac",
						"-b:a",
						"192k",
						audioPath,
					],
					{ maxBuffer: 32 * 1024 * 1024 },
				);
				hasAudio = true;
			}
		}

		// A real recording's own camera track wins over the generated one.
		const cameraSource = ctx.source.webcam ?? ctx.assets?.webcam;
		const wantsCamera = e.webcam?.enabled && cameraSource;
		if (wantsCamera) copyFileSync(cameraSource, join(project, "content", "camera.mp4"));
		const wantsCursor = e.cursor?.enabled;
		if (wantsCursor) {
			// A real recording brings its own telemetry; only a generated fixture needs a
			// synthetic path.
			if (ctx.source.cursorPath && existsSync(ctx.source.cursorPath)) {
				convertCursorForCap(ctx.source.cursorPath, project);
			} else if (ctx.source.spec) {
				writeCapCursor(project, ctx.source.spec);
			}
		}
		// `source: "tool-default"` leaves Cap's own background alone, which is what the scenario
		// now asks for. A supplied image is still copied in when one is named.
		let wallpaperPath = null;
		const toolDefaultBackground =
			e.background?.kind === "image" && e.background.source === "tool-default";
		if (e.background?.kind === "image" && !toolDefaultBackground && ctx.assets?.wallpaper) {
			wallpaperPath = join(project, "content", "wallpaper.png");
			copyFileSync(ctx.assets.wallpaper, wallpaperPath);
		}

		// A single-segment studio recording: the smallest shape `cap project validate` accepts,
		// and the one an import would produce.
		// A *multi*-segment studio recording, not a single-segment one — because the cursor
		// sprite table lives only on MultipleSegments. Without it Cap parses the telemetry,
		// looks the cursor_id up in an absent map, resolves no shape, and therefore loads
		// neither an SVG nor an image: it draws nothing at all, silently. `CursorShape`
		// serialises as "kind|variant", and with a shape present Cap uses its own bundled SVG,
		// so the image_path is only there to satisfy the struct.
		writeFileSync(
			join(project, "recording-meta.json"),
			`${JSON.stringify(
				{
					platform: IS_WIN ? "Windows" : "MacOS",
					pretty_name: `openscreen-benchmark-${ctx.scenario.id}`,
					segments: [
						{
							display: {
								path: "content/display.mp4",
								fps: Math.round(ctx.source.probe.video.fps),
							},
							...(wantsCamera ? { camera: { path: "content/camera.mp4", fps: 30 } } : {}),
							...(hasAudio ? { system_audio: { path: "content/system-audio.m4a" } } : {}),
							...(wantsCursor ? { cursor: "content/cursor.json" } : {}),
						},
					],
					...(wantsCursor
						? {
								cursors: {
									0: {
										// camelCase: CursorMeta carries rename_all, unlike its neighbours in the same
										// file — an image_path key fails the whole untagged enum with an error that
										// names the document rather than the field.
										imagePath: "content/cursor.png",
										hotspot: { x: 0, y: 0 },
										shape: IS_WIN ? "Windows|Arrow" : "MacOS|Arrow",
									},
								},
							}
						: {}),
				},
				null,
				2,
			)}\n`,
		);

		// Start from Cap's own defaults so nothing unset drifts between versions, then apply
		// only what the scenario names.
		const base = JSON.parse(
			execFileSync(CLI, ["project", "config", "get", project], { encoding: "utf8" }),
		);
		const duration = ctx.source.probe.durationSec;

		// An image the compositor samples per pixel, not a fill it clears once — which is what
		// these apps' own wallpapers cost, and what the first version of this scenario missed.
		if (toolDefaultBackground) {
			// Whatever the template already carries — Cap's own default. The verifier checks that
			// it varies like an image rather than sitting flat, so a tool that defaults to a fill
			// is reported rather than assumed.
		} else if (wallpaperPath) {
			base.background.source = { type: "image", path: wallpaperPath };
		} else {
			base.background.source = {
				type: "color",
				value: rgb(e.background?.color ?? "#000000"),
				alpha: 255,
			};
		}
		base.background.blur = 0;
		base.background.padding = ctx.paddingControl ?? this.defaultPaddingControl(ctx.scenario);
		base.background.rounding = e.cornerRadiusPx;
		// Cap's `shadow` is 0-100; the scenario's intensity is 0-1.
		base.background.shadow = e.shadow?.enabled ? Math.round(e.shadow.intensity * 100) : 0;
		// Camera inset: masked, rounded and shadowed, in the same corner as every other app.
		base.camera.hide = !wantsCamera;
		if (wantsCamera) {
			base.camera.size = e.webcam.sizePercent ?? 25;
			base.camera.rounding = e.webcam.shape === "rounded" ? 25 : 0;
			base.camera.shadow = e.webcam.shadow ? 60 : 0;
			base.camera.position = { x: "right", y: "bottom" };
		}

		// Cursor: rendered from the telemetry written above, with the smoothing, size and
		// motion blur the scenario asks for.
		base.cursor.hide = !wantsCursor;
		if (wantsCursor) {
			base.cursor.size = e.cursor.sizePercent ?? 100;
			base.cursor.motionBlur = e.cursor.motionBlur ? 1 : 0;
			base.cursor.animationStyle = e.cursor.smoothing >= 0.5 ? "mellow" : "regular";
			base.cursor.raw = false;
		}

		base.screenMotionBlur = e.motionBlur?.enabled ? e.motionBlur.amount * 2 : 0;
		base.audio.mute = false;
		base.audio.systemVolumeDb = 0;

		base.timeline = {
			segments: [{ recordingSegment: 0, timescale: 1, start: 0, end: duration }],
			zoomSegments: (e.zooms ?? []).map((z) => ({
				start: z.startSec,
				end: z.endSec,
				amount: z.scale,
				mode: { manual: { x: z.focus.x, y: z.focus.y } },
			})),
			sceneSegments: [],
			maskSegments: [],
			textSegments: [],
			captionSegments: [],
			keyboardSegments: [],
			audioSegments: [],
			camera3dSegments: [],
		};

		// `config set` takes the whole document as one argv string and resets anything omitted,
		// which is why the defaults were read first rather than a partial patch being sent.
		execFileSync(
			CLI,
			["project", "config", "set", project, "--settings-json", JSON.stringify(base)],
			{
				encoding: "utf8",
				maxBuffer: 16 * 1024 * 1024,
			},
		);
		// Keep a copy beside the project so a run is auditable after the fact.
		writeFileSync(
			join(dir, `${ctx.scenario.id}-config.json`),
			`${JSON.stringify(base, null, 2)}\n`,
		);

		const verify = JSON.parse(
			execFileSync(CLI, ["project", "config", "get", project], { encoding: "utf8" }),
		);
		// Read back what Cap kept, not what was sent: `config set` silently resets anything it
		// will not accept, and claiming a feature the app dropped is how a benchmark lies.
		const applied = ["targetResolution", "targetFps"];
		if (["color", "image", "wallpaper", "gradient"].includes(verify.background?.source?.type)) {
			applied.push("background");
		}
		if (verify.background?.padding > 0) applied.push("padding");
		if (verify.background?.rounding > 0) applied.push("cornerRadius");
		if (verify.background?.shadow > 0) applied.push("shadow");
		if (verify.screenMotionBlur > 0) applied.push("motionBlur");
		if (wantsCursor && verify.cursor?.hide === false) applied.push("cursor");
		if (wantsCamera && verify.camera?.hide === false) applied.push("webcam");
		if (
			(verify.timeline?.zoomSegments ?? []).length === (e.zooms ?? []).length &&
			e.zooms?.length
		) {
			applied.push("zooms");
		}

		ctx.state.projectPath = project;
		return {
			appliedFeatures: applied,
			notes: [
				`project: ${project}`,
				`zoom segments written: ${(verify.timeline?.zoomSegments ?? []).length}`,
				`camera track: ${wantsCamera ? "content/camera.mp4" : "none"}; cursor telemetry: ${wantsCursor ? "content/cursor.json" : "none"}; audio: ${hasAudio ? "content/system-audio.m4a" : "none"}`,
			],
		};
	},

	outputPath(ctx) {
		return join(ctx.outDir, `${this.id}-${ctx.scenario.id}-run${ctx.run.index}.mp4`);
	},

	async runExport(ctx) {
		const out = this.outputPath(ctx);
		if (existsSync(out)) rmSync(out);
		const t = ctx.scenario.output;

		const args = [
			"export",
			ctx.state.projectPath,
			"--output",
			out,
			"--format",
			"mp4",
			"--fps",
			String(t.fps),
			"--resolution",
			`${t.width}x${t.height}`,
			"--quality",
			"maximum",
			"--progress-json",
		];

		return new Promise((resolve, reject) => {
			const child = spawn(CLI, args, { stdio: ["ignore", "pipe", "pipe"] });
			let committed = false;
			let stderrTail = "";
			let buf = "";
			child.stdout.on("data", (d) => {
				buf += d.toString();
				const lines = buf.split("\n");
				buf = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.trim()) continue;
					let ev;
					try {
						ev = JSON.parse(line);
					} catch {
						continue;
					}
					// First Progress event = the renderer is live. Same rule as the OpenScreen
					// driver: process start-up is warm-up, rendering is the measurement.
					if (!committed && (ev.type === "Progress" || ev.type === "Completed")) {
						committed = true;
						ctx.commit();
					}
					if (ev.type === "Error") stderrTail += `\n${ev.error}`;
				}
			});
			child.stderr.on("data", (d) => {
				stderrTail = (stderrTail + d.toString()).slice(-2000);
			});
			child.on("error", reject);
			child.on("close", (code) => {
				if (!committed) ctx.commit();
				if (code === 0) resolve();
				else reject(new Error(`cap export exited ${code}: ${stderrTail.trim().slice(0, 600)}`));
			});
		});
	},

	async cleanup() {
		// True on macOS, not on Windows: there `cap-cli export` leaves a Cap process alive that
		// keeps burning ~0.4 of a core indefinitely — measured at 2.56 CPU-seconds per 6 seconds
		// while idle. Every later leg then inherits it. Across two runs of this benchmark Cap's own
		// median went 23.0 s to 50.0 s while OpenScreen and the ffmpeg floor stayed flat in the
		// same runs, because the second run was still sharing the machine with the first's orphan.
		if (IS_WIN) killProcesses(["Cap", "cap-cli"]);
	},
};
