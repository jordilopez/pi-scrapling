// `npm run validate` — static-check harness for the pi-scrapling package.
//
// Verifies (in this order):
//   1. package.json shape (name, keywords, pi.* namespaces, bin entry).
//   2. every declared pi resource path actually exists on disk.
//   3. the bin-script parses as a valid ES module (`node --check`).
//   4. the `files` list covers every path `pi.*` or `bin` references, so
//      `npm pack` will not silently strip a shipped resource.
//   5. extensions/*.ts typechecks against the linked Pi host, when a local
//      `tsc` is on PATH; missing here is a warning, not a failure.
//
// Exits 1 if any failure, regardless of step 5's outcome.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const failures = [];

function fail(msg) {
	failures.push(msg);
}

function check(label, ok) {
	if (!ok) fail(label);
}

// 1. package.json shape
let pkg;
try {
	pkg = JSON.parse(readFileSync("package.json", "utf8"));
} catch (e) {
	fail(`package.json not readable: ${e.message}`);
	process.exit(1);
}

check("package.json has name 'pi-scrapling'", pkg.name === "pi-scrapling");
check(`'pi-package' in keywords`, pkg.keywords?.includes("pi-package"));
check("pi.skills manifest present", Array.isArray(pkg.pi?.skills));
check("pi.extensions manifest present", Array.isArray(pkg.pi?.extensions));
check("bin['pi-scrapling'] declared", typeof pkg.bin?.["pi-scrapling"] === "string");

// 2. all declared resources exist on disk
for (const p of [...(pkg.pi.skills ?? []), ...(pkg.pi.extensions ?? [])]) {
	check(`pi resource exists: ${p}`, existsSync(p));
}

if (pkg.bin?.["pi-scrapling"]) {
	check(`bin entry exists: ${pkg.bin["pi-scrapling"]}`, existsSync(pkg.bin["pi-scrapling"]));
}

// 3. CLI parses as valid ES module
try {
	execFileSync(process.execPath, ["--check", pkg.bin["pi-scrapling"]], {
		stdio: ["ignore", "pipe", "pipe"],
	});
} catch (e) {
	fail(`CLI parse error in ${pkg.bin["pi-scrapling"]}: ${e.message}`);
}

// 4. files list includes every entry referenced by pi or bin
const files = (pkg.files ?? []).map((f) => f.replace(/^\.\//, ""));

function asDir(p) {
	if (!p) return "";
	if (p.endsWith("/")) return p;
	if (/\.[a-zA-Z0-9]+$/.test(p)) {
		const slash = p.lastIndexOf("/");
		return slash >= 0 ? p.slice(0, slash + 1) : "";
	}
	return p + "/";
}

function covered(p) {
	const norm = p.replace(/^\.\//, "");
	if (files.includes(norm)) return true;
	const dir = asDir(norm);
	return files.some((f) => {
		const fAsDir = f.endsWith("/") ? f : f + "/";
		return dir && dir.startsWith(fAsDir);
	});
}

for (const raw of [...pkg.pi.skills, ...pkg.pi.extensions, pkg.bin["pi-scrapling"], "README.md", "package.json"]) {
	const tag = `'files' covers ${raw}`;
	check(tag, covered(raw));
}

// 5. extensions/*.ts typechecks against the linked Pi host (best-effort).
// Run without positional args so tsconfig's `target` / `lib` apply.
if (existsSync("node_modules/.bin/tsc")) {
	try {
		execFileSync("node_modules/.bin/tsc", ["--noEmit"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (e) {
		console.warn(`⚠ typecheck did not run cleanly: ${(e.stderr || e.message || "").toString().split("\n")[0]}`);
	}
}

// Report
if (failures.length) {
	console.error(`pi-scrapling validate FAILED (${failures.length}):`);
	for (const msg of failures) console.error(`  - ${msg}`);
	process.exit(1);
}
console.log("pi-scrapling package validates ok");
