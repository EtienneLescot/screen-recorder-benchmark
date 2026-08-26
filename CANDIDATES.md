# Candidates

Which tools are in the roster, why, and what a PR has to deliver to add one.

## The filter

One question decides membership: **does this tool exist to turn a screen recording into a
finished, polished demo?** Wallpaper, padding, rounded corners, shadow, an animated zoom, a
rendered cursor, a camera inset — as its product, not as a plugin.

That filter excludes by definition, not by arbitration:

- **OBS** — a broadcaster and recorder; it composites live, it does not produce a demo export.
- **Loom** — recording plus hosting; the render is not the product.
- **Descript** — a transcript-first editor that happens to accept screen recordings.
- **Camtasia, ScreenFlow** — general video editors of an earlier generation. Camtasia can be
  made to express the scenario, but only by hand: its visual properties and zoom-n-pan are not
  scriptable on either platform, so any measurement of it measures a different edit.
- **Kap** — a recorder with no compositing at all.
- The macOS shareware swarm and the Chrome-extension recorders — same reason.

An adapter existing is not a reason to keep a tool in the roster, and adapters for tools that
fall outside it are not carried.

## Roster

The roster is per-platform, because the segment is. An empty cell is a finding.

### macOS — 5 of 5, complete

| Tool | Status |
|---|---|
| **OpenScreen** | reference |
| **Screen Studio** | defines the category |
| **Cap** | the only architectural peer — Rust/WGSL |
| **Recordly** | same lineage — Electron/Pixi |
| **FocuSee** | closed source, widest feature coverage |

The only platform where the segment exists in full. ScreenArc would be sixth.

### Windows — 5 of 5

| Tool | Status |
|---|---|
| **OpenScreen** | reference |
| **Cap** | architectural peer; ships `cap-cli.exe`, so it stays headless |
| **Recordly** | same lineage |
| **FocuSee** | also on the Microsoft Store |
| **ScreenArc** | cross-platform claimed — **provenance unverified** |

Screen Studio is absent by construction, and the table says so: *n/a — macOS only*, on the
platform with the most users. That is a fact about the product, not a criticism.

### Linux — 3, and the table is the result

| Tool | Status |
|---|---|
| **OpenScreen** | reference |
| **Recordly** | degraded — their own documentation says so |
| **Screenix** | closed source; Ubuntu/Fedora/Debian/GNOME — **provenance unverified** |

Cap ships no Linux desktop build per its own README. FocuSee and Screen Studio have none either.

And the real result is in a cell rather than a number: **Recordly loses the rendered cursor on
Linux** — Electron capture, no pointer masking — so **S3 is `n/a`** for it there. A three-row
table with one incomplete row says more than any export time.

## Provenance, stated

Two roster entries rest on thin sourcing and are marked accordingly. Neither is measured until
confirmed:

- **ScreenArc** — one AlternativeTo listing (19 likes). If it does not hold up, **Rapidemo** is
  the natural substitute on Windows, but it comes from the SEO swarm, so that slot is *to be
  confirmed*, not awarded by default.
- **Screenix** — its own site, cross-checked against an unnamed AlternativeTo entry describing
  the same product. Positioning is identical to OpenScreen's, down to offline Whisper captions.

## Implementation status

Roster membership and a working adapter are different things.

`node bench.mjs apps` answers this for the machine in front of you. As of the last run:

| Tool | Adapter | Measured | Blocker |
|---|---|---|---|
| OpenScreen (CLI + GUI) | yes | yes | — |
| Cap | yes | yes | — |
| Screen Studio | yes | **no** | export gated behind account activation; supply a licence and it runs |
| FocuSee | yes (macOS + Windows) | **no** | macOS build rejects every MP4, including real recordings; Windows untested |
| Recordly | **no** | no | adapter wanted |
| ScreenArc | **no** | no | provenance first |
| Screenix | **no** | no | provenance first |

`ffmpeg (re-encode floor)` is not a candidate. It is the unit.

## The adapter contract

Every addition is a PR, and this section is the gate. It lets a PR be refused on completeness
rather than on an opinion about the product.

A candidate PR delivers:

1. **A replayable input script.** How the tool is brought to the point of exporting, from a cold
   start, without human input. Menu items by name, accessibility identifiers, DOM text over CDP
   — anything but pixel coordinates.
2. **A scene configuration per rung, S0 → S4.** How the scenario's wallpaper, padding, radius,
   shadow, zooms, cursor and camera map onto *this* tool's controls. Where a rung cannot be
   expressed, say so — that is a legitimate result and becomes an `n/a` cell.
3. **The export procedure with the ISO parameters frozen.** Format, resolution, frame rate,
   codec pinned to the target; the settings must be set by the adapter, never inherited from
   whatever the app remembered.
4. **The measurement point.** Where `ctx.commit()` fires, and where the final file lands —
   including the temporary-path-then-rename case if the tool works that way.
5. **A version-detection method**, so results can be attributed to a build.
6. **A validation submission** from at least one machine, passing verification.

No conforming adapter, no slot, whatever the product is called.

See [`drivers/README.md`](./drivers/README.md) for the code-level contract and
`node bench.mjs discover <app>` for dumping an installed app's menus and accessibility tree.

## Adding a tool to the roster

Open an issue with the positioning argument first — does it pass the filter at the top of this
file? Roster membership is decided there, in public. The adapter comes second, and is a separate
PR.
