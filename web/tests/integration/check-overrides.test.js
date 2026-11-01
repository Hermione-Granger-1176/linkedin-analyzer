// @vitest-environment node
import { spawnSync } from "node:child_process";
import {
    chmodSync,
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

// The checker delegates each trial audit to scripts/ci/run_npm_audit.py, so the
// temporary project carries the same Python policy modules the repository uses.
const AUDIT_MODULES = [
    "scripts/__init__.py",
    "scripts/ci/__init__.py",
    "scripts/ci/run_npm_audit.py",
    "scripts/ci/security_audit_policy.py",
];
const LEFTOVER = "deepmerge GHSA-GCQX-W48M-W2H4";

const roots = [];
afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

/**
 * A reviewed exception for the leftover deepmerge advisory, valid unless overridden.
 * @param {Record<string, unknown>} fields
 */
function deepmergeException(fields = {}) {
    return {
        id: "ghsa-gcqx-w48m-w2h4",
        package: "deepmerge",
        reason: "Synthetic reviewed advisory that no override can fix.",
        review_by: "2999-12-31",
        ...fields,
    };
}

function runChecker({
    configured = true,
    blocked = false,
    upstreamFixed = false,
    fork = false,
    temporary = fork,
    fix = false,
    leftover = null,
    fixAvailable = false,
    rawReport = null,
    exceptions = [],
    auditPython = process.env.AUDIT_PYTHON || "python3",
} = {}) {
    const root = mkdtempSync(join(tmpdir(), "override-check-test-"));
    roots.push(root);
    const scriptDir = join(root, "scripts/checks");
    const binDir = join(root, "bin");
    mkdirSync(scriptDir, { recursive: true });
    mkdirSync(join(root, "scripts/ci"));
    mkdirSync(binDir);
    const script = join(scriptDir, "check-overrides.mjs");
    copyFileSync(join(process.cwd(), "scripts/checks/check-overrides.mjs"), script);
    for (const module of AUDIT_MODULES) {
        copyFileSync(join(process.cwd(), module), join(root, module));
    }
    const manifest = fork
        ? {
              overrides: { braces: "$braces" },
              devDependencies: {
                  braces: "https://example.test/braces.tar.gz",
                  stylelint: "^17.0.0",
              },
          }
        : { overrides: { braces: "3.0.3" } };
    writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
    mkdirSync(join(root, "config"));
    const policy = {
        npm_override_dev_dependencies: temporary ? ["braces"] : [],
        npm_vulnerability_exceptions: exceptions,
    };
    writeFileSync(join(root, "config/security_audit.json"), JSON.stringify(policy));
    const config = configured ? "engine-strict=true\nallow-remote=root\n" : null;
    if (configured) {
        writeFileSync(join(root, ".npmrc"), config);
    }
    const log = join(root, "npm-calls.jsonl");
    const npm = join(binDir, "npm");
    // Fake npm: `audit --json` reports the braces advisory while the override is
    // still needed, plus an optional leftover advisory no override can fix.
    writeFileSync(
        npm,
        `#!/usr/bin/env node
const fs = require("node:fs");
const config = fs.existsSync(".npmrc") ? fs.readFileSync(".npmrc", "utf8") : null;
const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
fs.appendFileSync(process.env.OVERRIDE_TEST_LOG, JSON.stringify({ command: process.argv[2], config, manifest }) + "\\n");
if (process.env.OVERRIDE_TEST_BLOCKED === "true") {
    console.error("npm error code EALLOWREMOTE");
    process.exit(1);
}
if (process.argv[2] !== "audit") process.exit(0);
const needed = process.env.OVERRIDE_TEST_FIXED !== "true" || Boolean(manifest.devDependencies?.braces);
if (!needed && process.env.OVERRIDE_TEST_RAW) {
    console.log(process.env.OVERRIDE_TEST_RAW);
    process.exit(1);
}
const advisory = (id, source, severity) => ({ source, severity, url: \`https://github.com/advisories/\${id}\` });
const vulnerabilities = {};
if (needed) {
    vulnerabilities.braces = { name: "braces", via: [advisory("GHSA-GRV7-FG5C-XMJG", 2, "high")], fixAvailable: false };
}
if (process.env.OVERRIDE_TEST_LEFTOVER) {
    const [name, id] = process.env.OVERRIDE_TEST_LEFTOVER.split(" ");
    const fixAvailable = process.env.OVERRIDE_TEST_FIX_AVAILABLE === "true";
    vulnerabilities[name] = { name, via: [advisory(id, 1, "low")], fixAvailable };
}
console.log(JSON.stringify({ vulnerabilities }));
process.exit(Object.keys(vulnerabilities).length > 0 ? 1 : 0);
`,
    );
    chmodSync(npm, 0o755);
    const result = spawnSync(process.execPath, [script, ...(fix ? ["--fix"] : [])], {
        encoding: "utf8",
        env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            OVERRIDE_TEST_LOG: log,
            OVERRIDE_TEST_BLOCKED: String(blocked),
            OVERRIDE_TEST_FIXED: String(upstreamFixed),
            OVERRIDE_TEST_LEFTOVER: leftover ?? "",
            OVERRIDE_TEST_FIX_AVAILABLE: String(fixAvailable),
            OVERRIDE_TEST_RAW: rawReport ?? "",
            AUDIT_PYTHON: auditPython,
        },
    });
    const calls = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    return { result, calls, root, config, manifest, policy };
}

