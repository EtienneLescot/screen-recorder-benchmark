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

export function renderSite(result, { submissions, generatedAt, roster = [] }) {
	const maxCost = Math.max(1, ...result.tools.map((t) => t.relativeCost));
	const bars = result.tools
		.map((t) => {
			const pct = (t.relativeCost / maxCost) * 100;
			const thin = t.submissions < 2;
			return `<div class="row">
        <div class="name">${esc(t.tool)}${thin ? '<span class="tag" title="one submission — no independent confirmation">1 machine</span>' : ""}</div>
        <div class="track"><div class="fill${thin ? " thin" : ""}" style="width:${pct.toFixed(1)}%"></div></div>
        <div class="val">${t.relativeCost}×</div>
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

	const rosterRows = roster
		.map(
			(r) => `<tr>
      <td><strong>${esc(r.tool)}</strong></td>
      <td>${r.macos ?? "—"}</td><td>${r.windows ?? "—"}</td><td>${r.linux ?? "—"}</td>
      <td class="muted">${esc(r.note ?? "")}</td>
    </tr>`,
		)
		.join("\n");

	const c = result.consistency;
	const disconnected = result.components.length > 1;

	return `<title>Screen Recorder Export Benchmark</title>
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
  .row { display:grid; grid-template-columns:minmax(9rem,13rem) 1fr 4rem; gap:1rem;
         align-items:center; margin:.45rem 0; }
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
    <span>${submissions} submission${submissions === 1 ? "" : "s"}</span>
    <span>${result.edges.length} ratio${result.edges.length === 1 ? "" : "s"}</span>
    <span>${result.tools.length} tool${result.tools.length === 1 ? "" : "s"}</span>
    <span>generated ${esc(generatedAt)}</span>
  </div>

  ${
		disconnected
			? `<div class="note warn"><strong>${result.components.length} disconnected groups.</strong>
      Tools in different groups have never been measured on the same machine, so they cannot be
      compared. Submitting a run that measures one tool from each would join them.</div>`
			: ""
	}

  <h2>Relative cost — lower is better</h2>
  <p class="muted" style="font-size:.95rem;margin:0 0 1.2rem">Each tool's export time divided by
  a plain ffmpeg transcode measured on the same machine moments earlier. Seconds are not
  comparable across machines; this is.</p>
  ${bars || '<p class="muted">No submissions yet.</p>'}

  ${
		c?.medianResidualPercent != null
			? `<div class="note"><strong>Consistency.</strong> Where several machines measured the same
      pair, they disagree by ${c.medianResidualPercent}% at the median and ${c.maxResidualPercent}%
      at worst${c.worst ? ` — <code>${esc(c.worst.a)}</code> against <code>${esc(c.worst.b)}</code> on ${esc(c.worst.machine)}` : ""}.
      Redundant paths are what makes that measurable; a single machine could not tell you.</div>`
			: ""
	}

  ${
		result.versionSpread?.length
			? `<div class="note warn"><strong>Mixed versions.</strong>
      ${result.versionSpread.map((v) => `<code>${esc(v.tool)}</code> spans ${v.versions.length} builds (${esc(v.versions.join(", "))})`).join("; ")}.
      Tools are measured as shipped rather than pinned, so a figure can rest on more than one
      build as submissions accumulate.</div>`
			: ""
	}

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
    <br>Run it yourself: <code>node bench.mjs run --bundle wikipedia-browse</code>
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
