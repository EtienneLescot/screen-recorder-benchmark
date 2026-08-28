/**
 * The registry: which tools are in the benchmark, where each comes from, and what it costs to
 * obtain.
 *
 * Membership follows roster.json, which is decided by what a tool is *for* — turning a screen
 * recording into a finished demo — not by which adapters happen to exist. General-purpose
 * editors and plain recorders are out even when they can be driven. Each entry below names the
 * roster tool it implements via `roster:`, and CANDIDATES.md's status table is generated from
 * that join, so no list of tools is maintained by hand in two places.
 *
 * `ffmpeg-baseline` carries no `roster:` — it is the unit, not a candidate.
 *
 * Separate from the drivers on purpose — `preflight` has to be able to show the user the whole
 * download list, with sizes and licence terms, and get one approval for all of it *before*
 * anything is fetched. Everything after that approval runs unattended.
 */

/**
 * Download URLs are pinned to a version wherever the vendor exposes one, because "latest"
 * makes a benchmark unreproducible: two machines run a month apart would measure two products.
 * `bench.mjs refresh-urls` re-resolves them and prints the diff.
 */
export const APPS = {
	"openscreen-cli": {
		roster: "OpenScreen",
		driver: "./drivers/openscreen-cli.mjs",
		default: true,
		install: {
			method: "github-release",
			repo: "getopenscreen/openscreen",
			assetPattern: /macOS-Apple-Silicon.*\.dmg$/i,
			appName: "Openscreen.app",
			approxMB: 250,
			licence: "MIT — free, no account, no watermark",
		},
	},
	"openscreen-gui": {
		roster: "OpenScreen",
		// macOS only for now, and said so here rather than discovered at runtime. The adapter
		// reaches the editor over CDP on either platform, but the two native surfaces on the path —
		// the File menu and the save panel — go through System Events. On Windows the leg died
		// with "spawnSync /usr/bin/osascript ENOENT" after `bench.mjs apps` had called it ready,
		// because readiness only ever checked that the binary existed. Porting it means replacing
		// those two steps with lib/uiWindows.mjs, the way drivers/recordly.mjs uses fileDialogTo.
		driver: { darwin: "./drivers/openscreen-gui.mjs" },
		default: true,
		sharesInstallWith: "openscreen-cli",
	},
	"screen-studio": {
		roster: "Screen Studio",
		blocker: "export requires an activated licence — there is no trial export",
		// Off by default: export is licence-gated, so an unactivated machine would only ever
		// record a failure. Enable it explicitly once a licence is activated.
		// macOS only, and export is licence-gated even there.
		driver: { darwin: "./drivers/screen-studio.mjs" },
		default: false,
		install: {
			// Resolved from the vendor's page at install time, not pinned: a hard-coded URL keeps
			// installing an old build long after the vendor has moved on, and does it silently.
			method: "page",
			page: "https://screen.studio/download",
			assetPattern: /https:\/\/screenstudioassets\.com\/releases\/[^"' ]*Apple%20Silicon\.dmg/,
			appName: "Screen Studio.app",
			approxMB: 349,
			licence: "commercial — trial exports carry a watermark (which does not change render time)",
			notes: [
				"No CLI and no scripting dictionary; only screen-studio://record-* deeplinks exist, none for export.",
			],
		},
	},
	recordly: {
		roster: "Recordly",
		driver: "./drivers/recordly.mjs",
		default: true,
		install: {
			// Windows installs per-user through winget — no elevation, no interactive installer.
			// macOS takes the signed dmg below; the two are listed together rather than split
			// because installPlan reads one spec per entry.
			method: "winget",
			id: "Webadderall.Recordly",
			url: "https://github.com/webadderallorg/Recordly/releases",
			macUrl:
				"https://github.com/webadderallorg/Recordly/releases/download/v1.3.3/Recordly-arm64.dmg",
			appName: "Recordly.exe",
			macAppName: "Recordly.app",
			approxMB: 201,
			licence: "AGPL-3.0 — free, no account or activation needed",
			notes: [
				"Official repository is webadderallorg/Recordly; a swarm of same-named forks exists, so pin the org.",
				"macOS build is signed by Fido Tech (54QUWA9PZA).",
			],
		},
	},
	"recordly-cuda": {
		roster: "Recordly",
		driver: "./drivers/recordly-cuda.mjs",
		// Off by default: the CUDA path is shipped disabled and marked Experimental in the
		// product, so the default row has to be the one a fresh install produces. Enable this
		// explicitly to measure the other side of the toggle — as a separate row, never averaged
		// with the first.
		default: false,
		sharesInstallWith: "recordly",
	},
	cap: {
		roster: "Cap",
		driver: "./drivers/cap.mjs",
		default: true,
		install: {
			method: "dmg",
			url: "https://cap.so/download/apple-silicon",
			appName: "Cap.app",
			approxMB: 123,
			licence: "AGPL-3.0 — free; signing in is optional and not needed for a local export",
			notes: [
				"Ships a real CLI at Cap.app/Contents/MacOS/cap-cli — `cap export` renders a .cap project.",
			],
		},
	},
	focusee: {
		roster: "FocuSee",
		blocker:
			"the macOS build rejects every MP4 — format, profile, frame rate, resolution, audio and location all ruled out; it opens only its own recordings. Windows untested",
		driver: { darwin: "./drivers/focusee.mjs", win32: "./drivers/focusee-win.mjs" },
		// On macOS the import is broken in 2.4.1 (see drivers/focusee.mjs); on Windows the
		// vendor ships the real application rather than a downloader stub, so it is in the
		// default set there.
		default: process.platform === "win32",
		install: {
			method: "manual",
			url: "https://focusee.imobie.com/go/download.php?product=fs",
			appName: "FocuSee.app",
			approxMB: 5,
			licence: "commercial — trial exports are watermarked",
			notes: ["The vendor ships a GUI installer stub; run it once during preflight."],
		},
	},
	"ffmpeg-baseline": {
		driver: "./drivers/ffmpeg-baseline.mjs",
		default: true,
		install: null,
	},
};

/**
 * What this machine can actually measure, and why anything is unavailable.
 *
 * Three separate questions, kept separate because conflating them is how a benchmark ends up
 * reporting "slow" when it means "not installed": is there an adapter for this platform, is the
 * application present, and is there anything blocking it from exporting.
 */
export async function surveyApps({ platform = process.platform } = {}) {
	const rows = [];
	for (const [id, entry] of Object.entries(APPS)) {
		const supported = typeof entry.driver === "string" || !!entry.driver?.[platform];
		if (!supported) {
			rows.push({ id, supported: false, installed: false, reason: `no adapter for ${platform}` });
			continue;
		}
		let driver;
		try {
			driver = await loadDriver(id);
		} catch (e) {
			rows.push({
				id,
				supported: true,
				installed: false,
				reason: `adapter failed to load: ${e.message.split("\n")[0]}`,
			});
			continue;
		}
		const det = driver.detect();
		rows.push({
			id,
			name: driver.displayName,
			supported: true,
			installed: det.installed,
			version: det.version,
			isDefault: !!entry.default,
			automation: driver.automation,
			blocker: entry.blocker ?? null,
			// The floor is not optional — without it nothing is comparable across machines — so
			// its absence needs a fix, not a status.
			reason: det.installed ? null : (det.error ?? "not installed"),
		});
	}
	return rows;
}

export async function loadDriver(id) {
	const entry = APPS[id];
	if (!entry) throw new Error(`Unknown app "${id}". Known: ${Object.keys(APPS).join(", ")}`);
	const mod = await import(driverPath(entry, id));
	return mod.default;
}

/** Apps that can run at all on this platform — the default set is filtered through this. */
export function availableOn(platform = process.platform) {
	return Object.entries(APPS)
		.filter(([, a]) => typeof a.driver === "string" || !!a.driver?.[platform])
		.map(([id]) => id);
}

/** Every distinct thing that has to be downloaded for the given app ids. */
export function installPlan(appIds) {
	const seen = new Set();
	const plan = [];
	for (const id of appIds) {
		const entry = APPS[id];
		if (!entry) continue;
		const target = entry.sharesInstallWith ?? id;
		if (seen.has(target)) continue;
		seen.add(target);
		const spec = (APPS[target] ?? entry).install;
		// `app` is the benchmark's id for the entry; `id` stays whatever the install spec sets,
		// because for a winget entry that is the package id installApp needs. The spread used to
		// clobber the entry id silently — plan rows for Recordly came back as
		// "Webadderall.Recordly", so anything looking the driver up by it found nothing.
		if (spec) plan.push({ app: target, id: target, ...spec });
	}
	return plan;
}

export const DEFAULT_APPS = Object.entries(APPS)
	.filter(([id, a]) => a.default && availableOn().includes(id))
	.map(([id]) => id);

/** Which driver file implements this app on this platform. */
function driverPath(entry, id) {
	if (typeof entry.driver === "string") return entry.driver;
	const p = entry.driver?.[process.platform];
	if (!p) {
		throw new Error(
			`"${id}" has no driver for ${process.platform}. Supported: ${Object.keys(entry.driver ?? {}).join(", ") || "none"}.`,
		);
	}
	return p;
}
