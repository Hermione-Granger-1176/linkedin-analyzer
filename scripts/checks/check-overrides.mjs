#!/usr/bin/env node

/**
 * Checks whether configured npm overrides are still necessary.
 *
 * Approach: copies package.json and .npmrc into a temporary directory with the
 * "overrides" field removed, runs `npm install --package-lock-only`
 * and `npm audit`, then reports whether everything passes without
 * overrides. Temporary dev dependencies listed in config/security_audit.json
 * are removed alongside their overrides. If the audit passes, the overrides
 * are stale and can be removed.
 *
 * This script is fully generic. It reads overrides dynamically from
 * package.json.  No package names or versions are hardcoded.
 *
 * Flags:
 *   --fix   Remove stale overrides from package.json and update the
 *           lockfile.  Without this flag the script only reports.
 *
 * Exit codes:
 *   0: overrides are still needed, or none exist, or --fix succeeded
 *   1: overrides are stale and --fix was not requested, or evaluation failed
 */

import {
    copyFileSync,
    existsSync,
    readFileSync,
    writeFileSync,
    mkdtempSync,
    rmSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const fix = process.argv.includes("--fix");
const rootDir = resolve(import.meta.dirname, "..", "..");
const pkgPath = join(rootDir, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
const overrides = pkg.overrides ?? {};
const names = Object.keys(overrides);
const policyPath = join(rootDir, "config", "security_audit.json");
const policy = existsSync(policyPath) ? JSON.parse(readFileSync(policyPath, "utf8")) : {};
const temporaryDevDependencies = policy.npm_override_dev_dependencies ?? [];
if (
    !Array.isArray(temporaryDevDependencies) ||
    temporaryDevDependencies.some(
        (name) =>
            typeof name !== "string" ||
            overrides[name] !== `$${name}` ||
            typeof pkg.devDependencies?.[name] !== "string",
    )
) {
    console.error(
        "npm_override_dev_dependencies must name direct dev dependencies with matching $name overrides.",
    );
    process.exit(1);
}

if (names.length === 0) {
    console.log("No overrides in package.json. Nothing to check.");
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
    return out
        .split("\n")
        .filter((l) => pattern.test(l))
        .slice(0, max)
        .join("\n");
};

const requireValidInstall = (result) => {
    if (result.phase !== "install") return;
    const output = (result.err.stderr ?? result.err.stdout ?? "").toString();
    if (/npm (?:error|ERR!) code ERESOLVE/u.test(output)) return;
    console.error("Unable to evaluate overrides because npm installation failed.");
    console.error(extractLines(result.err, /npm (?:error|ERR!)/u));
    process.exit(1);
};

const removeOverrides = (manifest, overridesToRemove) => {
    for (const name of overridesToRemove) {
        delete manifest.overrides[name];
        if (temporaryDevDependencies.includes(name)) {
            delete manifest.devDependencies[name];
        }
    }
    if (Object.keys(manifest.overrides).length === 0) {
        delete manifest.overrides;
    }
};

const saveRemoval = (overridesToRemove) => {
    removeOverrides(pkg, overridesToRemove);
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    if (overridesToRemove.some((name) => temporaryDevDependencies.includes(name))) {
        policy.npm_override_dev_dependencies = temporaryDevDependencies.filter(
            (name) => !overridesToRemove.includes(name),
        );
        writeFileSync(policyPath, JSON.stringify(policy, null, 2) + "\n");
    }
};

const testWithout = (overridesToRemove) => {
    const tmp = mkdtempSync(join(tmpdir(), "override-check-"));
    const cleanup = () => rmSync(tmp, { recursive: true, force: true });
    const run = (cmd) => execSync(cmd, { cwd: tmp, stdio: "pipe", timeout: 120_000 });

    const testPkg = structuredClone(pkg);
    removeOverrides(testPkg, overridesToRemove);
    writeFileSync(join(tmp, "package.json"), JSON.stringify(testPkg, null, 2));
    const npmConfigPath = join(rootDir, ".npmrc");
    if (existsSync(npmConfigPath)) {
        copyFileSync(npmConfigPath, join(tmp, ".npmrc"));
    }

    try {
        run("npm install --package-lock-only --ignore-scripts");
    } catch (err) {
        cleanup();
        return { ok: false, phase: "install", err };
    }

    try {
        // Gate every severity, matching the default in scripts/ci/run_npm_audit.py.
        // A higher floor would call an override stale because the advisory it
        // holds back happens to sit below the threshold.
        run("npm audit --audit-level=info");
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
requireValidInstall(allResult);

if (allResult.ok) {
    console.log("\u2713 npm install succeeds without any overrides");
    console.log("\u2713 npm audit passes without any overrides");
    console.log("\nAll overrides are stale and can be removed.");

    if (fix) {
        saveRemoval(names);
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
/* 2. Not all removable: test each override individually              */
/* ------------------------------------------------------------------ */
console.log("\u2717 Cannot remove all overrides at once. Testing individually...\n");

const removable = [];
const needed = [];

for (const name of names) {
    const result = testWithout([name]);
    requireValidInstall(result);
    if (result.ok) {
        console.log(`  \u2713 ${name}: no longer needed`);
        removable.push(name);
    } else {
        const reason = result.phase === "install" ? "installation failure" : "audit failure";
        console.log(`  \u2717 ${name}: still needed (${reason})`);
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
    saveRemoval(removable);
    console.log(`\nRemoved ${removable.length} override(s) from package.json.`);
    console.log("Updating lockfile...");
    execSync("npm install", { cwd: rootDir, stdio: "inherit" });
    console.log("Done.");
    process.exit(0);
}

console.log("\nRun with --fix to remove them automatically.");
console.log("See: docs/adr/001-npm-overrides-for-transitive-dependency-gaps.md");
process.exit(1);
