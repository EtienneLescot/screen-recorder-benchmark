#!/usr/bin/env node
/**
 * openscreen export benchmark — entrypoint.
 *
 *   node benchmark/bench.mjs preflight        # one interactive gate, then walk away
 *   node benchmark/bench.mjs install
 *   node benchmark/bench.mjs run
 *   node benchmark/bench.mjs status --json    # safe to poll from anywhere, incl. a remote session
 *   node benchmark/bench.mjs report
 *
 * See benchmark/README.md for the methodology and benchmark/REMOTE.md for driving it from a
 * dispatched Claude Code session.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APPS, DEFAULT_APPS, installPlan, loadDriver, surveyApps } from "./apps.mjs";
import { aggregate, submissionWeight } from "./lib/aggregate.mjs";
import { buildWallpaper, buildWebcam } from "./lib/assets.mjs";
import {
	CALIBRATION_PATH,
	calibrateApp,
	calibrationFixture,
	loadCalibration,
	saveCalibration,
} from "./lib/calibrate.mjs";
import {
	BENCH_ROOT,
	CACHE_DIR,
	diskState,
	ensureWorkDirs,
	ffmpegVersion,
	machineFingerprint,
	powerState,
	RESULTS_DIR,
	WORK_DIR,
} from "./lib/env.mjs";
import { buildFixture, DEFAULT_SPEC, fixturePath, probe, sha256 } from "./lib/fixture.mjs";
import { installApp } from "./lib/install.mjs";
import { median } from "./lib/measure.mjs";
import {
	accessibilityGranted,
	pendingPermissionDialog,
	primeAutomation,
} from "./lib/permissions.mjs";
import { remoteDesktopActive } from "./lib/platform.mjs";
import { fetchBundle, loadSources } from "./lib/publicSource.mjs";
import { renderReport } from "./lib/report.mjs";
import { preconditionCheck, runApp } from "./lib/runner.mjs";
import { loadRoster, renderSite } from "./lib/site.mjs";
import { prepareBundle } from "./lib/sourceBundle.mjs";
import { newRunId, RunState } from "./lib/state.mjs";
import { buildSubmission, collectSubmissions, renderAggregate } from "./lib/submission.mjs";
import {
	appIsRunning,
	describeWindow,
	dumpMenus,
	hasScriptingDictionary,
	launchApp,
} from "./lib/uiScript.mjs";
import { inspectExport } from "./lib/visualCheck.mjs";
import { DEFAULT_SCENARIO, fidelity, getScenario } from "./scenarios/index.mjs";

/* ------------------------------------------------------------------------- argv ---------- */

function parseArgs(argv) {
	const [command = "help", ...rest] = argv;
	const flags = {};
	const positional = [];
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a.startsWith("--")) {
			const [k, inline] = a.slice(2).split("=");
			if (inline !== undefined) flags[k] = inline;
			else if (rest[i + 1] && !rest[i + 1].startsWith("--")) flags[k] = rest[++i];
			else flags[k] = true;
		} else positional.push(a);
	}
	return { command, flags, positional };
}

const log = (...a) => console.log(...a);
const listFlag = (v, fallback) =>
	typeof v === "string"
		? v
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
		: fallback;

/* ---------------------------------------------------------------------- commands --------- */

async function cmdDoctor() {
	ensureWorkDirs();
	const fp = machineFingerprint();
	const pre = preconditionCheck();
	let ff = null;
	try {
		ff = ffmpegVersion();
	} catch (e) {
		ff = { banner: `MISSING — ${e.message}`, source: null };
	}
	log("Machine");
	log(
		`  ${fp.chip} · ${fp.cpuCount} cores (${fp.performanceCores}P/${fp.efficiencyCores}E) · ${fp.memoryGiB} GiB`,
	);
	log(`  ${fp.osProduct} ${fp.osVersion} (${fp.osBuild}) · node ${fp.nodeVersion}`);
	for (const d of fp.displays) log(`  ${d}`);
	log("\nPreconditions");
	log(`  ${pre.ok ? "✓ ready" : `✗ ${pre.problems.join("; ")}`}`);
	log(`  disk: ${pre.disk.availableGiB} GiB free at ${pre.disk.path}`);
	log(`\nffmpeg\n  ${ff.banner}\n  source: ${ff.source}`);
	log("\nApps");
	for (const id of DEFAULT_APPS) {
		let driver;
		try {
			driver = await loadDriver(id);
		} catch (e) {
			log(`  ! ${id.padEnd(26)} driver not available: ${e.message.split("\n")[0]}`);
			continue;
		}
		const d = driver.detect();
		const dict = driver.appPath ? hasScriptingDictionary(driver.appPath) : false;
		log(
			`  ${d.installed ? "✓" : "·"} ${driver.displayName.padEnd(26)} ${(d.version ?? "").padEnd(14)}` +
				` automation=${driver.automation}${dict ? " (has AppleScript dictionary)" : ""}`,
		);
	}
}

