import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/features/cleaning/excel.js", () => ({
    ExcelGenerator: { generate: vi.fn(async () => new Blob(["xlsx"])) },
}));

const SHARES_CSV = [
    "Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility",
    ...Array.from(
        { length: 7 },
        (_, index) =>
            `"2025-01-0${index + 1} 10:00:00 UTC","https://www.linkedin.com/feed/update/urn:li:activity:${index}","Post ${index}","","","PUBLIC"`,
    ),
].join("\n");

let runCleanJob;
let PREVIEW_ROW_LIMIT;
let LinkedInCleaner;
let ExcelGenerator;

describe("clean job", () => {
    beforeEach(async () => {
        vi.resetModules();
        ({ runCleanJob, PREVIEW_ROW_LIMIT } =
            await import("../../../src/features/cleaning/clean-job.js"));
        ({ LinkedInCleaner } = await import("../../../src/features/cleaning/cleaner.js"));
        ({ ExcelGenerator } = await import("../../../src/features/cleaning/excel.js"));
        ExcelGenerator.generate.mockClear();
    });

    it("returns only the preview rows and the row count", async () => {
        const reply = await runCleanJob({
            fileType: "shares",
            output: "preview",
            source: SHARES_CSV,
            key: "shares:1",
        });

        expect(reply.success).toBe(true);
        expect(reply.rowCount).toBe(7);
        expect(reply.previewRows).toHaveLength(PREVIEW_ROW_LIMIT);
        const headers = LinkedInCleaner.configs.shares.columns.map((column) => column.name);
        expect(reply.previewRows[0]).toHaveLength(headers.length);
        expect(reply.previewRows[0]).toContain("Post 0");
        expect(reply.blob).toBeNull();
    });

    it("reuses the rows it cleaned for the same stored upload", async () => {
        const process = vi.spyOn(LinkedInCleaner, "process");
        const payload = { fileType: "shares", source: new Blob([SHARES_CSV]), key: "shares:2" };

        await runCleanJob({ ...payload, output: "preview" });
        const csv = await runCleanJob({ ...payload, output: "csv" });

        expect(process).toHaveBeenCalledTimes(1);
        expect(csv.blob.type).toBe("text/csv;charset=utf-8");
        expect(await csv.blob.text()).toContain("Post 6");

        await runCleanJob({ ...payload, key: "shares:3", output: "preview" });
        expect(process).toHaveBeenCalledTimes(2);
    });

    it("builds an Excel workbook within the size limit and refuses one over it", async () => {
        const reply = await runCleanJob({
            fileType: "shares",
            output: "xlsx",
            source: SHARES_CSV,
            key: "shares:4",
        });
        expect(reply.success).toBe(true);
        expect(reply.blob).toBeInstanceOf(Blob);
        expect(ExcelGenerator.generate).toHaveBeenCalledWith(expect.any(Array), "shares");

        vi.spyOn(LinkedInCleaner, "process").mockReturnValue({
            success: true,
            cleanedData: [],
            rowCount: 0,
        });
        const large = new Blob([new Uint8Array(10 * 1024 * 1024 + 1)]);
        const refused = await runCleanJob({
            fileType: "shares",
            output: "xlsx",
            source: large,
            key: "shares:5",
        });
        expect(refused.success).toBe(false);
        expect(refused.error).toContain("too large to build an Excel file");
        expect(ExcelGenerator.generate).toHaveBeenCalledTimes(1);
    });

    it("reports the cleaner's own error for a file it cannot parse", async () => {
        const reply = await runCleanJob({
            fileType: "shares",
            output: "preview",
            source: "not,a,shares,file",
            key: "shares:6",
        });

        expect(reply.success).toBe(false);
        expect(reply.error).toBeTruthy();
        expect(reply.previewRows).toEqual([]);

        vi.spyOn(LinkedInCleaner, "process").mockReturnValue({ success: false });
        const fallback = await runCleanJob({
            fileType: "shares",
            output: "preview",
            source: SHARES_CSV,
            key: "shares:7",
        });
        expect(fallback.error).toBe("Unable to parse file.");
    });

    it("previews a missing cell as empty text", async () => {
        vi.spyOn(LinkedInCleaner, "process").mockReturnValue({
            success: true,
            cleanedData: [{ Date: null }],
            rowCount: 1,
        });

        const reply = await runCleanJob({
            fileType: "shares",
            output: "preview",
            source: SHARES_CSV,
            key: "shares:8",
        });

        expect(reply.previewRows[0].every((cell) => cell === "")).toBe(true);
    });
});
