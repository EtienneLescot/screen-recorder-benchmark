/**
 * Everything that differs between macOS and Windows, behind one interface.
 *
 * The measurement core — the stopwatch, the fidelity model, the pixel verification, the report
 * — is platform-agnostic and must stay that way, or the two platforms slowly stop measuring the
 * same thing. So the OS-specific parts live here and nowhere else: process sampling, hardware
 * and power state, installing an app, launching and quitting it, and which hardware encoder
 * ffmpeg should use.
 *
 * Adding a third platform means adding a branch here and a UI-driving module; it must not mean
 * touching runner.mjs.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

export const IS_MAC = process.platform === "darwin";
export const IS_WIN = process.platform === "win32";

export const PLATFORM_SUPPORTED = IS_MAC || IS_WIN;

/**
 * Refuse to *measure* on an unsupported platform — not to load.
 *
 * Reading a submission, solving the aggregate and rendering the site involve no application at
 * all, and a module that throws on import makes those impossible everywhere the adapters happen
 * not to run. CI is Linux, and so are most of the machines that will ever read this data.
 */
export function requireSupportedPlatform(what = "this operation") {
	if (PLATFORM_SUPPORTED) return;
	throw new Error(
		`${what} needs macOS or Windows; this is ${process.platform}. Reading submissions and ` +
			"building the aggregate work anywhere — only measuring does not. See lib/platform.mjs to add a platform.",
	);
}

const sh = (cmd, fallback = null) => {
	try {
		return execFileSync(IS_WIN ? "cmd.exe" : "/bin/sh", IS_WIN ? ["/c", cmd] : ["-c", cmd], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			maxBuffer: 16 * 1024 * 1024,
		}).trim();
	} catch {
		return fallback;
	}
};

