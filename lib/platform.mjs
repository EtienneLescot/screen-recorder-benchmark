/**
 * Everything that differs between macOS, Windows and Linux, behind one interface.
 *
 * The measurement core — the stopwatch, the fidelity model, the pixel verification, the report
 * — is platform-agnostic and must stay that way, or the platforms slowly stop measuring the
 * same thing. So the OS-specific parts live here and nowhere else: process sampling, hardware
 * and power state, installing an app, launching and quitting it, and which hardware encoder
 * ffmpeg should use.
 *
 * Adding a platform means adding a branch here and a UI-driving module; it must not mean
 * touching runner.mjs.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
} from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";

export const IS_MAC = process.platform === "darwin";
export const IS_WIN = process.platform === "win32";
export const IS_LINUX = process.platform === "linux";

export const PLATFORM_SUPPORTED = IS_MAC || IS_WIN || IS_LINUX;

/**
 * macOS and Linux share a process table.
 *
 * The sampling here was written as `IS_MAC ? ps… : powershell…`, which quietly made Linux a
 * Windows machine: every sampler reached for powershell.exe, threw ENOENT, and returned the
 * empty fallback — no CPU seconds, no RSS, no background load, and no error either. The `ps`
 * invocations are POSIX and behave identically on both, so they branch on this rather than on
 * "is it a Mac".
 */
const IS_POSIX = IS_MAC || IS_LINUX;

