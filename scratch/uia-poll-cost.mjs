/**
 * What the FocuSee adapter's completion poll costs the machine it is measuring.
 *
 * The adapter ends its export by calling describeApp every 500 ms until a SuccessTitle appears.
 * Each call is a fresh powershell.exe that scans every top-level window on the desktop and then
 * walks up to 4000 UIA elements across process boundaries. If that costs a meaningful slice of a
 * core, the adapter manufactures the background load that its own leg is then penalised for —
 * and the FocuSee leg is the only leg that pays it, because the CLI adapters poll nothing.
 *
 * Usage: node scratch/uia-poll-cost.mjs <processName> [samples]
 */
import fs from "node:fs";
import { powershell } from "../lib/platform.mjs";

const src = fs.readFileSync(new URL("../lib/uiWindows.mjs", import.meta.url), "utf8");
const PRELUDE = src.slice(
	src.indexOf("const PRELUDE = `") + "const PRELUDE = `".length,
	src.indexOf("\n`;\n"),
);

const proc = process.argv[2] ?? "claude";
const samples = Number(process.argv[3] ?? 8);
const max = 1200; // what drivers/focusee-win.mjs passes

// describeApp's body verbatim, plus the process reporting the CPU it burned getting there.
const body = `
		$rows = @()
		foreach ($w in (Get-AppWindows '${proc}')) {
			foreach ($e in (Find-Descendants $w)) {
				try { $c = $e.Current } catch { continue }
				if ($c.Name -or $c.AutomationId) {
					$rows += [pscustomobject]@{
						type = $c.ControlType.ProgrammaticName -replace 'ControlType\\.', ''
						name = $c.Name
						id   = $c.AutomationId
						enabled = $c.IsEnabled
						off  = $c.IsOffscreen
					}
				}
				if ($rows.Count -ge ${max}) { break }
			}
		}
		$p = [System.Diagnostics.Process]::GetCurrentProcess()
		"CPU=" + $p.TotalProcessorTime.TotalSeconds + " ROWS=" + $rows.Count
`;

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const wall = [];
const cpu = [];

for (let i = 0; i < samples; i++) {
	const t0 = Date.now();
	const out = powershell(PRELUDE + body, { timeoutMs: 120_000 });
	const ms = Date.now() - t0;
	const m = /CPU=([\d.]+) ROWS=(\d+)/.exec(out);
	if (!m) {
		console.log(`sample ${i}: no reading — ${out.trim().slice(0, 160)}`);
		continue;
	}
	wall.push(ms);
	cpu.push(Number(m[1]));
	console.log(`sample ${i}: wall ${ms} ms, cpu ${Number(m[1]).toFixed(2)} s, rows ${m[2]}`);
}

if (!cpu.length) process.exit(1);

// The loop is `await sleep(500)` then a *synchronous* spawn, so one poll occupies
// 500 ms + its own wall time. That cadence is what turns per-call CPU into a load figure.
const cadenceMs = 500 + med(wall);
const load = (med(cpu) / (cadenceMs / 1000)) * 100;
console.log(
	`\nmedian: wall ${med(wall)} ms, cpu ${med(cpu).toFixed(2)} s` +
		`\ncadence: one poll per ${cadenceMs} ms (500 ms sleep + the blocking spawn)` +
		`\nsustained load while polling: ${load.toFixed(0)}% of one core`,
);