/** Run a PowerShell snippet and return its stdout. The workhorse for everything on Windows. */
export function powershell(script, { timeoutMs = 60_000 } = {}) {
	const res = spawnSync(
		"powershell.exe",
		// Delivered base64/UTF-16LE rather than piped to `-Command -`. Reading a script from
		// stdin executes it a statement at a time, so anything spanning lines returns empty stdout
		// with exit code 0 — no error to catch, just no data. That silently emptied the process
		// snapshot and the per-process CPU query, and with them the CPU, RSS and background-load
		// columns.
		[
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-EncodedCommand",
			// stdout is read as UTF-8, but PowerShell writes in the console codepage — on a French
			// install that is Windows-1252, so every accented control name came back mojibake:
			// "Téléprompteur" as "T?l?prompteur". Any driver matching on localised names was
			// comparing against corrupted text.
			Buffer.from(
				`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
${script}`,
				"utf16le",
			).toString("base64"),
		],
		{ encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
	);
	if (res.error) throw new Error(`powershell failed: ${res.error.message}`);
	if (res.status !== 0) {
		throw new Error(`powershell exited ${res.status}: ${(res.stderr ?? "").trim().slice(0, 600)}`);
	}
	return (res.stdout ?? "").trim();
}

/* ------------------------------------------------------------------- hardware ------------ */

export function machineFingerprint() {
	requireSupportedPlatform("recording a machine fingerprint");
	const base = {
		platform: process.platform,
		arch: process.arch,
		cpuCount: os.cpus().length,
		memoryGiB: +(os.totalmem() / 1024 ** 3).toFixed(1),
		nodeVersion: process.version,
	};

	if (IS_MAC) {
		return {
			...base,
			osProduct: sh("sw_vers -productName"),
			osVersion: sh("sw_vers -productVersion"),
			osBuild: sh("sw_vers -buildVersion"),
			kernel: os.release(),
			model: sh("sysctl -n hw.model"),
			chip: sh("sysctl -n machdep.cpu.brand_string"),
			performanceCores: Number(sh("sysctl -n hw.perflevel0.logicalcpu", "0")) || null,
			efficiencyCores: Number(sh("sysctl -n hw.perflevel1.logicalcpu", "0")) || null,
			gpu: sh("system_profiler SPDisplaysDataType | awk -F': ' '/Chipset Model/{print $2; exit}'"),
			displays: (sh("system_profiler SPDisplaysDataType", "") || "")
				.split("\n")
				.filter((l) => /^\s+(Resolution|UI Looks like):/.test(l))
				.map((l) => l.trim()),
		};
	}

	// Windows. One PowerShell round-trip rather than several `wmic` calls, which is both faster
	// and future-proof — wmic is deprecated and absent from recent Windows images.
	let win = {};
	try {
		win = JSON.parse(
			powershell(`
				$os  = Get-CimInstance Win32_OperatingSystem
				$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
				$cs  = Get-CimInstance Win32_ComputerSystem
				# The first controller is not necessarily the real one. A remote-desktop or virtual
				# display driver enumerates ahead of the physical card and outlives the app that
				# installed it, so this reported "Parsec Virtual Display Adapter" on a machine whose
				# exports were running on an RTX 4070 Ti. For a benchmark whose floor and every export
				# go through the hardware encoder, naming the wrong adapter in a published submission
				# is worse than naming none. Physical adapters sit on PCI; virtual ones are
				# root-enumerated.
				$all = @(Get-CimInstance Win32_VideoController)
				$gpu = @($all | Where-Object { $_.PNPDeviceID -like 'PCI\*' })[0]
				if (-not $gpu) { $gpu = $all[0] }
				$mon = Get-CimInstance Win32_VideoController | ForEach-Object {
					"$($_.CurrentHorizontalResolution) x $($_.CurrentVerticalResolution) @ $($_.CurrentRefreshRate)Hz"
				}
				@{
					osProduct = $os.Caption
					osVersion = $os.Version
					osBuild   = $os.BuildNumber
					model     = "$($cs.Manufacturer) $($cs.Model)"
					chip      = $cpu.Name
					cores     = $cpu.NumberOfCores
					gpu       = $gpu.Name
					gpuDriver = $gpu.DriverVersion
					displays  = @($mon)
				} | ConvertTo-Json -Compress
			`),
		);
	} catch {
		/* doctor reports the gap rather than the run dying on it */
	}

	return {
		...base,
		osProduct: win.osProduct ?? "Windows",
		osVersion: win.osVersion ?? os.release(),
		osBuild: String(win.osBuild ?? ""),
		kernel: os.release(),
		model: win.model ?? null,
		chip: win.chip ?? null,
		// Windows reports physical cores directly; there is no P/E split to read.
		performanceCores: win.cores ?? null,
		efficiencyCores: null,
		gpu: win.gpu ?? null,
		gpuDriver: win.gpuDriver ?? null,
		displays: [].concat(win.displays ?? []),
	};
}

export function powerState() {
	if (IS_MAC) {
		const batt = sh("pmset -g batt", "");
		const therm = sh("pmset -g therm", "");
		const speed = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(therm);
		return {
			onACPower: /AC Power/.test(batt),
			batteryLine: batt.split("\n").slice(1).join(" ").trim() || null,
			lowPowerMode: /lowpowermode\s+1/.test(sh("pmset -g | grep -i lowpowermode", "")),
			cpuSpeedLimit: speed ? Number(speed[1]) : null,
			thermalPressure: readMacThermalPressure(),
		};
	}

	try {
		const j = JSON.parse(
			powershell(`
				$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
				$p = powercfg /getactivescheme
				@{
					hasBattery = [bool]$b
					# 1 = "Other" (on AC with no battery), 2 = AC line
					onAC       = if ($b) { $b.BatteryStatus -eq 2 } else { $true }
					charge     = if ($b) { $b.EstimatedChargeRemaining } else { $null }
					powerPlan  = ($p -replace '.*\\(', '' -replace '\\).*', '').Trim()
				} | ConvertTo-Json -Compress
			`),
		);
		return {
			onACPower: !!j.onAC,
			batteryLine: j.hasBattery ? `battery ${j.charge}%` : null,
			// Windows has no Low Power Mode; the equivalent risk is a power plan that caps the CPU.
			lowPowerMode: /power saver|économie/i.test(j.powerPlan ?? ""),
			powerPlan: j.powerPlan ?? null,
			cpuSpeedLimit: null,
			thermalPressure: { key: "unavailable", value: null },
		};
	} catch {
		return {
			onACPower: true,
			batteryLine: null,
			lowPowerMode: false,
			powerPlan: null,
			cpuSpeedLimit: null,
			thermalPressure: { key: "unavailable", value: null },
		};
	}
}

function readMacThermalPressure() {
	for (const key of ["kern.thermalpressurelevel", "machdep.xcpm.cpu_thermal_level"]) {
		const v = sh(`sysctl -n ${key}`);
		if (v !== null && v !== "") return { key, value: Number(v) };
	}
	if (/No thermal warning level has been recorded/i.test(sh("pmset -g therm", "") ?? "")) {
		return { key: "pmset", value: 0 };
	}
	return { key: "unavailable", value: null };
}

export function diskFreeGiB(path) {
	const target = existsSync(path) ? path : os.homedir();
	if (IS_MAC) {
		const cols = (sh(`df -k ${JSON.stringify(target)} | tail -1`, "") ?? "").split(/\s+/);
		return { path: target, availableGiB: +(Number(cols[3] || 0) / 1024 / 1024).toFixed(1) };
	}
	try {
		const drive = target.slice(0, 2);
		const free = powershell(`(Get-PSDrive -Name '${drive[0]}').Free`);
		return { path: target, availableGiB: +(Number(free) / 1024 ** 3).toFixed(1) };
	} catch {
		return { path: target, availableGiB: 0 };
	}
}

/* -------------------------------------------------------------- process sampling --------- */

/**
 * One snapshot of every process: cumulative CPU seconds, resident bytes, and the command line.
 * Cumulative counters (not instantaneous %) are what let a helper that exits mid-export still
 * contribute its full cost.
 */
export function listProcesses() {
	if (IS_MAC) {
		let out;
		try {
			out = execFileSync("/bin/ps", ["-axo", "pid=,rss=,time=,args="], {
				encoding: "utf8",
				maxBuffer: 16 * 1024 * 1024,
			});
		} catch {
			return [];
		}
		const rows = [];
		for (const line of out.split("\n")) {
			const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
			if (!m) continue;
			rows.push({
				pid: m[1],
				rssBytes: Number(m[2]) * 1024,
				cpuSeconds: parseMacCpuTime(m[3]),
				args: m[4],
			});
		}
		return rows;
	}

	try {
		const raw = powershell(
			`Get-Process | ForEach-Object {
				[pscustomobject]@{
					pid = $_.Id
					rss = $_.WorkingSet64
					cpu = $_.CPU
					p   = $_.Path
					n   = $_.ProcessName
				}
			} | ConvertTo-Json -Compress`,
			{ timeoutMs: 20_000 },
		);
		const arr = JSON.parse(raw || "[]");
		return [].concat(arr).map((p) => ({
			pid: String(p.pid),
			rssBytes: Number(p.rss ?? 0),
			// Process.CPU is total processor seconds; null for processes we cannot open.
			cpuSeconds: Number(p.cpu ?? 0) || 0,
			args: p.p || p.n || "",
		}));
	} catch {
		return [];
	}
}

/** macOS `ps` TIME is [[dd-]hh:]mm:ss[.ff]. Exported for the unit tests. */
export function parseMacCpuTime(t) {
	const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(String(t).trim());
	if (!m) return 0;
	const [, d, h, mi, s] = m;
	return Number(d || 0) * 86400 + Number(h || 0) * 3600 + Number(mi) * 60 + Number(s);
}

/**
 * Instantaneous %CPU per process, summed for those whose argv matches a prefix.
 *
 * Needed to answer "how busy is this machine *besides* the app being measured" — a question the
 * total load cannot answer, and getting it wrong made a CPU-heavy app look like it was running
 * under heavy external load. Cumulative counters cannot substitute: they say what a process has
 * used since it started, not what it is using now.
 */
export function instantaneousCpuFor(matchPrefixes) {
	const prefixes = [].concat(matchPrefixes).filter(Boolean);
	if (!prefixes.length) return 0;
	if (IS_MAC) {
		try {
			const out = execFileSync("/bin/ps", ["-axo", "pcpu=,args="], {
				encoding: "utf8",
				maxBuffer: 16 * 1024 * 1024,
			});
			let total = 0;
			for (const line of out.split("\n")) {
				const m = /^\s*([\d.]+)\s+(.*)$/.exec(line);
				if (!m) continue;
				if (prefixes.some((pre) => m[2].includes(pre))) total += Number(m[1]);
			}
			return +total.toFixed(1);
		} catch {
			return 0;
		}
	}
	try {
		const names = prefixes.map((x) =>
			x
				.split(/[/\\]/)
				.pop()
				.replace(/\.exe$/i, ""),
		);
		const raw = powershell(
			// Two things needed fixing here. Counter *paths* are localised, so
			// "\\Process(x)\\% Processor Time" does not resolve on a non-English Windows: the lookup
			// threw, this returned 0, and the foreign-load subtraction below silently became a
			// no-op. WMI class and property names are invariant.
			//
			// And the match has to mean what the cumulative sampler's match means. That one tests
			// `args.includes(prefix)` against a full path, so a prefix of "Cap" catches
			// ...\\Cap\\cap-cli.exe — the process that actually renders. Reducing the prefix to an
			// exact image name did not, so cap-cli's ~1.9 cores were never subtracted and were
			// reported as *background* load: 240 % against OpenScreen's 63 %, which then tripped
			// the "not measured under the same conditions" warning on a machine that was idle.
			// Substring, in both matchers, so they agree.
			`$n = @(${names.map((n) => `'${n.replace(/'/g, "''")}'`).join(",")})
			 $s = 0
			 foreach ($p in (Get-CimInstance Win32_PerfFormattedData_PerfProc_Process)) {
			   $nm = $p.Name -replace '#\\d+$',''
			   if ($nm -eq '_Total' -or $nm -eq 'Idle') { continue }
			   foreach ($x in $n) { if ($nm -like "*$x*") { $s += $p.PercentProcessorTime; break } }
			 }
			 $s`,
			{ timeoutMs: 20_000 },
		);
		return Number.isFinite(Number(raw)) ? +Number(raw).toFixed(1) : 0;
	} catch {
		return 0;
	}
}

/**
 * Total CPU load right now, as a percentage summed across cores — the "is something else using
 * this machine" check. Instantaneous by nature, so callers sample it repeatedly.
 */
export function instantaneousLoadPercent() {
	if (IS_MAC) {
		try {
			const out = execFileSync("/bin/ps", ["-axo", "pcpu="], {
				encoding: "utf8",
				maxBuffer: 8 * 1024 * 1024,
			});
			return +out
				.split("\n")
				.map((l) => Number(l.trim()))
				.filter((n) => Number.isFinite(n))
				.reduce((a, b) => a + b, 0)
				.toFixed(0);
		} catch {
			return null;
		}
	}
	try {
		// Read through WMI for the same reason as ownCpuPercent: the English counter path does
		// not resolve on a localised Windows — a French install wants
		// "\\Processeur(_Total)\\% temps processeur" — the lookup threw, the catch returned null,
		// and every Bg load reading came out blank. PercentProcessorTime is 0-100; scaled to match
		// the macOS convention of summing per-core percentages.
		const v = powershell(
			`(Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime`,
			{ timeoutMs: 15_000 },
		);
		return Number.isFinite(Number(v)) ? Math.round(Number(v) * os.cpus().length) : null;
	} catch {
		return null;
	}
}

/**
 * Terminate processes by executable name. Adapters use this to tear down helpers their export
 * left running — an orphan that keeps burning CPU contaminates every later measurement, and the
 * sampler cannot tell it apart from the tool legitimately under test.
 */
export function killProcesses(names) {
	const list = [].concat(names).filter(Boolean);
	if (!list.length) return 0;
	if (IS_MAC) {
		let killed = 0;
		for (const n of list) {
			try {
				execFileSync("/usr/bin/pkill", ["-f", n], { stdio: "ignore" });
				killed++;
			} catch {
				/* none running */
			}
		}
		return killed;
	}
	try {
		const quoted = list.map((n) => `'${String(n).replace(/'/g, "''")}'`).join(",");
		const out = powershell(
			`$n = @(${quoted})
			 $p = @(Get-Process | Where-Object { $n -contains $_.ProcessName })
			 if ($p.Count) { $p | Stop-Process -Force -ErrorAction SilentlyContinue }
			 $p.Count
			 exit 0`,
			{ timeoutMs: 20_000 },
		);
		return Number(out) || 0;
	} catch {
		return 0;
	}
}

