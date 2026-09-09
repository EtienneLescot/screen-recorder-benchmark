/**
 * FocuSee on Windows.
 *
 * The closest pitch-for-pitch rival to OpenScreen, and on Windows it is a first-class entrant:
 * the vendor's download *is* the Windows application (`focusee-en-v2-setup.exe`), where the Mac
 * side ships only a downloader stub.
 *
 * **The scenario is written into the project, not clicked into the editor.** Same reason as Cap
 * and OpenScreen, and here it is not a preference: the three zooms, the cursor and the webcam
 * inset have no addressable control at all, and they are most of what this scenario costs. See
 * lib/focuseeProject.mjs for the format. Driven through the UI, FocuSee would render a cheaper
 * scene than every tool beside it and its number would mean nothing.
 *
 * That also removes the recorder from the picture entirely: `FocuSeeEditor.exe <project>` opens
 * an edit directly, so the run skips the File menu, the drop zone, the OS picker and a minute of
 * import — and skips the locale bug living in that path.
 *
 * What a discovery pass against the running 2.3.5 build found, in the order a run meets it:
 *
 *   · **The editor is a second process.** `FocuSeeEditor.exe` owns the editor window, the whole
 *     scenario surface and the export dialog; `FocuSee.exe` is only the recorder. Every lookup
 *     here goes to `FocuSeeEditor` — an adapter that keeps asking the recorder finds no Export
 *     button and has no way to tell that from the app not having one.
 *
 *   · **FocuSee parses numbers with the machine's culture.** `VideoImportViewModel.GetVideoInfo`
 *     calls `Double.Parse("60.000000")` with no CultureInfo, so on a comma-decimal locale the
 *     app's own import cannot read any video at all — silently, for two minutes, then back to
 *     the drop zone. The import path is not used here, but the editor is the same codebase, so
 *     both are launched with .NET globalization set to invariant (LAUNCH_ENV). That changes how
 *     the app parses numbers, not how it renders; the UI stays in the language it has stored.
 *
 *   · **The crop tool is named "Export".** The editor's crop button carries AutomationId
 *     `IB_Crop` and Name "Export", while the export button's AutomationId is `Export` and its
 *     Name is the localised "Exporter". A lookup on the visible name opens the crop dialog and
 *     reports success, so the export button is matched by id (`byId`).
 *
 *   · **Names are localised, AutomationIds are not.** "Fichier", "Exporter" on this install.
 *     Every control below is matched by id where it has one; the export dialog's four combo
 *     boxes are the only things here that have none.
 *
 *   · **The export combos publish their ViewModel, not their value.** All four are unnamed and
 *     id-less, and their selected item's Name is the class name — `SelectFPSModel`,
 *     `SelectResolutionModel`. That class name is what identifies which combo is which, in any
 *     language. The visible labels exist only in the *raw* UIA view (`Title_TB`), so both the
 *     pin and its read-back walk the raw tree. Worth the trouble: this machine's dialog came up
 *     on 30FPS, so a run that trusted the defaults would have measured half the scenario's
 *     frame rate.
 *
 * Export requires an activated licence. On an unlicensed machine it raises a "FocuSee Premium"
 * panel whose only action is `BuyBtn`, and no file is written; `runExport` detects that at runtime.
 * The driver pins every axis, commits, and then fails with that named — so an activated machine
 * needs no code change, only the licence. What cannot be checked until then is the only thing
 * this adapter asserts without pixels: the editor reports the cursor, camera and audio channels
 * as live, but whether they are composited the way the verifier would want is a question for an
 * export that runs.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { resolveFfmpeg } from "../lib/env.mjs";
import { writeFocuseeProject } from "../lib/focuseeProject.mjs";
import { sleep } from "../lib/measure.mjs";
import { appVersion, powershell, resolveAppPath } from "../lib/platform.mjs";
import {
	activateApp,
	appIsRunning,
	clickControl,
	describeApp,
	fileDialogTo,
	launchApp,
	quitApp,
	setControlValue,
	waitForWindow,
} from "../lib/uiWindows.mjs";

export const FOCUSEE = {
	macPath: "/Applications/FocuSee.app",
	winPaths: [
		// The vendor is iMobie now — the MSI on the Microsoft Store is signed "iMobie Inc." and
		// installs to Program Files (x86)\\iMobie\\FocuSee. Only the Gemoo paths were listed, so
		// detect() reported "not installed" on a machine where FocuSee was sitting right there.
		"%ProgramFiles(x86)%\\iMobie\\FocuSee\\FocuSee.exe",
		"%ProgramFiles%\\iMobie\\FocuSee\\FocuSee.exe",
		"%ProgramFiles%\\Gemoo\\FocuSee\\FocuSee.exe",
		"%ProgramFiles(x86)%\\Gemoo\\FocuSee\\FocuSee.exe",
		"%LOCALAPPDATA%\\Programs\\FocuSee\\FocuSee.exe",
		"%ProgramFiles%\\FocuSee\\FocuSee.exe",
	],
};

/** The recorder, which owns the import path. */
const PROC = "FocuSee";
/** The editor, spawned by the recorder, which owns everything after the import. */
const EDITOR = "FocuSeeEditor";

