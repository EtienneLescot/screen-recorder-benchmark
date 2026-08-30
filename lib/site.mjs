/**
 * The published page: what the aggregate looks like to somebody who did not run it.
 *
 * Generated from `submissions/` on every merge, so the site cannot drift from the data. It
 * leads with the ratio, never with seconds, and it shows what would let a reader distrust it —
 * how many machines each figure rests on, how much redundant paths disagree, whether the
 * groups are even connected, and who submitted what.
 *
 * Every sentence on the page that names a number is written from the data rather than typed in.
 * The design mock that this layout follows carried its own hand-written prose — "the 5800X
 * submission names no GPU", "no NVIDIA submissions yet" — and both had already stopped being
 * true of the tree they described. A page whose credibility is the whole product cannot carry a
 * caption that ages, so the captions are derived and the constants are the method.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { aggregate, normaliseVersion } from "./aggregate.mjs";
import { STYLE } from "./siteStyle.mjs";

const esc = (s) =>
	String(s ?? "").replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	);

/**
 * What a tool is called on the page.
 *
 * The registry keys a leg by how it is driven — `openscreen-cli`, `openscreen-gui` — because the
 * harness needs to tell them apart. A reader does not: both drive the same export backend and
 * the difference between them is marginal. The label drops the suffix; the "Driven" column still
 * says `cli` or `cdp`, so how a number was obtained stays visible without living in its name.
 */
const displayTool = (id) => String(id ?? "").replace(/-(cli|gui)$/, "");

/**
 * What a machine is called in a column that has to stay narrow.
 *
 * The OS reports a marketing string — "AMD Ryzen 5 7520U with Radeon Graphics", trailing padding
 * included — and repeating it in fifteen rows costs the table half its width for one repeated
 * fact. The part that identifies the silicon survives; the untouched string and the GPU ride
 * along in the cell's title, so nothing is dropped, only folded.
 */
const machineLabel = (s) =>
	String(s ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\s+\d+-Core Processor$/i, "")
		.replace(/\s+with\s+.*\bGraphics$/i, "")
		.replace(/^(AMD|Intel\(R\)|Intel)\s+/i, "")
		.trim() || "unknown";

/**
 * The vendor behind a reported GPU string, or nothing.
 *
 * Coarse on purpose. The scopes below need to say "AMD graphics" and "NVIDIA graphics" because
 * that is the split the ratios actually move across — the floor divides out the encoder block
 * while the compositing under test is shader-bound, and those do not scale together. Naming the
 * exact board would make every machine its own scope, which is what the machine scope is for.
 */
const gpuVendor = (s) => {
	const g = String(s ?? "");
	if (/nvidia|geforce|\brtx\b|\bgtx\b|quadro/i.test(g)) return "NVIDIA";
	if (/\bamd\b|radeon/i.test(g)) return "AMD";
	if (/apple/i.test(g)) return "Apple";
	if (/intel|\barc\b|iris|\buhd\b/i.test(g)) return "Intel";
	return null;
};

// `darwin` and `win32` are what Node calls them, not what a reader calls them. The ids stay the
// values behind the filter and in the JSON; only the words on screen change.
const PLATFORM_LABEL = { darwin: "macOS", win32: "Windows", linux: "Linux" };
const platformName = (pf) => PLATFORM_LABEL[pf] ?? pf;

/**
 * Colour is data here and nothing else: one hue per platform, and no third meaning.
 *
 * The two hues sit at the same chroma and lightness and differ only in hue, so neither reads as
 * louder than the other — a requirement when they stand for two vendors' platforms. A platform
 * the palette has no hue for falls back to ink rather than inventing one, and no ranking is ever
 * colour-coded: bar length carries the comparison.
 */
const PLATFORM_INK = { darwin: "var(--accent)", win32: "var(--warm)" };
const platformInk = (pf) => PLATFORM_INK[pf] ?? "var(--ink-2)";

/** 3.400 → "3.4", 1.210 → "1.21". The protocol's digits, without the padding. */
const trim = (n) => n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Byte order, not locale order: the generated file is diffed in CI and collation is not portable. */
const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

/**
 * The ranking, drawn from the floor outwards.
 *
 * A bar that starts at zero spends most of its length redrawing the re-encode every tool has to
 * do anyway, leaving the part a reader is choosing between — what the compositing costs on top —
 * as the short remainder. So the track starts where ffmpeg finishes: length is the excess, and
 * the figure beside it is still the whole ratio. The 1× reference is one continuous rail down
 * the left of the ranking rather than a tick repeated in every row, which would read as many
 * references instead of one.
 */
