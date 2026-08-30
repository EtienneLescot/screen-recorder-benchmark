/**
 * Unattended installation of the competitor apps.
 *
 * Everything here runs *after* the single up-front approval collected by `preflight`, and
 * nothing here can ask a question — a run is expected to continue with nobody at the keyboard.
 *
 * Note on Gatekeeper: `curl` does not set `com.apple.quarantine`, so an app fetched this way
 * skips the "downloaded from the internet" first-launch prompt that would otherwise stall an
 * unattended run. The quarantine flag is never stripped from anything — if a vendor ships an
 * unnotarised build, that is recorded as a finding rather than worked around.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
	IS_LINUX,
	IS_WIN,
	LINUX_APP_ROOT,
	LINUX_INSTALL_MARKER,
	appVersion as platformVersion,
	powershell,
	signatureStatus,
} from "./platform.mjs";

const APPLICATIONS = "/Applications";

/**
 * One decision about which curl, made once.
 *
 * This was branched at each call site, and one of the three did not branch: the HEAD probe in
 * download() asked for curl.exe and the fetch two lines below it asked for /usr/bin/curl, so on
 * Windows every install resolved its redirect, printed the file it was about to download, and
 * then died on "spawnSync /usr/bin/curl ENOENT". A constant cannot drift the way three copies of
 * a ternary can.
 */
const CURL = IS_WIN ? "curl.exe" : "/usr/bin/curl";

const run = (bin, args, opts = {}) =>
	execFileSync(bin, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...opts });

export const appVersion = platformVersion;

/** Signing / notarisation status, recorded so the report can say what was actually run. */
export const codesignStatus = signatureStatus;

/**
 * Resolve the current download URL from a vendor's own download page.
 *
 * For vendors who publish version-addressed assets but no stable "latest" link. Scraping is
 * fragile, and that is the point: it fails loudly when the page changes, where a hard-coded URL
 * would keep installing an old build for months without anyone noticing.
 */
export function resolveFromPage(pageUrl, pattern) {
	const html = run(CURL, ["-fsSL", "--max-time", "40", pageUrl]);
	const m = html.match(pattern);
	if (!m) {
		throw new Error(
			`no download URL matching ${pattern} on ${pageUrl}. The vendor's page changed; update the ` +
				"registry entry rather than pinning a version.",
		);
	}
	const url = m[0];
	const version = /releases\/([^/]+)\//.exec(url)?.[1] ?? null;
	return { url, version };
}

/** Resolve a GitHub release asset to a concrete URL. */
export function resolveGithubAsset(repo, pattern) {
	const json = run(CURL, [
		"-fsSL",
		"--max-time",
		"40",
		"-H",
		"Accept: application/vnd.github+json",
		`https://api.github.com/repos/${repo}/releases/latest`,
	]);
	const rel = JSON.parse(json);
	const asset = (rel.assets ?? []).find((a) => pattern.test(a.name));
	if (!asset) {
		throw new Error(
			`no asset in ${repo}@${rel.tag_name} matched ${pattern}. Present: ${(rel.assets ?? []).map((a) => a.name).join(", ")}`,
		);
	}
	return {
		url: asset.browser_download_url,
		version: rel.tag_name,
		name: asset.name,
		sizeBytes: asset.size,
	};
}

/**
 * Run a Windows installer unattended.
 *
 * Both vendors in the Windows set ship NSIS packages, where `/S` is the silent switch; an MSI
 * would need `msiexec /qn` instead. If an installer rejects its silent switch it will sit on a
 * dialog forever, so this is bounded and reports what it left behind rather than hanging a run.
 */
function runWindowsInstaller(installerPath, spec, { log = () => undefined }) {
	const args = spec.silentArgs ?? ["/S"];
	log(`  running ${basename(installerPath)} ${args.join(" ")}`);
	powershell(
		`$p = Start-Process -FilePath ${JSON.stringify(installerPath)} -ArgumentList @(${args
			.map((a) => `'${a}'`)
			.join(",")}) -PassThru -Wait
		 exit $p.ExitCode`,
		{ timeoutMs: 20 * 60 * 1000 },
	);
}