async function cmdPreflight({ flags }) {
	ensureWorkDirs();
	const apps = listFlag(flags.apps, DEFAULT_APPS);
	const plan = installPlan(apps);

	log("═══ Preflight ═══\n");
	await cmdDoctor();

	/* ---------------------------------------------------------------- downloads --------- */
	const missing = plan.filter((m) => !existsSync(join("/Applications", m.appName)));
	log("\nDownloads needed");
	if (!missing.length) log("  (none — every app is already installed)");
	for (const m of missing) {
		log(`  ${m.appName.padEnd(22)} ~${m.approxMB} MB   ${m.licence}`);
		log(`     ${m.url ?? m.repo}`);
		for (const n of m.notes ?? []) log(`     note: ${n}`);
	}
	const totalMB = missing.reduce((s, m) => s + (m.approxMB ?? 0), 0);
	if (totalMB) log(`  total ≈ ${totalMB} MB  —  run \`bench.mjs install\` to fetch them`);

	/* -------------------------------------------------------------- permissions --------- */
	log("\nPermissions");
	if (!accessibilityGranted()) {
		log("  ✗ Accessibility is NOT granted to the process running this script.");
		log("    Without it System Events refuses every menu click and no GUI app can be driven.");
		log("    Grant it in System Settings → Privacy & Security → Accessibility, then re-run.");
	} else {
		log(
			"  ✓ Accessibility — System Events responds, so menus and the accessibility tree are reachable.",
		);
	}
	log(
		"  · Screen Recording is NOT needed: the benchmark never records, it imports a generated clip.",
	);

	// Every app gets one harmless scripted question. The first raises the macOS prompt and
	// blocks until answered; later ones are silent. Doing this here is the whole point of
	// preflight — it moves six mid-run ambushes into one sitting.
	const drivers = [];
	for (const id of apps) {
		try {
			drivers.push(await loadDriver(id));
		} catch {
			/* a driver that will not load is reported by doctor */
		}
	}
	const needPrompt = drivers.filter((d) => d.bundleId && d.appPath && existsSync(d.appPath));
	if (needPrompt.length) {
		log(`\n  Provoking the Apple Events prompt for ${needPrompt.length} app(s).`);
		log("  Each will raise a “… wants access to control …” dialog. Click Allow on every one —");
		log("  these are security settings, so nothing here can accept them for you.\n");
	}
	const permissions = [];
	for (const d of needPrompt) {
		process.stdout.write(`  ${d.displayName.padEnd(24)} `);
		const r = primeAutomation(d.bundleId);
		permissions.push({ app: d.displayName, ...r });
		log(
			r.status === "granted"
				? "✓ granted"
				: r.status === "denied"
					? "✗ DENIED — this app cannot be driven"
					: `… ${r.status}`,
		);
		const pending = pendingPermissionDialog();
		if (pending) log(`     still waiting on: ${pending.slice(0, 90)}…`);
	}

	/* ------------------------------------------------------- first-launch dialogs ------- */
	if (flags.launch) {
		log("\nOpening each GUI app once so its first-launch dialogs can be cleared.");
		log("Dismiss onboarding, consent and update prompts now — after this the run is unattended.\n");
		for (const d of drivers) {
			if (d.kind !== "gui" || !d.appPath || !existsSync(d.appPath)) continue;
			log(`  → ${d.displayName}`);
			try {
				await launchApp(d.appPath, d.processName);
			} catch (e) {
				log(`     could not launch: ${e.message.split("\n")[0]}`);
			}
		}
	} else {
		log(
			"\nRe-run with --launch to also open each GUI app once and clear its first-launch dialogs.",
		);
	}

	const denied = permissions.filter((p) => p.status === "denied");
	const status = {
		generatedAt: new Date().toISOString(),
		apps,
		missingInstalls: missing.map((m) => m.appName),
		totalDownloadMB: totalMB,
		accessibility: accessibilityGranted(),
		permissions,
		machine: machineFingerprint(),
		preconditions: preconditionCheck(),
	};
	mkdirSync(RESULTS_DIR, { recursive: true });
	writeFileSync(join(RESULTS_DIR, "preflight.json"), `${JSON.stringify(status, null, 2)}\n`);

	log("\n─────────────────────────────────────────");
	if (denied.length)
		log(`⚠ ${denied.length} app(s) denied automation: ${denied.map((d) => d.app).join(", ")}`);
	if (missing.length) log(`Next: node benchmark/bench.mjs install`);
	else log("Next: node benchmark/bench.mjs calibrate && node benchmark/bench.mjs run");
	log(`preflight complete — written to ${join(RESULTS_DIR, "preflight.json")}`);
}

async function cmdInstall({ flags }) {
	ensureWorkDirs();
	const apps = listFlag(flags.apps, DEFAULT_APPS);
	const plan = installPlan(apps);
	const cacheDir = join(WORK_DIR, "installers");
	const records = [];
	for (const spec of plan) {
		log(`${spec.appName}`);
		try {
			const rec = installApp(spec, { cacheDir, force: !!flags.force, log });
			records.push(rec);
			log(
				`  ${rec.status} — ${rec.version ?? "?"} — gatekeeper: ${rec.codesign.accepted ? "accepted" : "REJECTED"}`,
			);
		} catch (e) {
			records.push({ id: spec.id, status: "failed", error: e.message });
			log(`  ✗ ${e.message}`);
		}
	}
	writeFileSync(join(RESULTS_DIR, "install.json"), `${JSON.stringify(records, null, 2)}\n`);
	log(`\nWritten: ${join(RESULTS_DIR, "install.json")}`);
}

async function cmdFixture({ flags }) {
	ensureWorkDirs();
	const spec = { ...DEFAULT_SPEC };
	if (flags.duration) spec.durationSec = Number(flags.duration);
	if (flags.fps) spec.fps = Number(flags.fps);
	const r = buildFixture(WORK_DIR, spec, { force: !!flags.force, log });
	const wp = buildWallpaper(WORK_DIR, spec);
	const wc = buildWebcam(WORK_DIR, spec);
	log(`\nscreen    ${r.path}`);
	log(`          sha256 ${r.sha256}`);
	log(`          ${JSON.stringify(r.probe.video)}  ${(r.probe.sizeBytes / 1048576).toFixed(1)} MB`);
	log(`wallpaper ${wp.path}\n          sha256 ${wp.sha256}`);
	log(`webcam    ${wc.path}\n          sha256 ${wc.sha256}`);
	log(
		"\nCursor telemetry is written per app at prepare time, from the same seed — see lib/assets.mjs.",
	);
}

