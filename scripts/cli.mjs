#!/usr/bin/env node
// pi-scrapling setup CLI.
//
// Subcommands: install | update | remove | doctor
//
// Flags (full list lives in this file's `usage()` block, surfaced by --help):
//   Subcommand-agnostic:        --source, --venv-dir, --yes, -h, --help
//   install / update only:      --skip-browser
//   install / update / remove:  --reconcile-user-mcp
//   remove only:                --purge-venv
//
// Resolves its own package root via import.meta.url so the same code works
// from a checkout (`node scripts/cli.mjs ...`) and from an npm bin install
// (`pi-scrapling ...`). Shares configFilePath(), backupJson(), and the JSON
// + log helpers via ./platform-paths.mjs and ./mcp-json.mjs.

import {
	spawn,
	execFileSync,
} from "node:child_process";
import {
	existsSync,
	readFileSync,
	rmSync,
	mkdirSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, basename } from "node:path";
import { homedir, platform } from "node:os";
import { configFilePath } from "./platform-paths.mjs";
import { backupJson, readJsonOrNull, writeJsonPreservingNewlines, C, ok, warn, err, step, note } from "./mcp-json.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");
const PKG = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));

const PY_MIN = { major: 3, minor: 10 };
const PY_MIN_STR = `${PY_MIN.major}.${PY_MIN.minor}`;

// ----- formatting (shared with scripts/dev-prune-mcp.mjs via ./mcp-json.mjs) -----
const fail = (msg) => {
	console.error(err(msg));
	process.exit(1);
};

// ----- arg parsing (lightweight, no deps) -----
function parseArgs(argv) {
	const args = {
		help: false,
		purgeVenv: false,
		skipBrowser: false,
		reconcileUserMcp: false,
		source: null,
		venvDir: null,
		yes: false,
	};
	const positional = [];
	let i;
	const value = (flag) => {
		const v = argv[++i];
		if (v === undefined || v.startsWith("--")) fail(`Missing value for ${flag}`);
		return v;
	};
	for (i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "-h" || a === "--help") args.help = true;
		else if (a === "--purge-venv") args.purgeVenv = true;
		else if (a === "--skip-browser") args.skipBrowser = true;
		else if (a === "--reconcile-user-mcp") args.reconcileUserMcp = true;
		else if (a === "--yes" || a === "-y") args.yes = true;
		else if (a === "--source") args.source = value("--source");
		else if (a === "--venv-dir") args.venvDir = value("--venv-dir");
		else if (a.startsWith("--")) {
			fail(`Unknown flag: ${a}`);
		} else positional.push(a);
	}
	if (positional.length) args.command = positional[0];
	return args;
}

// ----- helpers -----
function resolveSource(args) {
	if (args.source) return args.source;
	// Default: the package this script lives inside (works for both
	// repo checkouts and npm global installs).
	return PKG_ROOT;
}

function resolveVenvDir(args) {
	if (args.venvDir) return args.venvDir;
	return platform() === "win32"
		? join(homedir(), "venvs", "scrapling")
		: join(homedir(), ".venvs", "scrapling");
}

function venvPython(venvDir) {
	return platform() === "win32"
		? join(venvDir, "Scripts", "python.exe")
		: join(venvDir, "bin", "python");
}

function venvPip(venvDir) {
	return platform() === "win32"
		? join(venvDir, "Scripts", "pip.exe")
		: join(venvDir, "bin", "pip");
}

function venvBin(name, venvDir) {
	return platform() === "win32"
		? join(venvDir, "Scripts", `${name}.exe`)
		: join(venvDir, "bin", name);
}

// Path where pip would drop pure-Python packages inside `venvDir`. POSIX venvs
// nest by interpreter version (lib/pythonX.Y/site-packages); Windows venvs
// share a single site-packages root (Lib\site-packages) regardless of
// interpreter version.
function venvSitePackages(venvDir, pyVer) {
	if (platform() === "win32") return join(venvDir, "Lib", "site-packages");
	const major = pyVer?.major ?? 3;
	const minor = pyVer?.minor ?? 10;
	return join(venvDir, "lib", `python${major}.${minor}`, "site-packages");
}

// Mirror the extension's resolution-chain config file. Shared with
// extensions/scrapling.ts via `./platform-paths.mjs`.

