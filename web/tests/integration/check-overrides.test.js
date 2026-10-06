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

const roots = [];
afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

function runChecker({
    configured = true,
    blocked = false,
    upstreamFixed = false,
    fork = false,
    temporary = fork,
    fix = false,
} = {}) {
    const root = mkdtempSync(join(tmpdir(), "override-check-test-"));
    roots.push(root);
    const scriptDir = join(root, "scripts/checks");
    const binDir = join(root, "bin");
    mkdirSync(scriptDir, { recursive: true });
    mkdirSync(binDir);
    const script = join(scriptDir, "check-overrides.mjs");
    copyFileSync(join(process.cwd(), "scripts/checks/check-overrides.mjs"), script);
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
    writeFileSync(
        join(root, "config/security_audit.json"),
        JSON.stringify({
            npm_override_dev_dependencies: temporary ? ["braces"] : [],
            npm_vulnerability_exceptions: [{ package: "braces", id: "synthetic" }],
        }),
    );
    const config = configured ? "engine-strict=true\nallow-remote=root\n" : null;
    if (configured) {
        writeFileSync(join(root, ".npmrc"), config);
    }
    const log = join(root, "npm-calls.jsonl");
    const npm = join(binDir, "npm");
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
process.exit(process.argv[2] === "audit" && (process.env.OVERRIDE_TEST_FIXED !== "true" || manifest.devDependencies?.braces) ? 1 : 0);
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
        },
    });
    const calls = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    return { result, calls, root, config, manifest };
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
    const { result, root } = runChecker({ fork: true, upstreamFixed: true, fix: true });
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).toEqual({
        devDependencies: { stylelint: "^17.0.0" },
    });
    expect(JSON.parse(readFileSync(join(root, "config/security_audit.json"), "utf8"))).toEqual({
        npm_override_dev_dependencies: [],
        npm_vulnerability_exceptions: [{ package: "braces", id: "synthetic" }],
    });
});