function rankChart(tools, { flagThin = true } = {}) {
	if (!tools.length) return "";
	const max = Math.max(...tools.map((t) => t.relativeCost));
	const axis = [2, 3, 4, 5, 7, 9, 11, 13].find((s) => s >= max * 1.12) ?? Math.ceil(max * 1.15);
	// Clamped, because a tool below the floor is a real result the page already words for — see
	// `heroUnit`. Unclamped it emits a negative width, the browser drops the whole declaration,
	// and the row keeps its figure while losing its bar.
	const pct = (v) => `${(Math.max(0, (v - 1) / (axis - 1)) * 100).toFixed(1)}%`;

	const ticks = ['<span class="floor" style="left:0">ffmpeg 1.00×</span>'];
	const stride = axis > 7 ? 2 : 1;
	for (let v = axis; v >= 2; v -= stride) {
		// A tick crowded against the floor label is two numbers in one place, and the leftmost
		// inch of the axis is where the leader's bar starts.
		if ((v - 1) / (axis - 1) < 0.14) continue;
		// The top tick is the one the phone keeps: with the floor named at the left edge and the
		// ceiling at the right, the bars are still readable when the interior ticks will not fit.
		const top = v === axis;
		const shift = top ? "translateX(-100%)" : "translateX(-50%)";
		ticks.push(
			`<span class="tick${top ? " top" : ""}" style="left:${pct(v)};transform:${shift}">${v}×</span>`,
		);
	}

	const rows = tools
		.map((t, i) => {
			// One machine is not a cross-check. The stripe and the tag say so on the bar itself,
			// rather than in a footnote the eye reaches after it has already ranked them. Inside a
			// scope that *is* one machine the mark says nothing — every row would carry it, and the
			// note above the chart has already said it once.
			const thin = flagThin && (t.machines?.length ?? 0) < 2;
			const tag = thin
				? '<span class="tag" title="measured on one machine — no independent confirmation">1 machine</span>'
				: "";
			return `      <article class="rank-row">
        <div class="rank-head">
          <span class="rank-no">${String(i + 1).padStart(2, "0")}</span>
          <h3>${esc(displayTool(t.tool))}</h3>${tag}
          <div class="rank-val"><b>${t.relativeCost.toFixed(2)}</b><span>×</span></div>
        </div>
        <div class="rank-track"><i${thin ? ' class="thin"' : ""} style="width:${pct(t.relativeCost)}"></i></div>
      </article>`;
		})
		.join("\n");

	return `<div class="chart">
      <div class="chart-axis">${ticks.join("")}</div>
${rows}
      <p class="chart-foot">Bars start where ffmpeg finishes: their length is what the tool spends
      on top of a raw re-encode. The figure beside each is the full ratio, floor included.</p>
    </div>`;
}

/**
 * The buttons that re-rank the page, and the rankings behind them.
 *
 * A consensus across every machine answers "which is fastest in general", which is not the
 * question a reader with one laptop has. Each scope is the *same* solve run over a subset of the
 * submissions rather than a cheaper average, so a scoped figure and the headline are the same
 * kind of number and can be read against each other.
 *
 * Platforms are the roster's three rather than the ones that happen to have data: a scope with
 * nothing in it names a gap, and the caveat it shows is a finding. Two buttons that would select
 * exactly the same runs collapse to the first — with one Mac in the tree, "macOS", "Apple
 * graphics" and "Apple M1" are one set of runs wearing three labels, and offering all three
 * implies a coverage that is not there.
 *
 * The pool is what the solve actually counted, not everything in `submissions/`. The aggregate
 * drops a submission on the wrong scenario rung or on footage nobody else can obtain, and those
 * still appear in the run table below as a worked example. Scoping over the raw tree would let a
 * button say "nothing has been measured on this machine" about a machine the table lists.
 */
function buildScopes(submissions, { result, step }) {
	const pool = (result.used ?? []).map((u) => u.sub).filter((s) => submissions.includes(s));
	if (!pool.length) return [];
	const platformOf = (s) => s.machine?.platform ?? s.platform ?? "";
	const groups = [
		{ name: "", items: [{ id: "all", label: "All", tail: "across every run measured so far." }] },
		{
			name: "Platform",
			items: ["darwin", "win32", "linux"].map((pf) => ({
				id: `p-${pf}`,
				label: platformName(pf),
				tail: `on ${platformName(pf)}.`,
				platform: pf,
				filter: (s) => platformOf(s) === pf,
			})),
		},
		{
			name: "GPU",
			items: [...new Set(pool.map((s) => gpuVendor(s.machine?.gpu)).filter(Boolean))]
				.sort(cmp)
				.map((v) => ({
					id: `g-${v.toLowerCase()}`,
					label: v,
					tail: `on ${v} graphics.`,
					filter: (s) => gpuVendor(s.machine?.gpu) === v,
				})),
		},
		{
			name: "Machine",
			items: [...new Set(pool.map((s) => machineLabel(s.machine?.chip)))].sort(cmp).map((m, i) => ({
				id: `m-${i}`,
				label: m,
				tail: `on ${m}.`,
				filter: (s) => machineLabel(s.machine?.chip) === m,
			})),
		},
	];

	const seen = new Set();
	const scopes = [];
	for (const group of groups) {
		let first = true;
		for (const item of group.items) {
			const subs = item.filter ? pool.filter(item.filter) : pool;
			const key = subs.map((s) => pool.indexOf(s)).join(",");
			// Only runs collapse into each other. Two empty scopes are two separate gaps — with
			// submissions on one platform only, collapsing them would keep one empty button and
			// silently drop the rest, which is the opposite of naming the gap.
			if (subs.length && seen.has(key)) continue;
			if (subs.length) seen.add(key);
			scopes.push({
				...item,
				subs,
				// Reused rather than re-solved, so the headline scope is the same object that was
				// written to docs/aggregate.json down to the last digit.
				res: item.id === "all" ? result : aggregate(subs, { step }),
				group: first ? group.name : "",
			});
			first = false;
		}
	}
	return scopes;
}