/** Resumable download. A 400 MB DMG over a flaky link should not restart from zero. */
export function download(url, destDir, { log = () => undefined, extension = null } = {}) {
	mkdirSync(destDir, { recursive: true });
	// The vendor URL is often a redirect; ask curl for the effective name it lands on.
	const nul = IS_WIN ? "NUL" : "/dev/null";
	const effective = run(CURL, [
		"-sIL",
		"--max-time",
		"60",
		"-o",
		nul,
		"-w",
		"%{url_effective}",
		url,
	]).trim();
	let name = basename(new URL(effective).pathname) || basename(new URL(url).pathname);
	// A redirect does not have to land on a filename. Cap's /download/linux ends at a CDN asset
	// id — "01KZEFJ…", no extension — and the platform default guessed .AppImage for what is
	// actually a .deb, so the installer picked the wrong unpacker for a correctly downloaded
	// file. The registry already declares which artefact it is; that beats guessing from a URL
	// the vendor is free to change.
	if (!/\.(dmg|zip|pkg|exe|msi|appimage|deb|rpm)$/i.test(name)) {
		name = `${name || "download"}${extension ?? (IS_WIN ? ".exe" : IS_LINUX ? ".AppImage" : ".dmg")}`;
	}
	const dest = join(destDir, decodeURIComponent(name));

	log(`  downloading ${decodeURIComponent(name)}`);
	run(
		CURL,
		["-fL", "--retry", "3", "--retry-delay", "2", "-C", "-", "--max-time", "1800", "-o", dest, url],
		{ stdio: ["ignore", "ignore", "inherit"] },
	);

	const sha = createHash("sha256").update(readFileSync(dest)).digest("hex");
	return { path: dest, sizeBytes: statSync(dest).size, sha256: sha };
}

/** Mount a DMG, copy the .app out, unmount. Idempotent at the app level. */
export function installDmg(dmgPath, appName, { log = () => undefined } = {}) {
	const plist = run("/usr/bin/hdiutil", [
		"attach",
		dmgPath,
		"-nobrowse",
		"-noverify",
		"-noautoopen",
		"-plist",
	]);
	const mountPoint = /<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
	if (!mountPoint) throw new Error(`could not determine mount point for ${dmgPath}`);

	try {
		const src = join(mountPoint, appName);
		if (!existsSync(src)) {
			const contents = run("/bin/ls", ["-1", mountPoint]).trim().split("\n");
			throw new Error(
				`"${appName}" not found on the mounted image. Contents: ${contents.join(", ")}`,
			);
		}
		const dest = join(APPLICATIONS, appName);
		if (existsSync(dest)) {
			log(`  replacing existing ${appName}`);
			rmSync(dest, { recursive: true, force: true });
		}
		log(`  copying ${appName} → ${APPLICATIONS}`);
		cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
		return dest;
	} finally {
		try {
			run("/usr/bin/hdiutil", ["detach", mountPoint, "-quiet"]);
		} catch {
			run("/usr/bin/hdiutil", ["detach", mountPoint, "-force", "-quiet"]);
		}
	}
}

/**
 * Unpack an AppImage into a directory and return the executable inside it.
 *
 * Extracted rather than executed in place, which is the one choice here that needs defending.
 * An AppImage is a self-mounting squashfs and needs libfuse2 to run directly — a library Ubuntu
 * has not shipped by default since 22.04. Left as a bare `chmod +x && run`, every install would
 * appear to succeed and every *export* would die on "dlopen(): error loading libfuse.so.2",
 * which reads like an application fault rather than a missing system library. `--appimage-extract`
 * is built into the runtime itself, needs no FUSE and no root, and produces the same tree the
 * mount would have.
 */
export function installAppImage(
	imagePath,
	appName,
	{ log = () => undefined, version = null } = {},
) {
	const dest = join(LINUX_APP_ROOT, appName);
	// Extraction is not atomic and always writes ./squashfs-root relative to the working
	// directory, so it runs in a scratch directory beside the destination and is moved into
	// place only once it has completed. An interrupted install then leaves no half-tree that the
	// next `detect()` would report as installed.
	const staging = `${dest}.unpacking`;
	mkdirSync(staging, { recursive: true });
	rmSync(join(staging, "squashfs-root"), { recursive: true, force: true });
	chmodSync(imagePath, 0o755);
	log(`  extracting ${basename(imagePath)}`);
	try {
		execFileSync(imagePath, ["--appimage-extract"], {
			cwd: staging,
			stdio: ["ignore", "ignore", "pipe"],
			timeout: 10 * 60 * 1000,
			maxBuffer: 32 * 1024 * 1024,
		});
	} catch (e) {
		rmSync(staging, { recursive: true, force: true });
		throw new Error(
			`could not extract ${basename(imagePath)}: ${(e.stderr ?? e.message ?? "").toString().trim().slice(0, 300)}`,
		);
	}
	const root = join(staging, "squashfs-root");
	if (!existsSync(root)) {
		rmSync(staging, { recursive: true, force: true });
		throw new Error(`${basename(imagePath)} produced no squashfs-root`);
	}
	rmSync(dest, { recursive: true, force: true });
	mkdirSync(LINUX_APP_ROOT, { recursive: true });
	renameSync(root, dest);
	rmSync(staging, { recursive: true, force: true });
	// Electron trees carry their version in the asar, so this is a fallback rather than the only
	// source — but a build that ever ships without one should still report something.
	if (version) recordLinuxInstall(dest, version);
	return dest;
}

