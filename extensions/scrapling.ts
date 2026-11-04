/**
 * pi-scrapling — register the Scrapling MCP server.
 *
 * Pi packages cannot ship `mcp.json` entries, so this extension registers the
 * server for the current session instead. A `scrapling` entry in `mcp.json`
 * takes precedence and shows as an override in `/mcp`.
 *
 * Resolution order for the binary (first hit wins):
 *   1. `SCRAPLING_MCP_COMMAND` env var (full path or command name).
 *   2. `scrapling-mcp` on `PATH` (the upstream install style).
 *   3. `SCRAPLING_MCP_VENV_DIR` env var → `<venv>/bin/scrapling-mcp`
 *      (`Scripts\\scrapling-mcp.exe` on Windows).
 *   4. The `pi-scrapling` config file at the user's config dir
 *      (`$XDG_CONFIG_HOME/pi-scrapling/config.json` on POSIX,
 *      `%APPDATA%/pi-scrapling/config.json` on Windows), which `install`
 *      writes to remember the chosen `--venv-dir`.
 *   5. Canonical default venv locations:
 *      `~/.venvs/scrapling`, `~/venvs/scrapling`, `./.venv`, `./venv`
 *      (Scripts on Windows).
 *
 * Anything beyond (1) and (2) resolves to a full path so MCP doesn't depend
 * on the user's `PATH` containing the venv bin dir.
 *
 * When no candidate resolves, the server is registered **disabled** and a
 * one-line warning fires at session_start so the gap is visible instead of
 * failing every connection attempt.
 */

import { accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configFilePath } from "../scripts/platform-paths.mjs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SERVER_NAME = "scrapling";
const DEFAULT_COMMAND = "scrapling-mcp";
const DESCRIPTION =
	"Scrapling MCP server — fetch, parse, and crawl websites. Exposes 16 tools for " +
	"HTTP requests, stealth browser sessions, page snapshots, screenshots, browser " +
	"actions, saved login state, Cloudflare Turnstile bypass, and adaptive parsing.";

const INSTALL_HINT =
	'Run `pi-scrapling install` (or `pip install "scrapling[all]" && scrapling install --force`).';

/** Locate an executable without starting it. */
async function isAvailable(pi: ExtensionAPI, command: string): Promise<boolean> {
	const looksLikePath = command.includes("/") || command.includes("\\");
	if (looksLikePath) {
		try {
			accessSync(command, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	}

	const locator = process.platform === "win32" ? "where" : "which";
	try {
		const { code } = await pi.exec(locator, [command], { timeout: 5_000 });
		return code === 0;
	} catch {
		return false;
	}
}

function venvBinaryPath(venvDir: string): string {
	const binDir =
		process.platform === "win32" ? join(venvDir, "Scripts") : join(venvDir, "bin");
	return process.platform === "win32"
		? join(binDir, "scrapling-mcp.exe")
		: join(binDir, "scrapling-mcp");
}

function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
	return p;
}

function readConfigVenv(): string | null {
	try {
		const raw = readFileSync(configFilePath(), "utf8");
		const parsed = JSON.parse(raw) as { venv?: unknown };
		if (typeof parsed.venv === "string" && parsed.venv.trim()) {
			return expandHome(parsed.venv.trim());
		}
	} catch {
		// Missing or malformed — fall through to defaults.
	}
	return null;
}

function defaultVenvDirs(): string[] {
	const home = homedir();
	const cwd = process.cwd();
	return [
		join(home, ".venvs", "scrapling"),
		join(home, "venvs", "scrapling"),
		join(cwd, ".venv"),
		join(cwd, "venv"),
	];
}

async function resolveCommand(
	pi: ExtensionAPI,
): Promise<{ command: string; available: boolean }> {
	// 1. Explicit override wins.
	const envOverride = process.env.SCRAPLING_MCP_COMMAND?.trim();
	if (envOverride) {
		return { command: envOverride, available: await isAvailable(pi, envOverride) };
	}

	// 2. Bare command name on `PATH` (the upstream install style).
	if (await isAvailable(pi, DEFAULT_COMMAND)) {
		return { command: DEFAULT_COMMAND, available: true };
	}

	// 3-5. Build the fallback candidate list of full venv bin paths. The first
	// executable we can stat as X_OK wins, and we register that absolute path
	// so MCP doesn't depend on whatever PATH happens to contain.
	const candidates: string[] = [];

	// 3. SCRAPLING_MCP_VENV_DIR escape hatch.
	const envVenv = process.env.SCRAPLING_MCP_VENV_DIR?.trim();
	if (envVenv) candidates.push(venvBinaryPath(expandHome(envVenv)));

	// 4. Config-file remembered venv.
	const cfgVenv = readConfigVenv();
	if (cfgVenv) candidates.push(venvBinaryPath(cfgVenv));

	// 5. Canonical defaults (~/.venvs/scrapling, ./venv, …).
	for (const v of defaultVenvDirs()) {
		candidates.push(venvBinaryPath(v));
	}

	for (const candidate of candidates) {
		try {
			accessSync(candidate, constants.X_OK);
			return { command: candidate, available: true };
		} catch {
			/* try next */
		}
	}

	// Nothing found — keep the bare name so the warning identifies the upstream
	// install unit. The user can still set SCRAPLING_MCP_COMMAND or fix PATH.
	return { command: DEFAULT_COMMAND, available: false };
}

export default async function (pi: ExtensionAPI) {
	const { command, available } = await resolveCommand(pi);

	pi.registerMcpServer(SERVER_NAME, {
		command,
		// Expose the scraper tools to the model directly rather than only through
		// codemode scripts; scraping is a first-class action for this package.
		exposure: "direct",
		enabled: available,
		description: available
			? DESCRIPTION
			: `${DESCRIPTION} Not connected: \`${command}\` was not found. ${INSTALL_HINT} — or set SCRAPLING_MCP_COMMAND to the binary's path.`,
	});

	if (!available) {
		pi.on("session_start", async (_event, ctx) => {
			ctx.ui.notify(
				`Scrapling MCP is configured but \`${command}\` was not found. ${INSTALL_HINT}`,
				"warning",
			);
		});
	}
}
