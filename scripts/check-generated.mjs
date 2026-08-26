/**
 * Fail if regenerating the derived files would change them.
 *
 * Comparing against HEAD instead would fire every time you regenerate before committing —
 * exactly when the tree is correct. What actually matters is whether the committed output
 * still matches its inputs, and that is what running the generators and diffing the bytes
 * answers, on a clean checkout in CI and on a dirty one locally alike.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = ["CREDITS.md", "CANDIDATES.md", "docs"];

const digest = (p) => {
	const abs = join(ROOT, p);
	if (statSync(abs).isDirectory()) {
		return readdirSync(abs)
			.sort()
			.map((f) => `${f}:${digest(join(p, f))}`)
			.join("|");
	}
	return createHash("sha256").update(readFileSync(abs)).digest("hex");
};

const before = Object.fromEntries(TARGETS.map((t) => [t, digest(t)]));
for (const cmd of ["site", "credits", "roster"]) {
	execFileSync(process.execPath, [join(ROOT, "bench.mjs"), cmd], { cwd: ROOT, stdio: "ignore" });
}
const stale = TARGETS.filter((t) => digest(t) !== before[t]);

if (stale.length) {
	console.error(
		`\n${stale.join(" and ")} did not match ${stale.length > 1 ? "their" : "its"} inputs — ` +
			"regenerated in place. Commit the result.\n",
	);
	process.exit(1);
}
console.log(`generated output matches its inputs (${TARGETS.join(", ")})`);
