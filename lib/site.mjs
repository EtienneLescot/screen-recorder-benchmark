/**
 * The published page: what the aggregate looks like to somebody who did not run it.
 *
 * Generated from `submissions/` on every merge, so the site cannot drift from the data. It
 * leads with the ratio, never with seconds, and it shows what would let a reader distrust it —
 * how many machines each figure rests on, how much redundant paths disagree, whether the
 * groups are even connected, and who submitted what.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

export function renderSite(
	result,
	{ submissions, generatedAt, roster = [], softwareFloor = null },
) {
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
					version: m.version ?? "",
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
	const PLATFORM_SERIES = { darwin: "var(--s1)", win32: "var(--s2)", linux: "var(--s3)" };
	// `darwin` and `win32` are what Node calls them, not what a reader calls them. The ids stay
	// the values behind the filter and in the JSON; only the words on screen change.
	const PLATFORM_LABEL = { darwin: "macOS", win32: "Windows", linux: "Linux" };
	const platformName = (pf) => PLATFORM_LABEL[pf] ?? pf;
	const stripTools = [...new Set(runRows.map((r) => r.tool))].sort(
		(a, b) =>
			Math.min(...runRows.filter((r) => r.tool === a).map((r) => r.cost)) -
			Math.min(...runRows.filter((r) => r.tool === b).map((r) => r.cost)),
	);
	const stripPlatforms = [...new Set(runRows.map((r) => r.platform).filter(Boolean))].sort();
	const hi = Math.max(1.2, ...runRows.map((r) => r.cost)) * 1.08;
	const W = 760;
	const rowH = 34;
	const padL = 132;
	const padR = 26;
	const padT = 26;
	const H = padT + stripTools.length * rowH + 46;
	const xOf = (c) => padL + (c / hi) * (W - padL - padR);

	const ticks = [];
	for (let v = 1; v <= hi; v += hi > 4 ? 1 : 0.5) ticks.push(+v.toFixed(1));

	const stripSvg = runRows.length
		? `<svg viewBox="0 0 ${W} ${H}" class="strip" role="img"
        aria-label="Cost against the ffmpeg floor, one dot per measurement, grouped by tool">
      ${ticks
				.map(
					(t) =>
						`<line x1="${xOf(t)}" x2="${xOf(t)}" y1="${padT - 6}" y2="${H - 26}"
               class="${t === 1 ? "floor-line" : "grid-line"}"/>
             <text x="${xOf(t)}" y="${H - 26}" class="axis mid">${t}×</text>`,
				)
				.join("")}
      <text x="${xOf(1)}" y="${padT - 12}" class="axis mid floor-tag">1× = ffmpeg itself</text>
      <text x="${padL + (W - padL - padR) / 2}" y="${H - 6}" class="axis mid caption">export time ÷ the same machine's ffmpeg transcode — 2× means twice as long, not twice as fast</text>
      ${stripTools
				.map((tool, i) => {
					const y = padT + i * rowH + rowH / 2;
					const mine = runRows.filter((r) => r.tool === tool);
					const lo = Math.min(...mine.map((r) => r.cost));
					const hiC = Math.max(...mine.map((r) => r.cost));
					const range =
						mine.length > 1
							? `<line x1="${xOf(lo)}" x2="${xOf(hiC)}" y1="${y}" y2="${y}" class="strip-range"/>`
							: "";
					const dots = mine
						.map(
							(r) =>
								`<circle cx="${xOf(r.cost)}" cy="${y}" r="5.5"
                   fill="${PLATFORM_SERIES[r.platform] ?? "var(--s4)"}"
                   stroke="var(--card)" stroke-width="1.5"><title>${esc(displayTool(r.tool))} on ${esc(r.machine)} (${esc(r.platform)}): ${r.cost}× the floor, ${r.seconds}s${r.fps ? `, ${r.fps} fps` : ""}</title></circle>`,
						)
						.join("");
					return `<text x="${padL - 12}" y="${y + 4}" class="strip-tool">${esc(displayTool(tool))}</text>
            ${range}${dots}`;
				})
				.join("")}
    </svg>`
		: "";

	const stripLegend = stripPlatforms
		.map(
			(pf) =>
				`<span class="key"><i style="background:${PLATFORM_SERIES[pf] ?? "var(--s4)"}"></i>${esc(platformName(pf))}</span>`,
		)
		.join("");

	const machines = [...new Set(runRows.map((r) => r.machine))].sort();
	const platforms = [...new Set(runRows.map((r) => r.platform).filter(Boolean))].sort();
	const runTable = runRows
		.map(
			(
				r,
			) => `<tr data-machine="${esc(r.machine)}" data-platform="${esc(r.platform)}" data-tool="${esc(r.tool)}">
      <td><strong>${esc(displayTool(r.tool))}</strong>${r.version ? ` <span class="muted">${esc(r.version)}</span>` : ""}</td>
      <td>${esc(r.machine)}</td>
      <td class="muted">${esc(r.platform)}</td>
      <td class="num"><strong>${r.cost}×</strong> <span class="muted">ffmpeg</span></td>
      <td class="num">${r.seconds} s${r.madSeconds ? ` <span class="muted">±${r.madSeconds}</span>` : ""}</td>
      <td class="num">${r.fps ?? "—"}</td>
      <td class="num">${r.cpuSeconds ?? "—"}</td>
      <td class="num">${r.coreAvg != null ? `<strong>${r.coreAvg}</strong>` : "—"}</td>
      <td class="num">${r.peakRssMiB ? Math.round(r.peakRssMiB) : "—"}</td>
      <td class="num">${r.background != null ? `${Math.round(r.background)}%` : "—"}</td>
      <td>${r.fidelity === 1 ? "full" : r.fidelity != null ? `${Math.round(r.fidelity * 100)}%` : "—"}</td>
      <td class="muted">${esc(r.automation)}</td>
    </tr>`,
		)
		.join("\n");

	// ffmpeg is drawn as the first bar, at 1×.
	//
	// The unit was described in prose — "divided by a plain ffmpeg transcode" — and a reader had
	// to hold that sentence in mind to make sense of "1.48×". Putting the reference in the chart
	// makes it visible instead: the bar the others are measured against sits above them, and
	// "1.48×" needs no explanation once you can see what 1× looks like. It is styled apart
	// because it is the ruler, not an entrant.
	const maxCost = Math.max(1, ...result.tools.map((t) => t.relativeCost));
	const floorBar = `<div class="row floor-row">
      <div class="name">ffmpeg <span class="tag">the yardstick</span></div>
      <div class="track"><div class="fill floor-fill" style="width:${(100 / maxCost).toFixed(1)}%"></div></div>
      <div class="val">1×</div>
    </div>`;
	const bars = result.tools
		.map((t) => {
			const pct = (t.relativeCost / maxCost) * 100;
			const thin = t.submissions < 2;
			return `<div class="row">
        <div class="name">${esc(displayTool(t.tool))}${thin ? '<span class="tag" title="one submission — no independent confirmation">1 machine</span>' : ""}</div>
        <div class="track"><div class="fill${thin ? " thin" : ""}" style="width:${pct.toFixed(1)}%"></div></div>
        <div class="val">${t.relativeCost}×</div>
      </div>`;
		})
		.join("\n");

	// The same tools solved against the CPU-side floor, as a column beside the encoder one rather
	// than a table below it. They answer different questions and are meant to be read together: a
	// part whose encoder block has more than one sustained clock moves every hardware-floor cost
	// while the exports themselves do not move at all. Measured on one machine, two runs an hour
	// apart, the hardware costs moved 19-27% and the software costs 1-4%.
	const swCost = new Map((softwareFloor?.tools ?? []).map((t) => [t.tool, t.relativeCost]));

	const table = result.tools
		.map(
			(t) => `<tr>
      <td><strong>${esc(t.tool)}</strong></td>
      <td class="num">${t.relativeCost}×</td>
      <td class="num">${swCost.has(t.tool) ? `${swCost.get(t.tool)}×` : '<span class="muted">—</span>'}</td>
      <td class="num">${t.submissions}</td>
      <td>${esc(t.platforms.join(", ") || "—")}</td>
      <td class="num">${t.observedCostRange ? `${t.observedCostRange[0]}–${t.observedCostRange[1]}×` : "—"}</td>
      <td class="muted">${esc(t.versions.slice(0, 3).join(", "))}</td>
    </tr>`,
		)
		.join("\n");

	// A cell is membership on that platform. `n/a` is a fact about the product, and the reason a
	// short table is a result rather than missing coverage.
	const CELL = {
		"✓": '<span title="roster member">✓</span>',
		degraded: '<span title="member, degraded on this platform">degraded</span>',
		"n/a": '<span class="muted" title="the product does not exist on this platform">n/a</span>',
	};
	const cell = (v) => CELL[v] ?? esc(v ?? "—");

	const rosterRows = roster
		.map(
			(r) => `<tr>
      <td><strong>${esc(displayTool(r.tool))}</strong></td>
      <td>${cell(r.macos)}</td><td>${cell(r.windows)}</td><td>${cell(r.linux)}</td>
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
				`<li><strong>${esc(displayTool(tool))}</strong> on ${esc(plat)} — ${esc(why)}</li>`,
		)
		.join("");

	const c = result.consistency;
	const disconnected = result.components.length > 1;

	return `<meta charset="utf-8">
<title>Screen Recorder Export Benchmark</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,600&family=IBM+Plex+Mono:wght@400;600&display=swap">
<style>
  :root {
    --bg:#fbfaf7; --ink:#1c1a17; --muted:#6f6a61; --line:#e2ddd3; --card:#fffefb;
    --accent:#7a4b2a; --accent-soft:#efe3d6; --warn:#8a5a12; --ok:#3f6b46;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg:#14130f; --ink:#ece7dd; --muted:#9a9287; --line:#2b2822; --card:#1b1915;
      --accent:#d99a63; --accent-soft:#3a2b1e; --warn:#e0a94a; --ok:#7fc08c;
    }
  }
  :root[data-theme="dark"] {
    --bg:#14130f; --ink:#ece7dd; --muted:#9a9287; --line:#2b2822; --card:#1b1915;
    --accent:#d99a63; --accent-soft:#3a2b1e; --warn:#e0a94a; --ok:#7fc08c;
  }
  * { box-sizing: border-box; }
  body { background:var(--bg); color:var(--ink); margin:0; padding:3rem 1.25rem 5rem;
         font:400 17px/1.65 Newsreader, Georgia, serif; }
  main { max-width: 60rem; margin: 0 auto; }
  h1 { font-size:2.6rem; line-height:1.1; letter-spacing:-0.02em; margin:0 0 .6rem; font-weight:600; }
  h2 { font-size:1.15rem; margin:3rem 0 .9rem; letter-spacing:.02em; text-transform:uppercase;
       font-family:"IBM Plex Mono", ui-monospace, monospace; font-weight:600; color:var(--muted); }
  .lede { font-size:1.2rem; color:var(--muted); margin:0 0 2.5rem; max-width:46rem; }
  .meta { font-family:"IBM Plex Mono", monospace; font-size:.78rem; color:var(--muted);
          border-top:1px solid var(--line); border-bottom:1px solid var(--line);
          padding:.7rem 0; margin:0 0 2.5rem; display:flex; gap:1.5rem; flex-wrap:wrap; }
  :root { --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; --s4:#eda100; --floor:#8a8880; }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) { --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500; --floor:#6f6d66; }
    }
    :root[data-theme="dark"] { --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500; --floor:#6f6d66; }
    .slope-wrap { overflow-x:auto; margin:.2rem 0 1.6rem; }
    .strip { width:100%; min-width:600px; height:auto; display:block;
      font-family:"IBM Plex Mono", monospace; }
    .strip .grid-line { stroke:var(--line); stroke-width:1; }
    .strip .floor-line { stroke:var(--floor); stroke-width:1.5; stroke-dasharray:3 4; }
    .strip .axis { fill:var(--muted); font-size:10.5px; }
    .strip .axis.mid { text-anchor:middle; }
    .strip .floor-tag { fill:var(--floor); font-weight:600; }
    .strip .strip-tool { text-anchor:end; font-size:12px; font-weight:600; fill:var(--ink); }
    .strip .strip-range { stroke:var(--line); stroke-width:6; stroke-linecap:round; }
    .strip circle { transition:r .12s ease; }
    .strip circle:hover { r:7.5; }
    .plain { background:var(--card); border:1px solid var(--line); border-radius:8px;
      padding:1.1rem 1.3rem; margin:0 0 2rem; }
    .plain-q { margin:0 0 .8rem; font-size:1.05rem; }
    .plain-list { list-style:none; margin:0 0 .9rem; padding:0; display:flex; gap:1.8rem; flex-wrap:wrap; }
    .plain-list li { display:flex; flex-direction:column; gap:.15rem; }
    .plain-tool { font-family:"IBM Plex Mono", monospace; font-size:.8rem; color:var(--muted); }
    .plain-secs { font-size:1.9rem; font-weight:600; line-height:1; letter-spacing:-.02em; }
    .plain-note { margin:0; font-size:.88rem; color:var(--muted); }
    .row.floor-row .name, .row.floor-row .val { color:var(--muted); }
    .row.floor-row .track { border-style:dashed; }
    .row.floor-row .fill.floor-fill {
      background:repeating-linear-gradient(45deg,var(--line) 0 4px,transparent 4px 8px); }
    .row.floor-row { padding-bottom:.5rem; border-bottom:1px solid var(--line); margin-bottom:.6rem; }
    .cites { margin:.6rem 0 0; padding-left:1.1rem; font-size:.85rem; color:var(--muted); }
    .cites li { margin:.2rem 0; }
    .note .lead { margin:0; font-size:1rem; }
    .note .fine { margin:.45rem 0 0; font-size:.85rem; color:var(--muted); line-height:1.55; }
    .legend { display:flex; gap:1rem; flex-wrap:wrap; margin:0 0 .5rem;
      font-family:"IBM Plex Mono", monospace; font-size:.75rem; color:var(--muted); }
    .legend .key { display:inline-flex; align-items:center; gap:.35rem; }
    .legend i { width:10px; height:10px; border-radius:50%; display:inline-block; }

    .filters { display:flex; gap:1.1rem; flex-wrap:wrap; align-items:center; margin:0 0 1rem;
      font-family:"IBM Plex Mono", monospace; font-size:.8rem; }
    .filters label { display:flex; gap:.4rem; align-items:center; color:var(--muted); }
    .filters select { font:inherit; background:var(--card); color:var(--ink);
      border:1px solid var(--line); border-radius:4px; padding:.25rem .4rem; }
    .row { display:grid; grid-template-columns:minmax(9rem,13rem) 1fr 3.6rem; gap:1rem;
         align-items:center; margin:.45rem 0; }
    @media (max-width:620px) {
      /* The track is the data. Below this width the three-column grid leaves it about
         thirty pixels, which reads as decoration rather than a measurement. */
      .row { grid-template-columns:1fr auto; grid-template-areas:"name val" "bar bar"; gap:.35rem 1rem; }
      .row > :nth-child(1) { grid-area:name; }
      .row > :nth-child(2) { grid-area:bar; }
      .row > :nth-child(3) { grid-area:val; text-align:right; }
    }
  .name { font-family:"IBM Plex Mono", monospace; font-size:.85rem; }
  .tag { font-size:.62rem; background:var(--accent-soft); color:var(--accent); padding:.1rem .35rem;
         border-radius:3px; margin-left:.4rem; vertical-align:middle; text-transform:uppercase; letter-spacing:.04em; }
  .track { background:var(--card); border:1px solid var(--line); border-radius:3px; height:1.6rem; overflow:hidden; }
  .fill { background:var(--accent); height:100%; }
  .fill.thin { background:repeating-linear-gradient(45deg,var(--accent),var(--accent) 5px,var(--accent-soft) 5px,var(--accent-soft) 10px); }
  .val { font-family:"IBM Plex Mono", monospace; font-size:.85rem; white-space:nowrap; text-align:right; font-variant-numeric:tabular-nums; }
  .scroll { overflow-x:auto; border:1px solid var(--line); border-radius:4px; background:var(--card); }
  table { border-collapse:collapse; width:100%; font-size:.86rem;
          font-family:"IBM Plex Mono", monospace; }
  th,td { padding:.5rem .7rem; text-align:left; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { font-size:.68rem; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); font-weight:600; }
  tr:last-child td { border-bottom:0; }
  td.num { font-variant-numeric:tabular-nums; }
  .muted { color:var(--muted); }
  .note { background:var(--card); border:1px solid var(--line); border-left:3px solid var(--accent);
          padding:.9rem 1.1rem; margin:1.2rem 0; font-size:.95rem; }
  .note.warn { border-left-color:var(--warn); }
  a { color:var(--accent); }
  code { font-family:"IBM Plex Mono", monospace; font-size:.85em; background:var(--card);
         border:1px solid var(--line); padding:.05rem .3rem; border-radius:3px; }
  footer { margin-top:4rem; padding-top:1.5rem; border-top:1px solid var(--line);
           font-size:.85rem; color:var(--muted); }