/**
 * Unpack a .deb into a directory and return the tree root.
 *
 * `dpkg-deb -x`, not `dpkg -i`: installing the package properly would need root, and this
 * harness takes none — a benchmark that requires sudo to install a competitor cannot be run by
 * most of the people whose results it wants. Extraction produces the same `usr/bin` the package
 * would have placed under /, and the driver looks for its CLI inside that tree.
 *
 * The package's `Depends:` are *not* installed, which is the trade. For Cap that is survivable
 * and checked rather than assumed: the dependencies are the desktop app's (webkit2gtk, gtk3,
 * appindicator), and `ldd` on the extracted cap-cli reports nothing missing on a stock Ubuntu.
 * A build that did need one would fail loudly on first launch with the library named.
 */
export function installDeb(debPath, appName, { log = () => undefined } = {}) {
	const dest = join(LINUX_APP_ROOT, appName);
	const staging = `${dest}.unpacking`;
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging, { recursive: true });
	log(`  extracting ${basename(debPath)}`);
	try {
		execFileSync("dpkg-deb", ["-x", debPath, staging], {
			stdio: ["ignore", "ignore", "pipe"],
			timeout: 10 * 60 * 1000,
			maxBuffer: 32 * 1024 * 1024,
		});
	} catch (e) {
		rmSync(staging, { recursive: true, force: true });
		throw new Error(
			`could not extract ${basename(debPath)}: ${(e.stderr ?? e.message ?? "").toString().trim().slice(0, 300)}. ` +
				"dpkg-deb comes with dpkg and is present on every Debian-family system; on others, " +
				"install it or point the driver at an existing Cap.",
		);
	}
	rmSync(dest, { recursive: true, force: true });
	mkdirSync(LINUX_APP_ROOT, { recursive: true });
	renameSync(staging, dest);
	// The control file is the only place this version exists; the payload does not carry it.
	recordLinuxInstall(dest, debControlField(debPath, "Version"));
	return dest;
}

/** One field out of a .deb's control file. */
function debControlField(debPath, field) {
	try {
		const out = run("dpkg-deb", ["-f", debPath, field], { stdio: ["ignore", "pipe", "ignore"] });
		return out.trim() || null;
	} catch {
		return null;
	}
}

/**
 * Note what was installed, beside what was installed.
 *
 * An unpacked tree need not carry a version anywhere — Cap's does not — so the one moment the
 * answer is known for certain is here, while the package it came from is still on disk.
 * `appVersion()` reads this back.
 */
function recordLinuxInstall(dest, version) {
	if (!version) return;
	try {
		writeFileSync(
			join(dest, LINUX_INSTALL_MARKER),
			`${JSON.stringify({ version, installedBy: "screen-recorder-benchmark" }, null, 2)}\n`,
		);
	} catch {
		/* a missing version is reported as "—"; it is not worth failing an install over */
	}
}

/**
 * Install one app from its registry spec. Returns a record detailed enough that another
 * machine can be checked against it — the whole point of pinning versions and hashes.
 */
