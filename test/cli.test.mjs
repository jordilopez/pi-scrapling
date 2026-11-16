import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url);
const CLI = fileURLToPath(new URL("scripts/cli.mjs", ROOT));

function fixtureVenv() {
	const dir = mkdtempSync(join(tmpdir(), "pi-scrapling-cli-"));
	const bin = join(dir, process.platform === "win32" ? "Scripts" : "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, process.platform === "win32" ? "python.exe" : "python"), "");
	return { dir, bin };
}

function runCli(args) {
	return spawnSync(process.execPath, [CLI, ...args], {
		encoding: "utf8",
		windowsHide: true,
		env: process.env,
	});
}

test("path prints the requested venv executable", () => {
	const { dir, bin } = fixtureVenv();
	try {
		const result = runCli(["path", "--venv-dir", dir, "--", "python"]);
		assert.equal(result.status, 0);
		assert.equal(result.stdout.trim(), join(bin, process.platform === "win32" ? "python.exe" : "python"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("path rejects unknown executables", () => {
	const { dir } = fixtureVenv();
	try {
		const result = runCli(["path", "--venv-dir", dir, "--", "bash"]);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Unknown venv executable: bash/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("path reports a missing executable", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-scrapling-cli-"));
	try {
		const result = runCli(["path", "--venv-dir", dir, "--", "pip"]);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Venv executable not found/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("exec forwards arguments and exposes the shared venv", () => {
	const { dir, bin } = fixtureVenv();
	try {
		const script = "process.stdout.write(JSON.stringify({args: process.argv.slice(1), venv: process.env.VIRTUAL_ENV, path: process.env.PATH.split(require('node:path').delimiter)[0]}))";
		const result = runCli([
			"exec", "--venv-dir", dir, "--", process.execPath, "-e", script, "alpha", "two words",
		]);
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), {
			args: ["alpha", "two words"],
			venv: dir,
			path: bin,
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("exec rejects a missing venv", () => {
	const dir = join(tmpdir(), `pi-scrapling-missing-${Date.now()}`);
	const result = runCli(["exec", "--venv-dir", dir, "--", process.execPath, "-e", ""]);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Venv not found/);
});

test("exec propagates the child failure", () => {
	const { dir } = fixtureVenv();
	try {
		const result = runCli(["exec", "--venv-dir", dir, "--", process.execPath, "-e", "process.exit(7)"]);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /exited 7/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
