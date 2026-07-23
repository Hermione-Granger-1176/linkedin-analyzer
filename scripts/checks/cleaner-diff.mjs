/*
 * Differential check for web/src/cleaner.js over a local LinkedIn export.
 *
 * Usage (prefer the Makefile):
 *   make cleaner-diff
 *   make cleaner-diff args="oldRef newRef"
 *   make cleaner-diff strict=1
 *
 * Defaults: oldRef=main, newRef=worktree. Normal runs compare both refs without
 * retaining rows. An explicit --output-dir switches to single-ref row staging,
 * with the selected ref defaulting to worktree. Missing inputs skip outside
 * strict mode and fail in strict mode.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Resolve the repo root from this module's location so a direct script run is
// independent of the caller's working directory. Under Vitest the module is
// imported with a non-file import.meta.url, so fall back to the process cwd;
// tests always pass explicit directories and the Makefile runs from the root.
function resolveRepoRoot() {
    try {
        return fileURLToPath(new URL("../..", import.meta.url));
    } catch {
        return process.cwd();
    }
}

const REPO = resolveRepoRoot();
const FILES = {
    shares: "Shares.csv",
    comments: "Comments.csv",
    messages: "messages.csv",
    connections: "Connections.csv",
};
const MODULES = [
    "cleaner.js",
    "constants.js",
    "csv-parser.js",
    "cleaner-configs.js",
    "field-cleaners.js",
];

/**
 * Parse positional refs and privacy-related options.
 * @param {string[]} argv - Command line arguments
 * @returns {object}
 */
export function parseArgs(argv) {
    const options = {
        oldRef: "main",
        newRef: "worktree",
        ref: "worktree",
        inputDir: join(REPO, "data/input"),
        outputDir: null,
        strict: false,
    };
    const refs = [];

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--strict") {
            options.strict = true;
        } else if (argument === "--input-dir") {
            index += 1;
            if (index >= argv.length) {
                throw new Error("invalid options");
            }
            options.inputDir = argv[index];
        } else if (argument === "--output-dir") {
            index += 1;
            if (index >= argv.length) {
                throw new Error("invalid options");
            }
            options.outputDir = argv[index];
        } else if (argument.startsWith("--")) {
            throw new Error("invalid options");
        } else {
            refs.push(argument);
        }
    }

    if (options.outputDir !== null) {
        if (refs.length > 1) {
            throw new Error("invalid options");
        }
        [options.ref = "worktree"] = refs;
    } else {
        if (refs.length > 2) {
            throw new Error("invalid options");
        }
        [options.oldRef = "main", options.newRef = "worktree"] = refs;
    }
    return options;
}

function writePrivateSync(path, contents) {
    writeFileSync(path, contents, { encoding: "utf8", mode: 0o600 });
}

