#!/usr/bin/env node
/**
 * Schema-check every submission, and apply the two rules the schema cannot express.
 *
 * Rejection is only ever for form: a malformed file, fewer than two verified tools, or footage
 * nobody else can obtain. Never for a number being unflattering to any tool — including the one
 * this benchmark's author maintains.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH_ROOT } from "../lib/env.mjs";
import { collectSubmissions } from "../lib/submission.mjs";

const schema = JSON.parse(
	readFileSync(join(BENCH_ROOT, "schema", "submission.schema.json"), "utf8"),
);
const subs = collectSubmissions(BENCH_ROOT);
const problems = [];

/** Enough of draft 2020-12 for this schema — a dependency here would be more surface than value. */
function validate(node, sch, path = "") {
	const out = [];
	const type = Array.isArray(sch.type) ? sch.type : sch.type ? [sch.type] : null;
	const is = (t) =>
		t === "array"
			? Array.isArray(node)
			: t === "null"
				? node === null
				: t === "integer"
					? Number.isInteger(node)
					: t === "object"
						? node && typeof node === "object" && !Array.isArray(node)
						: typeof node === t;
	if (sch.const !== undefined && node !== sch.const) out.push(`${path}: expected ${sch.const}`);
	if (sch.enum && !sch.enum.includes(node))
		out.push(`${path}: ${JSON.stringify(node)} not one of ${sch.enum.join(", ")}`);
	if (type && node !== undefined && !type.some(is))
		out.push(
			`${path}: expected ${type.join("|")}, got ${Array.isArray(node) ? "array" : node === null ? "null" : typeof node}`,
		);
	if (sch.required && node && typeof node === "object") {
		for (const k of sch.required) if (node[k] === undefined) out.push(`${path}: missing "${k}"`);
	}
	if (sch.properties && node && typeof node === "object" && !Array.isArray(node)) {
		for (const [k, sub] of Object.entries(sch.properties)) {
			if (node[k] !== undefined) out.push(...validate(node[k], sub, `${path}.${k}`));
		}
		if (sch.additionalProperties === false) {
			for (const k of Object.keys(node)) {
				if (!sch.properties[k] && !k.startsWith("_")) out.push(`${path}: unexpected "${k}"`);
			}
		}
	}
	if (sch.items && Array.isArray(node)) {
		node.forEach((v, i) => out.push(...validate(v, sch.items, `${path}[${i}]`)));
	}
	if (sch.minItems != null && Array.isArray(node) && node.length < sch.minItems) {
		out.push(`${path}: needs at least ${sch.minItems} entries, has ${node.length}`);
	}
	if (sch.minimum != null && typeof node === "number" && node < sch.minimum)
		out.push(`${path}: below ${sch.minimum}`);
	if (sch.maximum != null && typeof node === "number" && node > sch.maximum)
		out.push(`${path}: above ${sch.maximum}`);
	return out;
}

for (const sub of subs) {
	const where = sub._path.replace(`${BENCH_ROOT}/`, "");
	const { _path, ...clean } = sub;
	for (const e of validate(clean, schema, where)) problems.push(e);

	const verified = (clean.measurements ?? []).filter((m) => m.verified && m.localFloorMs);
	if (verified.length < 2) {
		problems.push(
			`${where}: ${verified.length} verified tool(s) with a local floor — a submission needs two to contribute a ratio`,
		);
	}
	if (clean.source?.kind === "public-bundle" && !clean.source.downloadSha256) {
		problems.push(
			`${where}: public-bundle source without a downloadSha256 — nothing proves which footage was measured`,
		);
	}
	if (clean.source?.kind === "recording") {
		console.warn(
			`· ${where}: local recording — kept as a worked example, not counted in the aggregate`,
		);
	}
}

if (problems.length) {
	console.error(`\n${problems.length} problem(s):`);
	for (const p of problems) console.error(`  ✗ ${p}`);
	process.exit(1);
}
console.log(`✓ ${subs.length} submission(s) valid`);