/**
 * What makes the import work at all off an en-US machine.
 *
 * Invariant globalization gives the process a CurrentCulture with a `.` decimal separator, so
 * the app's un-cultured `Double.Parse` of the clip's frame rate succeeds. The second variable
 * keeps `new CultureInfo("fr")` from throwing, which invariant mode otherwise makes it do — the
 * app sets its own UI language that way and would fall over on startup.
 */
const LAUNCH_ENV = {
	DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: "1",
	DOTNET_SYSTEM_GLOBALIZATION_PREDEFINED_CULTURES_ONLY: "0",
};

/** The editor's composition sliders, and the range each publishes. */
const SLIDERS = { padding: [0, 25], inset: [0, 60], round: [0, 20], shadow: [0, 100] };

const clamp = (v, [lo, hi]) => Math.max(lo, Math.min(hi, Math.round(v)));

const rows = (proc, max = 900) => {
	try {
		return [].concat(JSON.parse(describeApp(proc, { max }) || "[]"));
	} catch {
		return [];
	}
};

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Shared UIA preamble for the two lookups this app needs that uiWindows.mjs cannot express. */
const UIA = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes | Out-Null
$root = [System.Windows.Automation.AutomationElement]::RootElement
$ids = @{}
foreach ($p in (Get-Process -Name 'FocuSeeEditor' -ErrorAction SilentlyContinue)) { $ids[[int]$p.Id] = $true }
$cWin = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Window)
$cItem = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::ListItem)
$cw = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$rw = [System.Windows.Automation.TreeWalker]::RawViewWalker
function Walk($el, $d, $w) {
  if ($d -gt 30) { return }
  $el
  $c = $w.GetFirstChild($el)
  while ($c -ne $null) { Walk $c ($d + 1) $w; $c = $w.GetNextSibling($c) }
}
# The visible label of a combo item lives in the raw view only: its TextBlocks are inside a
# DataTemplate and the control view hides them, which is why the control view shows six blank
# resolutions where the raw view shows Original / 4K / 2K / 1080P / 720P / 480P.
function Label($el) {
  $t = @()
  foreach ($k in (Walk $el 0 $rw)) {
    if ($k.Current.ControlType.ProgrammaticName -match 'Text' -and $k.Current.Name) { $t += $k.Current.Name }
  }
  ($t -join ' ')
}
function EditorWindows {
  $out = @()
  foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cWin)) {
    if ($ids.ContainsKey([int]$w.Current.ProcessId)) { $out += $w }
  }
  $out
}
`;

/**
 * Read, or pin and read back, one export-dialog combo box.
 *
 * `model` is the ViewModel class name its selection reports — the only language-independent
 * handle these four have. `want` is a regex against the visible label, or an index for a combo
 * whose labels are localised (quality), where "the first option" is at least reproducible.
 * Returns the label that is selected afterwards, so callers verify rather than assume.
 */
function exportCombo(model, want = null) {
	const pick =
		want == null
			? ""
			: `
