/**
 * A real mouse click, for controls that ignore a synthetic one.
 *
 * System Events' `click at {x, y}` posts a synthetic event. An app drawing its own controls can
 * ignore it entirely — no reaction, no error, nothing to tell "the click missed" from "the app
 * refused". FocuSee's import drop zone behaves exactly that way, and it cost this benchmark a
 * candidate: the import was recorded as broken when it worked on the first real click.
 *
 * The helper is a few lines of C against ApplicationServices, compiled on first use into the work
 * directory. clang ships with the Command Line Tools this benchmark already requires.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WORK_DIR } from "./env.mjs";
import { IS_MAC } from "./platform.mjs";

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), "hidClick.c");
const BINARY = join(WORK_DIR, "tools", "hid-click");

/** Compile once, and again whenever the source is newer than what was built. */
function ensureBuilt() {
	if (!IS_MAC) throw new Error("hidClick is macOS-only; Windows drivers use SendInput equivalents");
	const fresh = existsSync(BINARY) && statSync(BINARY).mtimeMs >= statSync(SOURCE).mtimeMs;
	if (fresh) return BINARY;
	mkdirSync(dirname(BINARY), { recursive: true });
	execFileSync("/usr/bin/clang", [
		"-O2",
		"-o",
		BINARY,
		SOURCE,
		"-framework",
		"ApplicationServices",
	]);
	return BINARY;
}

/** Click at a screen point, in points — the same space the accessibility API reports. */
export function hidClick(x, y) {
	execFileSync(ensureBuilt(), [String(Math.round(x)), String(Math.round(y))]);
}

/** Press at one point, drag to another, release. */
export function hidDrag(x1, y1, x2, y2) {
	execFileSync(
		ensureBuilt(),
		[x1, y1, x2, y2].map((n) => String(Math.round(n))),
	);
}