/**
 * Hosts that stream this screen to somebody else. Matched on the process image name, which is
 * stable across versions in a way window titles and service names are not.
 */
/**
 * Where a streaming host's own CPU stops looking like an idle tray icon. Measured, not guessed:
 * Parsec 32.8% of a core with a session live against 1.0-1.1% seconds after it dropped, and
 * screensharingd and ARDAgent at 0.0% while idle.
 */
const HOST_ACTIVE_CPU_PERCENT = 8;

const REMOTE_DESKTOP_PROCESSES = [
	"parsecd",
	"TeamViewer",
	"TeamViewer_Service",
	"AnyDesk",
	"rustdesk",
	"sunshine",
	"nvstreamer",
	"screensharingd",
	"ARDAgent",
	"RemoteDesktopAgent",
	"vncserver",
	"winvnc",
	"tvnserver",
	"chrome_remote_desktop_host",
	"remoting_host",
];

/**
 * Is a remote-desktop session encoding this screen right now?
 *
 * This is the single largest error source in the whole benchmark and the one nothing else
 * catches. Parsec, Sunshine, RDP and Screen Sharing encode the desktop continuously through the
 * *same* hardware H.264/H.265 block every export here uses, so they steal from the thing being
 * measured — and they do it while using almost no CPU, which is why `preconditionCheck`'s load
 * test sails straight past them. Measured on the machine this was written on: parsecd held two
 * 1920×1080@60 NVENC sessions while consuming 0.2 % of one core.
 *
 * Returns `{ active, reasons }` where `active` is:
 *   true   a streaming host is running *and* holding a hardware encoder session — confirmed
 *   false  nothing streaming found
 *   null   a streaming host is running but its encoder use could not be confirmed either way
 *
 * The tri-state matters: the submission schema down-weights a run by ×0.3 when this is true, and
 * guessing in either direction is worse than saying "unknown".
 */
