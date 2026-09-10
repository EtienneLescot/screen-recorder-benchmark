/**
 * Turning many machines' submissions into one ranking.
 *
 * Seconds from different machines cannot be compared and never will be. What *can* be compared
 * is a ratio to the machine's own floor: every counted measurement divides its export by an
 * ffmpeg transcode of the same footage, run on the same machine minutes away under the same
 * load. `exportMs / localFloorMs` is therefore already dimensionless, already comparable across
 * hardware, and already the number the page prints. Aggregating is averaging it per build.
 *
 * This used to be a ratio graph: tools as nodes, every pair measured together as an edge
 * weighted by log(a/b), solved by least squares. The premise was that there is no common
 * denominator. There is — the protocol requires a local floor and refuses to count a
 * measurement without one — so the graph was a second normalisation stacked on a first, and it
 * did damage. A build held into the graph by a single neighbour inherited that neighbour's
 * level, fitted across machines the build never ran on, and the page printed a figure outside
 * everything ever measured for it: Screen Studio ran once at 4.681× and was published at 5.70×,
 * because the OpenScreen it was measured beside costs 1.04× on that M1 and 1.84× on a Ryzen
 * laptop. Nothing was re-measured to fix this. The same runs now print 4.681×.
 *
 * The property that matters politically survives, and is stronger for it: **no tool is the
 * denominator.** ffmpeg is, and ffmpeg is not a competitor.
 *
 * What no single figure can fix: a build's cost is not one number. Recordly runs 2.6× on an M1
 * and 17× on a Ryzen 5 7520U. One bar has to average that, so the spread is published beside it
 * and the scope buttons re-run the same aggregation over one platform or one GPU.
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
 * The average of a setup's runs, each counted by how much its conditions can be trusted.
 *
 * Plain arithmetic, because the number under the bar is the average cost and a reader should be
 * able to check it by hand. The weights are the only complication and they earn it: a run made
 * while the machine was drifting or contending for the encoder is still evidence, just less of
 * it, and down-weighting is what keeps it from being thrown away.
 *
 * One observation returns that observation — the case the page most needs exact, because a
 * build measured once should print what it measured.
 */
function weightedMean(samples) {
	if (!samples.length) return null;
	const total = samples.reduce((n, x) => n + x.weight, 0);
	if (!total) return samples.reduce((n, x) => n + x.value, 0) / samples.length;
	return samples.reduce((n, x) => n + x.value * x.weight, 0) / total;
}

/**
 * How much a submission's measurements should count.
 *
 * Not a judgement of the submitter. These are the conditions that provably move a cost: a
 * machine that changed underneath the run, tools measured under different background loads, and
 * a live screen-sharing session contending for the same hardware encoder the exports use.
 */
/**
 * The relative uncertainty on this submission's ratios, or null if it cannot be measured.
 *
 * Each cost is `exportMs / localFloorMs`, so its relative uncertainty combines the spread of the
 * numerator with the spread of the denominator. The two are reported in different statistics and
 * are converted to the same one — an estimated σ — before being added in quadrature: `madMs` is a
 * median absolute deviation, so it is scaled by 1.4826, and `floorSpreadPercent` is the full
 * range of three paired floors, so it is divided by 1.69.
 *
 * Combined across tools as a root-mean-square rather than a maximum. Taking the worst leg would
 * discount a precise OpenScreen measurement because Recordly's floors happened to be noisy in
 * the same submission. Per-measurement weights would be better still and are the obvious next
 * refinement; the schema weights a submission as a whole today.
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
	// response to a wide estimate is to trust it less in proportion, which is inverse-variance
	// weighting.
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
 * to nothing — recorded, not counted.
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
 *   openscreen        78.11 -> 77.81   3.396 -> 4.083x       2.094 -> 2.013x
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

/**
 * The registry id a measurement belongs to, with the driving mode folded out.
 *
 * OpenScreen used to be keyed by how it was driven — `openscreen-cli`, beside an
 * `openscreen-gui` that never produced a measurement — and that id travelled through every
 * submission and onto the page as the competitor's name. How a tool is driven is not a property
 * of the product being timed: both paths reach the same export backend, and the run table's
 * "Driven" column already records which was used. Two competitors named for one product is the
 * confusion, not the disclosure.
 *
 * A mode that moves the clock is a different matter and keeps its own id: `recordly-cuda` is a
 * switch in the product that changes the export path, not a way of pressing the same button.
 *
 * Applied at read time, like `normaliseVersion`. The submissions in this repo were rewritten,
 * but a run produced by an older harness still names the driving mode, and it has to land on
 * the same node rather than stand up as a competitor of its own.
 */