async function cmdRun({ flags }) {
	ensureWorkDirs();
	const apps = listFlag(flags.apps, DEFAULT_APPS);
	const scenario = getScenario(flags.scenario ?? DEFAULT_SCENARIO);
	const repetitions = Number(flags.reps ?? 3);
	const cooldownSec = Number(flags.cooldown ?? 45);
	const discardFirst = flags["no-warmup"] ? false : true;

	const spec = { ...DEFAULT_SPEC };
	// --source points the run at a real recording bundle instead of the generated fixture.
	// Credible to look at, not reproducible elsewhere; the report records which was used.
	// Three ways to source a run, in descending order of how well it travels:
	//   --bundle  public URLs, hash-checked, normalised by a documented protocol — reproducible
	//             on any machine and real footage
	//   (default) generated from a seed — reproducible, and obviously synthetic
	//   --source  a local recording — real, and not reproducible anywhere else
	const fixture = flags.bundle
		? fetchBundle(WORK_DIR, String(flags.bundle), { log })
		: flags.source
			? prepareBundle(WORK_DIR, String(flags.source), { log })
			: existsSync(fixturePath(WORK_DIR, spec))
				? {
						path: fixturePath(WORK_DIR, spec),
						probe: probe(fixturePath(WORK_DIR, spec)),
						sha256: sha256(fixturePath(WORK_DIR, spec)),
						spec,
					}
				: buildFixture(WORK_DIR, spec, { log });
	// A demo export is not just a screen clip: the scenario also needs a wallpaper to sample
	// and a camera track to composite. Both come from the same seed as the screen recording,
	// so they travel with it rather than being shipped.
	const wallpaper = buildWallpaper(WORK_DIR, spec);
	const assets = {
		wallpaper: wallpaper.path,
		jpeg: wallpaper.jpeg,
		webcam: buildWebcam(WORK_DIR, spec).path,
	};

	const calibration = loadCalibration();
	if (calibration.machine) {
		const here = machineFingerprint();
		if (
			calibration.machine.chip !== here.chip ||
			calibration.machine.osVersion !== here.osVersion
		) {
			log(
				`⚠ benchmark/calibration.json was solved on ${calibration.machine.chip} / macOS ${calibration.machine.osVersion}, ` +
					`not this machine. Re-run \`bench.mjs calibrate\` — app versions differ between machines and ` +
					`a stale padding solve makes the apps composite different rectangles.\n`,
			);
		}
	} else if (Object.keys(calibration.apps ?? {}).length) {
		log("⚠ benchmark/calibration.json has no machine stamp; re-run `bench.mjs calibrate`.\n");
	} else {
		log("· no calibration found — each driver will use its documented default padding.\n");
	}
	const runId = flags.id ?? newRunId();
	const state = new RunState(join(RESULTS_DIR, runId), runId);
	const outDir = join(WORK_DIR, "out", runId);
	mkdirSync(outDir, { recursive: true });

	const header = {
		runId,
		startedAt: new Date().toISOString(),
		scenario: {
			id: scenario.id,
			step: scenario.step ?? "S4",
			label: scenario.label,
			effects: scenario.effects,
			output: scenario.output,
		},
		repetitions,
		discardFirst,
		cooldownSec,
		machine: machineFingerprint(),
		power: powerState(),
		disk: diskState(),
		// Recorded at the top of the run so the submission can state it instead of asking the
		// submitter to remember. A streaming session is the heaviest down-weight in the protocol
		// and the only condition a CPU reading cannot see.
		conditions: (() => {
			const r = remoteDesktopActive();
			return { remoteDesktopActive: r.active, remoteDesktopReasons: r.reasons };
		})(),
		ffmpeg: (() => {
			try {
				return ffmpegVersion();
			} catch {
				return null;
			}
		})(),
		// `kind`, the bundle name and the download hash are what a submission needs to prove
		// which footage was measured; dropping them here made every submission claim
		// "generated" regardless of what actually ran.
		fixture: {
			kind: fixture.kind ?? "generated",
			name: fixture.name ?? null,
			path: fixture.path,
			sha256: fixture.sha256,
			downloadSha256: fixture.downloadSha256 ?? null,
			spec: fixture.spec,
			probe: fixture.probe,
		},
		assets: {
			wallpaper: { path: assets.wallpaper, sha256: sha256(assets.wallpaper) },
			webcam: { path: assets.webcam, sha256: sha256(assets.webcam), probe: probe(assets.webcam) },
		},
		calibration: calibration.apps
			? {
					generatedAt: calibration.generatedAt,
					targetInsetPercent: calibration.targetInsetPercent,
					apps: calibration.apps,
				}
			: null,
		apps,
	};
	state.event("run-started", header);
	state.writeStatus({ ...header, phase: "starting", completed: [], pending: apps });

	log(
		`run ${runId} · scenario "${scenario.id}" · ${repetitions}×${discardFirst ? " (+1 warm-up)" : ""}`,
	);
	log(`fixture ${fixture.path} (${fixture.sha256.slice(0, 12)})\n`);

	// Re-running one app into an existing run id is the documented way to pick up after a
	// failure (see REMOTE.md). Without this it silently discarded everything already measured.
	const prior = flags.append ? (state.readResults()?.results ?? []) : [];
	if (prior.length) log(`appending to ${prior.length} existing app result(s) in ${runId}\n`);
	const results = prior.filter((r) => !apps.includes(r.app));
	const localFloor = new Map();
	const interleaveFloor = !flags["no-local-floor"] && apps.length > 1;
	for (const [i, id] of apps.entries()) {
		let driver;
		try {
			driver = await loadDriver(id);
		} catch (e) {
			const rec = {
				app: id,
				skipped: true,
				reason: `driver failed to load: ${e.message}`,
				runs: [],
			};
			results.push(rec);
			state.event("app-skipped", rec);
			continue;
		}

		state.writeStatus({
			...header,
			phase: "running",
			current: { app: id, index: i + 1, of: apps.length },
			completed: results.map((r) => r.app),
			pending: apps.slice(i + 1),
		});

		// A floor measurement taken alongside *this* app, not once at the start of the run.
		//
		// The floor is what makes results comparable across machines: it does a fixed, known
		// amount of work, so an app's multiple of it says how expensive that app is in units of
		// this machine's encoder. But a single floor at the top of a run only normalises the
		// machine, not the moment — and background load moves between legs. Measured here:
		// OpenScreen's leg ran at 264% foreign CPU and Cap's at 194%, which is a difference
		// between the apps that has nothing to do with the apps. One floor per leg removes it.
		if (interleaveFloor && id !== "ffmpeg-baseline") {
			try {
				const floorDriver = await loadDriver("ffmpeg-baseline");
				const floorRec = await runApp(
					floorDriver,
					{
						workDir: WORK_DIR,
						outDir,
						scenario,
						source: fixture,
						assets,
						log: () => undefined,
						state: {},
					},
					// The same shape as the tools this divides: a discarded warm-up, then a median.
					// Measured once and cold, the denominator of the headline number was the
					// noisiest thing in the run — two legs of one run disagreed by 15 %, which
					// moved a tool's published cost from 1.284× to 1.077× while the other tool,
					// whose two floors happened to agree, stayed put to 0.4 %. And because an
					// aggregate edge is log((exportA/floorA) / (exportB/floorB)), floors that
					// disagree do not cancel — that noise goes straight into the ranking.
					// Four short ffmpeg runs per leg, about 50 s, against a leg that already
					// costs several minutes.
					{ repetitions: 3, discardFirst: true, cooldownSec: 5, log: () => undefined },
				);
				const scored = (floorRec.runs ?? []).filter((r) => !r.warmup && r.ok);
				const ms = median(scored.map((r) => r.exportMs).filter((x) => x != null));
				const bg = median(scored.map((r) => r.foreignCpuPercent).filter((x) => x != null));
				localFloor.set(id, { exportMs: ms, foreignCpuPercent: bg });
				if (ms) log(`  local floor for ${id}: ${(ms / 1000).toFixed(2)}s at ${bg}% background`);
			} catch (e) {
				log(`  local floor failed for ${id}: ${e.message?.slice(0, 120)}`);
			}
		}

		const calibrated = calibration.apps?.[id]?.paddingControl ?? null;
		const baseCtx = {
			workDir: WORK_DIR,
			outDir,
			scenario,
			source: fixture,
			assets,
			log,
			state,
			paddingControl: calibrated,
		};
		let rec;
		try {
			rec = await runApp(driver, baseCtx, { repetitions, discardFirst, cooldownSec, log });
		} catch (e) {
			rec = {
				app: id,
				displayName: driver.displayName,
				skipped: true,
				reason: `crashed: ${e.message}`,
				runs: [],
			};
			log(`  ✗ ${driver.displayName}: ${e.message}`);
		}
		// Carry the local floor onto the result so the report can normalise per leg rather than
		// against a number measured under different conditions.
		if (localFloor.has(id)) rec.localFloor = localFloor.get(id);
		results.push(rec);
		state.event("app-finished", rec);
		state.writeResults({ ...header, finishedAt: null, results });
	}

	// Closing control. A long run heat-soaks the SoC and the background load drifts, so an app
	// measured last is not measured under the same conditions as one measured first. Re-running
	// the floor at the end quantifies that drift instead of leaving it as an unstated caveat: if
	// the opening and closing controls agree, the ordering did not matter; if they do not, the
	// report says by how much.
	// Not gated on ffmpeg-baseline being in --apps. It is the unit, not a competitor, and the
	// README tells contributors to run `--apps cap,openscreen-cli` — which never put it in the
	// list, so the control never fired, driftRatio stayed null, and the schema rejected the
	// submission that the documented command produced.
	if (!flags["no-control"] && results.length > 1) {
		log("\nclosing control: re-running the floor to measure drift over the run");
		const driver = await loadDriver("ffmpeg-baseline");
		const baseCtx = {
			workDir: WORK_DIR,
			outDir,
			scenario,
			source: fixture,
			assets,
			log,
			state: {},
		};
		try {
			const rec = await runApp(driver, baseCtx, {
				// Same shape as the opening floor, or the drift ratio compares a median against
				// a cold single sample and reports the difference between two protocols as
				// drift. The short cooldown is the opening floor's, for the same reason.
				repetitions: 3,
				discardFirst: true,
				cooldownSec: 5,
				log,
			});
			rec.app = "ffmpeg-baseline-close";
			rec.displayName = "ffmpeg floor (closing control)";
			rec.isControl = true;
			results.push(rec);
			state.event("app-finished", rec);
		} catch (e) {
			log(`  closing control failed: ${e.message}`);
		}
	}

	const final = { ...header, finishedAt: new Date().toISOString(), results };
	state.writeResults(final);
	state.writeStatus({ ...final, phase: "done", completed: results.map((r) => r.app), pending: [] });
	state.event("run-finished", { apps: results.map((r) => r.app) });

	const report = renderReport(final);
	writeFileSync(join(state.dir, "report.md"), report.markdown);
	writeFileSync(join(state.dir, "report.html"), report.html);
	log(`\n${report.summaryText}`);
	log(`\nResults: ${state.dir}`);
}

