# Protocol

What is measured, how, and what a submission has to contain to join the aggregate. This file is
the contract. If a result and this document disagree, the document is wrong and should be fixed
by PR — not the number.

## 1. What is timed

**Export only.** The clock starts at the instant the export is committed — the click on
*Export*, or a CLI's first progress event — and stops when the last byte lands in the output
file. Launching the app, loading the project, setting presets and importing media all happen
before the clock starts, for every tool alike, and are reported separately.

The stopwatch lives in `lib/runner.mjs` and is shared. No adapter times itself, shortens its own
interval, or excludes a stage. A tool that publishes its own completion signal may only
**shorten** its measurement, never lengthen it.

**The measurement point is the final rename.** Tools that write to a temporary path and rename
on completion are timed to the rename, not to the first byte of the temporary file.

## 2. The ladder

Tools are only ever compared **on the same rung**. Each rung adds one stage to the compositor.

| Rung | Adds | Why it is a separate rung |
|---|---|---|
| **S0** | nothing — trim and re-encode to the target | isolates the encoder from the pipeline |
| **S1** | wallpaper background, padding, corner radius, shadow | the frame the recording sits in |
| **S2** | three zooms | animated transform |
| **S3** | rendered cursor — sprite, smoothing, motion blur, click effects | drawn from telemetry, not baked into the source |
| **S4** | webcam inset with mask and shadow, plus motion blur | a second stream to decode and composite |
| S5 | burned-in captions | **optional, outside the common trunk** |

**S4 is the headline.** It is what a finished product demo actually contains, and every tool in
the roster can express it.

**S5 is deliberately outside the trunk.** The roster fractures there — one tool has no captions
at all, another generates them server-side — so including it would fold an architectural
difference into a speed comparison. Submit it if you like; it is aggregated separately.

## 3. Output, pinned

`1920×1080, 60 fps, H.264, MP4` for every tool.

60 rather than 30 because one tool's MP4 export is fixed at 60 and every other tool can be told
to emit 60 — it is the only rate on which identical output is achievable at all.

**The input is conformed to that rate too.** The public footage is 25 fps at the source, and a
25 fps input with a 60 fps target leaves every app converting the rate inside the interval being
timed. That is not equal work: duplicating frames costs almost nothing, interpolating motion
costs a great deal, and a tool that did the expensive thing would look slow for doing more. The
bundle is therefore conformed to 60 fps during preparation, once, by ffmpeg, before the stopwatch
starts.

The trade this makes is worth stating: conforming 25 to 60 repeats frames rather than inventing
them, so 35 of every 60 frames are duplicates and encode more cheaply than a native 60 fps
capture would. Every app and the floor read the identical file, so the ratios hold — but absolute
seconds from a bundle run are lower than from native 60 fps footage, and the two are not
interchangeable.

An export that does not hit the target is a **failure**, not a fast run.

## 4. Verification — an output has to earn its number

Metadata alone proves nothing. Every export is re-probed and inspected:

| Check | Method |
|---|---|
| Resolution, frame rate, codec, duration | ffprobe against the pinned target |
| Wallpaper | frame corners must be light where the recording is dark |
| Padding | bounding box of the dark recording, measured — this is also how each tool's padding control is calibrated |
| Corner radius | the box's corner shows wallpaper while its top edge shows content |
| Zooms | frame-to-frame activity must spike inside every zoom window |
| Rendered cursor | motion energy at the telemetry's position, against controls on the same scrolling material |
| Webcam | skin-tone fraction in the expected corner |
| **Audio** | **mean loudness** — a present-but-silent track fails |
| Motion blur | *not asserted* — every threshold tried passed some correct renders and failed others |

**The verifier overrides the adapter.** An adapter reports what it configured; only the pixels
and the waveform say what happened. A feature configured but not found in the output is recorded
as *contradicted* and removed from that tool's fidelity score.

The cursor and audio checks exist because both failures occur in practice: an adapter can
configure a cursor track a tool then ignores, and a tool can emit a conforming AAC stream
carrying digital silence. Neither is visible in metadata.

**Where the verifier checks a value, and where it only checks presence.** The output target is
checked exactly — resolution, frame rate, codec and duration are compared against the pinned
figures, and an export that misses any of them is a failure rather than a fast run. Padding is
measured against a solved target too, by `bench.mjs calibrate`, because two tools disagreeing on
it changes how many source pixels each samples per frame.

