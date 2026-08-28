import { describe, expect, it } from "vitest";
import { installPlan } from "./apps.mjs";

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
});