/**
 * Solve each app's padding control so they all composite the same rectangle. Run once per
 * machine (and again after an app updates); the result is written to benchmark/calibration.json
 * and read automatically by `run`.
 */
async function cmdCalibrate({ flags }) {
	ensureWorkDirs();
	const apps = listFlag(flags.apps, DEFAULT_APPS);
	const scenario = getScenario(flags.scenario ?? DEFAULT_SCENARIO);
	const fixture = calibrationFixture(WORK_DIR, log);
	const calibWallpaper = buildWallpaper(WORK_DIR, fixture.spec);
	const calibAssets = {
		wallpaper: calibWallpaper.path,
		jpeg: calibWallpaper.jpeg,
		webcam: buildWebcam(WORK_DIR, fixture.spec).path,
	};
	const outDir = join(WORK_DIR, "out", "calibration");
	mkdirSync(outDir, { recursive: true });
	log(
		`calibrating padding against a ${fixture.spec.durationSec}s clip; target inset ${scenario.effects.paddingPercent}% of the short side\n`,
	);

	const entries = [];
	for (const id of apps) {
		let driver;
		try {
			driver = await loadDriver(id);
		} catch {
			continue;
		}
		if (!driver.detect().installed) {
			log(`${driver.displayName}: not installed, skipping`);
			continue;
		}
		if (typeof driver.defaultPaddingControl !== "function") {
			log(`${driver.displayName}: no padding control to calibrate`);
			entries.push({ app: id, paddingControl: null, reason: "driver exposes no padding control" });
			continue;
		}
		log(`${driver.displayName}:`);
		const ctx = {
			workDir: WORK_DIR,
			outDir,
			scenario,
			source: fixture,
			// Without these the calibrator solves padding against a scene with no wallpaper and
			// no camera — a different composition from the one the run will measure.
			assets: calibAssets,
			log,
			state: {},
			run: { index: 0 },
			commit: () => undefined,
		};
		try {
			const r = await calibrateApp(driver, ctx, { log });
			entries.push(r);
			log(
				`  -> padding=${r.paddingControl} gives ${r.achievedInsetPercent}%${r.withinTolerance ? "" : "  (best available; outside tolerance)"}`,
			);
		} catch (e) {
			log(`  x ${e.message}`);
			entries.push({ app: id, paddingControl: null, error: e.message?.slice(0, 400) });
		}
		try {
			await driver.cleanup(ctx);
		} catch {
			/* best effort */
		}
	}

	const path = saveCalibration(entries, {
		scenario: scenario.id,
		targetInsetPercent: scenario.effects.paddingPercent,
		fixture: { spec: fixture.spec, sha256: fixture.sha256 },
	});
	log(`\nWritten: ${path}`);
}

