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
  automation: "menu",           // "cli" | "menu" | "menu+coords" | "none"
  processName: "Screen Studio", // as System Events sees it
  appPath: "/Applications/Screen Studio.app",
  bundleId: "studio.screen.app",
  install: { method: "dmg", url, appName, approxMB, licence, notes },

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
path until it stops growing (`waitForStableFile`), so an app that shows 100% before it has
finished muxing gets no credit for it. A driver's `runExport` may return as soon as the export
is committed; it does not have to detect the end itself.

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