export function remoteDesktopActive() {
	const reasons = [];
	let hosts = [];
	try {
		hosts = IS_MAC ? macRemoteHosts() : winRemoteHosts();
	} catch {
		return { active: null, reasons: ["could not enumerate processes"] };
	}
	if (!hosts.length) return { active: false, reasons: [] };

	for (const h of hosts) reasons.push(`${h.name} is running (pid ${h.pid})`);

	// A host process on its own proves nothing — Parsec idles in the tray on plenty of desktops.
	// What matters is whether it holds an encoder session, and NVIDIA will say so outright.
	const sessions = nvencSessions();
	if (sessions == null) {
		// No NVIDIA here, which is not the same as a failed query — an Apple GPU simply cannot be
		// asked this. Fall back to what the host itself is doing. Streaming a desktop costs little
		// CPU because the encoding is in hardware, but capture, packetisation and the network loop
		// are not free: measured on this Mac, Parsec sat at 32.8% of a core with a session live
		// and 1.0-1.1% once it dropped, and macOS's own screensharingd and ARDAgent read 0.0%
		// while idle. A threshold in that gap is a real answer where the alternative was a
		// permanent "unknown".
		const busy = hosts
			.map((h) => ({ h, cpu: processCpuPercent(h.pid) }))
			.filter((x) => x.cpu != null);
		if (!busy.length) {
			reasons.push("could not read hardware encoder sessions or host activity");
			return { active: null, reasons };
		}
		const live = busy.filter((x) => x.cpu >= HOST_ACTIVE_CPU_PERCENT);
		for (const x of busy) reasons.push(`${x.h.name} is using ${x.cpu}% of a core`);
		if (live.length) {
			reasons.push("no hardware encoder counter here, so this is inferred from host activity");
			return { active: true, reasons };
		}
		reasons.push("idle enough to be sitting in the tray rather than streaming");
		return { active: false, reasons };
	}
	const pids = new Set(hosts.map((h) => String(h.pid)));
	const held = sessions.filter((s) => pids.has(String(s.pid)));
	if (held.length) {
		for (const s of held) {
			reasons.push(
				`holding a hardware encoder session: ${s.codec} ${s.width}x${s.height}@${s.fps}`,
			);
		}
		return { active: true, reasons };
	}
	reasons.push("but it holds no hardware encoder session");
	return { active: false, reasons };
}

