/**
 * Submissions: turning a local run into something another machine can use, and back.
 *
 * A run's `results.json` is full of things that mean nothing elsewhere — absolute seconds,
 * filesystem paths, this machine's thermal state. A submission keeps what travels: each tool's
 * cost in units of the floor measured beside it, the conditions that decide how much to trust
 * that ratio, and enough provenance to prove two submissions measured the same footage.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { mad } from "./measure.mjs";

/** Everything the aggregate needs, and nothing that only means something on one machine. */
export function buildSubmission(doc, { submitter = undefined } = {}) {
	const rows = (doc.results ?? []).filter((r) => !r.skipped && r.app !== "ffmpeg-baseline-close");
	const scoring = (r) => (r.runs ?? []).filter((x) => !x.warmup && x.ok);
	const med = (xs) => {
		if (!xs.length) return null;
		const s = [...xs].sort((a, b) => a - b);
		const m = Math.floor(s.length / 2);
		return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
	};

	const measurements = rows
		.map((r) => {
			const runs = scoring(r);
			if (!runs.length) return null;
			return {
				tool: r.app,
				version: r.version ?? "unknown",
				exportMs: Math.round(med(runs.map((x) => x.exportMs).filter((x) => x != null)) ?? 0),
				// Spread across the scoring runs. This was hardcoded null, so every submission
				// ever published claimed no spread — including the two in docs/aggregate.json —
				// while lib/report.mjs computed it from the same runs and printed it locally.
				madMs: (() => {
					const m = mad(runs.map((x) => x.exportMs).filter((x) => x != null));
					return m == null ? null : Math.round(m);
				})(),
				runs: runs.length,
				localFloorMs: r.localFloor?.exportMs ? Math.round(r.localFloor.exportMs) : null,
				// The CPU-side companion, carried so a reader can see how far apart the two floors
				// sat on this machine. Their ratio is what says whether a cost figure travels: a
				// machine whose fixed-function block is fast relative to its cores flatters every
				// compositor divided by it.
				softwareFloorMs: r.softwareFloor?.exportMs ? Math.round(r.softwareFloor.exportMs) : null,
				// How far the denominator moved *while this tool was being measured*.
				//
				// `localFloorMs` is the median of the floors paired with this leg's scoring runs,
				// so this says how much those disagreed with each other. It is the error bar on
				// the number every cost here is divided by, and unlike the run-wide drift ratio it
				// is not inflated by a machine that settled between one leg and the next — that
				// settling is exactly what pairing absorbs.
				floorSpreadPercent: (() => {
					const paired = runs.map((x) => x.pairedFloor?.exportMs).filter((x) => x != null);
					if (paired.length < 2) return null;
					return +((Math.max(...paired) / Math.min(...paired) - 1) * 100).toFixed(2);
				})(),
				cpuSeconds: med(runs.map((x) => x.cpuSeconds).filter((x) => x != null)),
				peakRssMiB: Math.max(0, ...runs.map((x) => x.peakRssMiB ?? 0)) || null,
				foreignCpuPercent: med(runs.map((x) => x.foreignCpuPercent).filter((x) => x != null)),
				outputBytes: med(runs.map((x) => x.outputSizeBytes).filter(Boolean)),
				outputMeanVolumeDb: med(runs.map((x) => x.outputMeanVolumeDb).filter((x) => x != null)),
				fidelity: r.fidelity?.score ?? 0,
				missing: r.fidelity?.missing ?? [],
				contradicted: r.fidelity?.contradicted ?? [],
				// Only a run whose output passed metadata, pixel and audio verification counts.
				verified: runs.every((x) => x.verified !== false),
				automation: r.automation ?? "unknown",
			};
		})
		.filter(Boolean)
		.filter((m) => m.verified && m.localFloorMs);

	const allLoads = rows
		.flatMap((r) => scoring(r).map((x) => x.foreignCpuPercent))
		.filter((x) => x != null);
	// The spread is *between tools*, which is what PROTOCOL.md weights and what report.mjs
	// prints: it asks whether the legs were measured under comparable conditions. Taking
	// max-min over every individual sample instead answered a different question — how spiky
	// was any one reading — and a single instantaneous spike then halved the submission's
	// weight on a run the report itself called clean. Measured here: 166.5 points across raw
	// samples against 37 points between the two tools' medians.
	const toolLoads = measurements.map((m) => m.foreignCpuPercent).filter((x) => x != null);
	const openFloor = doc.results?.find((r) => r.app === "ffmpeg-baseline");
	const closeFloor = doc.results?.find((r) => r.app === "ffmpeg-baseline-close");
	const floorMedian = (r) =>
		med(
			scoring(r ?? {})
				.map((x) => x.exportMs)
				.filter((x) => x != null),
		);
	// With no standalone ffmpeg-baseline leg — the normal case, since it is the unit rather
	// than a competitor — the opening reference is the first leg's own local floor. Same
	// workload, same binary, measured minutes earlier: exactly what the drift ratio compares.
	const open =
		floorMedian(openFloor) ?? (measurements.length ? measurements[0].localFloorMs : null) ?? null;
	const close = floorMedian(closeFloor);

	const m = doc.machine ?? {};
	return {
		schemaVersion: 1,
		submittedAt: new Date().toISOString(),
		...(submitter ? { submitter } : {}),
		machine: {
			platform: m.platform ?? "unknown",
			chip: m.chip ?? "unknown",
			gpu: m.gpu ?? null,
			cpuCount: m.cpuCount ?? 0,
			memoryGiB: m.memoryGiB ?? 0,
			osVersion: m.osVersion ?? "unknown",
			osBuild: m.osBuild ?? null,
		},
		conditions: {
			onACPower: doc.power?.onACPower ?? null,
			maxForeignCpuPercent: allLoads.length ? Math.max(...allLoads) : null,
			loadSpreadPercentagePoints:
				toolLoads.length > 1
					? +(Math.max(...toolLoads) - Math.min(...toolLoads)).toFixed(1)
					: toolLoads.length
						? 0
						: null,
			driftRatio: open && close ? +(close / open).toFixed(4) : null,
			// The widest any single leg's paired floors disagreed. This is what the weighting
			// asks about, because it is the error on the denominator each cost actually used;
			// `driftRatio` is kept beside it as a description of the machine over the run, which
			// is worth publishing but is not the same question. Measured on the run that
			// prompted this: 19.9% drift across the run against 0.3-4.3% within each leg, on a
			// machine whose *software* floor moved 0.8% — the cores never wavered and the
			// fixed-function encoder settled, which is one subsystem finding its sustained clock
			// rather than a machine that changed underneath the measurement.
			floorSpreadPercent: (() => {
				const s = measurements.map((x) => x.floorSpreadPercent).filter((x) => x != null);
				return s.length ? +Math.max(...s).toFixed(2) : null;
			})(),
			// Detected rather than trusted where the platform can answer: a streaming host holding
			// a hardware encoder session is confirmable. null still means "could not tell", which
			// is a different claim from false and is why the field is a tri-state.
			remoteDesktopActive: doc.conditions?.remoteDesktopActive ?? null,
		},
		scenario: {
			step: doc.scenario?.step ?? "S4",
			outputWidth: doc.scenario?.output?.width ?? 1920,
			outputHeight: doc.scenario?.output?.height ?? 1080,
			outputFps: doc.scenario?.output?.fps ?? 60,
			outputCodec: doc.scenario?.output?.videoCodec ?? "h264",
		},
		source: {
			kind: doc.fixture?.kind ?? "generated",
			bundle: doc.fixture?.name ?? null,
			downloadSha256: doc.fixture?.downloadSha256 ?? null,
			normalisedSha256: doc.fixture?.sha256 ?? null,
			durationSec: doc.fixture?.probe?.durationSec ?? 0,
			frames: doc.fixture?.probe?.video?.nbFrames ?? null,
		},
		measurements,
		// The drivers' own notes travel too. They were dropped here, so the published aggregate
		// recorded Recordly's zooms as applied without also recording that 1.6x is not one of its
		// presets and 1.5x was substituted — the kind of caveat that decides how a number should
		// be read, and which the local report has always printed.
		//
		// A note naming a filesystem path stays behind: this object is published, so an absolute
		// path leaks the submitter's home directory and means nothing on another machine anyway.
		notes: rows.flatMap((r) =>
			(r.notes ?? [])
				.filter((n) => !/[A-Za-z]:\\|\/(?:Users|home)\//.test(n))
				.map((n) => `${r.app}: ${n}`),
		),
	};
}

/** Every submission committed to the repository. */
export function collectSubmissions(root) {
	const dir = join(root, "submissions");
	if (!existsSync(dir)) return [];
	const out = [];
	const walk = (d) => {
		for (const entry of readdirSync(d)) {
			const p = join(d, entry);
			if (statSync(p).isDirectory()) walk(p);
			else if (entry.endsWith(".json")) {
				try {
					// Repo-relative, never absolute: this object is serialised into the
					// published aggregate, so an absolute path both leaks the submitter's
					// home directory and makes the file differ on every machine that
					// rebuilds it.
					const rel = relative(root, p).split(sep).join("/");
					out.push({ ...JSON.parse(readFileSync(p, "utf8")), _path: rel });
				} catch {
					/* a malformed file is caught by CI's schema check, not here */
				}
			}
		}
	};
	walk(dir);
	return out;
}

export function renderAggregate(result, { step, submissions } = {}) {
	const L = [];
	L.push(
		`Aggregate${step ? ` — ${step}` : ""}: ${submissions} submission(s), ${result.edges.length} ratio(s)`,
	);
	if (result.components.length > 1) {
		L.push(
			`⚠ ${result.components.length} disconnected groups — tools in different groups cannot be compared.`,
		);
		L.push("  Submit a run measuring one tool from each together to join them.");
	}
	if (result.consistency && !result.consistency.measurable) {
		L.push(
			"consistency: not measurable — no redundant paths yet. Two submissions measuring the same pair " +
				"on different machines would make disagreement visible.",
		);
	} else if (result.consistency?.medianResidualPercent != null) {
		const bp = result.consistency.byPlatform ?? {};
		// Same GPU first: of the three tiers it is the only one whose disagreement would mean the
		// measurement is wrong. The other two are hardware differences being reported as such.
		if (bp.sameGpuPairs) {
			L.push(
				`consistency: runs on the same platform and GPU disagree by ${bp.sameGpuSpreadPercent}% ` +
					`(median over ${bp.sameGpuPairs} pair(s)) — this is the figure that should be small.`,
			);
		} else if (bp.samePlatformPairs) {
			L.push(
				"consistency: no two submissions share a platform *and* a GPU yet, so nothing here says " +
					"whether the measurement repeats. That is the figure to watch; a second run on any " +
					"machine already here would produce it.",
			);
		} else {
			L.push(
				"consistency: no two submissions share a platform yet, so nothing here says whether the " +
					"measurement repeats. That is the figure to watch; a second machine on either platform " +
					"would produce it.",
			);
		}
		// Same platform, different GPU. Reported apart from the tier above because the floor does
		// not make a cost GPU-independent: it divides out the encoder block, while the compositing
		// under test is shader-bound, and NVENC and VCN sit far closer together than the shader
		// arrays behind them. Folding this into the line above reads a hardware fact as a fault.
		if (bp.samePlatformPairs && bp.samePlatformSpreadPercent !== bp.sameGpuSpreadPercent) {
			L.push(
				`  on the same platform across different GPUs they move by ${bp.samePlatformSpreadPercent}% ` +
					`(median over ${bp.samePlatformPairs} pair(s)) — the floor divides out the encoder, not ` +
					"the shader array the compositing actually runs on.",
			);
		}
		if (bp.crossPlatformPairs) {
			L.push(
				`  across platforms the same pairs move by ${bp.crossPlatformSpreadPercent}% (median over ` +
					`${bp.crossPlatformPairs} pair(s)) — expected, since a tool tuned for one media stack ` +
					"need not keep its order on another.",
			);
		}
		// Both ends, never one machine: the widest pair moved between two runs and both are real.
		const w = result.consistency.worst;
		if (w?.ends?.length === 2) {
			const [lo, hi] = w.ends;
			L.push(
				`  widest: ${w.a} vs ${w.b} — ${lo.ratio}× on ${lo.machine} (${lo.platform}) against ` +
					`${hi.ratio}× on ${hi.machine} (${hi.platform})${w.inverts ? ", which inverts the order" : ""}.`,
			);
		}
	}
	if (result.versionSpread?.length) {
		L.push("");
		for (const v of result.versionSpread) {
			L.push(
				`⚠ ${v.tool}: submissions span ${v.versions.length} versions (${v.versions.join(", ")}) — this figure is not one build`,
			);
		}
	}
	L.push("");
	L.push("tool                      cost   submissions  platforms          observed range");
	for (const t of result.tools) {
		L.push(
			`${t.tool.padEnd(24)}  ${`${t.relativeCost}×`.padEnd(6)} ${String(t.submissions).padEnd(12)} ` +
				`${t.platforms.join(",").padEnd(18)} ${t.observedCostRange ? `${t.observedCostRange[0]}–${t.observedCostRange[1]}× of floor` : ""}`,
		);
	}
	if (result.skipped.length) {
		L.push("");
		L.push("not counted:");
		for (const s of result.skipped.slice(0, 10)) {
			L.push(`  ${s.sub.machine?.chip ?? "?"} — ${s.why}`);
		}
	}
	return L.join("\n");
}