export function normaliseTool(tool) {
	return String(tool ?? "").replace(/-(cli|gui)$/, "");
}

/**
 * The build a measurement belongs to — the row it becomes on the page.
 *
 * A version is not a label on a tool here, it is the competitor. Two builds of one product are
 * two nodes, because a release that got 3× faster is the whole point of publishing the number
 * and averaging it with its predecessor would erase exactly the thing the vendor shipped.
 *
 * Iterations of one prerelease are folded together: `1.11.0-rc.1`, `-rc.2` and `-rc.3` are all
 * `1.11.0-rc`. A leaderboard with four rc rows for one release is noise, and an rc series is
 * read as one thing by everybody outside the vendor. The cost is real and is not hidden — the
 * exact builds a folded node rests on travel with it, and `buildSpread` names any node resting
 * on more than one, because two rc's of a base version can differ as much as two releases do.
 *
 * Prereleases are builds like any other: they are downloadable by the public, so they compete.
 * They are marked, not excluded — see `isPrerelease`.
 */
export function buildKey(version) {
	const v = normaliseVersion(version);
	if (!v) return null;
	// 1.11.0-rc.1, 1.11.0-rc1 and 1.11.0-rc all name the same series. Anything that is not a
	// numeric version followed by one alphabetic tag is left exactly as reported: inventing a
	// fold for a spelling nobody has published yet would merge builds nobody asked to merge.
	const m = /^(\d+(?:\.\d+)*)-([A-Za-z]+)(?:[.-]?\d+)?$/.exec(v);
	return m ? `${m[1]}-${m[2].toLowerCase()}` : v;
}

/** Whether a build key names a prerelease — a marker on the row, never a reason to drop it. */
export function isPrerelease(build) {
	return /^\d+(?:\.\d+)*-[a-z]+$/.test(String(build ?? ""));
}

/**
 * Which of two builds is the newer, by the only ordering a version string supports.
 *
 * Numeric components first, then the rule that decides the case the page actually depends on:
 * `1.11.0` is newer than `1.11.0-rc`, because a release supersedes the candidates for it. Two
 * different prerelease tags on one base fall back to alphabetic order, which happens to put
 * alpha before beta before rc.
 */
export function compareBuilds(a, b) {
	const parse = (s) => {
		const [num, tag = ""] = String(s ?? "").split("-");
		return { parts: num.split(".").map((n) => Number(n) || 0), tag };
	};
	const x = parse(a);
	const y = parse(b);
	for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
		const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
		if (d) return d;
	}
	if (x.tag === y.tag) return 0;
	// No tag is the release itself, and it outranks every candidate for it.
	if (!x.tag) return 1;
	if (!y.tag) return -1;
	return cmpStr(x.tag, y.tag);
}

/** Byte order, not locale order: this file's output is diffed byte-for-byte in CI. */
const cmpStr = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

/** The row a tool's build occupies on the page, and the key its observations pool under. */
export const nodeId = (tool, build) => `${tool}@${build}`;

/**
 * What identifies a machine, with the reporting platform's whitespace taken back out.
 *
 * The probe trims this now, but submissions are files: ten of them were written before it did,
 * and the next contributor may be measuring from an older checkout. A padded chip name splits one
 * laptop into two machines — which is how `machines` came to list three for a build measured on
 * two — so the aggregator cannot assume its inputs are clean, whatever the probe does.
 */
