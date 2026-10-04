/**
 * Making the apps composite the same rectangle.
 *
 * Every app in this set has a "padding" control, and no two of them are on the same scale:
 * asking each for "5" produced a 1.85% inset in Cap and a 10% inset in OpenScreen — a 44%
 * difference in the number of source pixels being sampled per frame. That is a confound, not a
 * result, so before the real run each app's control is solved for the value that yields the
 * scenario's inset.
 *
 * The solve is a secant search on a deliberately short clip: two probes to establish the app's
 * (usually near-linear) mapping, then up to two refinements. Everything is measured from the
 * rendered pixels, never from what the app claims, and the outcome is written to
 * benchmark/calibration.json so a run is reproducible without repeating it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { machineName } from "./aggregate.mjs";
import { BENCH_ROOT, machineFingerprint } from "./env.mjs";
import { buildFixture, DEFAULT_SPEC, probe } from "./fixture.mjs";
import { waitForStableFile } from "./measure.mjs";
import { inspectExport } from "./visualCheck.mjs";

export const CALIBRATION_PATH = join(BENCH_ROOT, "calibration.json");

/**
 * Every solve the file holds, one bucket per machine.
 *
 * The file used to *be* one bucket: a single `machine` stamp beside a single `apps` map. That
 * shape cannot hold two machines, so each `calibrate` deleted the previous machine's work —
 * committing a Mac's solves removed this laptop's, and solving Cap here removed the Mac's, 79
 * lines of somebody else's measurement gone from a committed file. The gate was right and the
 * container was too small.
 *
 * A pre-`machines` file reads forward as the one bucket it always was, so nobody loses a solve
 * by upgrading; the next save on any machine writes the new shape with that bucket kept.
 */
export function calibrationBuckets(doc) {
	if (Array.isArray(doc?.machines)) return doc.machines;
	return doc?.apps || doc?.machine ? [doc] : [];
}

function readCalibrationFile() {
	if (!existsSync(CALIBRATION_PATH)) return [];
	try {
		return calibrationBuckets(JSON.parse(readFileSync(CALIBRATION_PATH, "utf8")));
	} catch {
		return [];
	}
}

/** Every machine the file covers — for telling the user which, when none of them is this one. */
export function loadAllCalibrations() {
	return readCalibrationFile();
}

/**
 * This machine's solves, in the shape every reader already expects: `{ machine, apps, ... }`.
 *
 * Found with `sameMachine` rather than by a key derived from the stamp, so machine identity
 * stays decided in one place — and a bucket written before the chip name was trimmed still
 * matches the machine that wrote it.
 */
export function loadCalibration(here = machineFingerprint()) {
	const buckets = readCalibrationFile();
	return buckets[findMachine(buckets, here)] ?? {};
}

/**
 * Is a stored machine stamp the machine running now?
 *
 * Both sides go through `machineName` because a stamp is a *file*, written whenever it was
 * written. This laptop's calibration.json was stamped while the probe still recorded WMI's
 * padding, so comparing it byte-for-byte against a freshly trimmed name reports "a different
 * machine" about the very machine it was solved on. Both readers of the stamp act on that: `run`
 * warns that the padding solve is stale when it is not, and `saveCalibration` opens a second
 * bucket for a machine that already has one, losing the merge with its own earlier solves.
 *
 * Where both sides carry the anonymous machine id (`id` on a stamp, `machineId` on a live
 * fingerprint — see `anonymousMachineId`), the id decides alone. Chip and OS version were a
 * stand-in for it and wrong both ways: an OS update made the same Mac a stranger to its own
 * solves, and two M1 Macs on the same macOS were one machine that overwrote each other. A stamp
 * written before the id existed still matches on chip and OS version, and the next save on that
 * machine stamps it with the id.
 */
const idOf = (m) => m?.id ?? m?.machineId ?? null;

export const sameMachine = (a, b) =>
	idOf(a) && idOf(b)
		? idOf(a) === idOf(b)
		: machineName(a?.chip) === machineName(b?.chip) && a?.osVersion === b?.osVersion;

/**
 * Which bucket is this machine's: its own id first, an unstamped one only failing that.
 *
 * Without the order, a Mac with an id-stamped bucket would also match another Mac's pre-id
 * bucket on chip and OS version, and whichever came first in the file would win.
 */
export function findMachine(buckets, here) {
	const byId = idOf(here) ? buckets.findIndex((b) => idOf(b.machine) === idOf(here)) : -1;
	return byId >= 0 ? byId : buckets.findIndex((b) => sameMachine(b.machine, here));
}

/** A short clip: the geometry of the composition does not depend on how long the clip is. */
export function calibrationFixture(workDir, log = () => undefined) {
	const spec = { ...DEFAULT_SPEC, name: "calib-1080p60-4s", durationSec: 4 };
	return buildFixture(workDir, spec, { log });
}