// Read the existing config so we can preserve any keys the user added
// (data directories, alternate command overrides, etc.). On missing or
// unparseable file, start from an empty object.
function readExistingConfig(path) {
	if (!existsSync(path)) return {};
	const existing = readJsonOrNull(path);
	if (Array.isArray(existing)) return {};
	return existing && typeof existing === "object" ? existing : {};
}

function writeVenvConfig(venvDir) {
	const path = configFilePath();
	mkdirSync(dirname(path), { recursive: true });
	const previous = readExistingConfig(path);
	const backup = existsSync(path) ? backupJson(path) : { ok: true, path: "(no prior file)" };
	if (!backup.ok) {
		// Same fail-loud contract as the MCP reconciles: if we can't back up,
		// we don't clobber user-owned state. The new venv path is reported,
		// the user can `pi install` again after fixing permissions.
		console.log(warn(`Backup of ${path} failed; venv path not saved. Reason: ${backup.err}`));
		return;
	}
	const merged = { ...previous, venv: venvDir, writtenBy: "pi-scrapling" };
	writeJsonPreservingNewlines(path, merged);
	const preservedKeys = Object.keys(previous).filter((k) => k !== "venv" && k !== "writtenBy");
	console.log(note(`Saved venv location: ${path}`));
	if (preservedKeys.length > 0) {
		console.log(note(`Preserved user keys: ${preservedKeys.join(", ")}${backup.path === "(no prior file)" ? "" : ` (backup at ${backup.path})`}`));
	}
}

function clearVenvConfig() {
	const path = configFilePath();
	try {
		rmSync(path, { force: true });
	} catch {
		/* missing is fine */
	}
}

// Persistent MCP overrides left over from earlier sessions can shadow the
// extension's auto-resolved path with the bare `scrapling-mcp` name, which
// isn't on `PATH`. The user-MCP reconcile is gated behind an explicit opt-in
// flag (`--reconcile-user-mcp`) so this package never silently rewrites
// user-owned MCP state. Each rewrite writes `<path>.bak.<UTC>` first so a
// previous state can always be reverted from. The project-MCP reconcile was
// removed from the public surface in 1.0.x; it lives at
// `scripts/dev-prune-mcp.mjs` as a maintainer-only script and is not part of
// the user-facing CLI.
function userMcpJsonPath() {
	return join(homedir(), ".pi", "agent", "mcp.json");
}

// Pre-rewrite backup; the function lives in ./mcp-json.mjs (shared with
// scripts/dev-prune-mcp.mjs). Callers must check `.ok` before mutating.
function reconcileUserMcpJson(args) {
	if (!args.reconcileUserMcp) {
		console.log(note(`Skipped user-MCP reconcile ${C.dim}(pass --reconcile-user-mcp to remove a stale bare-name entry)${C.reset}`));
		return;
	}
	const mcpPath = userMcpJsonPath();
	if (!existsSync(mcpPath)) return;
	const parsed = readJsonOrNull(mcpPath);
	if (!parsed || !parsed.mcpServers || typeof parsed.mcpServers !== "object") return;
	const entry = parsed.mcpServers.scrapling;
	if (!entry || typeof entry !== "object") return;

	// Only touch the legacy stale-default shape: a single `command: "scrapling-mcp"`
	// key and nothing else. Configured entries with extra fields (an explicit
	// `args`, a deliberate `enabled: false`, env overrides, etc.) are
	// user-owned and must stay put. README advertises "bare-name entry".
	const keys = Object.keys(entry);
	if (keys.length !== 1 || entry.command !== "scrapling-mcp") return;

	const backup = backupJson(mcpPath);
	if (!backup.ok) {
		console.log(warn(`Backup of ${mcpPath} failed; left file unchanged. Reason: ${backup.err}`));
		return;
	}
	delete parsed.mcpServers.scrapling;
	if (Object.keys(parsed.mcpServers).length === 0) delete parsed.mcpServers;
	writeJsonPreservingNewlines(mcpPath, parsed);
	console.log(step(`Removed stale ${mcpPath} scrapling entry ${C.dim}(was: command="scrapling-mcp")${C.reset}`));
	console.log(note(`Backup of previous file at ${backup.path}`));
}

function run(cmd, args, options = {}) {
	return new Promise((resolveRun, rejectRun) => {
		const child = spawn(cmd, args, {
			stdio: "inherit",
			...options,
		});
		child.on("error", rejectRun);
		child.on("exit", (code) => {
			if (code === 0) resolveRun(0);
			else rejectRun(Object.assign(new Error(`${cmd} exited ${code}`), { code }));
		});
	});
}