/**
 * Fetch a public footage bundle and report what it produced, without running a benchmark.
 *
 * Worth having on its own: it is the step that needs the network, it is the step that can fail
 * because an upstream file changed, and it is the step whose output somebody may want to
 * inspect before spending an hour measuring against it.
 */
async function cmdFetchSource({ flags, positional }) {
	ensureWorkDirs();
	const { bundles } = loadSources();
	const name = positional[0] ?? flags.bundle;
	if (!name) {
		log("usage: bench.mjs fetch-source <bundle> [--force]\n");
		log("bundles:");
		for (const [id, b] of Object.entries(bundles ?? {})) {
			log(`  ${id.padEnd(20)} ${b.description ?? ""}`);
			log(`  ${"".padEnd(20)} screen: ${b.screen.attribution} (${b.screen.licence})`);
			if (b.webcam) log(`  ${"".padEnd(20)} camera: ${b.webcam.attribution} (${b.webcam.licence})`);
		}
		return;
	}
	const b = fetchBundle(WORK_DIR, name, { log, force: !!flags.force });
	log(`\nscreen  ${b.path}`);
	log(
		`        ${b.probe.video.width}x${b.probe.video.height}@${b.probe.video.fps} · ${b.probe.durationSec?.toFixed(1)}s · audio ${b.audioDb} dBFS`,
	);
	log(`        download sha256 ${b.downloadSha256.slice(0, 16)} (must match everywhere)`);
	log(`        normalised sha256 ${b.sha256.slice(0, 16)} (differs by encoder — expected)`);
	if (b.webcam) log(`camera  ${b.webcam}`);
	if (b.cursorPath) log(`cursor  ${b.cursorPath} (generated — a downloaded clip carries none)`);
	log(`\nmanifest: ${join(WORK_DIR, "sources", name, "manifest.json")}`);
	log("\nAttribution for these clips is in CREDITS.md.");
}

/**
 * Turn a finished run into a submission — the only artefact meant to leave this machine.
 *
 * Seconds are included for context but the aggregate never reads them; what travels is each
 * tool's cost in units of the floor measured beside it.
 */
async function cmdSubmit({ flags }) {
	const fs = await import("node:fs");
	const runs = fs.existsSync(RESULTS_DIR)
		? fs
				.readdirSync(RESULTS_DIR)
				.filter((d) => fs.existsSync(join(RESULTS_DIR, d, "results.json")))
				.sort()
		: [];
	const runId = flags.run ?? runs[runs.length - 1];
	if (!runId) return log("No runs to submit.");
	const doc = new RunState(join(RESULTS_DIR, runId), runId).readResults();
	if (!doc) return log(`Run ${runId} has no results.json.`);

	const sub = buildSubmission(doc, {
		submitter: flags.as ? { name: String(flags.as) } : undefined,
	});
	const problems = [];
	if ((sub.measurements ?? []).length < 2) {
		problems.push(
			"fewer than two verified tools with a local floor — this cannot contribute a ratio",
		);
	}
	if (sub.source.kind !== "public-bundle") {
		problems.push(
			`source is "${sub.source.kind}"; submissions must use --bundle so two machines can prove they measured the same footage`,
		);
	}
	const { weight, reasons } = submissionWeight(sub);
	if (flags.json === undefined) {
		log(JSON.stringify(sub, null, 2));
	} else {
		log(JSON.stringify(sub));
	}
	if (problems.length) {
		console.error(`\n⚠ this submission would be rejected:\n  - ${problems.join("\n  - ")}`);
	}
	if (weight < 1) {
		console.error(`\n· it would be weighted ×${weight}: ${reasons.join("; ")}`);
	}
}

