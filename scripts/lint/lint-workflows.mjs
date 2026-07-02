import { createLinter } from "actionlint";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

async function listWorkflowFiles() {
    const workflowDir = path.join(REPO_ROOT, ".github", "workflows");
    const entries = await readdir(workflowDir, { withFileTypes: true });

    return entries
        .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
        .map((entry) => path.posix.join(".github/workflows", entry.name))
        .sort();
}

function isAllowedFalsePositive(result) {
    // actionlint cannot know repository-level GitHub Actions variables at lint time.
    // Its diagnostic only names the "vars" context and does not include the
    // property path, so this allowlist cannot be narrowed to specific variables.
    return result.message.includes('undefined variable "vars"');
}

async function main() {
    const workflowFiles = await listWorkflowFiles();
    let hasErrors = false;

    for (const relativePath of workflowFiles) {
        const lint = await createLinter();
        const filePath = path.join(REPO_ROOT, relativePath);
        const content = await readFile(filePath, "utf-8");
        let results;
        try {
            results = lint(content, relativePath).filter(
                (result) => !isAllowedFalsePositive(result),
            );
        } catch (error) {
            throw new Error(`Failed to lint ${relativePath}`, { cause: error });
        }

        if (results.length > 0) {
            hasErrors = true;
            process.stderr.write(
                results
                    .map(
                        (result) =>
                            `${result.file}:${result.line}:${result.column}: ${result.message} [${result.kind}]\n`,
                    )
                    .join(""),
            );
        }
    }

    if (hasErrors) {
        process.exitCode = 1;
        return;
    }

    process.stdout.write(`Workflow lint passed for ${workflowFiles.length} file(s)\n`);
}

main().catch((error) => {
    process.stderr.write(
        `${error instanceof Error ? error.stack || error.message : String(error)}\n`,
    );
    process.exitCode = 1;
});
