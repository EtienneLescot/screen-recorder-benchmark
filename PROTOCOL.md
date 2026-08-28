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
- **Background load is recorded per tool**, excluding the tool being measured.
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

## 7. Aggregation — the ratio graph

Submissions come from machines that share nothing. They are combined as a graph, not an average.

- **Nodes** are tools. **Edges** are ratios between two tools measured on the same machine in
  the same submission, weighted by log(a/b).
- The global solution is recovered by **weighted least squares over every edge at once**, up to
  one free constant per connected component. Presentation rescales each component so its
  cheapest tool reads 1.00× — that is cosmetic, and privileges nothing.
- **Redundant paths disagree slightly, and the disagreement is the quality signal.** The
  aggregate publishes the median and worst residual; a large one means submissions genuinely
  conflict and the ranking should be read with that in mind.

### The rule that matters

**A submission must contain at least two tools, and no particular tool is required.**

There is no common denominator by construction: any overlapping pair contributes an edge, and
the graph recomposes as long as submissions overlap. Consistency is then checkable through
redundant paths, which a fixed-anchor design could not offer.

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

A submission is rejected only for failing the schema, containing fewer than two verified tools,
or using a footage source that cannot be verified.
