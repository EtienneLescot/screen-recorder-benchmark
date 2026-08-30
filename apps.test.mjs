import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APPS, installPlan } from "./apps.mjs";
import { loadRoster } from "./lib/site.mjs";

/**
 * A vendor ships one product per platform, from different URLs, by different mechanisms. The
 * registry held one spec per entry, so it described whichever platform was written first — and
 * `install` on the other one fetched a build it could not run.
 */
describe("installPlan describes the platform it is asked about", () => {
	const on = (platform, ids) =>
		Object.fromEntries(installPlan(ids, { platform }).map((p) => [p.app, p]));

	it("sends each platform to its own build of Cap", () => {
		expect(on("darwin", ["cap"]).cap).toMatchObject({
			method: "dmg",
			url: "https://cap.so/download/apple-silicon",
			appName: "Cap.app",
		});
		expect(on("win32", ["cap"]).cap).toMatchObject({
			method: "exe",
			url: "https://cap.so/download/windows",
			appName: "Cap.exe",
		});
	});

	/** The release publishes a .exe.blockmap beside the installer; it must not match first. */
	it("picks the Windows installer out of a release that also ships macOS and Linux builds", () => {
		const p = on("win32", ["openscreen-cli"])["openscreen-cli"];
		expect("Openscreen.Setup.1.10.0.exe").toMatch(p.assetPattern);
		expect("Openscreen.Setup.1.10.0.exe.blockmap").not.toMatch(p.assetPattern);
		expect("Openscreen-macOS-Apple-Silicon-1.10.0.dmg").not.toMatch(p.assetPattern);
		expect("Openscreen-macOS-Apple-Silicon-1.10.0.dmg").toMatch(
			on("darwin", ["openscreen-cli"])["openscreen-cli"].assetPattern,
		);
	});

	/**
	 * Recordly installs by winget on Windows and from a dmg on macOS. Held as one spec, the macOS
	 * plan named a winget package and offered the vendor's releases *page* as the download.
	 */
	it("does not offer a winget package to macOS", () => {
		expect(on("win32", ["recordly"]).recordly).toMatchObject({
			method: "winget",
			id: "Webadderall.Recordly",
		});
		const mac = on("darwin", ["recordly"]).recordly;
		expect(mac.method).toBe("dmg");
		expect(mac.url).toMatch(/\.dmg$/);
		expect(mac.appName).toBe("Recordly.app");
	});

	it("keeps a single-platform entry flat", () => {
		expect(on("darwin", ["screen-studio"])["screen-studio"]).toMatchObject({ method: "page" });
	});

	it("gives Linux the AppImage, which is the only build that installs without root", () => {
		expect(on("linux", ["openscreen-cli"])["openscreen-cli"]).toMatchObject({
			method: "github-release",
			appName: "Openscreen",
		});
		const p = on("linux", ["openscreen-cli"])["openscreen-cli"].assetPattern;
		expect("Openscreen-Linux-1.10.0.AppImage").toMatch(p);
		// The same release ships three packaged formats, and every one of them wants a root install.
		for (const other of [
			"Openscreen-Linux-1.10.0.deb",
			"Openscreen-Linux-1.10.0.rpm",
			"Openscreen-Linux-1.10.0.pacman",
			"Openscreen.Setup.1.10.0.exe",
		]) {
			expect(other).not.toMatch(p);
		}
		expect(on("linux", ["recordly"]).recordly).toMatchObject({
			method: "github-release",
			repo: "webadderallorg/Recordly",
		});
		expect("Recordly-linux-x64.AppImage").toMatch(on("linux", ["recordly"]).recordly.assetPattern);
		expect("Recordly-windows-x64.exe").not.toMatch(on("linux", ["recordly"]).recordly.assetPattern);
	});
});

/**
 * The registry and the roster describe the same membership from two directions, and only the
 * roster was ever checked. An entry whose `driver` is a bare string claims every platform, which
 * is a statement about the *product*: Cap carried one, so `bench.mjs apps` on Linux reported it
 * as merely "not installed" — an invitation to install a build its vendor does not make — while
 * roster.json had always said `"linux": "n/a"`. Nothing compared the two.
 */
describe("the registry does not claim a platform the roster denies", () => {
	const roster = loadRoster(dirname(fileURLToPath(import.meta.url)));
	const PLATFORMS = [
		["darwin", "macos"],
		["win32", "windows"],
		["linux", "linux"],
	];

	for (const [id, entry] of Object.entries(APPS)) {
		// `ffmpeg-baseline` is the unit rather than a candidate and carries no roster row.
		if (!entry.roster) continue;
		it(`${id} is only driven where ${entry.roster} exists`, () => {
			const row = roster.find((t) => t.tool === entry.roster);
			expect(row, `${id} names a roster tool that does not exist`).toBeDefined();
			for (const [platform, key] of PLATFORMS) {
				const driven = typeof entry.driver === "string" || !!entry.driver?.[platform];
				if (row[key] === "n/a") {
					expect(
						driven,
						`${id} declares a ${platform} driver but ${entry.roster} is n/a there`,
					).toBe(false);
				}
			}
		});
	}
});
