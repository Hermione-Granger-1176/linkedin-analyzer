import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
    CREATE_COMMIT_MUTATION,
    isCliEntrypoint,
    parseDiffOutput,
} from "../../.github/actions/verified-commit/verified-commit.mjs";

describe("verified commit action helpers", () => {
    it("keeps the createCommitOnBranch mutation fully closed", () => {
        expect(CREATE_COMMIT_MUTATION).toContain("mutation ($input: CreateCommitOnBranchInput!)");
        expect(CREATE_COMMIT_MUTATION.trim().endsWith("}")).toBe(true);

        const opens = [...CREATE_COMMIT_MUTATION.matchAll(/\{/gu)].length;
        const closes = [...CREATE_COMMIT_MUTATION.matchAll(/\}/gu)].length;
        expect(closes).toBe(opens);
    });

    it("detects direct CLI execution from absolute or relative argv paths", () => {
        const actionPath = ".github/actions/verified-commit/verified-commit.mjs";
        const moduleUrl = pathToFileURL(path.resolve(actionPath)).href;

        expect(isCliEntrypoint(moduleUrl, actionPath)).toBe(true);
        expect(isCliEntrypoint(moduleUrl, path.resolve(actionPath))).toBe(true);
        expect(isCliEntrypoint(moduleUrl, "scripts/other.mjs")).toBe(false);
        expect(isCliEntrypoint(moduleUrl, undefined)).toBe(false);
    });

    it("uses the destination path for copied files in GraphQL additions", () => {
        const result = parseDiffOutput("C100\told.txt\tnew.txt", {
            existsSync: (filePath) => filePath === "new.txt",
            readFileSync: (filePath) => Buffer.from(`contents:${filePath}`),
        });

        expect(result.deletions).toEqual([]);
        expect(result.additions).toEqual([
            {
                path: "new.txt",
                contents: Buffer.from("contents:new.txt").toString("base64"),
            },
        ]);
    });
});