async function measureInset(driver, ctx, paddingControl) {
	await driver.prepare({ ...ctx, paddingControl });
	const out = driver.outputPath(ctx);
	let committed = false;
	await driver.runExport({
		...ctx,
		paddingControl,
		commit: () => {
			committed = true;
		},
		// The rest of the callback contract runOnce() gives a driver — see lib/runner.mjs. Nothing
		// here times anything or keeps telemetry, but a driver is entitled to call all of them and
		// cannot know which harness is driving it. Supplying only `commit` meant Recordly, the one
		// adapter that reports what it saw, died on "ctx.observe is not a function" and then on
		// "ctx.markComplete is not a function" — so it went uncalibrated while the tools it is
		// ranked against did not, which is a silent confound rather than a visible failure.
		// The completion audit added a fourth callback and repeated the same mistake: FocuSee
		// died here on "ctx.observeComplete is not a function".
		observe: () => undefined,
		markComplete: () => undefined,
		observeComplete: () => undefined,
	});
	const wait = await waitForStableFile(out, { timeoutMs: 10 * 60 * 1000, stableMs: 1200 });
	if (!wait.ok) throw new Error(`calibration export produced nothing (${wait.reason})`);
	const p = probe(out);
	const v = inspectExport(out, ctx.scenario, { probe: p });
	const inset = v.measured?.insetPercentShortSide;
	if (inset == null) throw new Error("could not measure the content box");
	return { inset, box: v.measured.contentBox, checks: v.checks, committed };
}

/**
 * Solve one app's padding control for the scenario's target inset.
 * Returns the chosen control value plus every probe, so the calibration file shows its work.
 */
export async function calibrateApp(
	driver,
	ctx,
	{ tolerancePercent = 0.4, maxProbes = 4, log = () => undefined } = {},
) {
	const target = ctx.scenario.effects.paddingPercent;
	if (!target)
		return {
			app: driver.id,
			paddingControl: 0,
			target,
			probes: [],
			reason: "no padding requested",
		};
	if (typeof driver.defaultPaddingControl !== "function") {
		return {
			app: driver.id,
			paddingControl: null,
			target,
			probes: [],
			reason: "driver exposes no padding control",
		};
	}

	const probes = [];
	const seed = driver.defaultPaddingControl(ctx.scenario);
	// Two points far enough apart to establish the slope without leaving the control's range.
	let x0 = Math.max(0, seed * 0.5);
	let x1 = seed;

	const run = async (x) => {
		const m = await measureInset(driver, ctx, x);
		probes.push({ control: +x.toFixed(2), inset: m.inset, box: m.box });
		log(
			`  ${driver.id}: padding=${x.toFixed(2)} → inset ${m.inset}% (${m.box.width}×${m.box.height})`,
		);
		return m.inset;
	};

	let y0 = await run(x0);
	let y1 = await run(x1);

	for (let i = 0; i < maxProbes - 2; i++) {
		const best = probes.reduce((a, b) =>
			Math.abs(a.inset - target) <= Math.abs(b.inset - target) ? a : b,
		);
		if (Math.abs(best.inset - target) <= tolerancePercent) break;
		if (y1 === y0) break; // control has no effect in this range; stop rather than divide by zero
		// Secant step, clamped to a sane control range.
		let x2 = x1 + ((target - y1) * (x1 - x0)) / (y1 - y0);
		x2 = Math.max(0, Math.min(100, x2));
		if (!Number.isFinite(x2) || probes.some((p) => Math.abs(p.control - x2) < 0.05)) break;
		const y2 = await run(x2);
		x0 = x1;
		y0 = y1;
		x1 = x2;
		y1 = y2;
	}

	const best = probes.reduce((a, b) =>
		Math.abs(a.inset - target) <= Math.abs(b.inset - target) ? a : b,
	);
	return {
		app: driver.id,
		target,
		paddingControl: best.control,
		achievedInsetPercent: best.inset,
		achievedBox: best.box,
		withinTolerance: Math.abs(best.inset - target) <= tolerancePercent,
		probes,
	};
}

/**
 * Put one machine's bucket into the list, replacing that machine's own entry and nobody else's.
 *
 * Pure, and exported for the test: the eviction this file used to commit was a property of
 * exactly this fold, so this is the only place a test can pin it down.
 */
export function mergeCalibration(buckets, bucket) {
	const i = findMachine(buckets, bucket.machine);
	return i < 0 ? [...buckets, bucket] : buckets.map((b, j) => (j === i ? bucket : b));
}

export function saveCalibration(entries, meta) {
	mkdirSync(BENCH_ROOT, { recursive: true });
	const m = machineFingerprint();
	const buckets = readCalibrationFile();
	const previous = loadCalibration(m);
	const bucket = {
		generatedAt: new Date().toISOString(),
		// Stamped so `run` can tell which machine a solve belongs to. The padding a control
		// produces is a property of the app, not the machine, but app versions differ between
		// machines and a silently stale solve is worse than none.
		machine: { chip: m.chip, osVersion: m.osVersion, model: m.model, id: m.machineId ?? null },
		...meta,
		// Merged, not replaced.
		//
		// `calibrate --apps recordly` used to write a file containing recordly alone, dropping the
		// solves for every other app. The next run then found no entry for them and composited
		// them at their driver defaults, against whichever tool had just been solved — which is
		// the confound calibration exists to remove, reintroduced by the command that removes it.
		//
		// Only ever over this machine's own earlier solve: a macOS solve is not kept alive by a
		// Windows one, because app versions differ between machines. Every *other* machine's
		// bucket rides through `mergeCalibration` untouched, which is the whole difference
		// between gating the merge and deleting the rest of the file.
		apps: {
			...(previous.apps ?? {}),
			...Object.fromEntries(entries.map((e) => [e.app, e])),
		},
	};
	// Tabs, because biome.json pins indentStyle to "tab" and this file is both committed and
	// linted. Written with two spaces, a single `bench.mjs calibrate` — step 5 of the README's
	// own run sequence — left `npm run verify` failing on a tree the contributor had not
	// otherwise touched.
	writeFileSync(
		CALIBRATION_PATH,
		`${JSON.stringify({ machines: mergeCalibration(buckets, bucket) }, null, "\t")}\n`,
	);
	return CALIBRATION_PATH;
}