export const machineName = (s) =>
	String(s ?? "")
		.replace(/\s+/g, " ")
		.trim();

/**
 * One row per tool, built from the newest build measured **on each platform**.
 *
 * "Newest" means newest *measured*, not newest published: a release nobody has run yet cannot
 * be ranked, and pretending otherwise would empty the page between a vendor's release and the
 * first submission on it. A build that is in the tree but not current anywhere is not deleted —
 * it keeps its own figure and is published on the builds page.
 *
 * `newestBuilds` takes the newest build anywhere, and that quietly answers a different question
 * as soon as a vendor ships at different cadences per platform. FocuSee is the case: 2.4.1 was
 * measured on an M1 and 2.3.5 on two Windows machines, so the globally newest build is a
 * macOS-only figure and every Windows run vanished from the combined chart. The row read 0.93×,
 * one run on one machine, next to rivals resting on three machines each.
 *
 * Taking the newest build per platform is what a reader on any given platform would actually
 * install. macOS contributes 2.4.1, Windows contributes 2.3.5, and the row averages the setups
 * underneath both. Nothing is hidden and nothing is invented: every setup that ever ran the
 * tool's current release on its own platform is counted exactly once.
 *
 * The cost is that a row can now rest on more than one build, which is the thing this benchmark
 * otherwise refuses to do — a version is a competitor, and averaging two of them erases what the
 * vendor shipped. It is allowed here and only here because the mixture is principled rather than
 * arbitrary, and because `builds` names every build in the row so the page can print them
 * against their platforms instead of showing one number that is true of only some of the runs.
 *
 * Inside a scope that is one platform this is exactly `newestBuilds`, which is why the
 * per-platform rankings never had the problem.
 */
export function newestPerPlatform(tools) {
	const byTool = new Map();
	for (const t of tools) {
		if (!byTool.has(t.tool)) byTool.set(t.tool, []);
		byTool.get(t.tool).push(t);
	}
	const rows = [];
	for (const [tool, builds] of byTool) {
		// Which build is the current one on each platform. A build with no setups on a platform
		// cannot be that platform's answer, however new it is.
		const newestOn = new Map();
		for (const b of builds) {
			for (const s of b.setups ?? []) {
				const cur = newestOn.get(s.platform);
				if (!cur || compareBuilds(b.build, cur.build) > 0) newestOn.set(s.platform, b);
			}
		}
		const kept = builds
			.map((b) => ({
				build: b,
				setups: (b.setups ?? []).filter((s) => newestOn.get(s.platform) === b),
			}))
			.filter((x) => x.setups.length)
			.sort(
				(x, y) => compareBuilds(y.build.build, x.build.build) || cmpStr(x.build.node, y.build.node),
			);
		if (!kept.length) continue;
		const setups = kept.flatMap((x) => x.setups);
		const obsRanges = kept.map((x) => x.build.observedCostRange).filter(Boolean);
		const lead = kept[0].build;
		rows.push({
			// The newest build's node, so the row still addresses one thing for the scope filter
			// and for `data-node`. `builds` is what the label is drawn from.
			node: lead.node,
			tool,
			build: lead.build,
			prerelease: kept.some((x) => x.build.prerelease),
			// Every build in the row, newest first, each with the platforms it answers for. One
			// entry is the ordinary case and reads exactly as it always did.
			builds: kept.map((x) => ({
				build: x.build.build,
				prerelease: x.build.prerelease,
				platforms: [...new Set(x.setups.map((s) => s.platform))].sort(cmpStr),
			})),
			relativeCost: +(setups.reduce((n, s) => n + s.cost, 0) / setups.length).toFixed(3),
			setups,
			submissions: setups.reduce((n, s) => n + s.runs, 0),
			machines: [...new Set(setups.map((s) => s.machine).filter(Boolean))],
			platforms: [...new Set(setups.map((s) => s.platform).filter(Boolean))],
			versions: [...new Set(kept.flatMap((x) => x.build.versions ?? []))].sort(cmpStr),
			// Widened over every build in the row, so the range still covers every run behind the
			// figure rather than only the newest build's.
			observedCostRange: obsRanges.length
				? [Math.min(...obsRanges.map((r) => r[0])), Math.max(...obsRanges.map((r) => r[1]))]
				: null,
		});
	}
	return rows.sort((a, b) => a.relativeCost - b.relativeCost || cmpStr(a.node, b.node));
}

