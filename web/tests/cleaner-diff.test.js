import { execFileSync, spawnSync } from "node:child_process";
import {
    chmodSync,
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseArgs, runCleanerDiff } from "../../scripts/checks/cleaner-diff.mjs";

const PRIVATE_MARKER = "PRIVATE_SYNTHETIC_MARKER_91c8";
const FILES = {
    shares: "Shares.csv",
    comments: "Comments.csv",
    messages: "messages.csv",
    connections: "Connections.csv",
};
const temporaryRoots = [];

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        rmSync(root, { force: true, recursive: true });
    }
});

function createFixture() {
    const root = mkdtempSync(join(tmpdir(), "cleaner-diff-test-"));
    temporaryRoots.push(root);
    const repoDir = join(root, "repo");
    const sourceDir = join(repoDir, "web/src");
    const scriptDir = join(repoDir, "scripts/checks");
    const scriptPath = join(scriptDir, "cleaner-diff.mjs");
    const inputDir = join(root, "input");
    const tempRoot = join(root, "stages");
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(scriptDir, { recursive: true });
    mkdirSync(inputDir);
    mkdirSync(tempRoot);
    chmodSync(tempRoot, 0o700);
    copyFileSync(join(process.cwd(), "scripts/checks/cleaner-diff.mjs"), scriptPath);

    const cleanerSource = `
export class LinkedInCleaner {
    static process(csv, type) {
        if (csv.includes("${PRIVATE_MARKER}")) {
            return { success: false, error: csv };
        }
        return { success: true, cleanedData: [{ type, row: "synthetic" }] };
    }
}
`;
    writeFileSync(join(sourceDir, "cleaner.js"), cleanerSource);
    for (const moduleName of [
        "constants.js",
        "csv-parser.js",
        "cleaner-configs.js",
        "field-cleaners.js",
    ]) {
        writeFileSync(join(sourceDir, moduleName), "export {};\n");
    }
    for (const [type, filename] of Object.entries(FILES)) {
        writeFileSync(join(inputDir, filename), `synthetic-${type}\n`);
    }

    return { inputDir, repoDir, root, scriptPath, tempRoot };
}

function copyParityInputs(inputDir) {
    const fixtureDir = join(process.cwd(), "tests/fixtures");
    for (const [type, filename] of Object.entries(FILES)) {
        copyFileSync(join(fixtureDir, `${type}-parity.csv`), join(inputDir, filename));
    }
}

function runFixtureCommand(fixture, args) {
    const result = spawnSync(
        process.execPath,
        [fixture.scriptPath, "--input-dir", fixture.inputDir, ...args],
        {
            cwd: fixture.repoDir,
            encoding: "utf8",
            env: { ...process.env, TMPDIR: fixture.tempRoot },
        },
    );
    return {
        exitCode: result.status ?? 1,
        output: `${result.stdout}${result.stderr}`,
    };
}

function baseOptions(fixture) {
    return {
        inputDir: fixture.inputDir,
        newRef: "worktree",
        oldRef: "worktree",
        repoDir: fixture.repoDir,
        tempRoot: fixture.tempRoot,
    };
}

describe("cleaner-diff", () => {
    it("cleans staged modules after a successful standalone comparison", () => {
        const fixture = createFixture();

        const { exitCode, output } = runFixtureCommand(fixture, ["worktree", "worktree"]);

        expect(exitCode).toBe(0);
        expect(output).toContain("RESULT       IDENTICAL");
        expect(readdirSync(fixture.tempRoot)).toEqual([]);
        expect(readdirSync(fixture.root).sort()).toEqual(["input", "repo", "stages"]);
    });

    it("stages one selected ref and locks down retained rows", () => {
        const fixture = createFixture();
        const outputDir = join(fixture.root, "rows");

        const { exitCode, output } = runFixtureCommand(fixture, [
            "--output-dir",
            outputDir,
            "worktree",
        ]);

        expect(exitCode).toBe(0);
        expect(output).toContain("RESULT       STAGED");
        expect(output).toContain("ROWS         RETAINED   files=4");
        expect(readdirSync(outputDir).sort()).toEqual([
            "comments.json",
            "connections.json",
            "messages.json",
            "shares.json",
        ]);
        expect(readdirSync(fixture.tempRoot)).toEqual([]);
        if (process.platform !== "win32") {
            expect(statSync(outputDir).mode & 0o777).toBe(0o700);
            for (const filename of readdirSync(outputDir)) {
                expect(statSync(join(outputDir, filename)).mode & 0o777).toBe(0o600);
            }
        }
    });

    it("cleans partial row dumps and stages after failure without leaking content", () => {
        const fixture = createFixture();
        const outputDir = join(fixture.root, "rows");
        writeFileSync(join(fixture.inputDir, FILES.shares), PRIVATE_MARKER);

        const { exitCode, output } = runFixtureCommand(fixture, [
            "--output-dir",
            outputDir,
            "worktree",
        ]);

        expect(exitCode).toBe(1);
        expect(output).toContain("shares       ERROR");
        expect(output).not.toContain(PRIVATE_MARKER);
        expect(readdirSync(outputDir)).toEqual([]);
        expect(readdirSync(fixture.tempRoot)).toEqual([]);
    });

    it.each([
        { strict: false, expectedCode: 0, expectedStatus: "SKIPPED" },
        { strict: true, expectedCode: 1, expectedStatus: "FAILED" },
    ])("handles missing inputs with strict=$strict", async ({ strict, expectedCode, expectedStatus }) => {
        const fixture = createFixture();
        const lines = [];
        rmSync(join(fixture.inputDir, FILES.shares));

        const exitCode = await runCleanerDiff(
            { ...baseOptions(fixture), strict },
            (line) => lines.push(line),
        );

        expect(exitCode).toBe(expectedCode);
        expect(lines.join("\n")).toContain(expectedStatus);
        expect(lines.join("\n")).toContain("missing-inputs=1");
        expect(readdirSync(fixture.tempRoot)).toEqual([]);
    });

    it("runs the native standalone command without retaining rows", () => {
        const fixture = createFixture();
        copyParityInputs(fixture.inputDir);

        const output = execFileSync(
            process.execPath,
            [
                join(process.cwd(), "scripts/checks/cleaner-diff.mjs"),
                "--input-dir",
                fixture.inputDir,
                "worktree",
                "worktree",
            ],
            {
                cwd: process.cwd(),
                encoding: "utf8",
                env: process.env,
            },
        );

        expect(output).toContain("RESULT       IDENTICAL");
        expect(output).not.toContain("sha=");
        expect(output).not.toContain("digest=");
    });

    it("uses an explicit output directory for single-ref staging", () => {
        expect(
            parseArgs(["--output-dir", "/synthetic/output", "selected-ref"]),
        ).toMatchObject({
            outputDir: "/synthetic/output",
            ref: "selected-ref",
        });
        expect(() =>
            parseArgs(["--output-dir", "/synthetic/output", "first", "second"]),
        ).toThrow("invalid options");
        expect(() => parseArgs(["--retain-rows"])).toThrow("invalid options");
    });
});