function capture(cmd, args) {
	try {
		return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	} catch (e) {
		return null;
	}
}

async function askConfirm(question, args) {
	if (args.yes) return true;
	if (!process.stdin.isTTY) return false;
	return await new Promise((resolveAsk) => {
		const rl = createInterface({ input: process.stdin, output: process.stderr });
		rl.question(`${question} [y/N] `, (answer) => {
			rl.close();
			resolveAsk(/^y(es)?$/i.test((answer ?? "").trim()));
		});
	});
}

// ----- python discovery -----
function findPython() {
	for (const cmd of ["python3", "python"]) {
		const out = capture(cmd, ["-V"]);
		if (out) return { cmd, version: out };
	}
	return null;
}

function parseVersion(text) {
	const m = /Python\s+(\d+)\.(\d+)(?:\.(\d+))?/.exec(text || "");
	if (!m) return null;
	return {
		major: Number(m[1]),
		minor: Number(m[2]),
		patch: Number(m[3] || 0),
	};
}

function meetsMin(v) {
	if (!v) return false;
	if (v.major !== PY_MIN.major) return v.major > PY_MIN.major;
	return v.minor >= PY_MIN.minor;
}

// ----- pi CLI -----
function findPi() {
	if (capture("which", ["pi"]) || capture("where", ["pi"])) return "pi";
	const localBin = join(PKG_ROOT, "node_modules", ".bin", "pi");
	if (existsSync(localBin)) return localBin;
	return null;
}