/** Fold every submission in the repository into one ranking. */
async function cmdAggregate({ flags }) {
	const subs = collectSubmissions(BENCH_ROOT);
	if (!subs.length) return log(`No submissions found under ${join(BENCH_ROOT, "submissions")}.`);
	const step = flags.step ?? null;
	const result = aggregate(subs, { step });
	if (flags.json) return log(JSON.stringify(result, null, 2));
	log(renderAggregate(result, { step, submissions: subs.length }));
}

/** Regenerate the published page from the submissions in the repository. */
/**
 * Regenerate CREDITS.md from sources.json.
 *
 * The footage is other people's work under licences that require attribution, so the credits
 * have to follow the manifest rather than someone's memory of it. CI fails if this output
 * differs from what is committed.
 */
async function cmdCredits() {
	const fs = await import("node:fs");
	const src = JSON.parse(fs.readFileSync(join(BENCH_ROOT, "sources.json"), "utf8"));
	const name = (t) => decodeURIComponent(t.page.split("/File:").pop()).replace(/_/g, " ");
	const track = (label, t) =>
		`**${label}** — [${name(t)}](${t.page})\nby ${t.attribution}. Licensed **${t.licence}**.\n`;

	const body = Object.entries(src.bundles)
		.map(([bundle, b]) => {
			const parts = [`## ${bundle}`, "", track("Screen track", b.screen)];
			if (b.webcam) parts.push(track("Camera track", b.webcam));
			return parts.join("\n");
		})
		.join("\n");

	fs.writeFileSync(
		join(BENCH_ROOT, "CREDITS.md"),
		`# Credits

The benchmark runs on public footage so that every machine measures the same bytes. Those clips
are other people's work, under licences that ask for attribution. This file is that attribution,
and it is generated from \`sources.json\` by \`node bench.mjs credits\` — if you add a bundle, add
it there and regenerate.

${body}
No clip is redistributed by this repository. They are downloaded at run time, verified against
the hashes in \`sources.json\`, and normalised locally; the exports made from them are not
published.

---

The generated fixture (\`lib/fixture.mjs\`, \`lib/assets.mjs\`) is original to this repository and
carries no third-party rights.
`,
	);
	log(`${join(BENCH_ROOT, "CREDITS.md")}  (${Object.keys(src.bundles).length} bundle(s))`);
}

/**
 * Rewrite the roster tables inside CANDIDATES.md from roster.json.
 *
 * The roster used to be written out in prose here and machine-readable there, which is two
 * copies of one fact — they had already drifted. roster.json is the source; this renders it.
 */
async function cmdRoster() {
	const fs = await import("node:fs");
	const tools = loadRoster(BENCH_ROOT);
	const PLATFORMS = [
		["macos", "macOS"],
		["windows", "Windows"],
		["linux", "Linux"],
	];

	// Membership, not capability: `n/a` says the product is not on the platform at all, which is
	// the finding a short table carries.
	const member = (v) => v === "✓" || v === "degraded";
	const blocks = PLATFORMS.map(([key, label]) => {
		const on = tools.filter((t) => member(t[key]));
		const rows = on
			.map((t) => {
				// A per-platform note already says what the cell says; prefixing it repeats itself.
				const own = t.notes?.[key];
				const flag = !own && t[key] === "degraded" ? "degraded — " : "";
				return `| **${t.tool}** | ${flag}${own ?? t.note} |`;
			})
			.join("\n");
		const missing = tools.filter((t) => t[key] === "n/a").map((t) => t.tool);
		const tail = missing.length ? `Not on ${label}: ${missing.join(", ")}.` : "";
		return `### ${label} — ${on.length}\n\n| Tool | Status |\n|---|---|\n${rows}\n${tail ? `\n${tail}\n` : ""}`;
	});

	// Which roster entries have an adapter, and why the rest do not — joined rather than listed.
	const { APPS } = await import("./apps.mjs");
	const adapters = new Map();
	for (const [key, entry] of Object.entries(APPS)) {
		if (!entry.roster) continue;
		const prev = adapters.get(entry.roster) ?? { keys: [], blocker: null };
		prev.keys.push(key);
		prev.blocker ??= entry.blocker ?? null;
		adapters.set(entry.roster, prev);
	}
	const statusRows = tools
		.map((t) => {
			const a = adapters.get(t.tool);
			const adapter = a ? `yes (${a.keys.join(", ")})` : "**no**";
			const blocker = a ? (a.blocker ?? "—") : "adapter wanted";
			return `| ${t.tool} | ${adapter} | ${a && !a.blocker ? "yes" : "**no**"} | ${blocker} |`;
		})
		.join("\n");
	const statusTable = `| Tool | Adapter | Measured | Blocker |\n|---|---|---|---|\n${statusRows}`;

	const path = join(BENCH_ROOT, "CANDIDATES.md");
	let doc = fs.readFileSync(path, "utf8");
	const splice = (text, tag, body) => {
		const START = `<!-- ${tag}:start -->`;
		const END = `<!-- ${tag}:end -->`;
		const i = text.indexOf(START);
		const j = text.indexOf(END);
		if (i < 0 || j < 0) throw new Error(`CANDIDATES.md is missing the ${tag} markers`);
		return `${text.slice(0, i + START.length)}\n\n${body}\n${text.slice(j)}`;
	};
	doc = splice(doc, "roster", blocks.join("\n"));
	doc = splice(doc, "status", statusTable);
	fs.writeFileSync(path, doc);
	log(`${path}  (${tools.length} tool(s), ${adapters.size} with adapters)`);
}

