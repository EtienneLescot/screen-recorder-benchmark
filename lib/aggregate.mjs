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
export function submissionWeight(sub) {
	let w = 1;
	const c = sub.conditions ?? {};
	const reasons = [];

	if (c.driftRatio != null) {
		const drift = Math.abs(c.driftRatio - 1);
		if (drift > 0.08) {
			w *= 0.25;
			reasons.push(`drift ${c.driftRatio.toFixed(3)}× — the machine changed during the run`);
		} else if (drift > 0.03) {
			w *= 0.6;
			reasons.push(`drift ${c.driftRatio.toFixed(3)}×`);
		}
	}
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
function normalisedCost(m) {
	if (!m.verified) return null;
	if (m.localFloorMs) return m.exportMs / m.localFloorMs;
	return null;
}

/**
 * Build the ratio graph and solve it.
 *
 * The system is `log(cost_a) - log(cost_b) = log(ratio_ab)` for every edge, plus one gauge
 * constraint fixing the mean of all log-costs to zero. Solved by weighted least squares through
 * simple iterative relaxation — the graphs here have tens of nodes, not thousands, and an
 * explicit solver would be more code for no accuracy.
 */
export function aggregate(submissions, { step = null } = {}) {
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
		const { weight, reasons } = submissionWeight(sub);
		const costed = (sub.measurements ?? [])
			.map((m) => ({ m, cost: normalisedCost(m) }))
			.filter((x) => x.cost != null && Number.isFinite(x.cost) && x.cost > 0);

		if (costed.length < 2) {
			skipped.push({
				sub,
				why:
					costed.length === 0
						? "no verified measurement with a local floor"
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
					logRatio: Math.log(costed[i].cost / costed[j].cost),
					weight,
					machine: sub.machine?.chip ?? "?",
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
		worst: edges.length
			? (() => {
					const i = residuals.indexOf(Math.max(...residuals));
					return {
						a: edges[i].a,
						b: edges[i].b,
						machine: edges[i].machine,
						disagreementPercent: +((Math.exp(residuals[i]) - 1) * 100).toFixed(2),
					};
				})()
			: null,
	};

	/* ---- present it, anchored on the cheapest tool for readability only ------------------ */
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
			versions: [...new Set(obs.map((o) => o.version).filter(Boolean))],
			observedCostRange: obs.length
				? [
						+Math.min(...obs.map((o) => o.cost)).toFixed(3),
						+Math.max(...obs.map((o) => o.cost)).toFixed(3),
					]
				: null,
		};
	});
	// Rescale each component so its cheapest tool reads 1.00×. Presentation only — the ranking
	// and the ratios are unchanged by it, and no tool is privileged by being the reference.
	for (const [ci, comp] of components.entries()) {
		const inComp = tools.filter((t) => t.component === ci);
		const min = Math.min(...inComp.map((t) => t.relativeCost));
		for (const t of inComp) t.relativeCost = +(t.relativeCost / min).toFixed(3);
	}
	tools.sort((a, b) => a.component - b.component || a.relativeCost - b.relativeCost);

	return { tools, edges, used, skipped, components, consistency };
}
