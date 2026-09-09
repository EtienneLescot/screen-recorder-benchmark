# Driver contract

A driver teaches the harness how one app performs the benchmark scenario. It is the only
app-specific code; timing, verification and reporting are shared so no app is measured on a
kinder stopwatch than another.

```js
export default {
  id: "screen-studio",          // stable slug, used in results and on the CLI
  displayName: "Screen Studio",
  vendor: "Screen Studio",
  kind: "gui",                  // "cli" | "gui" | "reference"
  automation: "cdp+menu",       // "cli" | "menu" | "cdp+menu" | "menu+coords" | "none"
  processName: "Screen Studio", // as System Events sees it
  appPath: "/Applications/Screen Studio.app",
  bundleId: "com.timpler.screenstudio",
  install: { method: "page", page, assetPattern, appName, approxMB, licence, notes },

  detect(),                     // -> { installed, version, path }
  async prepare(ctx),           // import the source, apply the scenario, park in the editor
                                //    -> { appliedFeatures: string[], notes: string[] }
  outputPath(ctx),              // where the export will land
  async runExport(ctx),         // MUST call ctx.commit() at the instant export is committed
  async cleanup(ctx),           // quit, remove temp state
};
```

## The two rules that keep the comparison fair

**`ctx.commit()` marks the same moment for every app.** It is called immediately after the
action that starts the render — the click on *Export*, or the CLI's first `started` event —
never before the project is loaded and never after the first frame. Anything a driver does
before `commit()` (launching the app, importing the clip, setting presets) is warm-up and is
reported separately; anything after it counts.

**Completion is decided by the filesystem, not by the app.** The harness watches the output
path until it stops growing (`waitForStableFile`) and stops the clock at the file's final mtime,
not at the later observation that its stability window elapsed. An app that shows 100% before it
has finished muxing gets no credit for it. A driver's `runExport` may return as soon as the export
is committed; it does not have to detect the end itself. When an app also exposes an explicit
success event, call `ctx.observeComplete()` so the result records its skew from the filesystem;
that signal audits the stop but does not replace it.

### Completion audit backlog

Every driver on every supported platform must be reviewed for fixed sleeps after `ctx.commit()`,
progress percentages treated as completion, output copies whose time leaks into the measurement,
and files that may finish before `waitForStableFile` begins. For each GUI driver, add an app-level
completion observation where one exists and verify its recorded skew against final file mtime.
Generic Escape keystrokes must not dismiss post-export UI: target a control anchored inside the
specific modal and verify that the modal disappeared, because Escape may instead cancel the export,
close the editor, or be intercepted by the automation harness.
The audit covers OpenScreen CLI/GUI, Screen Studio, Recordly (including CUDA), Cap and FocuSee on
macOS, Windows and Linux wherever their adapters are supported.

## The automation ladder

GUI drivers should reach for the highest rung that works, and record which one they used —
`automation` in the results is what tells a reader how reproducible a given row is.

| Rung | Mechanism | Reproducible across machines? |
|---|---|---|
| 1 | AppleScript dictionary (`sdef`) | yes — none of these apps has one |
| 2 | System Events menu item by name | yes, until the app renames the item |
| 3 | Documented keyboard shortcut | yes |
| 4 | Accessibility control by name/description | mostly — names drift between versions |
| 5 | Pixel coordinates | no — flagged as reduced reproducibility |

`node bench.mjs discover <app>` dumps the menus and the accessibility tree of an installed app,
which is how a driver gets written or repaired when a new version moves something.

## Traps every GUI candidate sets

### A synthetic click is not a click

System Events' `click at {x, y}` posts a synthetic event. An app drawing its own controls —
anything that is not a stock AppKit button — may ignore it completely: no reaction, no error,
nothing that distinguishes "the click missed" from "the app refused to act". FocuSee's import
drop zone behaved exactly this way, and it cost this benchmark a candidate: the import was
recorded as broken for weeks when it worked on the first real click.

The same point clicked with a genuine CGEvent mouse-down/up opens the panel every time. A
~30-line C program against ApplicationServices does it, and clang ships with the Command Line
Tools that are already required here.

So: a click that produces no reaction is not evidence about the application. Retry it with a real
event before concluding anything, and prefer real events for any control that is not a named,
AX-addressable button. Elements with no `AXPress` action are the tell — if the accessibility tree
offers no action, the app is drawing that control itself.


These are not Recordly quirks. They come from what this whole category of app *is* — a screen
recorder, built on Electron, that remembers your last export — so expect each of them on each
candidate, on every machine. Each one below cost real time before it was named.

### A screenshot cannot see these apps

Screen recorders deliberately exclude their own HUD and overlays from screen capture, so the
recording does not show the recorder. On macOS that is `kCGWindowSharingNone`; Screen Studio and
Recordly both do it.

The consequence is worth stating bluntly: **a screenshot is not evidence about these windows.** A
capture-excluded window is absent from screenshots, and can be absent from the Window menu too, so
"I took a screenshot and there was no window" says nothing at all. Diagnose over CDP or the
accessibility tree, which do not care about capture exclusion, and never conclude an app is broken
from a picture of an empty desktop.