export function installApp(spec, { cacheDir, force = false, log = () => undefined } = {}) {
	// On Windows an app is wherever its installer put it, so the driver resolves it; on macOS
	// it is always /Applications/<Name>.app. Linux has no system-wide convention that works
	// without root, so the harness owns the location and the driver looks there.
	const destApp = IS_WIN
		? (spec.resolve?.() ?? null)
		: IS_LINUX
			? (spec.resolve?.() ?? null)
			: join(APPLICATIONS, spec.appName);
	if (destApp && existsSync(destApp) && !force) {
		return {
			id: spec.id,
			status: "already-installed",
			appPath: destApp,
			version: appVersion(destApp),
			codesign: codesignStatus(destApp),
		};
	}

	// winget, which the registry has declared since Recordly was added and nothing here
	// implemented: the spec fell through to the download path, which fetched the vendor's
	// *releases page* as though it were an installer and failed on "expected an .exe or .msi".
	// It installs per-user, needs no elevation, and verifies the package hash itself.
	if (spec.method === "winget") {
		log(`  winget install ${spec.id}`);
		const res = spawnSync(
			"winget",
			[
				"install",
				"--id",
				spec.id,
				"--exact",
				"--silent",
				"--accept-package-agreements",
				"--accept-source-agreements",
			],
			{ encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 20 * 60 * 1000 },
		);
		// Already-installed is exit 0 with a notice, but a no-op upgrade reports its own code;
		// the resolver below is what decides whether the app is actually there.
		const appPath = spec.resolve?.() ?? null;
		if (!appPath) {
			throw new Error(
				`winget install ${spec.id} did not leave ${spec.appName} where the driver looks for it. ` +
					`${(res.stderr || res.stdout || "").trim().split("\n").pop() ?? ""}`.trim(),
			);
		}
		return {
			id: spec.id,
			status: "installed",
			appPath,
			version: appVersion(appPath),
			sourceUrl: `winget:${spec.id}`,
			codesign: codesignStatus(appPath),
		};
	}

	let url = spec.url;
	let pinnedVersion = spec.version ?? null;
	if (spec.method === "page") {
		const found = resolveFromPage(spec.page, spec.assetPattern);
		url = found.url;
		pinnedVersion = found.version;
		log(`  resolved ${spec.page} → ${found.version ?? "current"}`);
	}
	if (spec.method === "github-release") {
		const asset = resolveGithubAsset(spec.repo, spec.assetPattern);
		url = asset.url;
		pinnedVersion = asset.version;
		log(`  resolved ${spec.repo} → ${asset.version} (${asset.name})`);
	}

	// What the registry says it is, for the case where the redirect lands on something with no
	// extension to read.
	const EXTENSION_FOR = {
		deb: ".deb",
		appimage: ".AppImage",
		dmg: ".dmg",
		exe: ".exe",
		msi: ".msi",
	};
	const dl = download(url, cacheDir, { log, extension: EXTENSION_FOR[spec.method] ?? null });

	let appPath;
	if (IS_WIN) {
		if (!/\.(exe|msi)$/i.test(dl.path)) {
			throw new Error(`expected an .exe or .msi installer; got ${basename(dl.path)}`);
		}
		runWindowsInstaller(dl.path, spec, { log });
		appPath = spec.resolve ? spec.resolve() : null;
		if (!appPath) {
			throw new Error(
				`${spec.appName} installed but its executable was not found where expected. ` +
					"Add the real path to the driver's winPaths list.",
			);
		}
	} else if (IS_LINUX) {
		// Both forms are unpacked into a directory this harness owns rather than installed
		// system-wide, so neither needs root.
		if (/\.appimage$/i.test(dl.path)) {
			installAppImage(dl.path, spec.appName, { log, version: pinnedVersion });
		} else if (/\.deb$/i.test(dl.path)) {
			installDeb(dl.path, spec.appName, { log });
		} else {
			throw new Error(
				`only .AppImage and .deb installs are automated on Linux; got ${basename(dl.path)}.`,
			);
		}
		// The driver owns the path to the launchable binary inside the extracted tree — the tree
		// root is a directory, and what runs is one file within it whose name only the driver knows.
		appPath = spec.resolve ? spec.resolve() : null;
		if (!appPath) {
			throw new Error(
				`${spec.appName} extracted but its executable was not found where expected. ` +
					"Add the real path to the driver's linuxPaths list.",
			);
		}
	} else {
		if (!/\.dmg$/i.test(dl.path)) {
			throw new Error(`only .dmg installs are automated on macOS; got ${basename(dl.path)}`);
		}
		appPath = installDmg(dl.path, spec.appName, { log });
	}

	return {
		id: spec.id,
		status: "installed",
		appPath,
		version: appVersion(appPath),
		pinnedVersion,
		sourceUrl: url,
		downloadSha256: dl.sha256,
		downloadBytes: dl.sizeBytes,
		codesign: codesignStatus(appPath),
	};
}
