#!/usr/bin/env node
// Maintainer-only: prune orphan override fragments from <pkg>/.pi/mcp.json.
//
// The project's `.pi/mcp.json` is a Pi runtime overlay that gets
// written into the package directory on `pi install`. In dev checkouts
// of this repo, session toggles (e.g. `pi mcp set scrapling enabled false`)
// can leave behind override-only entries that lack `command`, `url`, or
// `type` and therefore cannot stand alone at runtime. This script strips
// such fragments after taking a `<path>.bak.<UTC>` snapshot.
//
// End users running a global `npm install -g pi-scrapling` will never have
// this file; this script is intentionally not exposed as a CLI subcommand.
// Run via:
//
//   npm run dev:prune-mcp              # dry-run if a HYGIENE=plan env var is set
//   npm run dev:prune-mcp -- --dry-run
//
// Always prints a backup notice and refuses to write if the backup fails.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { backupJson, readJsonOrNull, writeJsonPreservingNewlines, C, ok, warn, err, note, step } from "./mcp-json.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..");
const MCP_PATH = join(PKG_ROOT, ".pi", "mcp.json");

const dryRun = process.argv.includes("--dry-run");
const plan = dryRun || process.env.HYGIENE === "plan";

// Pi's per-overlay mcp tweak knobs (extensions/scrapling.ts writes
// `exposure`; the user can toggle `enabled`). If Pi renames or adds
// fields, this list is the place to update.
const ORPHAN_OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"];

function main() {
	if (!existsSync(MCP_PATH)) {
		console.log(note(`No <pkg>/.pi/mcp.json at ${MCP_PATH}; nothing to prune.`));
		return;
	}
	const parsed = readJsonOrNull(MCP_PATH);
	if (!parsed || typeof parsed.mcpServers !== "object") {
		console.log(err(`${MCP_PATH} is missing mcpServers; leaving untouched.`));
		process.exitCode = 1;
		return;
	}
	const entry = parsed.mcpServers.scrapling;
	if (!entry || typeof entry !== "object") {
		console.log(note(`No scrapling entry in ${MCP_PATH}; nothing to prune.`));
		return;
	}
	if (entry.command !== undefined || entry.url !== undefined || entry.type !== undefined) {
		console.log(note(`scrapling entry has command/url/type; not an orphan fragment. Leaving untouched.`));
		return;
	}
	const keys = Object.keys(entry);
	const isOrphan = keys.length === 0 || keys.every((k) => ORPHAN_OVERRIDE_KEYS.includes(k));
	if (!isOrphan) {
		console.log(warn(`scrapling entry has unknown keys (${keys.join(", ")}); refusing to prune unknown schema.`));
		process.exitCode = 1;
		return;
	}

	if (plan) {
		console.log(step(`Would prune override-only scrapling entry from ${MCP_PATH} ${C.dim}(keys: ${keys.join(", ") || "<empty>"})${C.reset}`));
		console.log(note(`Backup target: ${MCP_PATH}.bak.<UTC>`));
		return;
	}

	const backup = backupJson(MCP_PATH);
	if (!backup.ok) {
		console.log(err(`Backup failed; ${MCP_PATH} left unchanged. Reason: ${backup.err}`));
		process.exitCode = 1;
		return;
	}
	delete parsed.mcpServers.scrapling;
	if (Object.keys(parsed.mcpServers).length === 0) delete parsed.mcpServers;
	writeJsonPreservingNewlines(MCP_PATH, parsed);
	console.log(ok(`Pruned orphan override at ${MCP_PATH}`));
	console.log(note(`Backup of previous file at ${backup.path}`));
}

main();