async function cmdSite() {
	const fs = await import("node:fs");
	const subs = collectSubmissions(BENCH_ROOT);
	const result = aggregate(subs, { step: "S4" });
	const html = renderSite(result, {
		submissions: subs.length,
		// The newest submission, not the wall clock: the reader wants to know how fresh the
		// data is, and a build stamp would also make CI's staleness check fail every day
		// simply because the date moved on.
		generatedAt:
			subs
				.map((s) => s.submittedAt ?? "")
				.sort()
				.at(-1)
				?.slice(0, 10) ?? "no data",
		roster: loadRoster(BENCH_ROOT),
	});
	const out = join(BENCH_ROOT, "docs", "index.html");
	fs.mkdirSync(join(BENCH_ROOT, "docs"), { recursive: true });
	fs.writeFileSync(out, `${html}\n`);
	fs.writeFileSync(
		join(BENCH_ROOT, "docs", "aggregate.json"),
		`${JSON.stringify(result, null, 2)}\n`,
	);
	log(`${out}  (${subs.length} submission(s), ${result.tools.length} tool(s))`);
}

/**
 * What can be measured here — the first thing to run on a new machine.
 *
 * Separates "no adapter on this platform" from "not installed" from "installed but blocked by
 * the vendor", because those are three different answers and only the middle one is fixed by
 * running `install`.
 */
async function cmdApps() {
	const rows = await surveyApps();
	const ready = rows.filter((r) => r.installed && !r.blocker);
	log("tool                  status        version         driven by");
	for (const r of rows) {
		const status = !r.supported
			? "n/a"
			: r.blocker
				? "blocked"
				: r.installed
					? "ready"
					: "not installed";
		log(
			`${r.id.padEnd(20)}  ${status.padEnd(13)} ${(r.version ?? "").padEnd(15)} ${r.automation ?? ""}`,
		);
		if (r.blocker) log(`${"".padEnd(22)}↳ ${r.blocker}`);
		else if (r.reason && r.reason !== "not installed") log(`${"".padEnd(22)}↳ ${r.reason}`);
	}
	const floor = rows.find((r) => r.id === "ffmpeg-baseline");
	if (floor && !floor.installed) {
		log("");
		log("⚠ the floor is missing, and nothing is comparable across machines without it.");
	}
	log("");
	log(`ready to measure: ${ready.map((r) => r.id).join(", ") || "none"}`);
	log(`default set:      ${DEFAULT_APPS.join(", ")}`);
	log("");
	log("Pick your own with --apps:");
	log(
		`  node bench.mjs run --bundle commons-upload --apps ${
			ready
				.slice(0, 2)
				.map((r) => r.id)
				.join(",") || "toolA,toolB"
		}`,
	);
	log("");
	log("A submission needs at least two tools measured together; which two is up to you.");
}

async function cmdStatus({ flags }) {
	const runs = existsSync(RESULTS_DIR)
		? readFileSync
			? (await import("node:fs"))
					.readdirSync(RESULTS_DIR)
					.filter((d) => /^\d{8}T/.test(d))
					.sort()
			: []
		: [];
	const runId = flags.run ?? runs[runs.length - 1];
	if (!runId) {
		const out = { phase: "no-runs" };
		log(flags.json ? JSON.stringify(out) : "No runs yet.");
		return;
	}
	const state = new RunState(join(RESULTS_DIR, runId), runId);
	const status = state.readStatus();
	if (flags.json) {
		log(JSON.stringify(status ?? { runId, phase: "unknown" }, null, 2));
		return;
	}
	if (!status) return log(`Run ${runId}: no status file.`);
	log(`Run ${runId} — ${status.phase}`);
	if (status.current)
		log(`  current: ${status.current.app} (${status.current.index}/${status.current.of})`);
	log(`  done: ${(status.completed ?? []).join(", ") || "none"}`);
	log(`  left: ${(status.pending ?? []).join(", ") || "none"}`);
}

/**
 * Re-adjudicate a finished run's outputs against the current verifier.
 *
 * A detector improves after a run has been measured — this one was wrong twice — and
 * re-measuring to pick up the fix costs an hour and changes the timings, which were never in
 * question. The exports are still on disk, so the pixel checks and the fidelity they decide can
 * simply be recomputed. Timings are never touched.
 */
/** The most recently started run, by folder mtime — ids are not always timestamps. */
function latestRunId() {
	if (!existsSync(RESULTS_DIR)) return null;
	const dirs = readdirSync(RESULTS_DIR, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => ({ id: d.name, t: statSync(join(RESULTS_DIR, d.name)).mtimeMs }))
		.sort((a, b) => b.t - a.t);
	return dirs[0]?.id ?? null;
}

