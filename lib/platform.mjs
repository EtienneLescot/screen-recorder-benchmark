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
			Buffer.from(script, "utf16le").toString("base64"),
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
				$gpu = Get-CimInstance Win32_VideoController | Select-Object -First 1
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
			`$p = Get-Process -Name ${quoted} -ErrorAction SilentlyContinue
			 if ($p) { $n = @($p).Count; $p | Stop-Process -Force -ErrorAction SilentlyContinue; $n } else { 0 }`,
			{ timeoutMs: 20_000 },
		);
		return Number(out) || 0;
	} catch {
		return 0;
	}
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

export function appVersion(appPath) {
	if (!appPath || !existsSync(appPath)) return null;
	if (IS_MAC) {
		try {
			return execFileSync(
				"/usr/bin/defaults",
				["read", join(appPath, "Contents", "Info.plist"), "CFBundleShortVersionString"],
				{ encoding: "utf8" },
			).trim();
		} catch {
			return null;
		}
	}
	try {
		return (
			powershell(`(Get-Item ${JSON.stringify(appPath)}).VersionInfo.ProductVersion`, {
				timeoutMs: 15_000,
			}) || null
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
		if (has(name)) {
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