/** @param {ReturnType<typeof runChecker>} run */
function expectOverridesKept({ result, root, manifest }) {
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("still needed (audit failure)");
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).toEqual(manifest);
}

it.each([
    { configured: true, blocked: false },
    { configured: false, blocked: false },
    { configured: true, blocked: true },
])("uses npm config=$configured, blocked=$blocked", ({ configured, blocked }) => {
    const { result, calls: rawCalls, config } = runChecker({ configured, blocked });
    const calls = rawCalls.map(({ command, config: npmConfig }) => ({
        command,
        config: npmConfig,
    }));
    expect(result.status).toBe(blocked ? 1 : 0);
    if (blocked) {
        expect(result.stderr).toContain("Unable to evaluate overrides");
        expect(result.stdout).not.toContain("All overrides are still needed.");
        expect(calls).toEqual([{ command: "install", config }]);
        return;
    }
    expect(result.stdout).toContain("still needed (audit failure)");
    expect(calls).toEqual([
        { command: "install", config },
        { command: "audit", config },
        { command: "install", config },
        { command: "audit", config },
    ]);
});

it.each([false, true])("detects upstream fix=%s without the temporary fork", (upstreamFixed) => {
    const { result, calls, root, manifest } = runChecker({ fork: true, upstreamFixed });
    expect(result.status).toBe(upstreamFixed ? 1 : 0);
    expect(result.stdout).toContain(
        upstreamFixed ? "All overrides are stale" : "still needed (audit failure)",
    );
    for (const call of calls) {
        expect(call.manifest.overrides).toBeUndefined();
        expect(call.manifest.devDependencies).toEqual({ stylelint: "^17.0.0" });
    }
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).toEqual(manifest);
});

it("preserves direct dependencies that are not marked as temporary", () => {
    const { result, calls } = runChecker({ fork: true, temporary: false, upstreamFixed: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("still needed (audit failure)");
    for (const call of calls) {
        expect(call.manifest.devDependencies.braces).toBe("https://example.test/braces.tar.gz");
    }
});

it("removes the temporary fork and its maintenance entry only when fixing a stale override", () => {
    const exceptions = [deepmergeException()];
    const { result, root } = runChecker({
        fork: true,
        upstreamFixed: true,
        fix: true,
        leftover: LEFTOVER,
        exceptions,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).toEqual({
        devDependencies: { stylelint: "^17.0.0" },
    });
    expect(JSON.parse(readFileSync(join(root, "config/security_audit.json"), "utf8"))).toEqual({
        npm_override_dev_dependencies: [],
        npm_vulnerability_exceptions: exceptions,
    });
});

it.each([
    { label: "a reviewed exception", exceptions: [deepmergeException()], stale: true },
    { label: "no exception", exceptions: [], stale: false },
])("judges a leftover advisory covered by $label", ({ exceptions, stale }) => {
    const run = runChecker({ upstreamFixed: true, leftover: LEFTOVER, exceptions, fix: true });
    if (!stale) {
        expectOverridesKept(run);
        return;
    }
    expect(run.result.status).toBe(0);
    expect(run.result.stdout).toContain("All overrides are stale");
    expect(JSON.parse(readFileSync(join(run.root, "package.json"), "utf8"))).toEqual({});
});

it.each([
    {
        label: "an expired exception",
        exceptions: [deepmergeException({ review_by: "2000-01-01" })],
    },
    {
        label: "a missing review date",
        exceptions: [deepmergeException({ review_by: undefined })],
    },
    {
        label: "a fix-restricted exception once a fix exists",
        exceptions: [deepmergeException({ ignore_only_without_fix: true })],
        fixAvailable: true,
    },
    {
        label: "overlapping GHSA and source exceptions",
        exceptions: [deepmergeException(), deepmergeException({ id: 1 })],
    },
])("keeps overrides when the leftover finding has $label", ({ exceptions, fixAvailable }) => {
    expectOverridesKept(
        runChecker({
            upstreamFixed: true,
            leftover: LEFTOVER,
            exceptions,
            fixAvailable,
            fix: true,
        }),
    );
});

it("accepts a fix-restricted exception while no fix exists", () => {
    const { result } = runChecker({
        upstreamFixed: true,
        leftover: LEFTOVER,
        exceptions: [deepmergeException({ ignore_only_without_fix: true })],
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("All overrides are stale");
});

it.each([
    { label: "an invalid via shape", rawReport: '{"vulnerabilities":{"glob":{"via":{}}}}' },
    { label: "an npm error report", rawReport: '{"error":{"summary":"ENOAUDIT"}}' },
    {
        label: "an advisory without ids",
        rawReport: '{"vulnerabilities":{"glob":{"via":[{"severity":"low"}]}}}',
    },
    { label: "non-JSON output", rawReport: "npm error network" },
])("keeps overrides after an audit with $label", ({ rawReport }) => {
    expectOverridesKept(runChecker({ upstreamFixed: true, rawReport, fix: true }));
});

it("fails loudly when the audit policy cannot run", () => {
    const { result } = runChecker({ upstreamFixed: true, auditPython: "missing-python-for-test" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unable to evaluate overrides");
    expect(result.stdout).not.toContain("still needed (audit failure)");
});