async function cmdReverify({ flags }) {
	const fs = await import("node:fs");
	const runId = flags.run ?? latestRunId();
	if (!runId) return log("No runs to re-verify.");
	const state = new RunState(join(RESULTS_DIR, runId), runId);
	const doc = state.readResults();
	if (!doc) return log(`Run ${runId} has no results.json.`);

	const scenario = getScenario(doc.scenario?.id ?? DEFAULT_SCENARIO);
	const spec = doc.fixture?.spec ?? null;
	const cursorPath = doc.fixture?.cursorPath ?? null;

	for (const app of doc.results ?? []) {
		for (const run of app.runs ?? []) {
			if (!run.outputPath || !fs.existsSync(run.outputPath)) continue;
			try {
				run.visual = inspectExport(run.outputPath, scenario, {
					probe: run.outputProbe ?? probe(run.outputPath),
					spec,
					cursorPath,
				});
				run.effectsVerified = run.visual.allPassed ?? null;
				run.contradicted = Object.entries(run.visual.checks ?? {})
					.filter(([, ok]) => ok === false)
					.map(([k]) => k);
			} catch (e) {
				run.visual = { error: e.message?.slice(0, 300), allPassed: null };
			}
		}
		// Fidelity follows the pixels, exactly as it does during a run: start from what the
		// driver reported applying and remove only what the verifier contradicts. Starting from
		// what the scenario *wants* would credit an app for every stage no check happens to
		// cover — it silently promoted the encode-only floor from 0.2 to 0.4.
		const contradicted = new Set((app.runs ?? []).flatMap((r) => r.contradicted ?? []));
		const pristine = app.fidelity?.appliedByDriver ?? app.fidelity?.applied ?? [];
		const applied = pristine.filter((f) => !contradicted.has(f));
		app.fidelity = fidelity(scenario, applied);
		app.fidelity.appliedByDriver = pristine;
		if (contradicted.size) app.fidelity.contradicted = [...contradicted];
		log(
			`${app.displayName}: fidelity ${app.fidelity.score}${app.fidelity.missing.length ? ` (missing ${app.fidelity.missing.join(", ")})` : ""}`,
		);
	}

	doc.reverifiedAt = new Date().toISOString();
	state.writeResults(doc);
	const report = renderReport(doc);
	fs.writeFileSync(join(state.dir, "report.md"), report.markdown);
	fs.writeFileSync(join(state.dir, "report.html"), report.html);
	log(`\nRe-verified ${runId}; timings untouched.`);
}

async function cmdReport({ flags }) {
	const fs = await import("node:fs");
	const runs = fs.existsSync(RESULTS_DIR)
		? fs
				.readdirSync(RESULTS_DIR)
				.filter((d) => /^\d{8}T/.test(d))
				.sort()
		: [];
	const runId = flags.run ?? runs[runs.length - 1];
	if (!runId) return log("No runs to report on.");
	const state = new RunState(join(RESULTS_DIR, runId), runId);
	const results = state.readResults();
	if (!results) return log(`Run ${runId} has no results.json yet.`);
	const report = renderReport(results);
	fs.writeFileSync(join(state.dir, "report.md"), report.markdown);
	fs.writeFileSync(join(state.dir, "report.html"), report.html);
	log(report.markdown);
	log(`\nWritten: ${join(state.dir, "report.md")} and report.html`);
}

/** Dump an app's menus and accessibility tree — how a GUI driver gets written or repaired. */
async function cmdDiscover({ positional, flags }) {
	const id = positional[0];
	if (!id) return log("usage: bench.mjs discover <app-id> [--window N] [--depth N]");
	const driver = await loadDriver(id);
	if (!driver.appPath) return log(`${id} has no app bundle.`);
	if (!existsSync(driver.appPath)) return log(`${driver.appPath} is not installed.`);

	log(`# ${driver.displayName}`);
	log(`bundle: ${driver.appPath}`);
	log(`AppleScript dictionary: ${hasScriptingDictionary(driver.appPath) ? "YES" : "no"}`);
	if (!appIsRunning(driver.processName)) {
		log(`launching ${driver.processName}…`);
		await launchApp(driver.appPath, driver.processName);
		await new Promise((r) => setTimeout(r, 4000));
	}
	log("\n## Menus");
	log(JSON.stringify(dumpMenus(driver.processName), null, 1));
	log("\n## Window accessibility tree");
	try {
		log(describeWindow(driver.processName, Number(flags.window ?? 1), Number(flags.depth ?? 4)));
	} catch (e) {
		log(`(could not read window: ${e.message})`);
	}
}

function cmdHelp() {
	log(`openscreen export benchmark

  doctor                    environment: hardware, power, load, ffmpeg, UI scripting
  apps                      what this machine can measure, and why anything is unavailable
  preflight [--launch]      the single interactive gate: what will be downloaded, what to grant
  install   [--apps a,b] [--force]
  calibrate [--apps a,b]    solve each app's padding control so they composite the same rect
  fixture   [--force] [--duration s] [--fps n]
  fetch-source <bundle> [--force]   download + verify + normalise public footage
  submit    [--run ID] [--as NAME]  turn a run into a submission on stdout
  aggregate [--step S4] [--json]    fold every submission into one ranking
  site                              regenerate docs/index.html from the submissions
  run       [--bundle NAME]      use a public footage bundle (reproducible, real)
            [--source FILE.mp4]  use a local recording (real, not reproducible elsewhere)
            [--apps a,b] [--scenario id] [--reps 3] [--cooldown 45] [--no-warmup] [--id NAME]
            [--append]  merge into an existing run id instead of replacing it
            [--no-control]  skip the closing drift control
            [--no-local-floor]  do not re-measure the floor before each app
  status    [--run ID] [--json]
  reverify  [--run ID]      re-run the pixel checks on a finished run; timings untouched
  report    [--run ID]
  discover  <app-id>        dump menus + accessibility tree (for writing a GUI driver)

apps: ${Object.keys(APPS).join(", ")}`);
}

const { command, flags, positional } = parseArgs(process.argv.slice(2));
const commands = {
	doctor: cmdDoctor,
	apps: cmdApps,
	preflight: cmdPreflight,
	install: cmdInstall,
	fixture: cmdFixture,
	run: cmdRun,
	status: cmdStatus,
	calibrate: cmdCalibrate,
	submit: cmdSubmit,
	aggregate: cmdAggregate,
	site: cmdSite,
	credits: cmdCredits,
	roster: cmdRoster,
	"fetch-source": cmdFetchSource,
	reverify: cmdReverify,
	report: cmdReport,
	discover: cmdDiscover,
	help: cmdHelp,
};
const fn = commands[command] ?? cmdHelp;
try {
	await fn({ flags, positional });
} catch (e) {
	console.error(`\n✗ ${e.stack ?? e.message}`);
	process.exit(1);
}
