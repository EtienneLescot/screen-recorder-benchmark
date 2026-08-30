/**
 * Turning many machines' submissions into one ranking, without an anchor.
 *
 * A submission is a set of tools measured on one machine under one set of conditions. Seconds
 * from different machines cannot be compared and never will be. What *can* be compared is the
 * ratio between two tools measured beside each other — an RTX 4070 and an M1 disagree wildly on
 * how long an export takes and can still agree that one tool costs 1.2× another.
 *
 * So the aggregate is a graph. Tools are nodes; every submission that measured two tools
 * together contributes an edge weighted by log(a/b). A connected graph then has a global
 * solution up to one free constant, recovered by least squares over every edge at once — which
 * is better than propagating from a chosen root, because redundant paths *disagree slightly*
 * and the disagreement is itself the quality signal.
 *
 * The property that matters politically: **no tool is the denominator.** Requiring every
 * submission to include OpenScreen would make the whole ranking contestable in one sentence,
 * because the benchmark's author maintains it. Any overlapping pair works instead, and the
 * graph recomposes.
 *
 * What is deliberately not done here: averaging seconds, comparing across scenario rungs, or
 * silently including a measurement whose output failed verification.
 */

/** Median, exact rather than interpolated — sample counts here are small. */
function median(xs) {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * How much a submission's edges should count.
 *
 * Not a judgement of the submitter. These are the conditions that provably move a ratio: a
 * machine that changed underneath the run, tools measured under different background loads, and
 * a live screen-sharing session contending for the same hardware encoder the exports use.
 */
/**
 * The relative uncertainty on this submission's ratios, or null if it cannot be measured.
 *
 * Each cost is `exportMs / localFloorMs`, so its relative uncertainty combines the spread of
 * the numerator with the spread of the denominator. `madMs` is a median absolute deviation
 * across the scoring runs; `floorSpreadPercent` is the full range of the floors paired with
 * them, so it is halved to read as a half-width before the two are added in quadrature.
 *
 * Combined across tools as a root-mean-square rather than a maximum. A submission contributes
 * one edge per pair of tools, and taking the worst leg would discount a precise Cap-vs-OpenScreen
 * edge because Recordly's floors happened to be noisy. Per-edge weights would be better still
 * and are the obvious next refinement; the schema weights a submission as a whole today.
 */
function relativeUncertainty(sub) {
	const per = [];
	for (const m of sub.measurements ?? []) {
		if (m.floorSpreadPercent == null || !m.exportMs) continue;
		// The two are reported in different statistics and have to be put in the same units before
		// they can be added. A median absolute deviation is about 0.6745σ for normal scatter, so
		// σ ≈ 1.4826·MAD; a full range over three samples is about 1.69σ. Using MAD as though it
		// were σ understated the numerator by half while the denominator was roughly right, which
		// would have made export scatter look cheaper than floor scatter for no reason.
		const numerator = m.madMs != null ? (1.4826 * m.madMs) / m.exportMs : 0;
		const denominator = m.floorSpreadPercent / 100 / 1.69;
		per.push(Math.sqrt(numerator ** 2 + denominator ** 2));
	}
	if (!per.length) return null;
	return Math.sqrt(per.reduce((s, x) => s + x * x, 0) / per.length);
}

export function submissionWeight(sub) {
	let w = 1;
	const c = sub.conditions ?? {};
	const reasons = [];

	// Noise, weighted by how much of it there is.
	//
	// Costs are divided by the median of the floors paired with that leg's own scoring runs, so a
	// machine that settles between one leg and the next is already corrected: the denominator ages
	// with the numerator by construction. Weighting on the opening-vs-closing drift ratio charged
	// a submission for an error the pairing had removed, and charged it against run length — which
	// grows with the number of tools measured — and against machine class: of the five submissions
	// published before this changed, the two desktops and the Apple part weighted ×1 while the only
	// thermally-limited laptop weighted ×0.6 and ×0.25, drift the sole reason in every case.
	//
	// `driftRatio` is still recorded and published; it describes the machine over the run, which is
	// worth knowing. It is simply not the error bar on the ratio.
	//
	// A submission's ratios are uncertain for two measurable reasons: its exports disagreed with
	// each other (madMs) and the floor they were divided by disagreed with itself
	// (floorSpreadPercent). Both widen the estimate rather than shifting it, and the right
	// response to a wide estimate is to trust it less in proportion — which is inverse-variance
	// weighting, the standard rule for the least-squares solve `aggregate()` already performs.
	//
	// This replaces a categorical penalty that compounded with the others: four multiplied
	// constants could take a submission to ×0.019, a figure nobody derived and which fell
	// hardest on small machines, because every one of the conditions correlates with the same
	// underlying cause. One measured number cannot compound with itself.
	const noise = relativeUncertainty(sub);
	if (noise != null) {
		// Capped at 1: a submission more precise than the reference is not worth *more* than one,
		// it is simply good enough. σ_ref is 2%, which every clean run in the corpus beats
		// comfortably — 0.01-0.5% export spread against 0.3-2% floor spread.
		const wn = Math.min(1, (0.02 / noise) ** 2);
		if (wn < 0.995) {
			w *= wn;
			reasons.push(`ratios carry ${(noise * 100).toFixed(1)}% relative uncertainty`);
		}
	} else if (c.driftRatio != null) {
		// Submissions predating the per-repetition paired floor cannot report either term, and —
		// more to the point — their costs really were divided by a floor that did not age with
		// the numerator. None of the five published before this carries a softwareFloorMs, which
		// is the marker of that change. For them the drift ratio is not double-counting anything;
		// it is the only evidence there is that the denominator moved. So they keep the old rule.
		const drift = Math.abs(c.driftRatio - 1);
		if (drift > 0.08) {
			w *= 0.25;
			reasons.push(`drift ${c.driftRatio.toFixed(3)}× — the machine changed during the run`);
		} else if (drift > 0.03) {
			w *= 0.6;
			reasons.push(`drift ${c.driftRatio.toFixed(3)}×`);
		}
	}
	/* Bias, not noise. These three shift the estimate rather than widening it, so no number of
	 * repetitions removes them and inverse-variance weighting cannot express them — a run under a
	 * streaming session is precisely wrong. They stay categorical, and they still multiply,
	 * because they are genuinely independent mechanisms rather than three readings of one
	 * thermally-limited machine, which is what the old noise terms were.
	 *
	 * Load spread survives the paired floor for a specific reason the repo already documents: the
	 * fixed-function encoder barely moves under CPU contention while a shader-bound compositor
	 * does, so a floor measured beside a busy leg under-corrects it. That is a residual bias
	 * between tools, not scatter. */
	if (c.loadSpreadPercentagePoints != null && c.loadSpreadPercentagePoints > 60) {
		w *= 0.5;
		reasons.push(
			`background load differed by ${Math.round(c.loadSpreadPercentagePoints)} points between tools`,
		);
	}
	if (c.remoteDesktopActive) {
		w *= 0.3;
		reasons.push("a remote-desktop session was encoding through the same hardware block");
	}
	if (c.onACPower === false) {
		w *= 0.5;
		reasons.push("running on battery");
	}
	return { weight: +w.toFixed(3), reasons };
}

/**
 * Cost of one measurement, in units of that machine's floor.
 *
 * The per-leg floor is preferred because it was taken minutes from the measurement under the
 * same load. Without one there is no comparable number at all, and the measurement contributes
 * to no edge — recorded, not counted.
 */
function normalisedCost(m, basis = "hardware") {
	if (!m.verified) return null;
	if (basis === "software") {
		return m.softwareFloorMs ? m.exportMs / m.softwareFloorMs : null;
	}
	if (m.localFloorMs) return m.exportMs / m.localFloorMs;
	return null;
}

/**
 * The two units a cost can be quoted in, and why one number is not enough.
 *
 * The hardware floor is a fixed-function encode. The tools are not: they composite on the
 * shader array and hand the encoder a fraction of the work. So the denominator can move without
 * the numerator moving at all, and on a part whose encoder block has more than one sustained
 * clock it does. Measured on a Ryzen 5 7520U, two runs an hour apart on the same machine and the
 * same footage:
 *
 *                     exports        ÷ hardware floor      ÷ software floor
 *   openscreen-cli    78.11 -> 77.81   3.396 -> 4.083x       2.094 -> 2.013x
 *   cap               57.36 -> 57.14   2.523 -> 2.991x       1.551 -> 1.535x
 *   recordly         324.09 -> 325.10 13.387 -> 17.031x      8.555 -> 8.701x
 *
 * The exports agree to 0.4 %. Against the encoder the costs move 19-27 %; against the cores they
 * move 1-4 %. Nothing about the tools changed — the VAAPI floor sat at 23.0 s in one run and
 * 19.1 s in the other, and every cost divided by it inherited the difference.
 *
 * This is the caveat the consistency section already prints — "the floor divides out the
 * encoder, not the shader array the compositing actually runs on" — arriving on a single machine
 * rather than between two GPUs. Neither unit is the right one on its own: the encoder floor is
 * what makes a hardware-accelerated export comparable, and the software floor is what stays put
 * when the encoder does not. Publishing both is the only honest answer, and it costs nothing:
 * every submission has carried `softwareFloorMs` since the paired floor landed.
 */
export const COST_BASES = ["hardware", "software"];

/**
 * Build the ratio graph and solve it.
 *
 * The system is `log(cost_a) - log(cost_b) = log(ratio_ab)` for every edge, plus one gauge
 * constraint fixing the mean of all log-costs to zero. Solved by weighted least squares through
 * simple iterative relaxation — the graphs here have tens of nodes, not thousands, and an
 * explicit solver would be more code for no accuracy.
 */
/**
 * Reduce a reported version to the build it names, so two spellings of one build are one build.
 *
 * Windows `VersionInfo.ProductVersion` pads a three-part version with a fourth zero: Recordly
 * 1.3.3 is reported as "1.3.3.0", which split one build into two on the page and raised a
 * "mixed versions" warning about a difference that did not exist. `null` and the string
 * "unknown" are absence, not a build, and must not be counted as one either.
 *
 * This runs at read time rather than at detection so that submissions already in the repo — and
 * any arriving from a submitter on an older build of the harness — converge too.
 */
export function normaliseVersion(v) {
	if (!v) return null;
	const s = String(v).trim();
	if (!s || /^(unknown|n\/a|none)$/i.test(s)) return null;
	return s.replace(/^(\d+\.\d+\.\d+)\.0$/, "$1");
}

export function aggregate(submissions, { step = null, basis = "hardware" } = {}) {
	const used = [];
	const skipped = [];
	const edges = [];
	const nodes = new Set();
	const perTool = new Map();

	for (const sub of submissions) {
		if (step && sub.scenario?.step !== step) {
			skipped.push({ sub, why: `scenario ${sub.scenario?.step} ≠ ${step}` });
			continue;
		}
		// Only footage anybody can obtain drives the ranking. A local recording is kept in the
		// tree as a worked example — validate-submissions.mjs already tells its submitter it is
		// "not counted in the aggregate" — but nothing here enforced that, so it was counted.
		// The cost is not academic: the first Windows submission arrived on the public bundle,
		// 60.007 s and 3600 frames, and was compared against a macOS run on a private 66.154 s
		// recording of 3969 frames. The published consistency line read "redundant paths
		// disagree by 56.65 % (median), 81.93 % at worst", inviting that to be read as a
		// platform difference when the two edges had not measured the same work.
		if (sub.source?.kind !== "public-bundle") {
			skipped.push({
				sub,
				why: `source is ${sub.source?.kind ?? "unknown"} — only public-bundle footage is comparable across machines`,
			});
			continue;
		}
		const { weight, reasons } = submissionWeight(sub);
		const costed = (sub.measurements ?? [])
			.map((m) => ({ m, cost: normalisedCost(m, basis) }))
			.filter((x) => x.cost != null && Number.isFinite(x.cost) && x.cost > 0);

		if (costed.length < 2) {
			skipped.push({
				sub,
				why:
					costed.length === 0
						? `no verified measurement with a ${basis} floor`
						: "only one comparable tool — a submission must carry two to contribute a ratio",
			});
			continue;
		}

		for (const { m, cost } of costed) {
			nodes.add(m.tool);
			if (!perTool.has(m.tool)) perTool.set(m.tool, []);
			perTool.get(m.tool).push({ cost, weight, machine: sub.machine, version: m.version, sub });
		}
		// Every pair inside a submission, not just consecutive ones: they were all measured
		// under the same conditions, so every pair is a legitimate observation.
		for (let i = 0; i < costed.length; i++) {
			for (let j = i + 1; j < costed.length; j++) {
				edges.push({
					a: costed[i].m.tool,
					b: costed[j].m.tool,
					// Rounded at the source: Math.log is not bit-identical across libm
					// implementations, so an unrounded edge makes the whole solve — and the
					// file we publish — differ between macOS and Linux. 1e-9 on a log ratio is
					// six orders of magnitude below the measurement noise; everything downstream
					// of here is + - * /, which IEEE-754 does make exact.
					logRatio: +Math.log(costed[i].cost / costed[j].cost).toFixed(9),
					weight,
					machine: sub.machine?.chip ?? "?",
					// The platform travels with the edge because the interesting spread is
					// between media stacks, not between two arbitrary boxes: a tool tuned for
					// VideoToolbox on Apple silicon and one tuned for a discrete GPU on Windows
					// are not expected to keep their order.
					platform: sub.platform ?? sub.machine?.platform ?? null,
					// The GPU travels too, because the platform is a coarse stand-in for it. The
					// floor divides out the encoder block while the compositing under test is
					// shader-bound, and those do not scale together — NVENC and VCN sit far closer
					// to each other than the shader arrays behind them do. So two Windows machines
					// with different GPUs are not repeating a measurement, they are measuring
					// different hardware, and the split below has to be able to say which it is.
					gpu: sub.machine?.gpu ?? null,
				});
			}
		}
		used.push({ sub, weight, reasons, tools: costed.map((x) => x.m.tool) });
	}

	if (!nodes.size) {
		return { tools: [], edges: [], used, skipped, components: [], consistency: null };
	}

	/* ---- connected components: a ranking only exists within one ------------------------- */
	const adjacency = new Map([...nodes].map((n) => [n, new Set()]));
	for (const e of edges) {
		adjacency.get(e.a).add(e.b);
		adjacency.get(e.b).add(e.a);
	}
	const components = [];
	const seen = new Set();
	for (const n of nodes) {
		if (seen.has(n)) continue;
		const comp = [];
		const stack = [n];
		while (stack.length) {
			const cur = stack.pop();
			if (seen.has(cur)) continue;
			seen.add(cur);
			comp.push(cur);
			for (const next of adjacency.get(cur)) if (!seen.has(next)) stack.push(next);
		}
		components.push(comp.sort());
	}

	/* ---- weighted least squares on log-costs -------------------------------------------- */
	const logCost = new Map([...nodes].map((n) => [n, 0]));
	// Damped Jacobi. Undamped, this system oscillates and collapses: with a single edge each
	// endpoint jumps to exactly satisfy it, the gauge recentres them, and the next sweep undoes
	// both — two tools whose true ratio was 1.044 converged to 1.000 and the residual reported
	// as a 4.4% disagreement that did not exist.
	const RELAX = 0.5;
	for (let iter = 0; iter < 20000; iter++) {
		const num = new Map([...nodes].map((n) => [n, 0]));
		const den = new Map([...nodes].map((n) => [n, 0]));
		for (const e of edges) {
			// Each edge pulls both endpoints toward satisfying it.
			num.set(e.a, num.get(e.a) + e.weight * (logCost.get(e.b) + e.logRatio));
			den.set(e.a, den.get(e.a) + e.weight);
			num.set(e.b, num.get(e.b) + e.weight * (logCost.get(e.a) - e.logRatio));
			den.set(e.b, den.get(e.b) + e.weight);
		}
		let maxDelta = 0;
		for (const n of nodes) {
			if (!den.get(n)) continue;
			const target = num.get(n) / den.get(n);
			const next = logCost.get(n) + RELAX * (target - logCost.get(n));
			maxDelta = Math.max(maxDelta, Math.abs(next - logCost.get(n)));
			logCost.set(n, next);
		}
		// Gauge: the solution is only defined up to a constant, so pin the mean per component.
		for (const comp of components) {
			const mean = comp.reduce((s, n) => s + logCost.get(n), 0) / comp.length;
			for (const n of comp) logCost.set(n, logCost.get(n) - mean);
		}
		if (maxDelta < 1e-10) break;
	}

	/* ---- consistency: what the redundant paths disagree about ---------------------------- */
	const residuals = edges.map((e) => Math.abs(logCost.get(e.a) - logCost.get(e.b) - e.logRatio));
	// Redundancy is what makes consistency measurable at all: a spanning tree always fits its
	// own edges exactly, so a graph with no cycles has nothing to disagree about. Reporting a
	// residual there would invite reading solver noise as evidence.
	const redundancy = edges.length - (nodes.size - components.length);
	const consistency = {
		edges: edges.length,
		redundantEdges: redundancy,
		measurable: redundancy > 0,
		medianResidualPercent: residuals.length
			? +((Math.exp(median(residuals)) - 1) * 100).toFixed(2)
			: null,
		maxResidualPercent: residuals.length
			? +((Math.exp(Math.max(...residuals)) - 1) * 100).toFixed(2)
			: null,
		/**
		 * Where the disagreement sits: between like configurations, or between media stacks.
		 *
		 * Pooling the two answers one question with the other's evidence. A tool that uses
		 * VideoToolbox well on Apple silicon and NVENC poorly on Windows genuinely changes its
		 * ratio against a rival between those platforms — that is a product fact, and the edge
		 * already carries its platform for exactly this reason (see the comment where edges are
		 * built). More submissions will never make it converge, because there is nothing there
		 * to converge to.
		 *
		 * What should be small is the spread between runs of the *same* platform. Reported
		 * separately, so a cross-platform figure is read as a finding and a same-platform one as
		 * a measurement problem. With one submission per platform there is no same-platform
		 * redundancy at all, and this says so rather than presenting the cross-platform number
		 * as though it were a fault.
		 */
		byPlatform: (() => {
			const byPair = new Map();
			for (const e of edges) {
				const k = `${e.a}\u0000${e.b}`;
				if (!byPair.has(k)) byPair.set(k, []);
				byPair.get(k).push(e);
			}
			const sameGpu = [];
			const same = [];
			const cross = [];
			for (const group of byPair.values()) {
				if (group.length < 2) continue;
				// Sub-grouped by platform, not classified by it. Judging the whole group by whether
				// it touched more than one platform threw the same-platform reading away as soon as
				// a third submission arrived: two Windows runs and one Mac made every pair "cross",
				// and the page went on saying no two submissions shared a platform when two did.
				const byPlat = new Map();
				for (const e of group) {
					const k = e.platform ?? "?";
					if (!byPlat.has(k)) byPlat.set(k, new Map());
					const byGpu = byPlat.get(k);
					const g = e.gpu ?? "?";
					if (!byGpu.has(g)) byGpu.set(g, []);
					byGpu.get(g).push(e.logRatio);
				}
				// Within one platform *and* one GPU: two runs of the same setup, and the only tier
				// here whose disagreement is a fault rather than a fact about hardware.
				for (const byGpu of byPlat.values()) {
					for (const rs of byGpu.values()) {
						if (rs.length > 1) sameGpu.push(Math.max(...rs) - Math.min(...rs));
					}
				}
				// Within a platform: how far two runs of the same thing sit apart.
				for (const byGpu of byPlat.values()) {
					const rs = [...byGpu.values()].flat();
					if (rs.length > 1) same.push(Math.max(...rs) - Math.min(...rs));
				}
				// Between platforms: the gap between their central values, so a platform measured
				// twice does not contribute its own noise to the cross-platform figure.
				if (byPlat.size > 1) {
					const meds = [...byPlat.values()].map((byGpu) => median([...byGpu.values()].flat()));
					cross.push(Math.max(...meds) - Math.min(...meds));
				}
			}
			const pct = (xs) => (xs.length ? +((Math.exp(median(xs)) - 1) * 100).toFixed(2) : null);
			return {
				sameGpuPairs: sameGpu.length,
				samePlatformPairs: same.length,
				crossPlatformPairs: cross.length,
				sameGpuSpreadPercent: pct(sameGpu),
				samePlatformSpreadPercent: pct(same),
				crossPlatformSpreadPercent: pct(cross),
			};
		})(),
		worst: (() => {
			// The widest-spread pair, reported from both ends. Naming a single edge and the
			// machine it came from read as though that machine were at fault; what actually
			// happened is that one pair's ratio moved between two runs, and both are real.
			const byPair = new Map();
			for (const e of edges) {
				const k = `${e.a}\u0000${e.b}`;
				if (!byPair.has(k)) byPair.set(k, []);
				byPair.get(k).push(e);
			}
			let best = null;
			for (const [k, group] of byPair) {
				if (group.length < 2) continue;
				const lo = group.reduce((m, e) => (e.logRatio < m.logRatio ? e : m));
				const hi = group.reduce((m, e) => (e.logRatio > m.logRatio ? e : m));
				const span = hi.logRatio - lo.logRatio;
				if (!best || span > best.span) {
					const [a, b] = k.split("\u0000");
					best = { a, b, span, lo, hi };
				}
			}
			if (!best) return null;
			const side = (e) => ({
				machine: e.machine.trim(),
				platform: e.platform,
				// How much `a` costs relative to `b` on that run — the number the reader is
				// already looking at elsewhere on the page.
				ratio: +Math.exp(e.logRatio).toFixed(2),
			});
			return {
				a: best.a,
				b: best.b,
				spreadPercent: +((Math.exp(best.span) - 1) * 100).toFixed(2),
				// `inverts` is the case worth naming: the pair does not merely widen, it swaps.
				inverts: best.lo.logRatio < 0 && best.hi.logRatio > 0,
				ends: [side(best.lo), side(best.hi)].sort((x, y) => x.ratio - y.ratio),
			};
		})(),
	};

	/* ---- present it in units of the floor ------------------------------------------------ */
	const compOf = (tool) => components.findIndex((c) => c.includes(tool));
	const tools = [...nodes].map((tool) => {
		const obs = perTool.get(tool) ?? [];
		return {
			tool,
			component: compOf(tool),
			relativeCost: Math.exp(logCost.get(tool)),
			submissions: obs.length,
			machines: [...new Set(obs.map((o) => o.machine?.chip).filter(Boolean))],
			platforms: [...new Set(obs.map((o) => o.machine?.platform).filter(Boolean))],
			versions: [...new Set(obs.map((o) => normaliseVersion(o.version)).filter(Boolean))].sort(),
			// Counted, not dropped. normaliseVersion returns null for "unknown" so that a failed
			// lookup is not listed as if it were a build — but filtering it out of the list and
			// stopping there produced the opposite lie: a tool measured once at 1.3.3 and once at
			// an unrecorded version read as a single known build. Absence is a fact about the
			// submission and belongs on the page.
			versionsUnreported: obs.filter((o) => !normaliseVersion(o.version)).length,
			observedCostRange: obs.length
				? [
						+Math.min(...obs.map((o) => o.cost)).toFixed(3),
						+Math.max(...obs.map((o) => o.cost)).toFixed(3),
					]
				: null,
		};
	});
	// Shift each component onto the floor's scale, rather than onto its cheapest tool.
	//
	// The solve fixes the mean of the log-costs at zero, which settles the ratios but loses the
	// absolute level, so it has to be restored. Rescaling to the cheapest tool was the earlier
	// answer and it reads badly: whichever tool happens to be fastest shows 1.00×, which every
	// reader takes for a reference the benchmark chose — and the page then explains costs
	// relative to a product while claiming its unit is a plain ffmpeg transcode.
	//
	// Every observation already carries that unit: `cost` is exportMs / localFloorMs, measured on
	// the same machine minutes apart. So the level is recovered by shifting the component until
	// its solved costs sit as close as possible to those measured ones — the median of the
	// per-observation offsets, which one loud submission cannot drag. 1.00× then means "as fast
	// as ffmpeg", not "the fastest thing here", and a tool can read below or above it.
	for (const ci of components.keys()) {
		const inComp = tools.filter((t) => t.component === ci);
		const offsets = [];
		for (const t of inComp) {
			for (const o of perTool.get(t.tool) ?? []) {
				offsets.push(Math.log(o.cost) - Math.log(t.relativeCost));
			}
		}
		const shift = offsets.length ? Math.exp(median(offsets)) : 1;
		for (const t of inComp) t.relativeCost = +(t.relativeCost * shift).toFixed(3);
	}
	tools.sort((a, b) => a.component - b.component || a.relativeCost - b.relativeCost);

	// Tools are not pinned to a version — the question is how the current products compare, and
	// half these vendors publish no version-addressable download anyway. The cost is that
	// submissions arrive over time and a node can quietly average two different builds. So the
	// spread is surfaced instead of hidden: a figure resting on several versions is reported as
	// such, and the reader decides whether it still means one thing.
	const versionSpread = tools
		.filter((t) => t.versions.length > 1 || t.versionsUnreported > 0)
		.map((t) => ({
			tool: t.tool,
			versions: t.versions,
			unreported: t.versionsUnreported,
			submissions: t.submissions,
		}));

	return { tools, edges, used, skipped, components, consistency, versionSpread };
}