</style>
<main>
  <h1>How long does a demo take to export?</h1>
  <p class="lede">The same recording, the same edit, the same stopwatch, across the desktop apps
  that compete to turn screen captures into finished product demos — with every result verified
  in pixels and audio before it counts.</p>

  <div class="meta">
    <span>${submissions.length} submission${submissions.length === 1 ? "" : "s"}</span>
    <span>${result.edges.length} ratio${result.edges.length === 1 ? "" : "s"}</span>
    <span>${result.tools.length} tool${result.tools.length === 1 ? "" : "s"}</span>
    <span>data as of ${esc(generatedAt)}</span>
  </div>

  ${
		disconnected
			? `<div class="note warn"><strong>${result.components.length} disconnected groups.</strong>
      Tools in different groups have never been measured on the same machine, so they cannot be
      compared. Submitting a run that measures one tool from each would join them.</div>`
			: ""
	}

  <h2>Export time against ffmpeg — lower is faster</h2>
  <p class="muted" style="font-size:.95rem;margin:0 0 1.2rem">Every tool is timed against the
  same yardstick: re-encoding the identical clip with plain <code>ffmpeg</code>, on the same
  machine, minutes apart. <strong>2× means it took twice as long as that</strong> — not twice as
  fast. ffmpeg does no compositing at all, so a tool that paints a wallpaper, rounds the corners,
  animates three zooms and mixes in a camera is expected to sit above 1×. Seconds would only
  describe the machine they were measured on; this survives the trip to yours.</p>
  ${bars ? floorBar + bars : '<p class="muted">No submissions yet.</p>'}

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
						const named = (e) =>
							`${esc(e.machine)}${e.platform ? ` (${esc(platformName(e.platform))})` : ""}`;
						const example = w
							? `<code>${esc(displayTool(w.a))}</code> takes ${w.ends[1].ratio}× as long as <code>${esc(displayTool(w.b))}</code> on ${named(w.ends[1])}, and ${w.ends[0].ratio}× as long on ${named(w.ends[0])}${w.inverts ? " — the two swap places" : ""}.`
							: "";
						return `<div class="note"><p class="lead"><strong>Which tool wins depends on the platform.</strong> Where a pair was measured on more than one, its ratio moves by ${c.medianResidualPercent}% at the median.</p><p class="fine">${example} That is the expected behaviour of different media stacks, not a fault in the measurement: the encoders, the GPUs and the drivers underneath are not the same, and a tool built against one of them has no obligation to lead on another. It is also why the figure above is a consensus rather than a verdict — to see your own hardware, filter the runs below. Only pairs measured on more than one platform can be compared this way, so each new submission narrows what the consensus is guessing at.</p></div>`;
					}
				)()
			: `<div class="note"><p class="lead"><strong>Not cross-checked yet.</strong> Every ratio here rests on a single machine.</p><p class="fine">Nothing here has been
      measured twice, so the ranking cannot yet be told apart from the hardware that produced it.
      That becomes checkable as soon as a second submission measures an overlapping pair.</p></div>`
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
							`<code>${esc(displayTool(v.tool))}</code> ${v.versions.length ? `on ${esc(v.versions.join(", "))}` : "on no recorded build"}${v.unreported ? `, with ${v.unreported} of ${v.submissions} submission${v.submissions === 1 ? "" : "s"} reporting none` : ""}`;
						return `<div class="note warn"><p class="lead"><strong>${gaps.length ? "A build here is unaccounted for." : "Mixed versions."}</strong> ${
							gaps.length
								? "One or more submissions did not record which build they measured, so a line may be folding two builds into one without saying so."
								: "A figure here rests on more than one build."
						}</p><p class="fine">${[...new Set([...gaps, ...spread])].map(say).join("; ")}.
      Tools are measured as shipped rather than pinned, so a figure resting on several known
      builds is expected as submissions accumulate. A missing version is not: it is a defect in
      the submitting harness, and the fix is to re-measure rather than to assume.</p></div>`;
					}
				)()
			: ""
	}

  <h2>Every measurement</h2>
  <p class="muted" style="font-size:.95rem;margin:0 0 .6rem">One dot per measured leg, placed by
  what it cost against the floor beside it. Where one tool's dots straddle another's, the
  ranking is not a property of the tools — it depends on the machine. Hover a dot for the
  machine, the seconds and the frame rate.</p>
  <div class="legend">${stripLegend}</div>
  ${stripSvg ? `<div class="slope-wrap">${stripSvg}</div>` : '<p class="muted">No measurements yet.</p>'}

  <h2>Every run</h2>
  <p class="muted" style="font-size:.95rem;margin:0 0 .9rem">One row per measured leg, with the
  machine that produced it. <strong>Cost</strong> is that leg's own export divided by the floor
  measured beside it, so it is comparable across every row here. Seconds and frames per second
  are not — they describe one machine, and are shown because a reader comparing hardware wants
  them.</p>

  <div class="filters">
    <label>Machine
      <select id="f-machine"><option value="">all</option>${machines
				.map((m) => `<option value="${esc(m)}">${esc(platformName(m))}</option>`)
				.join("")}</select>
    </label>
    <label>Platform
      <select id="f-platform"><option value="">all</option>${platforms
				.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`)
				.join("")}</select>
    </label>
    <label>Tool
      <select id="f-tool"><option value="">all</option>${[...new Set(runRows.map((r) => r.tool))]
				.sort()
				.map((m) => `<option value="${esc(m)}">${esc(displayTool(m))}</option>`)
				.join("")}</select>
    </label>
    <span class="muted" id="f-count"></span>
  </div>

  <div style="overflow-x:auto">
  <table id="runs">
    <thead><tr>
      <th>Tool</th><th>Machine</th><th>OS</th><th class="num">Cost</th><th class="num">Export</th>
      <th class="num">fps</th><th class="num">CPU·s</th><th class="num">cores</th><th class="num">RSS MiB</th>
      <th class="num">Bg load</th><th>Fidelity</th><th>Driven</th>
    </tr></thead>
    <tbody>${runTable}</tbody>
  </table>
  </div>

  <p class="muted" style="max-width:70ch">
    <strong>Export</strong> carries <code>±</code> the median absolute deviation of that machine's
    own scoring runs, so a re-run landing elsewhere can be read against the spread rather than
    against a single number.
    <strong>cores</strong> is CPU-seconds ÷ export time: how many cores the export kept busy on
    average. It is the column that separates compositing on the GPU from compositing on the CPU,
    and it moves by an order of magnitude where the time ratio moves by a factor of three. Note
    what it does not include — no GPU time is measured here, on either side — so a low figure
    means less CPU work, which is quieter fans and longer battery, not less work.
    <strong>Bg load</strong> is everything on the machine that was <em>not</em> the tool under
    test, sampled during that tool's own leg with its own processes subtracted. Where two rows on
    the same machine carry very different figures they were not measured under the same
    conditions, and their raw seconds should not be read against each other; the per-leg floor in
    <strong>Cost</strong> absorbs most of that, which is why Cost is the headline and seconds are
    not.
  </p>

  <script>
  (() => {
    const rows = [...document.querySelectorAll("#runs tbody tr")];
    const sel = (id) => document.getElementById(id);
    const apply = () => {
      const m = sel("f-machine").value, p = sel("f-platform").value, t = sel("f-tool").value;
      let shown = 0;
      for (const r of rows) {
        const ok = (!m || r.dataset.machine === m) && (!p || r.dataset.platform === p) &&
                   (!t || r.dataset.tool === t);
        r.hidden = !ok;
        if (ok) shown++;
      }
      sel("f-count").textContent = shown + " of " + rows.length + " runs";
    };
    for (const id of ["f-machine", "f-platform", "f-tool"]) sel(id).addEventListener("change", apply);
    apply();
  })();
  </script>

  <h2>Detail</h2>
  <div class="scroll"><table>
    <thead><tr><th>Tool</th><th class="num" title="in units of the fixed-function H.264 encoder">Cost (hw floor)</th><th class="num" title="in units of libx264 on the same clip — the cores rather than the encoder block">Cost (sw floor)</th><th>Submissions</th><th>Platforms</th><th>Observed range</th><th>Versions</th></tr></thead>
    <tbody>${table || '<tr><td colspan="6" class="muted">—</td></tr>'}</tbody>
  </table></div>

  ${
		roster.length
			? `<h2>Roster</h2>
  <p class="muted" style="font-size:.95rem;margin:0 0 1.2rem">Membership is decided by
  positioning, not by whether an adapter exists. An empty cell is a finding.</p>
  <div class="scroll"><table>
    <thead><tr><th>Tool</th><th>macOS</th><th>Windows</th><th>Linux</th></tr></thead>
    <tbody>${rosterRows}</tbody>
  </table>
  ${rosterSources ? `<ul class="cites">${rosterSources}</ul>` : ""}</div>`
			: ""
	}

  <h2>Method</h2>
  <div class="note">Each tool is timed by one shared stopwatch, from the instant its export is
  committed to the moment the last byte lands. Every output is then re-probed and inspected —
  resolution, frame rate and duration against the target; wallpaper, padding, corners, zooms,
  cursor and camera in the pixels; audio by loudness, because a silent track passes any check
  that only asks whether audio exists. A tool reports what it configured; the verifier decides
  what happened.
  <br><br>Submissions are combined as a graph of ratios rather than an average, so no tool is
  the denominator and the ranking recomposes as submissions overlap.
  <a href="https://github.com/EtienneLescot/screen-recorder-benchmark/blob/main/PROTOCOL.md">The protocol in full.</a></div>

  <footer>
    <a href="https://github.com/EtienneLescot/screen-recorder-benchmark">Source</a> ·
    <a href="https://github.com/EtienneLescot/screen-recorder-benchmark/blob/main/PROTOCOL.md">Protocol</a> ·
    <a href="https://github.com/EtienneLescot/screen-recorder-benchmark/blob/main/CANDIDATES.md">Roster &amp; adapter contract</a> ·
    <a href="https://github.com/EtienneLescot/screen-recorder-benchmark/blob/main/CREDITS.md">Footage credits</a>
    <br>Run it yourself: <code>node bench.mjs run --bundle commons-upload</code>
  </footer>
</main>`;
}

/** Roster table for the site, read from CANDIDATES.md's source of truth. */
export function loadRoster(root) {
	try {
		return JSON.parse(readFileSync(join(root, "roster.json"), "utf8")).tools ?? [];
	} catch {
		return [];
	}
}