function readModuleSource(ref, repoDir, moduleName) {
    if (ref === "worktree") {
        return readFileSync(join(repoDir, "web/src", moduleName), "utf8");
    }
    return execFileSync("git", ["-C", repoDir, "show", `${ref}:web/src/${moduleName}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
    });
}

function stage(ref, repoDir, tempRoot) {
    const directory = mkdtempSync(join(tempRoot, "linkedin-analyzer-cleaner-stage-"));
    chmodSync(directory, 0o700);
    try {
        writePrivateSync(join(directory, "package.json"), '{"type":"module"}\n');
        for (const moduleName of MODULES) {
            let source;
            try {
                source = readModuleSource(ref, repoDir, moduleName);
            } catch {
                if (ref === "worktree") {
                    throw new Error("module staging failed");
                }
                continue;
            }
            writePrivateSync(join(directory, moduleName), source);
        }
        return directory;
    } catch {
        rmSync(directory, { force: true, recursive: true });
        throw new Error("module staging failed");
    }
}

async function writePrivateRows(outputDir, type, contents, generatedFiles) {
    const path = join(outputDir, `${type}.json`);
    await writeFile(path, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    generatedFiles.push(path);
}

async function runVariant(ref, options, outputDir, generatedFiles) {
    const directory = stage(ref, options.repoDir, options.tempRoot);
    try {
        const moduleUrl = pathToFileURL(join(directory, "cleaner.js"));
        const { LinkedInCleaner } = await import(moduleUrl.href);
        if (typeof LinkedInCleaner?.process !== "function") {
            throw new Error("cleaner module failed");
        }

        const results = {};
        for (const [type, filename] of Object.entries(FILES)) {
            const csv = await readFile(join(options.inputDir, filename), "utf8");
            const result = LinkedInCleaner.process(csv, type);
            if (!result.success || !Array.isArray(result.cleanedData)) {
                results[type] = { error: true, rows: 0 };
                continue;
            }

            const canonical = JSON.stringify(result.cleanedData);
            results[type] = {
                digest:
                    outputDir === null
                        ? createHash("sha256").update(canonical).digest("hex")
                        : null,
                rows: result.cleanedData.length,
            };
            if (outputDir !== null) {
                await writePrivateRows(outputDir, type, canonical, generatedFiles);
            }
        }
        return results;
    } finally {
        rmSync(directory, { force: true, recursive: true });
    }
}

async function ensurePrivateOutputDirectory(outputDir) {
    await mkdir(outputDir, { mode: 0o700, recursive: true });
    const metadata = lstatSync(outputDir);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("output directory failed");
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
        throw new Error("output directory failed");
    }
    await chmod(outputDir, 0o700);
}

async function cleanupRows(generatedFiles) {
    await Promise.all(generatedFiles.map((path) => rm(path, { force: true })));
}

/**
 * Run a two-ref comparison or single-ref private row staging.
 * @param {object} providedOptions - Configurable refs, directories, and strict mode
 * @param {(line: string) => void} writeLine - Sanitized line writer
 * @returns {Promise<number>}
 */
export async function runCleanerDiff(providedOptions = {}, writeLine = console.log) {
    const {
        oldRef = "main",
        newRef = "worktree",
        ref = "worktree",
        repoDir = REPO,
        inputDir = join(REPO, "data/input"),
        outputDir = null,
        strict = false,
        tempRoot = tmpdir(),
    } = providedOptions;
    const options = { inputDir, repoDir, tempRoot };
    const generatedFiles = [];
    let retainSuccessfulRows = false;
    let exitCode = 1;

    try {
        const missingCount = Object.values(FILES).filter(
            (filename) => !existsSync(join(inputDir, filename)),
        ).length;
        if (missingCount > 0) {
            const status = strict ? "FAILED" : "SKIPPED";
            writeLine(`RESULT       ${status.padEnd(10)} missing-inputs=${missingCount}`);
            exitCode = strict ? 1 : 0;
        } else if (outputDir !== null) {
            await ensurePrivateOutputDirectory(outputDir);
            const results = await runVariant(ref, options, outputDir, generatedFiles);
            let errors = 0;

            for (const type of Object.keys(FILES)) {
                const result = results[type];
                const status = result.error ? "ERROR" : "STAGED";
                if (result.error) {
                    errors += 1;
                }
                writeLine(`${type.padEnd(12)} ${status.padEnd(10)} rows=${result.rows}`);
            }

            const failed = errors > 0;
            const status = failed ? "FAILED" : "STAGED";
            writeLine(
                `RESULT       ${status.padEnd(10)} types=${Object.keys(FILES).length} errors=${errors}`,
            );
            if (!failed) {
                retainSuccessfulRows = true;
                writeLine(`ROWS         RETAINED   files=${generatedFiles.length}`);
            }
            exitCode = failed ? 1 : 0;
        } else {
            const oldResults = await runVariant(oldRef, options, null, generatedFiles);
            const newResults = await runVariant(newRef, options, null, generatedFiles);
            let differing = 0;
            let errors = 0;

            for (const type of Object.keys(FILES)) {
                const oldResult = oldResults[type];
                const newResult = newResults[type];
                let status;
                if (oldResult.error || newResult.error) {
                    status = "ERROR";
                    errors += 1;
                } else if (oldResult.digest === newResult.digest) {
                    status = "IDENTICAL";
                } else {
                    status = "DIFFERS";
                    differing += 1;
                }
                writeLine(
                    `${type.padEnd(12)} ${status.padEnd(10)} old-rows=${oldResult.rows} new-rows=${newResult.rows}`,
                );
            }

            const failed = differing > 0 || errors > 0;
            const status = failed ? "FAILED" : "IDENTICAL";
            writeLine(
                `RESULT       ${status.padEnd(10)} types=${Object.keys(FILES).length} differing=${differing} errors=${errors}`,
            );
            exitCode = failed ? 1 : 0;
        }
    } catch {
        writeLine("RESULT       FAILED     comparison-errors=1");
        exitCode = 1;
    } finally {
        if (!retainSuccessfulRows) {
            try {
                await cleanupRows(generatedFiles);
            } catch {
                writeLine("RESULT       FAILED     cleanup-errors=1");
                exitCode = 1;
            }
        }
    }

    return exitCode;
}

/**
 * Run the command line interface without exposing raw errors.
 * @param {string[]} argv - Command line arguments
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2)) {
    let options;
    try {
        options = parseArgs(argv);
    } catch {
        console.error("RESULT       FAILED     invalid-options=1");
        return 1;
    }
    return runCleanerDiff(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = await main();
}
