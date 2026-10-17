// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
    auditState,
    formatLine,
    main,
    missingInputs,
    parseArgs,
} from "../../../scripts/checks/state-audit.mjs";
import { generateLargeExport } from "../../../scripts/fixtures/gen-large-export.mjs";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "state-audit-test-"));
const exportDir = join(root, "export");
generateLargeExport({ sizeMb: 1, dir: exportDir });

const loadFromRepo = (path) => import(resolve(REPO, `.${path}`));

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.gc;
});

describe("state-audit", () => {
    it("reads the input directory and strict flag", () => {
        expect(parseArgs([])).toEqual({ strict: false, inputDir: resolve(REPO, "data/input") });
        expect(parseArgs(["--strict", "--input-dir", "data/other"])).toEqual({
            strict: true,
            inputDir: resolve(REPO, "data/other"),
        });
    });

    it("names the export files that are missing", () => {
        expect(missingInputs(exportDir)).toEqual([]);
        expect(missingInputs(join(root, "absent"))).toEqual([
            "Shares.csv",
            "Comments.csv",
            "messages.csv",
            "Connections.csv",
        ]);
    });

    it("formats a report line in megabytes, with an optional note", () => {
        expect(formatLine("rows messages", 2_500_000, "10 rows")).toBe(
            `STATE  ${"rows messages".padEnd(30)}     2.5 MB  10 rows`,
        );
        expect(formatLine("analytics state", 0)).toBe(
            `STATE  ${"analytics state".padEnd(30)}     0.0 MB`,
        );
    });

    it("reports every structure for a real export", async () => {
        const lines = [];
        await auditState({
            inputDir: exportDir,
            load: loadFromRepo,
            used: () => 0,
            log: (line) => lines.push(line),
        });

        const labels = lines.map((line) => line.slice(7, 37).trim());
        expect(labels).toEqual([
            "input Shares.csv",
            "input Comments.csv",
            "input messages.csv",
            "input Connections.csv",
            "rows messages",
            "rows connections",
            "rows shares",
            "rows comments",
            "page messages + connections",
            "connections",
            "messages.events",
            "messages.rowTimestamps",
            "messages.contacts",
            "messages.talkedNameKeys",
            "messages.talkedUrlKeys",
            "messages.outreach",
            "analytics state",
        ]);
        expect(lines.find((line) => line.includes("rows messages"))).toMatch(/[1-9]\d* rows$/);
    });

    it("refuses to run without garbage collection exposed", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        expect(await main([])).toBe(2);
        expect(error).toHaveBeenCalledWith(expect.stringContaining("--expose-gc"));
    });

    it("skips a missing export, failing only under strict", async () => {
        globalThis.gc = () => {};
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const absent = join(root, "absent");

        expect(await main(["--input-dir", absent])).toBe(0);
        expect(await main(["--input-dir", absent, "--strict"])).toBe(1);
        expect(log).toHaveBeenCalledWith(expect.stringContaining("SKIP: missing Shares.csv"));
    });

    it("loads the modules through Vite and closes the server", async () => {
        globalThis.gc = () => {};
        vi.spyOn(console, "log").mockImplementation(() => {});
        const close = vi.fn(async () => {});
        const createViteServer = vi.fn(async () => ({ ssrLoadModule: loadFromRepo, close }));

        expect(await main(["--input-dir", exportDir], { createViteServer })).toBe(0);
        expect(createViteServer).toHaveBeenCalledWith(
            expect.objectContaining({ mode: "measurement", root: REPO }),
        );
        expect(close).toHaveBeenCalledTimes(1);
    });

    it("closes the server when the audit fails", async () => {
        globalThis.gc = () => {};
        const close = vi.fn(async () => {});
        const createViteServer = async () => ({
            ssrLoadModule: async () => {
                throw new Error("load failed");
            },
            close,
        });

        await expect(main(["--input-dir", exportDir], { createViteServer })).rejects.toThrow(
            "load failed",
        );
        expect(close).toHaveBeenCalledTimes(1);
    });
});
