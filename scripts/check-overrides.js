#!/usr/bin/env node

/**
 * Checks whether npm overrides in package.json are still necessary.
 *
 * Approach: copies package.json into a temporary directory with the
 * "overrides" field removed, runs `npm install --package-lock-only`
 * and `npm audit`, then reports whether everything passes without
 * overrides.  If it does, the overrides are stale and can be removed.
 *
 * This script is fully generic — it reads overrides dynamically from
 * package.json.  No package names or versions are hardcoded.
 *
 * Flags:
 *   --fix   Remove stale overrides from package.json and update the
 *           lockfile.  Without this flag the script only reports.
 *
 * Exit codes:
 *   0 — overrides are still needed, or none exist, or --fix succeeded
 *   1 — overrides are stale and --fix was not requested
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const fix = process.argv.includes("--fix");
const rootDir = resolve(import.meta.dirname, "..");
const pkgPath = join(rootDir, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
const overrides = pkg.overrides ?? {};
const names = Object.keys(overrides);

if (names.length === 0) {
    console.log("No overrides in package.json — nothing to check.");
    process.exit(0);
}

console.log(`Found ${names.length} override(s):\n`);
for (const [name, value] of Object.entries(overrides)) {
    const display = typeof value === "string" ? value : JSON.stringify(value);
    console.log(`  ${name}: ${display}`);
}
console.log("\nTesting whether they are still needed...\n");

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const extractLines = (err, pattern, max = 8) => {
    const out = (err.stderr ?? err.stdout ?? "").toString();
    return out.split("\n").filter((l) => pattern.test(l)).slice(0, max).join("\n");
};

const testWithout = (overridesToRemove) => {
    const tmp = mkdtempSync(join(tmpdir(), "override-check-"));
    const cleanup = () => rmSync(tmp, { recursive: true, force: true });
    const run = (cmd) => execSync(cmd, { cwd: tmp, stdio: "pipe", timeout: 120_000 });

    const testPkg = structuredClone(pkg);
    for (const name of overridesToRemove) {
        delete testPkg.overrides[name];
    }
    if (Object.keys(testPkg.overrides).length === 0) {
        delete testPkg.overrides;
    }
    writeFileSync(join(tmp, "package.json"), JSON.stringify(testPkg, null, 2));

    try {
        run("npm install --package-lock-only --ignore-scripts");
    } catch (err) {
        cleanup();
        return { ok: false, phase: "install", err };
    }

    try {
        run("npm audit --audit-level=high");
    } catch (err) {
        cleanup();
        return { ok: false, phase: "audit", err };
    }

    cleanup();
    return { ok: true };
};

/* ------------------------------------------------------------------ */
/* 1. Try removing ALL overrides at once (fast path)                   */
/* ------------------------------------------------------------------ */
const allResult = testWithout(names);

if (allResult.ok) {
    console.log("\u2713 npm install succeeds without any overrides");
    console.log("\u2713 npm audit passes without any overrides");
    console.log("\nAll overrides are stale and can be removed.");

    if (fix) {
        delete pkg.overrides;
        writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
        console.log("\nRemoved all overrides from package.json.");
        console.log("Updating lockfile...");
        execSync("npm install", { cwd: rootDir, stdio: "inherit" });
        console.log("Done.");
        process.exit(0);
    }

    console.log("Run with --fix to remove them automatically.");
    console.log("See: docs/adr/001-npm-overrides-for-transitive-dependency-gaps.md");
    process.exit(1);
}

/* ------------------------------------------------------------------ */
/* 2. Not all removable — test each override individually              */
/* ------------------------------------------------------------------ */
console.log("\u2717 Cannot remove all overrides at once. Testing individually...\n");

const removable = [];
const needed = [];

for (const name of names) {
    const result = testWithout([name]);
    if (result.ok) {
        console.log(`  \u2713 ${name} — no longer needed`);
        removable.push(name);
    } else {
        const reason = result.phase === "install" ? "peer dep conflict" : "audit failure";
        console.log(`  \u2717 ${name} — still needed (${reason})`);
        needed.push(name);
    }
}

console.log("");

if (removable.length === 0) {
    console.log("All overrides are still needed.");
    process.exit(0);
}

console.log(`${removable.length} override(s) can be removed: ${removable.join(", ")}`);
console.log(`${needed.length} override(s) still needed: ${needed.join(", ")}`);

if (fix) {
    for (const name of removable) {
        delete pkg.overrides[name];
    }
    if (Object.keys(pkg.overrides).length === 0) {
        delete pkg.overrides;
    }
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    console.log(`\nRemoved ${removable.length} override(s) from package.json.`);
    console.log("Updating lockfile...");
    execSync("npm install", { cwd: rootDir, stdio: "inherit" });
    console.log("Done.");
    process.exit(0);
}

console.log("\nRun with --fix to remove them automatically.");
console.log("See: docs/adr/001-npm-overrides-for-transitive-dependency-gaps.md");
process.exit(1);