/** Read a sysfs/procfs file, trimmed, or null. Linux exposes most of its hardware state here. */
const readFile = (path) => {
	try {
		return readFileSync(path, "utf8").trim();
	} catch {
		return null;
	}
};

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
		`${what} needs macOS, Windows or Linux; this is ${process.platform}. Reading submissions and ` +
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

	if (IS_LINUX) {
		// Everything here is sysfs, procfs or a small tool, in that order of preference: sysfs is
		// present on every kernel and needs no package, and a missing optional tool degrades one
		// field rather than the whole fingerprint.
		const osRelease = Object.fromEntries(
			(readFile("/etc/os-release") ?? "")
				.split("\n")
				.map((l) => /^([A-Z_]+)=(.*)$/.exec(l))
				.filter(Boolean)
				.map((m) => [m[1], m[2].replace(/^"|"$/g, "")]),
		);
		// Physical cores, to mean what `performanceCores` means on the other two platforms.
		// `os.cpus().length` counts SMT threads, so an 8-thread 4-core part reported 8 and made
		// this machine look like twice the machine it is.
		const cores =
			Number(sh("lscpu -p=Core,Socket 2>/dev/null | grep -v '^#' | sort -u | wc -l", "0")) || null;
		return {
			...base,
			osProduct: osRelease.NAME ?? "Linux",
			osVersion: osRelease.VERSION_ID ?? osRelease.VERSION ?? os.release(),
			osBuild: osRelease.BUILD_ID ?? "",
			kernel: os.release(),
			model:
				[readFile("/sys/class/dmi/id/sys_vendor"), readFile("/sys/class/dmi/id/product_name")]
					.filter(Boolean)
					.join(" ") || null,
			chip: /^model name\s*:\s*(.+)$/m.exec(readFile("/proc/cpuinfo") ?? "")?.[1] ?? null,
			performanceCores: cores,
			// No P/E split to read on the parts this runs on; Windows reports the same way.
			efficiencyCores: null,
			gpu:
				sh(
					"lspci 2>/dev/null | grep -iE 'vga|3d controller' | head -1 | cut -d: -f3-",
					"",
				)?.trim() || linuxGpuDriver(),
			gpuDriver: linuxGpuDriver(),
			// XWayland answers this under a Wayland session too, which is why xrandr is asked before
			// anything compositor-specific. A headless machine simply reports none.
			displays: (sh("xrandr --current 2>/dev/null", "") || "")
				.split("\n")
				.filter((l) => / connected/.test(l))
				.map((l) => {
					const m = /^(\S+) connected(?: primary)? (\d+x\d+)/.exec(l);
					return m ? `${m[1]} ${m[2]}` : l.trim();
				})
				.filter(Boolean),
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

/** Which kernel driver is bound to the render GPU — `amdgpu`, `i915`, `nvidia`. */
function linuxGpuDriver() {
	try {
		for (const card of readdirSync("/sys/class/drm")) {
			if (!/^card\d+$/.test(card)) continue;
			const uevent = readFile(`/sys/class/drm/${card}/device/uevent`) ?? "";
			const drv = /^DRIVER=(.+)$/m.exec(uevent)?.[1];
			if (drv) return drv;
		}
	} catch {
		/* no DRM subsystem: headless or a container */
	}
	return null;
}

export function powerState() {
	if (IS_LINUX) {
		// /sys/class/power_supply is the kernel's own view and needs no daemon — upower and
		// friends are not installed everywhere, and a desktop with no battery must still answer.
		let onAC = true;
		let batteryLine = null;
		try {
			const supplies = readdirSync("/sys/class/power_supply");
			const mains = supplies.filter(
				(s) => readFile(`/sys/class/power_supply/${s}/type`) === "Mains",
			);
			const batteries = supplies.filter(
				(s) => readFile(`/sys/class/power_supply/${s}/type`) === "Battery",
			);
			// A desktop has no Mains entry either; absent any evidence, assume wall power rather
			// than failing a precondition on a machine that cannot run on a battery at all.
			if (mains.length) {
				onAC = mains.some((m) => readFile(`/sys/class/power_supply/${m}/online`) === "1");
			}
			if (batteries.length) {
				const b = batteries[0];
				const pct = readFile(`/sys/class/power_supply/${b}/capacity`);
				const status = readFile(`/sys/class/power_supply/${b}/status`);
				batteryLine = [pct ? `battery ${pct}%` : null, status].filter(Boolean).join(" ") || null;
				if (!mains.length) onAC = status !== "Discharging";
			}
		} catch {
			/* no power_supply class: a VM or a container */
		}
		// The closest equivalent of Low Power Mode is a governor that refuses to clock up. Read
		// from cpufreq rather than a desktop setting, because that is what actually caps a render.
		const governor = readFile("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor");
		return {
			onACPower: onAC,
			batteryLine,
			lowPowerMode: governor === "powersave",
			governor,
			// No portable per-core speed cap to read: intel_pstate exposes one, amd-pstate does not,
			// and reporting one vendor's number as if it were universal would be worse than null.
			cpuSpeedLimit: null,
			thermalPressure: readLinuxThermalPressure(),
		};
	}

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

/**
 * Whether the cores have been thermally clamped, on the one Linux signal that means that.
 *
 * Deliberately not a temperature. `thermalPressure.value` is a macOS *pressure level* where 0 is
 * nominal, and /sys/class/thermal reports millidegrees — publishing 51000 in a field whose other
 * platform puts 0..3 in it would invite exactly the cross-platform comparison it cannot support.
 * x86 exposes a real throttle event counter; where the kernel does not, this says so.
 */
function readLinuxThermalPressure() {
	try {
		let total = 0;
		let found = false;
		for (const cpu of readdirSync("/sys/devices/system/cpu")) {
			if (!/^cpu\d+$/.test(cpu)) continue;
			const n = readFile(`/sys/devices/system/cpu/${cpu}/thermal_throttle/core_throttle_count`);
			if (n == null) continue;
			found = true;
			total += Number(n) || 0;
		}
		if (found) return { key: "core_throttle_count", value: total };
	} catch {
		/* fall through */
	}
	return { key: "unavailable", value: null };
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
	if (IS_POSIX) {
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
	if (IS_POSIX) {
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
	if (IS_POSIX) {
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
	if (IS_POSIX) {
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
	if (IS_POSIX) {
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
	// Linux. The X11 and Wayland screen-sharing servers have no counterpart on the other two
	// platforms, and they encode the desktop through the same VAAPI block the exports use.
	"x11vnc",
	"wayvnc",
	"xrdp",
	"gnome-remote-desktop-daemon",
	"krfb",
	"teamviewerd",
	"anydesk",
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
		hosts = IS_MAC ? macRemoteHosts() : IS_LINUX ? linuxRemoteHosts() : winRemoteHosts();
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

/**
 * Streaming hosts on Linux, matched on argv[0]'s basename.
 *
 * Not `comm`, which the kernel truncates to 15 characters: `gnome-remote-desktop-daemon` and
 * `chrome_remote_desktop_host` both exceed that and would never match the names above, so the
 * two most common desktop-sharing servers on this platform would go unseen. argv[0] is not
 * truncated.
 */
function linuxRemoteHosts() {
	const out = execFileSync("/bin/ps", ["-axo", "pid=,args="], {
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	const hosts = [];
	for (const line of out.split("\n")) {
		const m = /^\s*(\d+)\s+(.*)$/.exec(line);
		if (!m) continue;
		// Kernel threads are bracketed and own no encoder.
		if (m[2].startsWith("[")) continue;
		const name = m[2].split(/\s+/)[0].split("/").pop();
		if (REMOTE_DESKTOP_PROCESSES.some((r) => name.toLowerCase() === r.toLowerCase())) {
			hosts.push({ pid: m[1], name, path: m[2] });
		}
	}
	return hosts;
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

/**
 * Where Linux installs land.
 *
 * Under the user's data directory because nothing in this harness may assume root: a benchmark
 * that needs sudo to install a competitor cannot be run by the people whose results it wants.
 * /opt and /usr/local both would.
 */
export const LINUX_APP_ROOT = join(
	process.env.XDG_DATA_HOME || join(os.homedir(), ".local", "share"),
	"screen-recorder-benchmark",
	"apps",
);

/** Where an app spec's executable actually lives on this platform. */
export function resolveAppPath(spec) {
	const candidates = IS_MAC
		? [spec.macPath]
		: IS_LINUX
			? [].concat(spec.linuxPaths ?? [])
			: [].concat(spec.winPaths ?? []);
	for (const c of candidates.filter(Boolean)) {
		const expanded = c
			.replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? "")
			// Linux entries live under the user's data directory rather than a system prefix, because
			// nothing here may assume root; `~` is the only expansion those paths need.
			.replace(/^~(?=\/|$)/, os.homedir());
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

/**
 * The `version` out of an Electron app's package.json, read straight from the asar archive.
 *
 * There is no Linux equivalent of Info.plist or VersionInfo, and asking the binary is not a
 * substitute: neither entrant here implements `--version`, and both *hang* on it — the flag
 * falls through to opening the editor, which then waits for a window that a `detect()` call is
 * never going to close. A version probe that can block forever is worse than no version.
 *
 * The asar container is a 16-byte pickle header, a JSON directory, then the file data. Parsing
 * those two numbers is cheaper and far more predictable than shelling out to anything.
 */
function electronAsarVersion(appDir) {
	// electron-builder ships either an archive or, with asar disabled, a plain directory.
	const plain = join(appDir, "resources", "app", "package.json");
	if (existsSync(plain)) {
		try {
			return JSON.parse(readFileSync(plain, "utf8")).version ?? null;
		} catch {
			return null;
		}
	}
	const asar = join(appDir, "resources", "app.asar");
	if (!existsSync(asar)) return null;
	let fd = null;
	try {
		fd = openSync(asar, "r");
		const head = Buffer.alloc(16);
		readSync(fd, head, 0, 16, 0);
		const headerSize = head.readUInt32LE(12);
		// A corrupt or truncated download must not turn into a multi-gigabyte allocation.
		if (!(headerSize > 0 && headerSize < 64 * 1024 * 1024)) return null;
		const header = Buffer.alloc(headerSize);
		readSync(fd, header, 0, headerSize, 16);
		const entry = JSON.parse(header.toString("utf8")).files?.["package.json"];
		if (!entry) return null;
		// The data section follows the header, padded to a 4-byte boundary.
		const dataStart = 16 + headerSize + ((4 - (headerSize % 4)) % 4);
		const buf = Buffer.alloc(entry.size);
		readSync(fd, buf, 0, entry.size, dataStart + Number(entry.offset));
		return JSON.parse(buf.toString("utf8")).version ?? null;
	} catch {
		return null;
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

/** The name of the marker the Linux installers leave beside an unpacked application. */
export const LINUX_INSTALL_MARKER = ".benchmark-install.json";

/**
 * What a Linux package said its version was, recorded at install time.
 *
 * Nothing in an unpacked tree has to carry a version. Electron apps do, inside the asar, but
 * Cap is Tauri: the .deb's control file says 0.5.9 and *nothing else in the payload does*, so
 * after extraction the version is simply gone. Asking the binary is not a substitute — cap-cli
 * answers `--version` with 0.1.0, the CLI's own number, and reporting that beside macOS's 0.5.9
 * would make the aggregate warn that one release is two builds.
 *
 * So the installer writes down what it installed, and this reads it back. Searched upward
 * because a driver holds the executable, which is several directories inside the tree.
 */
function linuxRecordedVersion(startDir) {
	let dir = startDir;
	for (let up = 0; up < 6; up++) {
		const marker = readFile(join(dir, LINUX_INSTALL_MARKER));
		if (marker) {
			try {
				const v = JSON.parse(marker).version ?? null;
				// A release tag is conventionally "v1.10.0" and no other platform reports the v.
				// Left on, one release reads as two builds and the aggregate says so — the same
				// failure `trimBuildField` exists to prevent for Windows' four-component version.
				return typeof v === "string" ? v.replace(/^v(?=\d)/, "") : v;
			} catch {
				return null;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/** Which package owns a path, for an app the machine already had rather than one we unpacked. */
function dpkgVersionFor(appPath) {
	const pkg = sh(`dpkg -S ${JSON.stringify(appPath)} 2>/dev/null | head -1 | cut -d: -f1`, "");
	if (!pkg) return null;
	return sh(`dpkg-query -W -f='\${Version}' ${JSON.stringify(pkg)} 2>/dev/null`, "") || null;
}

export function appVersion(appPath) {
	if (!appPath || !existsSync(appPath)) return null;
	if (IS_LINUX) {
		// Drivers hold the launchable binary; the asar sits beside it in the same extracted tree.
		// Accept either, so a caller that kept the directory does not have to know which.
		const dir = statSync(appPath).isDirectory() ? appPath : dirname(appPath);
		// The app's own package.json first, because that is the number macOS reads out of
		// Info.plist and Windows out of VersionInfo — the point is that one release reports one
		// version on all three. The install marker is the fallback for a payload that carries no
		// version at all, which is every Tauri app; dpkg answers for a copy we did not unpack.
		return electronAsarVersion(dir) ?? linuxRecordedVersion(dir) ?? dpkgVersionFor(appPath);
	}
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
	if (IS_LINUX) {
		// `accepted: null`, not false. There is no Gatekeeper and no Authenticode here: a Linux
		// desktop binary carries no signature the OS would check before running it, so "rejected"
		// would be a finding about the vendor where the truth is a fact about the platform.
		// cmdInstall prints this, and `false` made every Linux install report "gatekeeper: REJECTED"
		// for apps that are shipped exactly as their vendors intend.
		return {
			accepted: null,
			authority: null,
			raw: "not applicable — Linux has no OS-level signature check for desktop binaries",
		};
	}
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
				// .ToString() on the status, because ConvertTo-Json serialises the SignatureStatus
				// enum as its integer: Status came back as 0 or 2, never "Valid", so the comparison
				// below could not be true for any file and every Windows app was recorded as
				// signature-rejected whether or not it was signed. Two of the three entrants here
				// really are unsigned, which is exactly why a broken check went unnoticed — it
				// agreed with the answer for the wrong reason.
				`Get-AuthenticodeSignature ${JSON.stringify(appPath)} |
				 Select-Object @{n='Status';e={$_.Status.ToString()}},
				               @{n='Subject';e={$_.SignerCertificate.Subject}} |
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
 *
 * The returned descriptor carries everything a caller must splice into its command line:
 *   encoder       the -c:v name
 *   rateArgs      rate control, which is per-encoder and not interchangeable
 *   inputArgs     options that must precede -i (opening a VAAPI device)
 *   filterSuffix  a filter every video chain must end with (uploading frames to the GPU)
 *   hwFrames      true when the encoder consumes GPU frames, so -pix_fmt must not be set
 *
 * `allowHwFrames: false` says the caller cannot end its chain with an upload — a lavfi source
 * graph, or a filter_complex whose last pad is labelled and mapped. Those call sites only
 * *generate the footage*; nothing about them is timed, so declining the GPU there costs a little
 * wall clock and keeps their graphs honest. It is not a way to opt out of a hardware floor.
 */
export function pickH264Encoder(ffmpegPath, { prefer = "hardware", allowHwFrames = true } = {}) {
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

	// libx264 was reachable only by falling through every hardware candidate, which is the one
	// case where reaching it means something went wrong. It is also the CPU-side companion the
	// floor needs *on purpose*: the fixed-function encoder block and the cores do not throttle
	// together, so a hardware-only floor cannot show how much of a machine's slowdown a
	// shader-bound compositor actually saw. Asking for software explicitly is not a failure, and
	// the caller says which it wants rather than inferring it from what was returned.
	if (prefer === "software") {
		if (!has("libx264")) return null;
		return {
			encoder: "libx264",
			hardware: false,
			inputArgs: [],
			filterSuffix: null,
			rateArgs: (mbps) => ["-b:v", `${mbps}M`, "-preset", "medium"],
		};
	}

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
	// The probe has to be the *same shape* as the real encode, not just the codec name. VAAPI
	// cannot be opened by naming it: without a device and an upload filter it fails in the filter
	// graph rather than the encoder, so a name-only probe rejects a perfectly good encoder. Each
	// candidate therefore carries the extra arguments it needs and is probed with them.
	const opens = (cand) => {
		try {
			execFileSync(
				ffmpegPath,
				[
					"-hide_banner",
					"-loglevel",
					"error",
					...(cand.inputArgs ?? []),
					"-f",
					"lavfi",
					"-i",
					"color=black:s=256x144:r=30",
					...(cand.filterSuffix ? ["-vf", cand.filterSuffix] : []),
					"-frames:v",
					"1",
					"-c:v",
					cand.encoder,
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

	const candidates = [
		{
			encoder: "h264_nvenc",
			vendor: "NVIDIA",
			rateArgs: (mbps) => ["-rc", "cbr", "-b:v", `${mbps}M`],
		},
		{
			encoder: "h264_qsv",
			vendor: "Intel Quick Sync",
			rateArgs: (mbps) => ["-b:v", `${mbps}M`, "-maxrate", `${mbps}M`],
		},
		{
			encoder: "h264_amf",
			vendor: "AMD",
			rateArgs: (mbps) => ["-rc", "cbr", "-b:v", `${mbps}M`],
		},
	];

	// VAAPI is how AMD and Intel parts encode on Linux, and without it this machine class has no
	// hardware path at all: h264_amf is a Windows runtime, and a full ffmpeg build advertises
	// nvenc and qsv on hardware that cannot open either. An AMD laptop therefore fell all the way
	// through to libx264 and measured a *software* floor — which the README is explicit is not
	// comparable to one measured on silicon, so every ratio from such a machine was quietly
	// against a different unit than the published ones.
	//
	// It is last because where both work the vendor SDK is the more direct path; it is only
	// offered on Linux because that is the only platform where it is the native answer.
	if (IS_LINUX) {
		for (const dev of linuxRenderNodes()) {
			candidates.push({
				encoder: "h264_vaapi",
				vendor: `VAAPI (${dev})`,
				inputArgs: ["-vaapi_device", dev],
				// Frames have to be on the GPU before this encoder will take them, so every caller's
				// filter chain ends here. nv12 is the format the upload expects.
				filterSuffix: "format=nv12,hwupload",
				hwFrames: true,
				// No `-rc`: VAAPI picks CBR from the presence of a matching maxrate, and passing
				// nvenc's spelling makes it refuse to open at all.
				rateArgs: (mbps) => ["-b:v", `${mbps}M`, "-maxrate", `${mbps}M`],
			});
		}
	}

	if (IS_MAC && has("h264_videotoolbox")) {
		return {
			encoder: "h264_videotoolbox",
			hardware: true,
			inputArgs: [],
			filterSuffix: null,
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
	for (const cand of candidates) {
		if (cand.hwFrames && !allowHwFrames) continue;
		if (has(cand.encoder) && opens(cand)) {
			return {
				hardware: true,
				inputArgs: [],
				filterSuffix: null,
				hwFrames: false,
				...cand,
			};
		}
	}
	if (has("libx264")) {
		// Why software was reached decides whether this is a finding or a detail, and one note
		// cannot say both. A caller that declined GPU frames got libx264 on purpose and its floor
		// is untouched; a machine with no hardware encoder at all has a floor that cannot be
		// compared with anyone else's. Saying "no hardware H.264 encoder was available, so the
		// fixture *and the floor* use libx264" in the first case is false twice over — one is
		// available, and the floor is using it.
		const declined = !allowHwFrames && candidates.some((c) => c.hwFrames && has(c.encoder));
		return {
			encoder: "libx264",
			hardware: false,
			inputArgs: [],
			filterSuffix: null,
			note: declined
				? "This asset is encoded with libx264 because its filter graph cannot hand frames to a " +
					"GPU encoder. The floor is unaffected and still measures on hardware."
				: "No hardware H.264 encoder was available, so the fixture and the floor use libx264 (software). " +
					"The floor is then not comparable to one measured on a machine with GPU encoding.",
			rateArgs: (mbps) => ["-b:v", `${mbps}M`, "-preset", "medium"],
		};
	}
	throw new Error(
		"ffmpeg has no usable H.264 encoder (looked for videotoolbox, nvenc, qsv, amf, vaapi, libx264). " +
			"Point OSBENCH_FFMPEG at a fuller build.",
	);
}

/** DRM render nodes, which are what a VAAPI device argument names. Empty on a machine with none. */
function linuxRenderNodes() {
	try {
		return readdirSync("/dev/dri")
			.filter((n) => /^renderD\d+$/.test(n))
			.sort()
			.map((n) => `/dev/dri/${n}`);
	} catch {
		return [];
	}
}