/**
 * Whether a macOS process path could be a third-party streaming host at all.
 *
 * Exported for the test: the distinction is one substring, and getting it wrong made every Mac
 * on earth report an unknown remote-desktop state.
 */
export function isThirdPartyRemoteHost(path) {
	return !path.startsWith("/System/") || path.includes("/RemoteManagement/");
}

function macRemoteHosts() {
	const out = execFileSync("/bin/ps", ["-axo", "pid=,comm="], {
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	const hosts = [];
	for (const line of out.split("\n")) {
		const m = /^\s*(\d+)\s+(.*)$/.exec(line);
		if (!m) continue;
		const path = m[2];
		// Apple ships its own `parsecd` — /System/Library/PrivateFrameworks/CoreParsec.framework,
		// the Siri and Spotlight suggestions daemon — on every Mac, and it has nothing to do with
		// Parsec the streaming host. Matching on the basename caught it, so every macOS machine
		// looked like it was running a streaming host, fell through to the NVENC question that
		// an Apple GPU can never answer, and recorded `remoteDesktopActive: null`. Not sometimes:
		// always, on every Mac, whatever was installed. A first-party daemon under /System is
		// never a third-party streaming host.
		if (!isThirdPartyRemoteHost(path)) continue;
		const name = path.split("/").pop();
		if (REMOTE_DESKTOP_PROCESSES.some((r) => name.toLowerCase() === r.toLowerCase())) {
			hosts.push({ pid: m[1], name, path });
		}
	}
	return hosts;
}

/**
 * What a process is using right now, as a percentage of one core.
 *
 * `ps -o pcpu` reports a decaying average rather than an instantaneous figure, so a host that
 * streamed heavily an hour ago still reads high. Two samples of accumulated CPU time, a known
 * interval apart, give the real thing.
 */
function processCpuPercent(pid, ms = 700) {
	const cpuMs = () => {
		const raw = spawnSync("/bin/ps", ["-p", String(pid), "-o", "cputime="], { encoding: "utf8" });
		const m = /(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/.exec((raw.stdout ?? "").trim());
		if (!m) return null;
		const [, d, h, min, sec] = m;
		return ((+(d ?? 0) * 24 + +(h ?? 0)) * 3600 + +min * 60 + Number.parseFloat(sec)) * 1000;
	};
	const a = cpuMs();
	if (a == null) return null;
	const t0 = Date.now();
	// A busy wait is wrong here and a sleep is what is wanted; spawning `sleep` keeps this
	// synchronous, which is what every caller of remoteDesktopActive() expects.
	spawnSync("/bin/sleep", [String(ms / 1000)]);
	const b = cpuMs();
	const elapsed = Date.now() - t0;
	if (b == null || elapsed <= 0) return null;
	return +(((b - a) / elapsed) * 100).toFixed(1);
}

function winRemoteHosts() {
	const names = REMOTE_DESKTOP_PROCESSES.map((n) => `'${n.replace(/'/g, "''")}'`).join(",");
	// Filtered from the full list rather than `Get-Process -Name`: that form exits non-zero when
	// *any* of the names has no match, which is the normal case here, and powershell() reads a
	// non-zero exit as failure. The explicit `exit 0` keeps a stray warning from doing the same.
	const raw = powershell(
		`$n = @(${names})
		 Get-Process | Where-Object { $n -contains $_.ProcessName } |
		   ForEach-Object { "$($_.Id)|$($_.ProcessName)" }
		 exit 0`,
		{ timeoutMs: 20_000 },
	);
	return raw
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => {
			const [pid, name] = l.split("|");
			return { pid, name };
		});
}

/**
 * Hardware encoder sessions currently open, via nvidia-smi. Returns null when there is no
 * NVIDIA GPU or the tool is absent — which is a different answer from "no sessions".
 */
function nvencSessions() {
	// nvidia-smi keeps emitting samples for as long as it is left running — the help text says
	// only `-l` loops, but the plain form does too — so this takes a bounded sample and keeps
	// whatever arrived. spawnSync hands back stdout even when the timeout kills the process,
	// which execFileSync does not, and a non-zero status here is expected rather than a failure.
	const res = spawnSync("nvidia-smi", ["encodersessions"], {
		encoding: "utf8",
		timeout: 4000,
		maxBuffer: 4 * 1024 * 1024,
	});
	const out = res.stdout ?? "";
	// No GPU, no driver, no tool: a different answer from "no sessions", and the caller
	// distinguishes them.
	if (res.error && res.error.code === "ENOENT") return null;
	if (!out.includes("Session")) return null;

	const rows = [];
	for (const line of out.split(/\r?\n/)) {
		// GPU  Session  Process  Codec  H-Res  V-Res  FPS  Latency
		const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
		if (!m) continue;
		rows.push({ pid: m[3], codec: m[4], width: +m[5], height: +m[6], fps: +m[7] });
	}
	// Repeated samples of the same session collapse to one row per pid+geometry.
	const seen = new Map();
	for (const r of rows) {
		const key = `${r.pid}|${r.codec}|${r.width}x${r.height}`;
		const prev = seen.get(key);
		if (!prev || r.fps > prev.fps) seen.set(key, r);
	}
	return [...seen.values()];
}

/* ------------------------------------------------------------------ applications --------- */

/** Where an app spec's executable actually lives on this platform. */
export function resolveAppPath(spec) {
	const candidates = IS_MAC ? [spec.macPath] : [].concat(spec.winPaths ?? []);
	for (const c of candidates.filter(Boolean)) {
		const expanded = c.replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? "");
		if (existsSync(expanded)) return expanded;
	}
	return null;
}

/**
 * Drop a Windows build field so the same release reads the same on both platforms.
 *
 * `VersionInfo.ProductVersion` returns four components — OpenScreen 1.10.0 comes back as
 * "1.10.0.0" — while macOS's CFBundleShortVersionString returns three. Left alone, one release
 * looks like two builds: the aggregate warned "openscreen-cli spans 2 versions (1.10.0,
 * 1.10.0.0) — this figure is not one build", which is a typographic difference reported as a
 * measurement problem.
 *
 * Only a trailing zero is dropped. A real fourth component is a real build and stays.
 */
const trimBuildField = (v) => (typeof v === "string" ? v.replace(/^(\d+\.\d+\.\d+)\.0$/, "$1") : v);

export function appVersion(appPath) {
	if (!appPath || !existsSync(appPath)) return null;
	if (IS_MAC) {
		// Drivers hold whichever path they need to launch, and for an Electron app that is the
		// executable inside the bundle — `Recordly.app/Contents/MacOS/Recordly`. Reading
		// `<that>/Contents/Info.plist` finds nothing, so the version came back null and the
		// submission recorded the string "unknown" beside three real measurements. Walk up to the
		// enclosing bundle first; a path that already is one is unchanged.
		const bundle = appPath.replace(/(\.app)\/.*$/, "$1");
		try {
			return execFileSync(
				"/usr/bin/defaults",
				["read", join(bundle, "Contents", "Info.plist"), "CFBundleShortVersionString"],
				{ encoding: "utf8" },
			).trim();
		} catch {
			return null;
		}
	}
	try {
		return (
			trimBuildField(
				powershell(`(Get-Item ${JSON.stringify(appPath)}).VersionInfo.ProductVersion`, {
					timeoutMs: 15_000,
				}),
			) || null
		);
	} catch {
		return null;
	}
}

/** Signing/notarisation status, recorded so the report can say what was actually run. */
export function signatureStatus(appPath) {
	if (!appPath || !existsSync(appPath)) return { accepted: false, authority: null, raw: "missing" };
	if (IS_MAC) {
		const res = spawnSync("/usr/sbin/spctl", ["-a", "-t", "exec", "-vv", appPath], {
			encoding: "utf8",
		});
		const text = `${res.stdout ?? ""}${res.stderr ?? ""}`;
		return {
			accepted: /: accepted/.test(text),
			authority: /origin=(.+)/.exec(text)?.[1]?.trim() ?? null,
			raw: text.trim().slice(0, 400),
		};
	}
	try {
		const j = JSON.parse(
			powershell(
				`Get-AuthenticodeSignature ${JSON.stringify(appPath)} |
				 Select-Object Status, @{n='Subject';e={$_.SignerCertificate.Subject}} |
				 ConvertTo-Json -Compress`,
				{ timeoutMs: 20_000 },
			),
		);
		return {
			accepted: j.Status === "Valid",
			authority: j.Subject ?? null,
			raw: `${j.Status}${j.Subject ? ` — ${j.Subject}` : ""}`,
		};
	} catch {
		return { accepted: false, authority: null, raw: "unreadable" };
	}
}

/* -------------------------------------------------------------------- encoders ----------- */

/**
 * Which hardware H.264 encoder ffmpeg should use for the fixture and the floor.
 *
 * This is deliberately probed rather than assumed: the answer differs by GPU vendor on Windows,
 * and picking a software encoder by accident would make the floor meaningless. Falls back to
 * libx264 with a loud note in the results, because a floor measured on a software encoder is
 * not comparable to one measured on silicon.
 */
export function pickH264Encoder(ffmpegPath) {
	let available = "";
	try {
		available = execFileSync(ffmpegPath, ["-hide_banner", "-encoders"], {
			encoding: "utf8",
			maxBuffer: 8 * 1024 * 1024,
		});
	} catch {
		/* fall through to the default */
	}
	const has = (name) => new RegExp(`\\b${name}\\b`).test(available);

	if (IS_MAC && has("h264_videotoolbox")) {
		return {
			encoder: "h264_videotoolbox",
			hardware: true,
			rateArgs: (mbps) => ["-b:v", `${mbps}M`],
		};
	}
	// Rate control is per-encoder, not universal. h264_nvenc ignores a bare `-b:v` and falls
	// back to its own constant-quality mode: asked for 20M it produced 2.5 Mbps, so the floor was
	// doing roughly an eighth of the encode work it was pinned to and the generated source came
	// out at a fifth of its spec. `-rc cbr` makes it honour the figure — measured 19.3 Mbps for
	// the same request on an RTX-class card.
	// `ffmpeg -encoders` lists what the build was compiled with, not what this machine can open:
	// a full build advertises nvenc, qsv and amf on every box regardless of the GPU in it. Trusting
	// the list alone picked h264_nvenc on an AMD laptop and every encode died on "Cannot load
	// nvcuda.dll" — after `apps` had already called the machine ready. Ask each candidate to encode
	// one frame and keep the first that actually opens.
	const opens = (name) => {
		try {
			execFileSync(
				ffmpegPath,
				[
					"-hide_banner",
					"-loglevel",
					"error",
					"-f",
					"lavfi",
					"-i",
					"color=black:s=256x144:r=30",
					"-frames:v",
					"1",
					"-c:v",
					name,
					"-f",
					"null",
					"-",
				],
				{ stdio: "ignore", timeout: 30_000 },
			);
			return true;
		} catch {
			return false;
		}
	};

	const RATE = {
		h264_nvenc: (mbps) => ["-rc", "cbr", "-b:v", `${mbps}M`],
		h264_amf: (mbps) => ["-rc", "cbr", "-b:v", `${mbps}M`],
		h264_qsv: (mbps) => ["-b:v", `${mbps}M`, "-maxrate", `${mbps}M`],
	};
	for (const [name, vendor] of [
		["h264_nvenc", "NVIDIA"],
		["h264_qsv", "Intel Quick Sync"],
		["h264_amf", "AMD"],
	]) {
		if (has(name) && opens(name)) {
			return { encoder: name, hardware: true, vendor, rateArgs: RATE[name] };
		}
	}
	if (has("libx264")) {
		return {
			encoder: "libx264",
			hardware: false,
			note:
				"No hardware H.264 encoder was available, so the fixture and the floor use libx264 (software). " +
				"The floor is then not comparable to one measured on a machine with GPU encoding.",
			rateArgs: (mbps) => ["-b:v", `${mbps}M`, "-preset", "medium"],
		};
	}
	throw new Error(
		"ffmpeg has no usable H.264 encoder (looked for videotoolbox, nvenc, qsv, amf, libx264). " +
			"Point OSBENCH_FFMPEG at a fuller build.",
	);
}