$ec = $null
if (-not $cb.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$ec)) {
  'ERR combo does not expand'; exit
}
$ec.Expand()
# A WPF ComboBox builds its items when the popup opens, so the first FindAll after Expand can
# come back empty and the pin reads as "no such option" against a list that simply is not there
# yet. Poll instead of guessing at a sleep.
$items = @()
for ($try = 0; $try -lt 12 -and $items.Count -eq 0; $try++) {
  Start-Sleep -Milliseconds 250
  $items = @($cb.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cItem))
}
$hit = $null
${
	typeof want === "number"
		? `if ($items.Count -gt ${want}) { $hit = $items[${want}] }`
		: `foreach ($li in $items) { if ((Label $li) -match ${q(want)}) { $hit = $li; break } }`
}
if ($hit -eq $null) {
  try { $ec.Collapse() } catch {}
  'ERR no option matching ${String(want).replace(/'/g, "")} among: ' + (($items | ForEach-Object { Label $_ }) -join ', ')
  exit
}
$si = $null
$hit.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$si) | Out-Null
$si.Select()
Start-Sleep -Milliseconds 400
try { $ec.Collapse() } catch {}
Start-Sleep -Milliseconds 250
`;

	const out = powershell(
		`${UIA}
$cb = $null
foreach ($wn in (EditorWindows)) {
  foreach ($e in (Walk $wn 0 $cw)) {
    if ($e.Current.ControlType.ProgrammaticName -notmatch 'ComboBox') { continue }
    $sp = $null
    if ($e.TryGetCurrentPattern([System.Windows.Automation.SelectionPattern]::Pattern, [ref]$sp)) {
      foreach ($s in $sp.Current.GetSelection()) { if ($s.Current.Name -match ${q(model)}) { $cb = $e } }
    }
  }
}
if ($cb -eq $null) { 'ERR no ${model} combo — is the export dialog open?'; exit }
${pick}
$sp = $null
$cb.TryGetCurrentPattern([System.Windows.Automation.SelectionPattern]::Pattern, [ref]$sp) | Out-Null
foreach ($s in $sp.Current.GetSelection()) { Label $s }
`,
		{ timeoutMs: 90_000 },
	).trim();
	if (out.startsWith("ERR ")) throw new Error(`FocuSee: ${out.slice(4)}`);
	return out;
}

/**
 * Open the export dialog's "Save to" browser.
 *
 * The control is an unnamed, id-less Button sitting immediately before the Text that shows the
 * current folder, and the folder itself is a Text rather than a field — so there is nothing to
 * set, only a picker to open. Anchored on the path Text inside whichever window carries
 * `ExportName`, which is the export dialog wherever the app decides to put it.
 */
function openExportFolderPicker() {
	const out = powershell(
		`${UIA}
foreach ($wn in (EditorWindows)) {
  $all = @(Walk $wn 0 $cw)
  if (-not ($all | Where-Object { $_.Current.AutomationId -eq 'ExportName' })) { continue }
  $prev = $null
  foreach ($e in $all) {
    $c = $e.Current
    if ($c.ControlType.ProgrammaticName -match 'Text' -and $c.Name -match '^[A-Za-z]:') {
      if ($prev -eq $null) { 'ERR no button before the save-to path'; exit }
      $ip = $null
      if (-not $prev.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) {
        'ERR the save-to button cannot be invoked'; exit
      }
      $ip.Invoke()
      'OK ' + $c.Name
      exit
    }
    if ($c.ControlType.ProgrammaticName -match 'Button' -and -not $c.Name -and -not $c.AutomationId) { $prev = $e }
  }
}