/** What a scope rests on, in its own words — never a claim the subset cannot carry. */
function scopeNote(scope) {
	const tools = scope.res.tools;
	if (!tools.length) return "";
	const legs = tools.reduce((n, t) => n + t.submissions, 0);
	const machines = [...new Set(scope.subs.map((s) => machineLabel(s.machine?.chip)))].sort(cmp);
	const platforms = [
		...new Set(scope.subs.map((s) => s.machine?.platform ?? s.platform).filter(Boolean)),
	];
	if (scope.id === "all") {
		return `All ${plural(legs, "run")} — ${plural(tools.length, "tool")}, ${plural(machines.length, "machine")}, ${plural(platforms.length, "platform")}. Combined as a graph of ratios, so no tool is the denominator.`;
	}
	const one = machines.length === 1 ? " One machine is a data point, not a verdict." : "";
	return `${machines.join(" · ")} — ${plural(legs, "run")}, ${plural(tools.length, "tool")}.${one}`;
}

/** A scope nothing has been measured in, explained from the roster rather than left blank. */
function emptyScope(scope, roster) {
	const where = scope.tail.replace(/\.$/, "");
	const col = { darwin: "macos", win32: "windows", linux: "linux" }[scope.platform];
	if (!col) {
		return `<div class="aside empty">
        <p class="lead">Nothing measured ${esc(where)} yet.</p>
        <p class="fine">No submission in the tree was produced ${esc(where)}, so this scope has
        nothing to rank. It is empty by fact, not by omission.</p>
      </div>`;
	}
	const named = (v) =>
		roster
			.filter((r) => r[col] === v)
			.map((r) => r.tool)
			.join(", ");
	const members = named("✓");
	const degraded = named("degraded");
	const article = /^[AEIOU]/.test(scope.label) ? "an" : "a";
	const claim = members
		? `The roster lists ${esc(members)} as ${members.includes(",") ? "members" : "a member"} on ${esc(scope.label)}${degraded ? `, and ${esc(degraded)} as degraded there` : ""}, but nothing has been measured on ${article} ${esc(scope.label)} machine.`
		: `Nothing has been measured on ${article} ${esc(scope.label)} machine.`;
	return `<div class="aside empty">
        <p class="lead">No ${esc(scope.label)} submissions yet.</p>
        <p class="fine">${claim} This scope is empty by fact, not by omission.</p>
      </div>`;
}

