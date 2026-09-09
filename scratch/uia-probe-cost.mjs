/**
 * The same question as uia-poll-cost.mjs, for the cheap version of the poll.
 *
 * Completion detection needs one bit — is SuccessTitle (or the paywall's BuyBtn / Title1) in the
 * tree — not a 1200-row inventory of it. A FindFirst on AutomationId asks the provider that
 * directly instead of walking 4000 elements client-side and building the rows in a PowerShell
 * array. A *miss* is the worst case: it searches the whole subtree before answering no, which is
 * exactly what every poll but the last one does.
 *
 * Usage: node scratch/uia-probe-cost.mjs <processName> [samples]
 */
import { powershell } from "../lib/platform.mjs";

const proc = process.argv[2] ?? "claude";
const samples = Number(process.argv[3] ?? 8);

const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes | Out-Null
$root = [System.Windows.Automation.AutomationElement]::RootElement
$ids = @{}
foreach ($p in (Get-Process -Name '${proc}' -ErrorAction SilentlyContinue)) { $ids[[int]$p.Id] = $true }
$cWin = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Window)
$found = ''
foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cWin)) {
  if (-not $ids.ContainsKey([int]$w.Current.ProcessId)) { continue }
  foreach ($id in @('SuccessTitle', 'BuyBtn', 'Title1')) {
    $c = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::AutomationIdProperty, $id)
    if ($w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c) -ne $null) {
      $found = $id
      break
    }
  }
  if ($found) { break }
}
$p = [System.Diagnostics.Process]::GetCurrentProcess()
"CPU=" + $p.TotalProcessorTime.TotalSeconds + " FOUND=" + $found
`;

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const wall = [];
const cpu = [];

for (let i = 0; i < samples; i++) {
	const t0 = Date.now();
	const out = powershell(script, { timeoutMs: 120_000 });
	const ms = Date.now() - t0;
	const m = /CPU=([\d.]+) FOUND=(\w*)/.exec(out);
	if (!m) {
		console.log(`sample ${i}: no reading — ${out.trim().slice(0, 160)}`);
		continue;
	}
	wall.push(ms);
	cpu.push(Number(m[1]));
	console.log(`sample ${i}: wall ${ms} ms, cpu ${Number(m[1]).toFixed(2)} s, found "${m[2]}"`);
}

if (!cpu.length) process.exit(1);

const cadenceMs = 500 + med(wall);
const load = (med(cpu) / (cadenceMs / 1000)) * 100;
console.log(
	`\nmedian: wall ${med(wall)} ms, cpu ${med(cpu).toFixed(2)} s` +
		`\ncadence: one poll per ${cadenceMs} ms` +
		`\nsustained load while polling: ${load.toFixed(0)}% of one core`,
);