The *effect* controls are not. For those, every test above asks whether the effect is **present**
— a corner is rounded, a cursor was drawn, a camera inset is in the corner — not whether it
matches the value the scenario pinned; and two, motion blur and click effects, are not asserted
at all. That gap is not hypothetical: Recordly rewrites a project with its own defaults when it
opens it, so it exports a 12.5px corner radius where the scenario asks for 40, a cursor at 250%
where it asks for 150, and no click effects — and still scores full fidelity, because a rounded
corner and a cursor are both there.

So a full fidelity score means *the output hits the target and the scenario's features all
appear*, not *every effect was applied at the value asked for*. Closing that means measuring each
effect against its pinned value the way padding already is, which is a larger change than adding
a check: for most of these the pinned value is not recoverable from a single frame.

## 5. Conditions

A run that measures a compromised machine measures nothing.

- **AC power**, no power-saver plan.
- **No remote-desktop session.** Parsec, Screen Sharing, RDP and ARD encode the screen
  continuously through the same hardware H.264 block the exports use. This is the largest error
  source found while building this benchmark, it is not visible in CPU usage, and it affects
  tools unequally — so it moves rankings, not just times. Measured: the floor went 17.7 s →
  23.7 s with a session live while one tool went 19.6 s → 43.8 s.
- **The benchmark's own output must not be indexed.** A run that exports video leaves gigabytes
  of it behind, and macOS then analyses what it finds: `mediaanalysisd` was measured at 125% of a
  core mid-run against 12 GB of this benchmark's own exports, alongside `VTDecoderXPCService` at
  22%. It is a confound the harness creates for itself, it grows with every run, and it lands on
  whichever tool happens to be measured while the daemon is busy — so, like a remote-desktop
  session, it moves rankings rather than times. The harness writes `.metadata_never_index` into
  the work directory to opt out; if you move the work directory, keep the marker with it.
  Dropping it took the daemon from 125% to 0%.
- **The backdrop is each tool's own, and this is a known bias — not a neutral choice.** `full-demo`
  asks for a wallpaper but does not supply one, because supplying a file needs a per-adapter import
  route and at least one tool has none. The cost was assumed to be small and has now been measured:
  running OpenScreen over two documents identical but for the wallpaper, all four paired legs came
  out about 10% apart (39.8 s on its own backdrop, 35.5 s on a supplied one). The mechanism is
  resolution. The wallpapers these tools ship are desktop photographs and they are not sized alike —
  Cap's are a uniform 10.0 Mpx, Recordly's span 2.6–12.0 Mpx, OpenScreen's 9.3–36.2 Mpx — so each
  tool is handed a different amount of texture work, chosen by its own vendor, and shipping a
  smaller default is rewarded. Reproduce it with `scratch/wallpaper-ab.mjs`. Until the rule changes,
  read a gap under ~10% as within this bias rather than as a difference between the tools.
- **Background load is recorded per tool**, excluding the tool being measured. Cost does not
  divide it out: on one machine background load doubled between two runs while the floor moved
  1.1% and the export it was dividing moved 19% — the fixed-function encoder block the floor uses
  barely throttles, the cores and shaders the compositing uses do.
- **Three scoring runs** after one discarded warm-up, 45 s of cooldown between them. The
  headline is the median with a median absolute deviation.

## 6. Normalisation — why seconds are never submitted

Seconds compare a machine to itself. The unit is **the floor**: a plain ffmpeg transcode of the
same clip with no compositing, measured **immediately before each tool runs**, so every tool is
divided by a reference taken on the same hardware under the same load minutes earlier.

```
cost = tool_export_ms / local_floor_ms
```

A tool at 1.26× did 26 % more work than a bare re-encode of the same footage, on whatever
machine you have.

A measurement without a local floor contributes to nothing. It is recorded, not counted.

## 7. Aggregation — the median against the floor

Submissions come from machines that share nothing. What they do share is the denominator: §6
requires every counted measurement to divide its export by an ffmpeg transcode of the same
footage, on the same machine, minutes away under the same load. A cost is therefore already
dimensionless when it leaves the machine, and aggregating is pooling those costs.

- **One figure per build**, the average of its costs. Plain arithmetic, so a reader can check it
  against the run table.
- **Averaged per setup before it is averaged across them.** Each platform-chip-GPU counts once.
  Otherwise the machine that submitted four runs outvotes the machine that submitted one, and
  the published figure is a fact about the submitter rather than about the tool.
- **Weights apply inside a setup and nowhere else.** They grade the conditions of a run against
  other runs of the same hardware. Between setups the differences are hardware, not quality.
- **A figure can never sit outside the runs behind it.** An average is bounded by its own sample.

The fleet is heterogeneous and will stay that way: different chips, different GPUs, different
media stacks. A build's cost moves by a factor of six across it in the worst case, and no
aggregate makes that go away. One bar is the average across the machines measured, which is the
question a reader arrives with. §7.1 publishes how far the runs behind it sat apart, the scope
buttons re-run the same aggregation over one platform or one GPU, and the run table lists every
run with the machine that produced it.

