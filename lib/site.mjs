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

export function renderSite(result, { submissions, generatedAt, roster = [] }) {
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
				`<span class="key"><i style="background:${PLATFORM_SERIES[pf] ?? "var(--s4)"}"></i>${esc(pf)}</span>`,
		)
		.join("");

	/**
	 * The headline in seconds, on one named machine.
	 *
	 * The ratio is the rigorous figure and the only one that travels, but it answers a question
	 * nobody asks first. "How long does this take?" wants seconds, and seconds are meaningless
	 * without saying on what — so this states the machine in the same breath, and the ratio
	 * immediately below carries the comparison the seconds cannot.
	 */
	const newest = [...submissions].sort((a, b) =>
		String(a.submittedAt ?? "").localeCompare(String(b.submittedAt ?? "")),
	)[submissions.length - 1];
	const plainRows = newest
		? (newest.measurements ?? [])
				.filter((m) => m.verified && m.exportMs)
				.sort((a, b) => a.exportMs - b.exportMs)
		: [];
	const clipSec = newest?.source?.durationSec ?? null;
	const plainSummary = plainRows.length
		? `<div class="plain">
      <p class="plain-q">A ${clipSec ? `${Math.round(clipSec)}-second` : "one-minute"} screen
      demo — wallpaper, rounded corners, three zooms, a cursor and a webcam — exported on
      <strong>${esc(newest.machine?.chip ?? "this machine")}</strong>.</p>
      <ul class="plain-list">${plainRows
				.map(
					(m) =>
						`<li><span class="plain-tool">${esc(displayTool(m.tool))}</span>
             <span class="plain-secs">${Math.round(m.exportMs / 1000)} s</span></li>`,
				)
				.join("")}</ul>
      <p class="plain-note">Those seconds describe that machine and no other. Everything below
      divides them by what a plain <code>ffmpeg</code> transcode cost on the same machine, which
      is what lets one computer's result be compared with another's.</p>
    </div>`
		: "";

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
      <td class="num">${r.seconds} s</td>
      <td class="num">${r.fps ?? "—"}</td>
      <td class="num">${r.cpuSeconds ?? "—"}</td>
      <td class="num">${r.peakRssMiB ? Math.round(r.peakRssMiB) : "—"}</td>
      <td class="num">${r.background != null ? `${Math.round(r.background)}%` : "—"}</td>
      <td>${r.fidelity === 1 ? "full" : r.fidelity != null ? `${Math.round(r.fidelity * 100)}%` : "—"}</td>
      <td class="muted">${esc(r.automation)}</td>
    </tr>`,
		)
		.join("\n");

	const maxCost = Math.max(1, ...result.tools.map((t) => t.relativeCost));
	const bars = result.tools
		.map((t) => {
			const pct = (t.relativeCost / maxCost) * 100;
			const thin = t.submissions < 2;
			return `<div class="row">
        <div class="name">${esc(displayTool(t.tool))}${thin ? '<span class="tag" title="one submission — no independent confirmation">1 machine</span>' : ""}</div>
        <div class="track"><div class="fill${thin ? " thin" : ""}" style="width:${pct.toFixed(1)}%"></div></div>
        <div class="val">${t.relativeCost}× <span class="muted">ffmpeg</span></div>
      </div>`;
		})
		.join("\n");

	const table = result.tools
		.map(
			(t) => `<tr>
      <td><strong>${esc(t.tool)}</strong></td>
      <td class="num">${t.relativeCost}×</td>
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
      <td class="muted">${esc(r.note ?? "")}</td>
    </tr>`,
		)
		.join("\n");

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
    details.note > summary { cursor:pointer; list-style:none; }
    details.note > summary::-webkit-details-marker { display:none; }
    details.note > summary::after { content:" — why"; color:var(--accent); font-size:.82rem; }
    details.note[open] > summary::after { content:" — hide"; }
    details.note > p { margin:.6rem 0 0; }
    .legend { display:flex; gap:1rem; flex-wrap:wrap; margin:0 0 .5rem;
      font-family:"IBM Plex Mono", monospace; font-size:.75rem; color:var(--muted); }
    .legend .key { display:inline-flex; align-items:center; gap:.35rem; }
    .legend i { width:10px; height:10px; border-radius:50%; display:inline-block; }

    .filters { display:flex; gap:1.1rem; flex-wrap:wrap; align-items:center; margin:0 0 1rem;
      font-family:"IBM Plex Mono", monospace; font-size:.8rem; }
    .filters label { display:flex; gap:.4rem; align-items:center; color:var(--muted); }
    .filters select { font:inherit; background:var(--card); color:var(--ink);
      border:1px solid var(--line); border-radius:4px; padding:.25rem .4rem; }
    .row { display:grid; grid-template-columns:minmax(9rem,13rem) 1fr 4rem; gap:1rem;
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
  .val { font-family:"IBM Plex Mono", monospace; font-size:.85rem; text-align:right; font-variant-numeric:tabular-nums; }
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

  ${plainSummary}

  <h2>Export time against ffmpeg — lower is faster</h2>
  <p class="muted" style="font-size:.95rem;margin:0 0 1.2rem">Each tool's export time divided by
  a plain ffmpeg transcode measured on the same machine moments earlier. Seconds are not
  comparable across machines; this is.</p>
  ${bars || '<p class="muted">No submissions yet.</p>'}

  ${
		// Gated on `measurable`, not on the numbers being present. With no redundant path the
		// solver still reports 0% residual — it fits one edge perfectly because nothing
		// contradicts it — and printing that as agreement claims a cross-check that never ran.
		c?.measurable
			? `<details class="note"><summary><strong>The machines do not fully agree.</strong> Where several measured the same pair, they differ by ${c.medianResidualPercent}% at the median.</summary><p>Where several machines measured the same
      pair, they disagree by ${c.medianResidualPercent}% at the median and ${c.maxResidualPercent}%
      at worst${c.worst ? ` — <code>${esc(displayTool(c.worst.a))}</code> against <code>${esc(displayTool(c.worst.b))}</code> on ${esc(c.worst.machine)}` : ""}.
      Redundant paths are what makes that measurable; a single machine could not tell you.</p></details>`
			: `<details class="note"><summary><strong>Not cross-checked yet.</strong> Every ratio here rests on a single machine.</summary><p>Every ratio here rests on a
      single machine, so nothing contradicts anything and no agreement figure is meaningful.
      Consistency becomes measurable once two submissions measure an overlapping pair.</p></details>`
	}

  ${
		result.versionSpread?.length
			? `<details class="note warn"><summary><strong>Mixed versions.</strong> A figure here rests on more than one build.</summary><p>
      ${result.versionSpread.map((v) => `<code>${esc(displayTool(v.tool))}</code> spans ${v.versions.length} builds (${esc(v.versions.join(", "))})`).join("; ")}.
      Tools are measured as shipped rather than pinned, so a figure can rest on more than one
      build as submissions accumulate.</div>`
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
				.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`)
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
      <th class="num">fps</th><th class="num">CPU·s</th><th class="num">RSS MiB</th>
      <th class="num">Bg load</th><th>Fidelity</th><th>Driven</th>
    </tr></thead>
    <tbody>${runTable}</tbody>
  </table>
  </div>

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
    <thead><tr><th>Tool</th><th>Cost</th><th>Submissions</th><th>Platforms</th><th>Observed range</th><th>Versions</th></tr></thead>
    <tbody>${table || '<tr><td colspan="6" class="muted">—</td></tr>'}</tbody>
  </table></div>

  ${
		roster.length
			? `<h2>Roster</h2>
  <p class="muted" style="font-size:.95rem;margin:0 0 1.2rem">Membership is decided by
  positioning, not by whether an adapter exists. An empty cell is a finding.</p>
  <div class="scroll"><table>
    <thead><tr><th>Tool</th><th>macOS</th><th>Windows</th><th>Linux</th><th>Note</th></tr></thead>
    <tbody>${rosterRows}</tbody>
  </table></div>`
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
