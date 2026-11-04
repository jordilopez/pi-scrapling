// Shared JSON IO + log helpers for scripts/cli.mjs and scripts/dev-prune-mcp.mjs.
// Extracted so the two scripts cannot drift on retry semantics, log format, or
// file-handling policy.

import { copyFileSync, readFileSync, writeFileSync } from "node:fs";

export function readJsonOrNull(path) {
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
	} catch {
		/* unreadable / non-JSON */
	}
	return null;
}

export function writeJsonPreservingNewlines(path, value) {
	const body = JSON.stringify(value, null, 2);
	writeFileSync(path, (body.endsWith("\n") ? body : body + "\n"));
}

// Pre-rewrite backup: copies the existing JSON file to a timestamped sibling
// `<path>.bak.<UTC>` so past snapshots survive a second rewrite. Returns
// `{ ok: true, path }` on success; `{ ok: false, err }` when the source is
// unreadable. Callers MUST inspect `.ok` before mutating the target — a
// "you can always revert from .bak" claim is only true when the backup
// actually wrote.
export function backupJson(path) {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const dest = `${path}.bak.${stamp}`;
	try {
		copyFileSync(path, dest);
		return { ok: true, path: dest };
	} catch (e) {
		return { ok: false, err: e instanceof Error ? e.message : String(e) };
	}
}

// ANSI log helpers; colours only when stdout is a TTY.
const tty = process.stdout.isTTY;
export const C = tty
	? { dim: "\x1b[2m", bold: "\x1b[1m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", blue: "\x1b[34m", reset: "\x1b[0m" }
	: { dim: "", bold: "", green: "", red: "", yellow: "", blue: "", reset: "" };

export const ok = (msg) => `${C.green}\u2713${C.reset} ${msg}`;
export const warn = (msg) => `${C.yellow}!${C.reset} ${msg}`;
export const err = (msg) => `${C.red}\u2717${C.reset} ${msg}`;
export const step = (msg) => `${C.blue}\u2192${C.reset} ${msg}`;
export const note = (msg) => `${C.dim}  ${msg}${C.reset}`;