export function aggregate(submissions, { step = null, basis = "hardware" } = {}) {
	const used = [];
	const skipped = [];
	const nodes = new Set();
	const perTool = new Map();
	const unplaceable = [];

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
		// platform difference when the two runs had not measured the same work.
		if (sub.source?.kind !== "public-bundle") {
			skipped.push({
				sub,
				why: `source is ${sub.source?.kind ?? "unknown"} — only public-bundle footage is comparable across machines`,
			});
			continue;
		}
		const { weight, reasons } = submissionWeight(sub);
		// Normalised once here rather than at each of the four places that read it, so an edge and
		// the `machines` list it feeds cannot disagree about what one machine is called.
		const machine = sub.machine && {
			...sub.machine,
			chip: machineName(sub.machine.chip) || null,
		};
		const priced = (sub.measurements ?? [])
			// Tool and machine are both normalised once here rather than at each of the places
			// that read them, so an edge and the lists it feeds cannot disagree about what one
			// machine, or one product, is called.
			.map((m) => ({
				m: { ...m, tool: normaliseTool(m.tool) },
				cost: normalisedCost(m, basis),
				build: buildKey(m.version),
			}))
			.filter((x) => x.cost != null && Number.isFinite(x.cost) && x.cost > 0);

		// A measurement whose build cannot be named has nowhere to go now that the node *is* the
		// build. It used to be folded into the tool under a page-wide caveat that a figure might
		// be resting on two builds without saying which — which no reader could act on. Dropped
		// and named instead; the fix was always to re-measure, and the schema requires a version.
		for (const x of priced) {
			if (!x.build) unplaceable.push({ sub, tool: x.m.tool, version: x.m.version ?? null });
		}
		const costed = priced
			.filter((x) => x.build)
			.map((x) => ({ ...x, node: nodeId(x.m.tool, x.build) }));

		if (!costed.length) {
			skipped.push({
				sub,
				why: priced.length
					? "no measurement records which build it measured"
					: `no verified measurement with a ${basis} floor`,
			});
			continue;
		}

		// One tool is enough. Under the ratio graph a submission had to carry two, because a lone
		// measurement produced no edge and so touched nothing. Against a floor it is a complete
		// observation on its own: it was divided by an ffmpeg run taken beside it, on the machine
		// that produced it.
		for (const { m, cost, node, build } of costed) {
			nodes.add(node);
			if (!perTool.has(node)) perTool.set(node, []);
			perTool.get(node).push({
				cost,
				weight,
				machine,
				// The reporting platform, which is not always the machine's: the same Ryzen laptop
				// submitted from both Windows and Linux, and those are two different media stacks
				// over one piece of hardware.
				platform: sub.platform ?? machine?.platform ?? null,
				tool: m.tool,
				build,
				version: m.version,
				sub,
			});
		}
		used.push({
			sub,
			weight,
			reasons,
			tools: costed.map((x) => x.m.tool),
			nodes: costed.map((x) => x.node),
		});
	}

	if (!nodes.size) {
		return { tools: [], used, skipped, consistency: null, buildSpread: [], unplaceable };
	}

	/* ---- how far a build's cost moves between machines ---------------------------------- */
	//
	// The figure above is an average over runs that did not agree, and by how much they disagreed
	// is what tells the reader what the average is worth. Three tiers, because the same number
	// means three different things:
	//
	//   same platform and GPU  two runs of one setup. Disagreement here is a fault.
	//   same platform          two GPUs behind one media stack. The floor divides out the
	//                          encoder block while the compositing under test is shader-bound,
	//                          and those two do not scale together — NVENC and VCN sit far
	//                          closer to each other than the shader arrays behind them do.
	//   between platforms      a product fact, not an error. A tool tuned for VideoToolbox on
	//                          Apple silicon and one tuned for a discrete GPU on Windows are not
	//                          expected to keep their cost. More submissions will never make
	//                          this converge; there is nothing there to converge to.
	//
	// Measured per build against itself, not per pair of tools. The ratio graph could only see a
	// disagreement where the same two tools had been measured together twice, which needed a
	// second product to say anything about the first. A build measured on three machines
	// disagrees with itself, and saying so takes no second tool.
	const consistency = (() => {
		const span = (xs) => Math.max(...xs) - Math.min(...xs);
		const all = [];
		const sameGpu = [];
		const same = [];
		const cross = [];
		let worst = null;
		for (const [node, obs] of perTool) {
			if (obs.length < 2) continue;
			all.push(span(obs.map((o) => Math.log(o.cost))));
			const byPlat = new Map();
			for (const o of obs) {
				const p = o.platform ?? "?";
				if (!byPlat.has(p)) byPlat.set(p, new Map());
				const byGpu = byPlat.get(p);
				const g = o.machine?.gpu ?? "?";
				if (!byGpu.has(g)) byGpu.set(g, []);
				byGpu.get(g).push(Math.log(o.cost));
			}
			for (const byGpu of byPlat.values()) {
				for (const rs of byGpu.values()) if (rs.length > 1) sameGpu.push(span(rs));
				const flat = [...byGpu.values()].flat();
				if (flat.length > 1) same.push(span(flat));
			}
			// Between platforms, the gap between their central values, so a platform measured
			// twice does not contribute its own noise to the cross-platform figure.
			if (byPlat.size > 1) {
				cross.push(span([...byPlat.values()].map((byGpu) => median([...byGpu.values()].flat()))));
			}
			const lo = obs.reduce((m, o) => (o.cost < m.cost ? o : m));
			const hi = obs.reduce((m, o) => (o.cost > m.cost ? o : m));
			const width = Math.log(hi.cost) - Math.log(lo.cost);
			if (!worst || width > worst.width) worst = { node, tool: obs[0].tool, width, lo, hi };
		}
		const pct = (xs) => (xs.length ? +((Math.exp(median(xs)) - 1) * 100).toFixed(2) : null);
		const side = (o) => ({
			machine: o.machine?.chip ?? "?",
			platform: o.platform,
			cost: +o.cost.toFixed(2),
		});
		return {
			observations: [...perTool.values()].reduce((n, o) => n + o.length, 0),
			// A build measured once disagrees with nothing. Where none has been measured twice the
			// aggregate says the spread is not measurable rather than printing a zero that would
			// read as agreement.
			repeatedBuilds: all.length,
			measurable: all.length > 0,
			medianSpreadPercent: pct(all),
			maxSpreadPercent: all.length ? +((Math.exp(Math.max(...all)) - 1) * 100).toFixed(2) : null,
			byPlatform: {
				sameGpuRepeats: sameGpu.length,
				samePlatformRepeats: same.length,
				crossPlatformRepeats: cross.length,
				sameGpuSpreadPercent: pct(sameGpu),
				samePlatformSpreadPercent: pct(same),
				crossPlatformSpreadPercent: pct(cross),
			},
			worst: worst && {
				node: worst.node,
				tool: worst.tool,
				spreadPercent: +((Math.exp(worst.width) - 1) * 100).toFixed(2),
				ends: [side(worst.lo), side(worst.hi)],
			},
		};
	})();

	/* ---- one figure per build, in units of the floor ------------------------------------ */
	//
	// The average of what was measured, and nothing else. 1.00× means "as fast as ffmpeg" because
	// every `cost` folded in was already divided by one, on its own machine, minutes from the
	// export. There is no level to restore and no scale to pin: the unit came in with the data.
	//
	// Averaged per setup before it is averaged across them. OpenScreen 1.11.0-rc ran four times
	// on one M1 at 1.04× and once on a Ryzen laptop at 1.46×; averaging the ten runs flat lands
	// near the M1 figure, which is a fact about who submitted most rather than about the tool.
	// Each platform-chip-GPU therefore counts once. Weights apply inside a setup, where they
	// grade the conditions of a run against other runs of the same hardware, and nowhere outside
	// it, where the differences are hardware rather than quality.
	//
	// A plain mean, not a geometric one. These are ratios, so the geometric mean is the textbook
	// choice, and on this corpus it sits between the mean and the median without reordering a
	// single row. What one bar is claiming to be is the average cost across the machines
	// measured, and a reader who wants to check it should be able to add up the run table.
	const setupKey = (o) =>
		JSON.stringify([o.platform ?? "?", o.machine?.chip ?? "?", o.machine?.gpu ?? "?"]);
	// Kept rather than reduced away, because the headline has to recombine them. A tool whose
	// newest build is not the newest everywhere is ranked from the newest build *per platform*
	// (see `newestPerPlatform`), and that row is the average over setups drawn from more than
	// one build. It cannot be assembled from the builds' finished averages without knowing how
	// many setups each rests on and which platform each sat on.
	const perSetup = (obs) => {
		const by = new Map();
		for (const o of obs) {
			const k = setupKey(o);
			if (!by.has(k)) by.set(k, []);
			by.get(k).push(o);
		}
		return [...by.values()].map((rs) => ({
			platform: rs[0].platform,
			machine: rs[0].machine?.chip ?? null,
			gpu: rs[0].machine?.gpu ?? null,
			runs: rs.length,
			cost: +weightedMean(rs.map((o) => ({ value: o.cost, weight: o.weight }))).toFixed(3),
		}));
	};
	const tools = [...nodes].map((node) => {
		const obs = perTool.get(node) ?? [];
		const setups = perSetup(obs);
		return {
			// The node id, and the two halves it is made of. `tool` stays the registry id so a row
			// can still be named, filtered and joined to the roster; `build` is what makes it a
			// competitor of its own.
			node,
			tool: obs[0]?.tool ?? node,
			build: obs[0]?.build ?? null,
			prerelease: isPrerelease(obs[0]?.build),
			relativeCost: +(setups.reduce((n, s) => n + s.cost, 0) / setups.length).toFixed(3),
			setups,
			submissions: obs.length,
			machines: [...new Set(obs.map((o) => o.machine?.chip).filter(Boolean))],
			platforms: [...new Set(obs.map((o) => o.machine?.platform).filter(Boolean))],
			// The exact builds folded into this node. Usually one; more than one only where an rc
			// series was collapsed, and then the reader is told rather than left to assume.
			versions: [...new Set(obs.map((o) => normaliseVersion(o.version)).filter(Boolean))].sort(
				cmpStr,
			),
			// Always contains `relativeCost` now — an average of averages is bounded by the
			// observations on both sides. The page prints it as the honest width of what it ranked.
			observedCostRange: obs.length
				? [
						+Math.min(...obs.map((o) => o.cost)).toFixed(3),
						+Math.max(...obs.map((o) => o.cost)).toFixed(3),
					]
				: null,
		};
	});
	tools.sort((a, b) => a.relativeCost - b.relativeCost || cmpStr(a.node, b.node));

	// The one place a node can still average two builds: an rc series folded into `1.11.0-rc`.
	// That fold is deliberate — nobody wants four rc rows — but two candidates for one release
	// can differ as much as two releases do, so a folded node that rests on more than one exact
	// build says which, rather than presenting itself as a single measured thing.
	const buildSpread = tools
		.filter((t) => t.versions.length > 1)
		.map((t) => ({
			node: t.node,
			tool: t.tool,
			build: t.build,
			versions: t.versions,
			submissions: t.submissions,
		}));

	return { tools, used, skipped, consistency, buildSpread, unplaceable };
}
