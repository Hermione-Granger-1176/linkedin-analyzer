/*
 * Differential check: run two versions of web/src/cleaner.js over the real
 * export in data/input and compare sha256 of the cleaned rows per file type.
 *
 * Usage (prefer the Makefile):
 *   make cleaner-diff                       # main vs working tree
 *   make cleaner-diff args="<oldRef> <newRef>"
 *   node scripts/checks/cleaner-diff.mjs [oldRef] [newRef]
 *
 * Defaults: oldRef=main, newRef=worktree (current working tree files).
 *
 * Generated output never lands in the repo. The newRef cleaned rows are dumped
 * to a temp folder ($TMPDIR/linkedin-analyzer/checks-out, override with
 * LIA_CHECKS_OUT) so the cross-runtime check (xrt-diff.py) can read them.
 *
 * Requires your private LinkedIn export in data/input (never committed). The
 * script skips cleanly when those files are absent.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const INPUT = join(REPO, "data/input");
const OUT_DIR = process.env.LIA_CHECKS_OUT || join(tmpdir(), "linkedin-analyzer", "checks-out");
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

const [oldRef = "main", newRef = "worktree"] = process.argv.slice(2);

const missing = Object.values(FILES).filter((name) => !existsSync(join(INPUT, name)));
if (missing.length > 0) {
    console.log(
        `SKIP: no local export in data/input (missing: ${missing.join(", ")}). ` +
            "This check needs your private LinkedIn export.",
    );
    process.exit(0);
}

function stage(ref) {
    const dir = mkdtempSync(join(tmpdir(), `cleaner-${ref.replace(/[^\w.-]/g, "_")}-`));
    for (const mod of MODULES) {
        let src;
        if (ref === "worktree") {
            src = readFileSync(join(REPO, "web/src", mod), "utf8");
        } else {
            // Sibling modules may not exist at older refs (e.g. main predates the
            // module split); skip those rather than failing the whole stage.
            try {
                src = execFileSync("git", ["-C", REPO, "show", `${ref}:web/src/${mod}`], {
                    encoding: "utf8",
                });
            } catch {
                continue;
            }
        }
        writeFileSync(join(dir, mod), src);
    }
    return dir;
}

async function runVariant(ref, dumpDir) {
    const dir = stage(ref);
    const { LinkedInCleaner } = await import(join(dir, "cleaner.js"));
    const out = {};
    for (const [type, name] of Object.entries(FILES)) {
        const csv = await readFile(join(INPUT, name), "utf8");
        const r = LinkedInCleaner.process(csv, type);
        if (!r.success) {
            out[type] = { error: r.error };
            continue;
        }
        const canonical = JSON.stringify(r.cleanedData);
        out[type] = {
            rows: r.cleanedData.length,
            sha: createHash("sha256").update(canonical).digest("hex"),
        };
        if (dumpDir) {
            await writeFile(join(dumpDir, `${type}.json`), canonical);
        }
    }
    return out;
}

await mkdir(OUT_DIR, { recursive: true });
const oldResults = await runVariant(oldRef, null);
const newResults = await runVariant(newRef, OUT_DIR);

let failed = false;
for (const type of Object.keys(FILES)) {
    const o = oldResults[type];
    const n = newResults[type];
    const match = o.sha && o.sha === n.sha ? "IDENTICAL" : "DIFFERS";
    if (match === "DIFFERS") {
        failed = true;
    }
    const oldCol = `${oldRef}: rows=${o.rows ?? "ERR"} sha=${(o.sha ?? o.error).slice(0, 16)}`;
    const newCol = `${newRef}: rows=${n.rows ?? "ERR"} sha=${(n.sha ?? n.error).slice(0, 16)}`;
    console.log(`${type.padEnd(12)} ${match.padEnd(10)} ${oldCol}  ${newCol}`);
}
console.log(`\nrows dumped to ${OUT_DIR}`);
console.log(
    failed
        ? "RESULT: output changed — inspect before shipping."
        : "RESULT: behavior-preserving on real data.",
);
process.exitCode = failed ? 1 : 0;