### The rule that matters

**No particular tool is required in a submission, and one tool is enough.**

Requiring every submission to include OpenScreen would make the whole ranking contestable in one
sentence, since the benchmark's author maintains it. ffmpeg is not a competitor, ships on every
platform, and is measured beside each leg on the submitter's own machine.

A submission used to need two tools. That rule existed to serve the ratio graph, which could do
nothing with a lone measurement, and the runner enforced it upstream by skipping the floor
entirely unless two apps were listed. Both are gone: the floor runs beside every leg, and a
single verified measurement with its floor is a complete observation. Somebody holding a licence
for one of these products can now measure it.

### What this replaced, and why

Until 2026-09, submissions were combined as a **graph of ratios**: tools were nodes, every pair
measured together was an edge weighted by log(a/b), and the ranking came from weighted least
squares over all edges. It was built for a premise that was never true here — that there is no
common denominator — and it stacked a second normalisation on the floor.

The cost was not theoretical. A build held into the graph by a single neighbour inherited that
neighbour's level, fitted across machines the build never ran on, and the page printed figures
outside every run behind them. Screen Studio was measured once, at 4.681×, and published at
5.70×. The graph could only reach that by assuming a tool's cost against the floor is the same
on every machine, and §7.1 is the measurement that it is not.

No submission was invalidated. The raw runs never changed; only what is computed from them.

### 7.1 How far a cost moves between machines

Reported in three tiers, because the same number means three different things:

| Tier | What disagreement there means |
|---|---|
| same platform **and** GPU | two runs of one setup — this is the figure that should be small |
| same platform, different GPU | the floor divides out the encoder block while the compositing under test is shader-bound, and those do not scale together |
| between platforms | a product fact, not an error: a tool tuned for VideoToolbox need not cost the same on NVENC |

Only the first is a fault. The third will never converge with more submissions, because there is
nothing there to converge to — which is why the per-platform rankings exist and why one
page-wide figure is read beside its spread, not instead of it.

### Weighting

Not a judgement of submitters — only the conditions that provably move a ratio:

| Condition | Weight |
|---|---|
| drift > 8 % between opening and closing control | ×0.25 |
| drift 3–8 % | ×0.6 |
| background load differing > 60 points between tools | ×0.5 |
| remote-desktop session active | ×0.3 |
| on battery | ×0.5 |

Weighting applies to every submission identically.

## 8. Versions

**Tools are measured as shipped, not pinned.** The question is how the current products compare,
and half of these vendors publish no version-addressable download at all — a stable "latest" URL
is the only thing some of them offer.

What that costs, and how it is paid:

- Every measurement records the version it measured, and it travels with the submission.
- Where a tool's submissions span more than one build, the aggregate and the site **say so** and
  name the versions. A number resting on two builds is not a number about one product.
- Install specs resolve at install time rather than hard-coding a URL. A pinned URL keeps
  fetching an old build long after the vendor has moved on, and does it silently — which is
  worse than either policy chosen deliberately.

A submission measuring a prerelease is valid, and its version string says so. Comparing a
prerelease against a competitor's stable build is a choice the reader can see and weigh.

## 9. Footage

Three sources, in descending order of how well they travel:

| | Reproducible elsewhere | Realistic | Use for |
|---|---|---|---|
| **Public bundle** | yes, hash-checked | yes | **submissions** |
| Generated fixture | yes, from a seed | no | development, CI |
| Local recording | no | yes | investigation only |

**Submissions must use a public bundle.** Every machine downloads the same bytes from a
permanent URL and verifies the sha256 before use, so two submissions provably measured the same
footage. Normalisation to H.264/MP4 is part of the protocol — Commons publishes VP8/VP9 and the
tools expect H.264 — with parameters recorded in the manifest alongside both hashes: the
download's, which must match everywhere, and the normalised file's, which will not, because
encoders differ.

Downloaded footage carries no cursor telemetry, so it is generated from a fixed seed: identical
everywhere, and it does not follow the pointer visible in the footage. The manifest says so.

## 10. Submitting

```bash
npm run bench -- --bundle commons-upload --scenario full-demo
node bench.mjs submit --run <runId> > submission.json
```

Open a PR adding it under `submissions/<platform>/<chip>-<date>.json`. It is validated against
`schema/submission.schema.json` in CI and folded into the aggregate on merge.

A submission is rejected only for failing the schema, containing no verified measurement with
a local floor, or using a footage source that cannot be verified.