export function renderSite(result, { submissions, generatedAt, roster = [], step = null }) {
	// One row per measurement, not per submission: a reader comparing machines wants the leg,
	// with the machine that produced it attached. `frames` and `durationSec` come from the
	// source, so frames per second is derived rather than asserted — it is the same number the
	// run printed as "×realtime", scaled by the output rate.
	const runRows = submissions.flatMap((sub) =>
		(sub.measurements ?? [])
			.filter((m) => m.verified && m.exportMs && m.localFloorMs)
			.map((m) => {
				const secs = m.exportMs / 1000;
				const frames = sub.source?.frames ?? null;
				return {
					machine: sub.machine?.chip ?? "unknown",
					gpu: sub.machine?.gpu ?? "",
					platform: sub.machine?.platform ?? "",
					cores: sub.machine?.cpuCount ?? null,
					memory: sub.machine?.memoryGiB ?? null,
					tool: m.tool,
					// Normalised, not raw. Windows pads a three-part version with a fourth zero, so
					// Recordly 1.3.3 arrives as "1.3.3.0" — and the per-tool table, which reads the
					// aggregate's already-folded set, printed 1.3.3 two rows away from it. One build,
					// two spellings, on one page.
					version: normaliseVersion(m.version) ?? "",
					cost: +(m.exportMs / m.localFloorMs).toFixed(3),
					seconds: +secs.toFixed(2),
					// Published so a reader who re-runs and lands elsewhere can see whether they are
					// outside this machine's own spread. It was computed and dropped until
					// 2026-08-28: every submission in the repository claimed none.
					madSeconds: m.madMs != null ? +(m.madMs / 1000).toFixed(2) : null,
					// CPU-seconds over wall time: how many cores the export kept busy on average. The
					// raw CPU·s already sat in this table and said little at a glance; this is the
					// figure that separates compositing on the GPU from compositing on the CPU, and it
					// moves by an order of magnitude where the time ratio moves by a factor of three.
					coreAvg: m.cpuSeconds != null && secs > 0 ? +(m.cpuSeconds / secs).toFixed(2) : null,
					fps: frames ? +(frames / secs).toFixed(1) : null,
					cpuSeconds: m.cpuSeconds ?? null,
					peakRssMiB: m.peakRssMiB ?? null,
					fidelity: m.fidelity ?? null,
					automation: m.automation ?? "",
					background: m.foreignCpuPercent ?? null,
					date: (sub.submittedAt ?? "").slice(0, 10),
				};
			}),
	);

	/**
	 * A strip plot: one row per tool, one dot per measurement, positioned by cost.
	 *
	 * This has to survive an unbounded number of submitters, which rules out the obvious forms.
	 * A slope chart drew the two-machine case beautifully and would be spaghetti at ten; anything
	 * keyed on machine identity needs a colour per machine, and machines are not a bounded set.
	 * Platforms are — the roster fixes them at three — so colour carries platform and position
	 * carries the measurement. Adding submitters then makes each row denser rather than making
	 * the chart unreadable, and the spread within a row is itself the finding: where a tool's
	 * dots straddle another's, the ranking is not a property of the tool.
	 */
	const stripTools = [...new Set(runRows.map((r) => r.tool))].sort(
		(a, b) =>
			Math.min(...runRows.filter((r) => r.tool === a).map((r) => r.cost)) -
			Math.min(...runRows.filter((r) => r.tool === b).map((r) => r.cost)),
	);
	const stripPlatforms = [...new Set(runRows.map((r) => r.platform).filter(Boolean))].sort(cmp);
	const hi = Math.max(2, Math.ceil(Math.max(1.2, ...runRows.map((r) => r.cost)) * 1.03));
	const at = (c) => `${((c / hi) * 100).toFixed(2)}%`;

	const gridLines = [];
	const footTicks = [];
	for (let v = 1; v < hi; v++) {
		gridLines.push(`<i${v === 1 ? ' class="floor"' : ""} style="left:${at(v)}"></i>`);
		footTicks.push(`<span style="left:${at(v)}">${v}×</span>`);
	}

	const stripRows = stripTools
		.map((tool) => {
			const mine = runRows.filter((r) => r.tool === tool);
			const lo = Math.min(...mine.map((r) => r.cost));
			const up = Math.max(...mine.map((r) => r.cost));
			const range =
				mine.length > 1
					? `<div class="rng" style="left:${at(lo)};width:${(((up - lo) / hi) * 100).toFixed(2)}%"></div>`
					: "";
			const dots = mine
				.map(
					(r) =>
						`<div class="dot" style="left:${at(r.cost)};background:${platformInk(r.platform)}" title="${esc(machineLabel(r.machine))} (${esc(platformName(r.platform))}) — ${r.cost}× the floor, ${r.seconds} s${r.fps ? `, ${r.fps} fps` : ""}"></div>`,
				)
				.join("");
			return `        <div class="strip-row">
          <div class="strip-name">${esc(displayTool(tool))}</div>
          <div class="strip-lane">${range}${dots}</div>
        </div>`;
		})
		.join("\n");

	const strip = runRows.length
		? `<div class="strip-wrap"><div class="strip">
      <div class="strip-grid">${gridLines.join("")}</div>
      <div class="strip-head"><div></div><div><span class="floor-tag" style="left:${at(1)}">1× = ffmpeg itself</span></div></div>
      <div class="strip-rows">
${stripRows}
      </div>
      <div class="strip-foot"><div></div><div>${footTicks.join("")}</div></div>
    </div></div>`
		: '<p class="prose">No measurements yet.</p>';

	const stripLegend = stripPlatforms
		.map(
			(pf) => `<span><i style="background:${platformInk(pf)}"></i>${esc(platformName(pf))}</span>`,
		)
		.join("");

	// Grouped by machine, then by where each tool stands overall. A reader scanning one machine's
	// block gets that machine's ranking without re-sorting, and the block boundaries fall exactly
	// where the seconds stop being comparable.
	const toolRank = new Map(result.tools.map((t, i) => [t.tool, i]));
	const sortedRuns = [...runRows].sort(
		(a, b) =>
			cmp(machineLabel(a.machine), machineLabel(b.machine)) ||
			(toolRank.get(a.tool) ?? 99) - (toolRank.get(b.tool) ?? 99) ||
			a.cost - b.cost,
	);

	const machines = [...new Set(runRows.map((r) => r.machine))].sort(cmp);
	const platforms = [...new Set(runRows.map((r) => r.platform).filter(Boolean))].sort(cmp);
	const runTable = sortedRuns
		.map(
			(
				r,
			) => `          <tr data-machine="${esc(r.machine)}" data-platform="${esc(r.platform)}" data-tool="${esc(r.tool)}">
            <td class="nw"><strong>${esc(displayTool(r.tool))}</strong>${r.version ? ` <span class="dim">${esc(r.version)}</span>` : ""}</td>
            <td class="nw" title="${esc(r.machine.replace(/\s+/g, " ").trim())}${r.gpu ? ` · ${esc(r.gpu)}` : ""}">${esc(machineLabel(r.machine))}</td>
            <td class="dim">${esc(r.platform)}</td>
            <td class="num"><strong>${r.cost.toFixed(3)}×</strong></td>
            <td class="num nw">${r.seconds.toFixed(2)}${r.madSeconds ? ` <span class="dim">±${r.madSeconds.toFixed(2)}</span>` : ""}</td>
            <td class="num">${r.fps != null ? r.fps.toFixed(1) : "—"}</td>
            <td class="num">${r.cpuSeconds != null ? r.cpuSeconds.toFixed(2) : "—"}</td>
            <td class="num">${r.coreAvg != null ? `<strong>${r.coreAvg.toFixed(2)}</strong>` : "—"}</td>
            <td class="num">${r.peakRssMiB ? Math.round(r.peakRssMiB) : "—"}</td>
            <td class="num dim">${r.background != null ? `${Math.round(r.background)}%` : "—"}</td>
            <td>${r.fidelity === 1 ? "full" : r.fidelity != null ? `${Math.round(r.fidelity * 100)}%` : "—"}</td>
            <td class="dim">${esc(r.automation)}</td>
          </tr>`,
		)
		.join("\n");

	// The one table that keeps the registry id. Everywhere else `openscreen-cli` reads as
	// `openscreen` because the Driven column says how it was obtained; this table has no such
	// column, and folding the suffix here would print two rows both called "openscreen" with
	// different costs and no way to tell which is which.
	const perTool = result.tools
		.map(
			(t) => `            <tr>
              <td><strong>${esc(t.tool)}</strong></td>
              <td class="num">${t.relativeCost}×</td>
              <td class="num">${t.submissions}</td>
              <td class="dim">${esc(t.platforms.map(platformName).join(", ") || "—")}</td>
              <td class="num nw">${t.observedCostRange ? `${trim(t.observedCostRange[0])}–${trim(t.observedCostRange[1])}×` : "—"}</td>
              <td class="num dim">${esc(t.versions.slice(0, 3).join(", ") || "—")}</td>
            </tr>`,
		)
		.join("\n");

	// A cell is membership on that platform. `n/a` is a fact about the product, and the reason a
	// short table is a result rather than missing coverage.
	const CELL = {
		"✓": '<span class="mark" title="roster member"></span>',
		degraded: '<span class="deg" title="member, degraded on this platform">degraded</span>',
		"n/a": '<span class="dim" title="the product does not exist on this platform">n/a</span>',
	};
	const cell = (v) => CELL[v] ?? esc(v ?? "—");
	const rosterRows = roster
		.map(
			(r) => `            <tr>
              <td><strong>${esc(r.tool)}</strong></td>
              <td class="mid">${cell(r.macos)}</td>
              <td class="mid">${cell(r.windows)}</td>
              <td class="mid">${cell(r.linux)}</td>
            </tr>`,
		)
		.join("\n");

	// The roster carried a free-prose note per tool — "defines the category", "the only
	// architectural peer". Every one of them was a judgement about a competitor written by a
	// maintainer of another entrant, and no wording makes that column defensible. It is gone.
	// What survives is citation: a cell that is not ✓ says who says so, which is the opposite
	// of commentary.
	const rosterSources = roster
		.flatMap((r) => Object.entries(r.sources ?? {}).map(([p, why]) => [r.tool, p, why]))
		.map(
			([tool, plat, why]) =>
				`<li><strong>${esc(tool)}</strong> on ${esc(platformName(plat))} — ${esc(why)}</li>`,
		)
		.join("");

	const c = result.consistency;
	const scopes = buildScopes(submissions, { result, step });

	// The unit the whole page is built on, spelled out once in the leader's own figure rather
	// than as an invented example.
	const lead = result.tools[0]?.relativeCost ?? null;
	const heroUnit =
		lead == null
			? "so 2× means twice as long as a raw re-encode, on any hardware."
			: lead >= 1
				? `so ${lead.toFixed(2)}× means ${Math.round((lead - 1) * 100)}% longer than a raw re-encode, on any hardware.`
				: `so ${lead.toFixed(2)}× means ${Math.round((1 - lead) * 100)}% quicker than a raw re-encode, on any hardware.`;

	const leadLine = (tools, tail) =>
		tools.length > 1
			? `<strong>${esc(displayTool(tools[0].tool))}</strong> exports fastest ${esc(tail)}`
			: tools.length === 1
				? `Only <strong>${esc(displayTool(tools[0].tool))}</strong> has been measured ${esc(tail)}`
				: `Nothing has been measured ${esc(tail)}`;

	let n = 0;
	const sec = () => String(++n).padStart(2, "0");

	return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Screen Recorder Export Benchmark</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="How long desktop screen-demo apps take to export the same edit, measured against a plain ffmpeg transcode on the same machine and verified in pixels and audio.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<!-- Before the stylesheet, so a reader who chose light on a dark system does not watch the page
     paint the wrong theme and correct itself on every load. -->
<script>try{const t=localStorage.getItem("srb-theme");if(t)document.documentElement.setAttribute("data-theme",t)}catch(e){}</script>
<style>${STYLE}</style>
<div class="page">

  <header class="topbar">
    <div class="brand">
      <b>Screen Recorder Export Benchmark</b>
      <span>Independent</span><span>Reproducible</span><span>Open data</span>
    </div>
    <button id="theme-btn" class="btn" type="button">Theme</button>
  </header>

  <section class="hero">
    <div>
      <h1>Which screen recorder exports fastest?</h1>
      <p class="hero-lede">Same clip, same edit, same machine. We time each app's export, then
      divide by what plain <code>ffmpeg</code> needs on that machine — ${heroUnit}</p>
    </div>
    <div class="hero-side">
      <div class="stats">
        <div><b>${submissions.length}</b><span>Submissions</span></div>
        <div><b>${runRows.length}</b><span>Runs</span></div>
        <div><b>${result.tools.length}</b><span>Tools timed</span></div>
        <div><b>${machines.length}</b><span>Machines</span></div>
        <div><b>${platforms.length}</b><span>Platforms</span></div>
      </div>
      <div class="stamp">Data as of ${esc(generatedAt)} · every export re-checked in pixels and
      audio before it counts</div>
    </div>
  </section>
${
	result.components.length > 1
		? `
  <div class="aside before">
    <p class="lead"><strong>${result.components.length} disconnected groups.</strong> Tools in
    different groups have never been measured on the same machine, so they cannot be compared.</p>
    <p class="fine">Submitting a run that measures one tool from each would join them, and the
    ranking below would recompose across the whole set instead of within each group.</p>
  </div>
`
		: ""
}
  <section class="lead-section">
    <div class="sec-head">
      <h2>${sec()} — Ranking</h2>
      <span class="sec-note">Lower is faster</span>
    </div>
${
	scopes.length
		? `${scopes
				.map(
					(s, i) =>
						`    <p class="lead-line" data-scope="${s.id}"${i ? " hidden" : ""}>${leadLine(s.res.tools, s.tail)}</p>`,
				)
				.join("\n")}

    <div class="scopes">
${scopes
	.map(
		(s) =>
			`      <div class="scope-group">${s.group ? `<span>${esc(s.group)}</span>` : ""}<button type="button" class="scope-btn" data-for="${s.id}" aria-pressed="${s.id === "all"}">${esc(s.label)}</button></div>`,
	)
	.join("\n")}
    </div>

${scopes
	.map((s, i) => {
		const note = scopeNote(s);
		const machines = new Set(s.subs.map((x) => machineLabel(x.machine?.chip)));
		return `    <div data-scope="${s.id}"${i ? " hidden" : ""}>
${note ? `      <p class="scope-note">${esc(note)}</p>\n` : ""}      ${s.res.tools.length ? rankChart(s.res.tools, { flagThin: machines.size > 1 }) : emptyScope(s, roster)}
    </div>`;
	})
	.join("\n")}`
		: result.tools.length
			? `    <p class="lead-line">${leadLine(result.tools, "across every run measured so far.")}</p>
    ${rankChart(result.tools)}`
			: '    <p class="prose">No submissions yet.</p>'
}

    <div class="tri">
      <p><strong>Read the ratio, not the seconds.</strong> 2× means the export took twice as long
      as ffmpeg did on that machine — not twice as fast.</p>
      <p><strong>The floor does no work.</strong> ffmpeg composites nothing, so every tool that
      paints a wallpaper, rounds the corners and animates a zoom sits above 1×. The question is
      how far above.</p>
      <p><strong>No tool is the reference.</strong> Runs are combined as a graph of ratios, so the
      standing recomposes as coverage grows.</p>
    </div>
${
	// Gated on `measurable`, not on the numbers being present. With no redundant path the
	// solver still reports 0% residual — it fits one edge perfectly because nothing
	// contradicts it — and printing that as agreement claims a cross-check that never ran.
	c?.measurable
		? (
				() => {
					// This note used to open "the machines do not fully agree", name one edge, and
					// name the machine it was taken on — three ways of calling a normal result a
					// defect. Nothing disagrees. A tool tuned for VideoToolbox on Apple silicon
					// and one tuned for a discrete GPU on Windows are not expected to keep their
					// order, and the spread between them is the most useful thing on this page:
					// it says the single number above is a consensus, and that your own hardware
					// is what decides which tool wins for you.
					const w = c.worst;
					const example = w
						? `<code>${esc(displayTool(w.a))}</code> takes ${w.ends[1].ratio}× as long as <code>${esc(displayTool(w.b))}</code> on ${esc(machineLabel(w.ends[1].machine))}, and ${w.ends[0].ratio}× as long on ${esc(machineLabel(w.ends[0].machine))}${w.inverts ? " — the two swap places" : ""}. `
						: "";
					return `
    <div class="aside after">
      <p class="lead"><strong>Which tool leads depends on the machine.</strong> Where a pair was
      measured on more than one, its ratio moves by ${c.medianResidualPercent}% at the median.</p>
      <p class="fine">${example}Different encoders, GPUs and drivers — not a fault in the
      measurement, and a tool built against one stack has no obligation to lead on another. It is
      also why the figure above is a consensus rather than a verdict: use the scopes to see
      hardware like yours. Only pairs measured on more than one platform can be compared this way,
      so each new submission narrows what the consensus is guessing at.</p>
    </div>`;
				}
			)()
		: `
    <div class="aside after">
      <p class="lead"><strong>Not cross-checked yet.</strong> Every ratio here rests on a single
      machine.</p>
      <p class="fine">Nothing here has been measured twice, so the ranking cannot yet be told apart
      from the hardware that produced it. That becomes checkable as soon as a second submission
      measures an overlapping pair.</p>
    </div>`
}
${
	result.versionSpread?.length
		? (
				() => {
					// Two different weaknesses, and collapsing them into "mixed versions" hid the
					// worse one. A figure resting on 1.2 and 1.3 rests on two known builds, which
					// is the cost of measuring tools as shipped. A figure resting on 1.3 and a
					// submission that recorded no version at all may rest on one build or two, and
					// nobody can tell which — that is not spread, it is a gap.
					const spread = result.versionSpread.filter((v) => v.versions.length > 1);
					const gaps = result.versionSpread.filter((v) => v.unreported > 0);
					const say = (v) =>
						`<code>${esc(displayTool(v.tool))}</code> ${v.versions.length ? `on ${esc(v.versions.join(", "))}` : "on no recorded build"}${v.unreported ? `, with ${v.unreported} of ${plural(v.submissions, "run")} reporting none` : ""}`;
					return `
    <div class="aside after">
      <p class="lead"><strong>${gaps.length ? "A build here is unaccounted for." : "Mixed versions."}</strong>
      ${
				gaps.length
					? "One or more submissions did not record which build they measured, so a line may be folding two builds into one without saying so."
					: "A figure here rests on more than one build."
			}</p>
      <p class="fine">${[...new Set([...gaps, ...spread])].map(say).join("; ")}. Tools are measured
      as shipped rather than pinned, so a figure resting on several known builds is expected as
      submissions accumulate. A missing version is not: it is a defect in the submitting harness,
      and the fix is to re-measure rather than to assume.</p>
    </div>`;
				}
			)()
		: ""
}
  </section>

  <section>
    <div class="sec-head">
      <h2>${sec()} — Spread across machines</h2>
      <div class="legend">${stripLegend}</div>
    </div>
    <p class="prose">One dot per run. Where one tool's dots straddle another's, the machine
    decides the order — not the tool. Hover a dot for the machine and the seconds.</p>
    ${strip}
    <p class="mono-note">Export time ÷ the same machine's ffmpeg transcode. 2× means twice as long,
    not twice as fast.</p>
  </section>

  <section>
    <div class="sec-head">
      <h2>${sec()} — Every run</h2>
      <span class="sec-note" id="f-count">${plural(runRows.length, "run")}</span>
    </div>
    <p class="prose">Every run, with the machine that produced it. <strong>Cost</strong> compares
    across rows; seconds and frame rate don't — they describe one machine.</p>

    <div class="filters">
      <label>Machine
        <select id="f-machine"><option value="">all</option>${machines
					.map((m) => `<option value="${esc(m)}">${esc(machineLabel(m))}</option>`)
					.join("")}</select>
      </label>
      <label>Platform
        <select id="f-platform"><option value="">all</option>${platforms
					.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`)
					.join("")}</select>
      </label>
      <label>Tool
        <select id="f-tool"><option value="">all</option>${[...new Set(runRows.map((r) => r.tool))]
					.sort(cmp)
					.map((t) => `<option value="${esc(t)}">${esc(displayTool(t))}</option>`)
					.join("")}</select>
      </label>
    </div>

    <div class="tw ruled">
      <table id="runs">
        <thead>
          <tr>
            <th>Tool</th><th>Machine</th><th>OS</th><th class="num">Cost</th>
            <th class="num">Export s</th><th class="num">fps</th><th class="num">CPU·s</th>
            <th class="num">Cores</th><th class="num">RSS MiB</th><th class="num">Bg load</th>
            <th>Fidelity</th><th>Driven</th>
          </tr>
        </thead>
        <tbody>
${runTable || '          <tr><td colspan="12" class="dim">No runs yet.</td></tr>'}
        </tbody>
      </table>
    </div>

    <div class="tri tight">
      <p><strong>Export</strong> carries ± the median absolute deviation of that machine's own
      scoring runs, so a re-run landing elsewhere can be read against the spread rather than
      against a single number.</p>
      <p><strong>Cores</strong> is CPU-seconds ÷ export time: how many cores the export kept busy.
      It separates compositing on the GPU from compositing on the CPU. No GPU time is measured on
      either side, so a low figure means quieter fans and longer battery — not less work.</p>
      <p><strong>Bg load</strong> is everything running that was <em>not</em> the tool under test,
      with the tool's own processes subtracted. Where two rows on one machine differ sharply,
      don't read their raw seconds against each other; Cost absorbs most of it.</p>
    </div>
  </section>

  <section class="duo">
    <div>
      <h2>${sec()} — Per tool</h2>
      <p class="prose">Cost, coverage and the range each tool has been seen inside.</p>
      <div class="tw narrow">
        <table>
          <thead>
            <tr>
              <th>Tool</th><th class="num">Cost</th><th class="num">Runs</th><th>Platforms</th>
              <th class="num">Range</th><th class="num">Versions</th>
            </tr>
          </thead>
          <tbody>
${perTool || '            <tr><td colspan="6" class="dim">—</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
${
	roster.length
		? `    <div>
      <h2>${sec()} — Roster</h2>
      <p class="prose">Who belongs here is decided by what a tool claims to do, not by whether an
      adapter exists. An empty cell is a finding.</p>
      <div class="tw narrow">
        <table>
          <thead>
            <tr>
              <th>Tool</th><th class="mid">macOS</th><th class="mid">Windows</th>
              <th class="mid">Linux</th>
            </tr>
          </thead>
          <tbody>
${rosterRows}
          </tbody>
        </table>
      </div>${rosterSources ? `\n      <ul class="cites">${rosterSources}</ul>` : ""}
    </div>`
		: ""
}
  </section>

  <section>
    <h2>${sec()} — Method</h2>
    <div class="cards">
      <div>
        <h3>One stopwatch</h3>
        <p>One clock, from the instant the export is committed to the moment the last byte lands.
        Every tool is timed on the same machine as its own ffmpeg floor, minutes apart.</p>
      </div>
      <div>
        <h3>Verified output</h3>
        <p>Every export is re-probed: resolution, frame rate and duration against target;
        wallpaper, padding, corners, zooms, cursor and camera in the pixels; audio by loudness,
        because a silent track passes any check that only asks whether audio exists.</p>
      </div>
      <div>
        <h3>No denominator</h3>
        <p>Runs are combined as a graph of ratios rather than averaged, so no tool is the
        reference. A tool reports what it configured; the verifier decides what happened.</p>
      </div>
    </div>
    <p class="mono-note"><a href="https://github.com/EtienneLescot/screen-recorder-benchmark/blob/main/PROTOCOL.md">Read the protocol in full →</a></p>
  </section>

  <section class="cta">
    <div class="cta-grid">
      <div>
        <h2>${sec()} — Submit a run</h2>
        <p class="cta-lead">Every new machine narrows the guess. Yours takes about twenty
        minutes.</p>
        <div class="cmd">node bench.mjs run --bundle commons-upload</div>
      </div>
      <ol class="steps">
        <li><b>01</b><span>Clone the repo and install the adapters for the tools you own.</span></li>
        <li><b>02</b><span>Run the bench on an idle machine. It measures its own ffmpeg floor
        beside every leg.</span></li>
        <li><b>03</b><span>Open a pull request with the produced JSON in <code>submissions/</code>.
        Validation runs on the PR.</span></li>
      </ol>
    </div>
  </section>

  <footer>
    <a href="https://github.com/EtienneLescot/screen-recorder-benchmark">Source</a>
    <a href="https://github.com/EtienneLescot/screen-recorder-benchmark/blob/main/PROTOCOL.md">Protocol</a>
    <a href="https://github.com/EtienneLescot/screen-recorder-benchmark/blob/main/CANDIDATES.md">Roster &amp; adapter contract</a>
    <a href="https://github.com/EtienneLescot/screen-recorder-benchmark/blob/main/CREDITS.md">Footage credits</a>
    <span class="end">MIT · data CC-BY · ${esc(generatedAt)}</span>
  </footer>
</div>

<script>
(() => {
  const root = document.documentElement;
  const themeBtn = document.getElementById("theme-btn");
  if (themeBtn) themeBtn.addEventListener("click", () => {
    const cur = root.getAttribute("data-theme");
    const dark = cur ? cur === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("srb-theme", next); } catch (e) {}
  });

  // Every scope is already in the page, solved at build time. Switching is a visibility flip,
  // so the ranking a reader lands on never depends on arithmetic done in the browser.
  const panels = [...document.querySelectorAll("[data-scope]")];
  const scopeBtns = [...document.querySelectorAll(".scope-btn")];
  for (const btn of scopeBtns) btn.addEventListener("click", () => {
    for (const p of panels) p.hidden = p.dataset.scope !== btn.dataset.for;
    for (const o of scopeBtns) o.setAttribute("aria-pressed", String(o === btn));
  });

  const rows = [...document.querySelectorAll("#runs tbody tr")];
  const count = document.getElementById("f-count");
  const ids = ["f-machine", "f-platform", "f-tool"];
  const apply = () => {
    const [m, p, t] = ids.map((id) => document.getElementById(id).value);
    let shown = 0;
    for (const r of rows) {
      const ok = (!m || r.dataset.machine === m) && (!p || r.dataset.platform === p) &&
                 (!t || r.dataset.tool === t);
      r.hidden = !ok;
      if (ok) shown++;
    }
    count.textContent = shown === rows.length
      ? shown + (shown === 1 ? " run" : " runs")
      : shown + " of " + rows.length + " runs";
  };
  if (rows.length && ids.every((id) => document.getElementById(id))) {
    for (const id of ids) document.getElementById(id).addEventListener("change", apply);
    apply();
  }
})();
</script>
</html>`;
}

/** Roster table for the site, read from CANDIDATES.md's source of truth. */
export function loadRoster(root) {
	try {
		return JSON.parse(readFileSync(join(root, "roster.json"), "utf8")).tools ?? [];
	} catch {
		return [];
	}
}