What *does* see them is `Page.captureScreenshot` over CDP: it renders the page rather than reading
the display, so exclusion does not apply. Screen Studio's editor and its activation window both
came out in full that way while `screencapture` saw an empty desktop behind them. Useful for
diagnosing a driver — not for verifying an export, which is decided by the file.

### The window you found is not necessarily the window you want

An Electron app publishes one CDP target per window, and the useful ones are not always the ones
with the recognisable URL. Screen Studio's *editor* — the window with the whole UI in it — is an
`about:blank` target with no bridge on `window`, while the target carrying the bundle's
`index.html` renders nothing at all and has the app's IPC bridge. A driver that takes "the first
page target" gets one job right and the other silently wrong.

Match a target on what it *is*: evaluate a probe in each one and test the answer — its visible
text for a UI window, the presence of the bridge for an IPC one.

### An icon inside a button defeats exact text matching

Where the UI draws its icons as font glyphs, they land in `innerText` alongside the label: Screen
Studio's Export button reads as `"\u{100203}\nExport"`, every glyph sitting in Unicode plane 16.
`{ exact: true }` therefore matches nothing anywhere in the app, with "not found" as the only
symptom — which reads exactly like a missing control. Match on substrings, and strip
`[\u{100000}-\u{10FFFD}]` before putting any of that text in a result.

### A paywall can be a window of its own

An upsell or activation wall does not have to appear in the DOM you are driving. Screen Studio
opens a separate `activation-window` BrowserWindow, so a driver watching the editor's `innerText`
for "Activate" waits out its timeout and then reports the wrong cause. Enumerate the targets after
any action that can be refused, and read the refusal from wherever it actually appeared.

### A CDP target existing is not the same as its renderer running

Electron publishes a target while the renderer behind it is still coming up. An evaluate sent into
that window does not fail — it **hangs**, for the whole timeout. Recordly's HUD takes around ten
seconds; a driver that attaches the instant the target is listed will look like it is talking to a
dead app.

Probe with something trivial (`1+1`) until it answers, then proceed. That also separates "not ready
yet" from "never going to answer", which are different problems with different fixes.

### Relaunching too quickly keeps the old instance's port

Asking an app to quit and relaunching two seconds later races the previous process's helpers,
which may still hold the debugging port. The new instance then comes up with a renderer that never
runs anything — the exact same symptom as the point above, from an unrelated cause. Wait until the
process is *gone*, not until it was asked to leave, and fail loudly if it will not go.

### `open -a App --args …` silently drops the flags

The app launches, without the debugging port, and every later step fails in a way that points
anywhere but here. Launch the binary inside the bundle directly.

### Export settings persist, so an unpinned axis is not a measurement

These apps remember the last export's format, resolution, frame rate, encoding mode and pipeline —
in Recordly's case in `app-settings.json`. A run that does not pin every axis measures whatever the
last run, or the last human, happened to leave selected, and one wrong pin contaminates every run
after it on that machine.

Pin all of them, and then **read them back** rather than trusting the clicks: a renamed or
translated label makes a click report success against the wrong control, and the export proceeds
down a path nobody chose. Where the app offers a fast path and a legacy one, measure the **default**
— that is the shipped product — and keep any opt-in path as its own row, never averaged in.

Pinning through the app's own preferences works, and needs care about *how* they are stored:
FocuSee keeps `AppConfiger.exportGlobalConfigure` as JSON inside an **NSData** value, so writing it
as a string is ignored silently and the sheet comes up on the last run's settings — a leg that had
been 60 fps came back at 30, which is half the frames and half the work. The read-back is cheap
because that sheet names each axis on the control itself (`MP4`, `Original (1920 * 1080)`, `60FPS`),
and it belongs before the commit on every repetition, not once per leg.

### The best rung is often not on the ladder

Two of the tools here keep the whole composition in a plain-JSON document — Screen Studio's
`project.json`, FocuSee's `configure.focuseeproj` inside the `.focusee` package — and read it back
when the project is reopened. Writing the scenario into that file beats every rung of the ladder
above: it survives a renamed control, a translated build and a moved window, and it reaches values
whose sliders publish no setter at all. FocuSee's padding, roundness, shadow, motion blur and zoom
tracks are all set that way; not one of them is clicked.

The check is the same one the rest of this file asks for, though, because the app may not keep what
it was given: reopen the project and read the values back off the app's own interface. Recordly
keeps a JSON project too and rewrites it with its own defaults on open, which is exactly why its
exports are not the scenario's.

### The bridge's promises do not all resolve

Some methods on an app's own bridge are fire-and-forget by design: Recordly's `switchToEditor`
tears down the renderer that called it, so awaiting it hangs the leg, while `openProjectFileAtPath`
returns a promise whose value the caller needs. `awaitPromise` therefore belongs on the individual
call, not on the helper.

### The save panel may come after the render, not before it

An app can render to a temporary file and only then ask where to put it. Waiting for the *saved*
file puts a modal dialog — and on macOS an Accessibility grant — inside the measured interval,
which times the operator rather than the encoder. Find the rendered file, hand its settled instant
to `ctx.markComplete`, and copy it to the run's output path.
