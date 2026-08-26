# screen-recorder-benchmark

**How long does it take to export a finished product demo?** Same recording, same edit, same
stopwatch, across the desktop apps built to make them — with every result verified in pixels and
audio before it counts.

**Results:** <https://etiennelescot.github.io/screen-recorder-benchmark/>

## Run it

```bash
git clone https://github.com/EtienneLescot/screen-recorder-benchmark
cd screen-recorder-benchmark && npm install

node bench.mjs doctor      # is this machine fit to measure?
node bench.mjs apps        # what can it measure, and what is missing
node bench.mjs preflight   # the one interactive step — grant everything here
node bench.mjs install     # unattended
node bench.mjs calibrate   # once per machine
node bench.mjs run --bundle wikipedia-browse
node bench.mjs report
```

`npm run doctor`, `npm run apps`, … are shorthand for the same commands.

### Choosing what to measure

`node bench.mjs apps` lists every tool, whether it is installed, and what is blocking it if
anything:

```
tool                  status        version         driven by
openscreen-cli        ready         1.10.0-rc.3     cli
cap                   ready         0.5.9           cli
screen-studio         blocked       3.7.5-4595      cdp+menu
                      ↳ export requires an activated licence — there is no trial export
ffmpeg-baseline       ready         8.1.2           cli
```

Then pick any set:

```bash
node bench.mjs run --bundle wikipedia-browse --apps cap,openscreen-cli
```

`ffmpeg-baseline` is added automatically and is not a competitor — it is the unit everything
else is divided by. A run needs **at least two tools** to produce a usable measurement, and
which two is up to you.

## What is measured

A finished demo export, not a transcode: a wallpaper background the compositor samples per
pixel, padding, rounded corners, a drop shadow, three animated zooms, motion blur, a **cursor
rendered from telemetry** — sprite, smoothing, its own motion blur, click effects — a **webcam
inset** with mask and shadow, and the recording's **audio**, all pinned to 1920×1080 / 60 fps /
H.264 / MP4 for every tool.

The cursor matters more than it looks. Every tool here hides the system pointer while recording
and re-draws it at export time from a sidecar; painting a cursor into the source would exercise
none of that. It is supplied as telemetry and the source is left clean.

Full definition, including the S0→S4 ladder: [PROTOCOL.md](./PROTOCOL.md).

## What a result means

**Quote `Cost (×floor)`, not seconds.** A plain ffmpeg transcode of the same clip, with no
compositing, is measured immediately before each tool runs — so every tool is divided by a
reference from the same hardware under the same load, minutes earlier. A tool at 1.26× did 26 %
more work than a bare re-encode, on whatever machine you have. Seconds compare a machine to
itself and nothing else.

Every export is re-probed and inspected before it counts: resolution, frame rate, codec and
duration against the target; wallpaper, padding, corner radius, zooms, cursor and camera in the
pixels; and audio by **loudness**, because a silent track passes any check that only asks
whether audio exists. A tool reports what it configured; the verifier decides what happened, and
the verifier wins.

Two conditions will ruin your numbers and both are checked: **background load**, reported per
tool, and **remote-desktop sessions** — Parsec, Screen Sharing, RDP and ARD encode the screen
through the same hardware H.264 block the exports use, which no CPU measurement sees and which
affects tools unequally.

## Contributing a measurement

```bash
node bench.mjs run --bundle wikipedia-browse --apps <two or more tools>
node bench.mjs submit --run <runId> --as "your name" > submissions/<platform>/<chip>-<date>.json
```

Open a PR. CI validates it against [`schema/submission.schema.json`](./schema/submission.schema.json)
and regenerates the site.

Submissions are combined as a **graph of ratios**, not an average: tools are nodes, every pair
measured together on one machine is an edge, and the global ranking is recovered by least
squares over all of them. So **no particular tool is required in a submission** — the graph
recomposes as long as submissions overlap, and where they overlap redundantly, the disagreement
between them is published.

A submission is rejected for failing the schema, carrying fewer than two verified tools, or
using footage nobody else can obtain. Nothing else.

## Roster

Membership follows what a tool is *for* — turning a screen recording into a finished demo — not
whether an adapter happens to exist. General-purpose editors and plain recorders are out even
when they can be driven. The roster is per-platform, and an empty cell is a result:
[CANDIDATES.md](./CANDIDATES.md).

## Footage

| | Reproducible elsewhere | Realistic | Use for |
|---|---|---|---|
| **Public bundle** — `--bundle` | yes, hash-checked | yes | **submissions** |
| Generated fixture — default | yes, from a seed | no | development, CI |
| Local recording — `--source` | no | yes | investigation |

Public bundles are downloaded from permanent Wikimedia URLs, verified against a sha256, and
normalised to H.264/MP4 with parameters recorded in the manifest — so two machines can prove
they measured the same footage. Attribution: [CREDITS.md](./CREDITS.md).

## Platforms

macOS and Windows. `lib/platform.mjs` holds everything that differs — process sampling, hardware
and power state, installation, encoder selection — and the measurement core is
platform-independent, because two platforms that time things differently stop measuring the same
thing.

The Windows adapters have **not been run yet**. Every lookup fails with the control names it did
find attached, and `node bench.mjs discover <app>` dumps the real tree on the target machine.

## Layout

```
bench.mjs              entrypoint
apps.mjs               the registry and what each machine can measure
sources.json           public footage bundles, with hashes and licences
roster.json            roster membership per platform
scenarios/index.mjs    the scenario and the pinned output target
lib/runner.mjs         the shared clock every adapter is timed by
lib/measure.mjs        stopwatch, process sampling, output + audio verification
lib/visualCheck.mjs    pixel verification of the effects
lib/aggregate.mjs      the ratio graph and its solver
lib/publicSource.mjs   fetch, verify and normalise public footage
lib/platform.mjs       everything that differs between macOS and Windows
drivers/               one per tool — see drivers/README.md for the contract
submissions/           contributed measurements
docs/                  the published site, regenerated from submissions/
```

## Licence

MIT. The footage it downloads is other people's work under its own licences — see
[CREDITS.md](./CREDITS.md).

## Before you push

```bash
npm run verify
```

Runs exactly what CI runs: the submission schema, the unit tests, the linter, and a
rebuild of `docs/` checked against what is committed. `npm run fix` applies the
formatting and regenerates the site.
