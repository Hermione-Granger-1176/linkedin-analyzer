import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
    CREATE_COMMIT_MUTATION,
    isCliEntrypoint,
    parseDiffOutput,
    selectReusablePull,
} from "../../../.github/actions/verified-commit/verified-commit.mjs";

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
            existsSync: () => false,
            readFileSync: (filePath) => Buffer.from(`working-tree:${filePath}`),
            readStagedFileSync: (filePath) => Buffer.from(`staged:${filePath}`),
        });

        expect(result.deletions).toEqual([]);
        expect(result.additions).toEqual([
            {
                path: "new.txt",
                contents: Buffer.from("staged:new.txt").toString("base64"),
            },
        ]);
    });

    it("reuses the pull request the branch reset closed instead of opening another", () => {
        const closedByReset = { number: 217, state: "closed", merged_at: null };

        expect(selectReusablePull([closedByReset])).toBe(closedByReset);
    });

    it("prefers an open pull request and never revives a merged one", () => {
        const merged = { number: 214, state: "closed", merged_at: "2026-08-01T07:00:00Z" };
        const open = { number: 219, state: "open", merged_at: null };

        expect(selectReusablePull([merged, open])).toBe(open);
        expect(selectReusablePull([merged])).toBeUndefined();
        expect(selectReusablePull([])).toBeUndefined();
    });

    it("picks the newest reusable pull request when several exist", () => {
        const older = { number: 217, state: "closed", merged_at: null };
        const newer = { number: 219, state: "closed", merged_at: null };

        expect(selectReusablePull([older, newer])).toBe(newer);
    });
});