async function piList() {
	const pi = findPi();
	if (!pi) return null;
	try {
		const out = execFileSync(pi, ["list"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return out;
	} catch {
		return null;
	}
}

// ----- pip/python wrappers -----
async function ensureVenv(venvDir, py) {
	if (existsSync(join(venvDir, "pyvenv.cfg"))) {
		console.log(note(`venv exists at ${venvDir}`));
		return;
	}
	console.log(step(`Creating venv at ${venvDir} ${C.dim}(requires Python ${PY_MIN_STR}+)${C.reset}`));
	mkdirSync(dirname(venvDir), { recursive: true });
	await run(py, ["-m", "venv", venvDir]);
}

async function pipInstall(venvDir, args, opts = {}) {
	const py = venvPython(venvDir);
	const fullArgs = ["-m", "pip", ...args];
	console.log(step(`${py} ${fullArgs.join(" ")}`));
	return run(py, fullArgs, opts);
}

async function scraplingBrowserInstall(venvDir, skip) {
	if (skip) {
		console.log(warn("Skipping browser download (--skip-browser)"));
		return;
	}
	const bin = venvBin("scrapling", venvDir);
	if (!existsSync(bin)) {
		console.log(warn(`scrapling binary not found in venv; skipping browser install`));
		console.log(note(`Run \`pi-scrapling install\` after pip install completes to retry.`));
		return;
	}
	console.log(step(`${bin} install --force ${C.dim}(one-time, ~few hundred MB)${C.reset}`));
	try {
		await run(bin, ["install", "--force"]);
	} catch {
		console.log(warn(`scrapling install --force did not exit 0`));
		console.log(note(`Continuing — you can retry manually later with: ${bin} install --force`));
	}
}

// ----- subcommands -----

async function install(args) {
	const source = resolveSource(args);
	const venvDir = resolveVenvDir(args);
	const skipBrowser = args.skipBrowser;

	console.log(`${C.bold}pi-scrapling install${C.reset}`);
	console.log(note(`source:  ${source}`));
	console.log(note(`venv:    ${venvDir}`));
	console.log("");

	const py = findPython();
	if (!py) fail("Python not found. Install Python 3.10+ and ensure `python3` is on PATH.");
	console.log(ok(`Python: ${py.version} ${C.dim}(${py.cmd})${C.reset}`));
	const v = parseVersion(py.version);
	if (!meetsMin(v)) fail(`Python ${PY_MIN_STR}+ required, got ${py.version}.`);

	await ensureVenv(venvDir, py.cmd);
	writeVenvConfig(venvDir);
	reconcileUserMcpJson(args);

	console.log(step(`Upgrading pip in venv`));
	await pipInstall(venvDir, ["install", "--upgrade", "pip", "setuptools", "wheel"]);

	console.log(step(`Installing scrapling[all]`));
	await pipInstall(venvDir, ["install", "--upgrade", "scrapling[all]>=0.5"]);

	await scraplingBrowserInstall(venvDir, skipBrowser);

	const pi = findPi();
	if (!pi) {
		console.log(warn("`pi` not found on PATH; skipping Pi package install"));
		console.log(note(`After installing Pi, run: \`pi install ${source}\``));
	} else {
		console.log(step(`${pi} install ${source}`));
		try {
			await run(pi, ["install", source]);
			console.log(ok(`pi-scrapling registered with Pi`));
		} catch (e) {
			console.log(warn(`pi install failed: ${e.message}`));
			console.log(note(`Retry manually: ${pi} install ${source}`));
		}
	}

	console.log("");
	console.log(ok(`install complete`));
	console.log(note(`Run \`pi-scrapling doctor\` to verify, then start a fresh \`pi\` session.`));
}

async function update(args) {
	const source = resolveSource(args);
	const venvDir = resolveVenvDir(args);
	const skipBrowser = args.skipBrowser;

	console.log(`${C.bold}pi-scrapling update${C.reset}`);
	console.log(note(`source:  ${source}`));
	console.log(note(`venv:    ${venvDir}`));
	console.log("");

	const py = venvPython(venvDir);
	if (!existsSync(py)) {
		fail(`Venv not found at ${venvDir}. Run \`pi-scrapling install\` first.`);
	}

	// Re-affirm the config so the extension stays in sync if --venv-dir was
	// overridden on this run and the path differs from the prior install.
	writeVenvConfig(venvDir);
	reconcileUserMcpJson(args);

	console.log(step(`Upgrading scrapling[all]`));
	await pipInstall(venvDir, ["install", "--upgrade", "scrapling[all]>=0.5"]);

	await scraplingBrowserInstall(venvDir, skipBrowser);

	const pi = findPi();
	if (pi) {
		console.log(step(`${pi} install ${source} ${C.dim}(re-installs to reconcile)${C.reset}`));
		try {
			await run(pi, ["install", source]);
		} catch (e) {
			console.log(warn(`pi install failed: ${e.message}`));
		}
	} else {
		console.log(warn("`pi` not found; skip Pi reconcile"));
	}

	console.log("");
	console.log(ok(`update complete`));
}

async function remove(args) {
	const source = resolveSource(args);
	const venvDir = resolveVenvDir(args);

	console.log(`${C.bold}pi-scrapling remove${C.reset}`);
	console.log(note(`source:   ${source}`));
	console.log(note(`venv:     ${venvDir}${args.purgeVenv ? " (will be deleted)" : ""}`));
	console.log("");

	const pi = findPi();
	if (pi) {
		console.log(step(`${pi} remove ${source}`));
		try {
			await run(pi, ["remove", source]);
		} catch (e) {
			console.log(warn(`pi remove failed: ${e.message}`));
		}
	} else {
		console.log(warn("`pi` not found; skip Pi package remove"));
	}

	if (args.purgeVenv) {
		if (!existsSync(venvDir)) {
			console.log(note(`venv does not exist; nothing to delete`));
		} else {
			const confirmed = await askConfirm(
				`Delete venv at ${venvDir}? This throws away installed scrapling and the browser cache.`,
				args,
			);
			if (!confirmed) {
				console.log(note(`Skipped venv purge`));
			} else {
				console.log(step(`rm -rf ${venvDir}`));
				rmSync(venvDir, { recursive: true, force: true });
				clearVenvConfig();
				reconcileUserMcpJson(args);
				console.log(ok(`venv, config, and stale MCP overrides cleaned`));
			}
		}
	} else {
		console.log(note(`Venv kept at ${venvDir} ${C.dim}(pass --purge-venv to delete)${C.reset}`));
	}

	console.log("");
	console.log(ok(`remove complete`));
}

async function doctor(args) {
	const venvDir = resolveVenvDir(args);
	console.log(`${C.bold}pi-scrapling doctor${C.reset}\n`);

	// 1. Python
	const py = findPython();
	const pyVer = py ? parseVersion(py.version) : null;
	if (!py) {
		console.log(err("Python not found on PATH"));
	} else {
		const okPy = meetsMin(pyVer);
		console.log(okPy
			? ok(`Python: ${py.version} ${C.dim}(${py.cmd})${C.reset}`)
			: warn(`Python ${py.version} found, but ${PY_MIN_STR}+ is required`));
	}

	// 2. Venv
	const vpy = venvPython(venvDir);
	if (!existsSync(vpy)) {
		console.log(err(`venv missing at ${venvDir}`));
	} else {
		const scraplingBin = venvBin("scrapling", venvDir);
		const hasScrapling = existsSync(scraplingBin);
		const archive = venvSitePackages(venvDir, pyVer);
		console.log(ok(`venv ok (${venvDir})`));
		console.log(hasScrapling
			? ok(`scrapling installed in venv`)
			: warn(`scrapling binary missing in venv ${C.dim}(run \`pi-scrapling install\` or \`update\`)${C.reset}`));
		console.log(existsSync(archive)
			? ok(`scrapling package importable`)
			: warn(`scrapling package import not verified`));
	}

	// 3. scrapling-mcp on PATH (or in venv — both acceptable)
	const whichScrapling = capture(process.platform === "win32" ? "where" : "which", ["scrapling-mcp"]);
	if (whichScrapling) {
		console.log(ok(`scrapling-mcp on PATH: ${whichScrapling}`));
	} else {
		const venvS = venvBin("scrapling-mcp", venvDir);
		if (existsSync(venvS)) {
			console.log(ok(`scrapling-mcp in venv (not on PATH). The extension auto-detects it via ${configFilePath()}`));
			console.log(note(`  ${venvS}`));
		} else {
			console.log(err(`scrapling-mcp not found in PATH or venv`));
		}
	}

	// 4. Browser
	const browserRoots = [join(process.env.HOME || homedir(), ".cache", "ms-playwright")];
	if (platform() === "darwin") {
		browserRoots.push(join(process.env.HOME || homedir(), "Library", "Caches", "ms-playwright"));
	}
	browserRoots.push(join(process.env.LOCALAPPDATA || "", "ms-playwright"));
	const hasBrowser = browserRoots.some((p) => p && existsSync(p));
	if (hasBrowser) {
		console.log(ok(`Playwright browser cache present (${browserRoots.find((p) => existsSync(p))})`));
	} else {
		console.log(warn(`Playwright browser cache not detected; stealth fetches will fail until \`scrapling install --force\` runs`));
	}

	// 5. Pi CLI
	const pi = findPi();
	if (!pi) {
		console.log(err("`pi` not on PATH"));
	} else {
		console.log(ok(`pi: ${pi}`));
		const installed = await piList();
		const listed = installed && installed.includes(resolveSource(args));
		console.log(listed ? ok(`pi-scrapling installed via Pi`) : warn(`pi-scrapling not listed by \`pi list\``));
	}

	console.log("");
}

// ----- entrypoint -----
function usage() {
	console.log(`Usage: pi-scrapling <command> [flags]

Commands:
  install   create venv, pip install scrapling[all], install browser, pi install
  update    upgrade pip packages, refresh browser, pi install (reconciles package)
  remove    pi remove the package; --purge-venv also deletes the venv
  doctor    check python, venv, scrapling, browser, Pi registration

Flags:
  --source <path|git:|npm:>      Pi install source (default: this package's root)
  --venv-dir <path>               venv location (default: ~/.venvs/scrapling)
  --skip-browser                  install/update: skip \`scrapling install --force\`
  --purge-venv                    remove: also delete the venv after confirming
  --reconcile-user-mcp            install/update/remove: rewrite ~/.pi/agent/mcp.json,
                                  stripping any one-key \`scrapling-mcp\` legacy
                                  entry with a timestamped .bak snapshot. Default:
                                  skip silently. Configured entries with extra
                                  fields are NOT touched.
  --yes, -y                       answer yes to confirmation prompts
  -h, --help                      show this help

Why --reconcile-user-mcp is gated: the reconcile touches a user-owned file
outside this package's own state. It never runs unless the flag is set, so a
fresh install/update/remove leaves your MCP config untouched. Run with the
flag once after upgrading from a version that auto-reconciled, to clear any
stale entries the old code wrote.

Maintainers cleaning up a dev checkout's <pkg>/.pi/mcp.json overlay (Pi's
runtime override fragments inside this package directory) should use
\`npm run dev:prune-mcp\` instead — that path is intentionally not in the
public CLI surface.
`);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || !args.command) {
		usage();
		process.exit(args.help ? 0 : 1);
	}
	switch (args.command) {
		case "install":
			await install(args);
			break;
		case "update":
			await update(args);
			break;
		case "remove":
			await remove(args);
			break;
		case "doctor":
			await doctor(args);
			break;
		default:
			console.error(err(`unknown command: ${args.command}`));
			usage();
			process.exit(2);
	}
}

main().catch((e) => {
	console.error(err(e.message || String(e)));
	process.exit(1);
});