'ERR the export dialog has no save-to path'
`,
		{ timeoutMs: 90_000 },
	).trim();
	if (!out.startsWith("OK")) throw new Error(`FocuSee: ${out.replace(/^ERR /, "")}`);
	return out.slice(3);
}

/** Close the export-success overlay, whose close button has neither a name nor an id. */
function dismissSuccessPanel() {
	const out = powershell(
		`${UIA}
$bySuccess = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'SuccessTitle')
foreach ($wn in (EditorWindows)) {
  $title = $wn.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $bySuccess)
  if ($title -eq $null) { continue }
  $dialog = $cw.GetParent($title)
  if ($dialog -eq $null) { 'ERR success title has no dialog'; exit }
  foreach ($button in $dialog.FindAll([System.Windows.Automation.TreeScope]::Children,
      (New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Button)))) {
    if ($button.Current.Name -or $button.Current.AutomationId) { continue }
    $ip = $null
    if ($button.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) {
      $ip.Invoke()
      'OK closed'
      exit
    }
  }
  'ERR success dialog has no close button'
  exit
}
'OK absent'
`,
		{ timeoutMs: 90_000 },
	).trim();
	if (!out.startsWith("OK")) throw new Error(`FocuSee: ${out.replace(/^ERR /, "")}`);
	return out === "OK closed";
}

export default {
	id: "focusee",
	displayName: "FocuSee",
	vendor: "iMobie / Gemoo",
	kind: "gui",
	automation: "uia",
	processName: PROC,
	get appPath() {
		return resolveAppPath(FOCUSEE);
	},
	bundleId: null,
	install: {
		method: "installer",
		// The link the vendor's download button resolves to on Windows, and the same one the
		// app's own update feed publishes for `win`.
		url: "https://focusee.imobie-resource.com/product/focusee-en-v2-setup.exe",
		appName: "FocuSee",
		approxMB: 120,
		licence: "commercial — export requires a licence; there is no watermarked trial export",
		silentArgs: ["/S"],
		notes: [
			"On Windows the vendor serves the real application, not the downloader stub the Mac side gets.",
			"If /S is rejected the installer is not NSIS; run it once by hand during preflight.",
		],
	},

	detect() {
		const path = resolveAppPath(FOCUSEE);
		if (!path) return { installed: false, version: null, path: null };
		return { installed: true, version: appVersion(path), path };
	},

	projectPath(ctx) {
		return join(ctx.workDir ?? ctx.outDir, "projects", `focusee-${ctx.scenario.id}.focusee`);
	},

	async prepare(ctx) {
		const exe = resolveAppPath(FOCUSEE);
		if (!exe) throw new Error("FocuSee is not installed");
		const editorExe = exe.replace(/FocuSee\.exe$/i, "FocuSeeEditor.exe");
		if (!existsSync(editorExe)) {
			throw new Error(
				`FocuSee is installed but ${editorExe} is missing — the editor is a separate binary`,
			);
		}

		// Before the project is rewritten, not after: an open editor holds every file in it.
		await this.cleanup();
		await sleep(2500);

		const e = ctx.scenario.effects;
		const durationSec = ctx.source.probe?.durationSec ?? ctx.source.spec?.durationSec ?? 60;
		const paddingControl = clamp(
			ctx.paddingControl ?? this.defaultPaddingControl(ctx.scenario),
			SLIDERS.padding,
		);
		const roundControl = clamp(e.cornerRadiusPx, SLIDERS.round);
		const project = this.projectPath(ctx);
		const written = writeFocuseeProject({
			dir: project,
			sourcePath: ctx.source.path,
			durationSec,
			width: ctx.source.probe?.video?.width ?? ctx.scenario.output.width,
			height: ctx.source.probe?.video?.height ?? ctx.scenario.output.height,
			scenario: ctx.scenario,
			webcamPath: ctx.source.webcam ?? ctx.assets?.webcam ?? null,
			cursorPath: ctx.source.cursorPath ?? ctx.assets?.cursorPath ?? null,
			spec: ctx.source.spec ?? null,
			paddingControl,
			roundControl,
			ffmpeg: resolveFfmpeg().ffmpeg,
		});

		// The editor opens a project directly. The recorder's import path is not used at all —
		// it is a menu, a drop zone, an OS picker and a minute of transcoding to reach the same
		// editor, and it is the path with the locale bug in it.
		await launchApp(editorExe, EDITOR, {
			args: [project],
			timeoutMs: 180_000,
			env: LAUNCH_ENV,
		});
		await waitForWindow(EDITOR, /editor/i, { timeoutMs: 180_000, pollMs: 2000 });
		await sleep(18_000);

		// Read back what the app made of the project, rather than what was asked of it. A
		// duration on the timeline means the clip loaded; a zoom clip per scenario zoom means the
		// tracks were parsed; an enabled Cursor tab means the telemetry was accepted, which is
		// the one that silently fails — with `projectType: "import"` in metadata.json the same
		// files leave it greyed out and no pointer is composited.
		const editor = rows(EDITOR, 1200);
		const total = editor.find((r) => r.id === "TotalTB")?.name ?? "";
		if (!/\d\d:\d\d\.\d\d/.test(total)) {
			throw new Error(
				`FocuSee opened the project with no clip on the timeline (duration reads "${total}")`,
			);
		}
		const zoomClips = editor.filter((r) => r.id === "ZoomV_TB").map((r) => r.name);
		const enabled = (id) => editor.find((r) => r.id === id)?.enabled === true;

		const applied = written.applied.filter((f) => {
			if (f === "cursor") return enabled("Cursor_Btn");
			if (f === "webcam") return enabled("Cam_Btn");
			if (f === "audio") return enabled("Aud_Btn");
			if (f === "zooms") return zoomClips.length === (e.zooms?.length ?? 0);
			return true;
		});
		const dropped = written.applied.filter((f) => !applied.includes(f));

		return {
			appliedFeatures: applied,
			notes: [
				`project: ${project}`,
				`timeline: ${total}, zooms ${zoomClips.join(" ") || "none"}`,
				`telemetry: ${written.moves} moves, ${written.clicks} clicks`,
				`padding=${paddingControl}/25, roundness=${roundControl}/20 (FocuSee's own slider units — ` +
					`the scenario's ${e.cornerRadiusPx}px has no conversion into that range and is clamped), ` +
					`shadow=${e.shadow?.intensity ?? 0}`,
				dropped.length
					? `the app did not take: ${dropped.join(", ")} — the panel came up disabled`
					: "the app took every channel the project declares",
			],
		};
	},

	/** FocuSee's padding slider is 0-25 on its own scale; `bench.mjs calibrate` solves it. */
	defaultPaddingControl(scenario) {
		return scenario.effects.paddingPercent;
	},

	outputPath(ctx) {
		return join(ctx.outDir, `${this.id}-${ctx.scenario.id}-run${ctx.run.index}.mp4`);
	},

	async runExport(ctx) {
		const out = this.outputPath(ctx);
		if (existsSync(out)) rmSync(out);
		mkdirSync(ctx.outDir, { recursive: true });

		activateApp(EDITOR);
		await sleep(800);
		// FocuSee leaves a success overlay over the editor after every export. Its close button has
		// neither a name nor an id, so anchor it on the overlay's SuccessTitle instead of using Escape
		// (which can close the editor itself).
		for (let i = 0; i < 4 && dismissSuccessPanel(); i++) await sleep(500);
		if (rows(EDITOR, 1200).some((r) => r.id === "SuccessTitle")) {
			throw new Error("FocuSee: the previous export's success panel could not be dismissed");
		}
		// By id: the crop tool's *name* is "Export", and it comes first in the tree.
		if (!clickControl(EDITOR, "Export", { byId: true }).ok) {
			throw new Error("FocuSee: the editor has no Export button (AutomationId `Export`)");
		}
		await sleep(4000);

		const stem = basename(out).replace(/\.mp4$/i, "");
		if (!setControlValue(EDITOR, "ExportName", stem)) {
			throw new Error("FocuSee: the export dialog never showed its name field");
		}
		openExportFolderPicker();
		await fileDialogTo(EDITOR, ctx.outDir, { timeoutMs: 45_000 });

		// Every axis pinned and read back, because the dialog remembers the last export: this
		// machine's came up on 30FPS against a scenario pinned at 60. Quality is chosen by
		// position — its three options are localised and carry no id, and the first is the
		// highest — so it is reproducible without depending on the install's language.
		const settings = {
			format: exportCombo("SelectExportFormatModel", "^MP4$"),
			fps: exportCombo("SelectFPSModel", "^60FPS$"),
			// "1080", not "1080P": the resolution list is derived from the canvas, so a project
			// that is already 1920x1080 collapses it to the single entry "Original (1920*1080)".
			// Both spellings are the target; either is accepted, and the read-back says which.
			resolution: exportCombo("SelectResolutionModel", "1080"),
			quality: exportCombo("SelectQualityModel", 0),
		};
		ctx.observe?.("exportSettings", settings);
		if (
			!/MP4/i.test(settings.format) ||
			!/60/.test(settings.fps) ||
			!/1080/.test(settings.resolution)
		) {
			throw new Error(
				`FocuSee did not take the pinned export settings: ${JSON.stringify(settings)}`,
			);
		}

		if (!clickControl(EDITOR, "OK", { byId: true }).ok) {
			throw new Error("FocuSee: the export dialog has no confirm button");
		}
		ctx.commit();

		// FocuSee's success overlay is the app's own completion signal, and this poll watches for
		// it and for the paywall that replaces it. What it is *not* is the stopwatch: this driver
		// reports through ctx.observeComplete, which lib/runner.mjs records as a skew and
		// explicitly does not use as the stop — waitForStableFile owns that, off the output's own
		// mtime. So the cadence cannot move exportMs by a millisecond. It only moves waitedMs.
		//
		// It moved something else. Each poll is a fresh powershell.exe that scans every top-level
		// window on the desktop and walks the editor's UIA tree, measured on this machine at 1.39
		// core-seconds a call — and the call is synchronous, so 500 ms of sleep meant one poll
		// every 2.7 s holding ~52% of a core for the entire export. The adapter was manufacturing
		// background load on the leg it was measuring, and on no other leg: the CLI adapters poll
		// nothing. That is most of the 75-point load gap between FocuSee and OpenScreen that
		// weighted run 20260909T193656Z at ×0.099.
		//
		// Six seconds costs nothing measurable and drops it to ~17%. The paywall still surfaces
		// within one poll, which is instant against a four-minute render.
		const deadline = Date.now() + 30 * 60_000;
		while (Date.now() < deadline) {
			await sleep(6000);
			const editor = rows(EDITOR, 1200);
			if (editor.some((r) => r.id === "BuyBtn" || r.id === "Title1")) {
				throw new Error(
					"FocuSee raised its “FocuSee Premium” panel instead of exporting — its only action is " +
						"Buy Now, and dismissing it cancels the render. Nothing else in this adapter is blocked: " +
						"activate a licence and the same run measures.",
				);
			}
			if (editor.some((r) => r.id === "SuccessTitle")) {
				ctx.observeComplete();
				return;
			}
		}
		throw new Error("FocuSee: export completion never signalled");
	},

	async cleanup() {
		if (appIsRunning(EDITOR)) await quitApp(EDITOR, { force: true });
		if (appIsRunning(PROC)) await quitApp(PROC, { force: true });
	},
};
