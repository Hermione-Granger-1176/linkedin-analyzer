import { beforeEach, describe, expect, it, vi } from "vitest";
import writeXlsxFile from "write-excel-file/browser";

import { ExcelGenerator } from "../src/excel.js";

vi.mock("write-excel-file/browser", () => ({
    default: vi.fn(
        async () =>
            new Blob(["xlsx"], {
                type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            }),
    ),
}));

describe("ExcelGenerator", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        writeXlsxFile.mockClear();
        vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:excel");
        vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
        vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
        document.body.innerHTML = "";
    });

    it("generates a workbook from spec with hyperlinks", async () => {
        const blob = await ExcelGenerator.generateFromSpec({
            sheetName: "Sheet A",
            headers: ["Name", "Profile"],
            rows: [
                [
                    "Ada",
                    {
                        value: "https://linkedin.com/in/ada",
                        hyperlink: "https://linkedin.com/in/ada",
                    },
                ],
                ["Bob", ""],
            ],
            columnWidths: [5, "bad"],
            wrapColumns: [false, true],
        });

        expect(blob).toBeInstanceOf(Blob);
        expect(blob.type).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    });

    it("downloads a spec and returns success", async () => {
        const result = await ExcelGenerator.downloadFromSpec(
            {
                sheetName: "Export",
                headers: ["Name"],
                rows: [["Ada"]],
            },
            "export.xlsx",
        );

        expect(result.success).toBe(true);
        expect(URL.createObjectURL).toHaveBeenCalledOnce();
    });

    it("returns errors for invalid specs", async () => {
        const result = await ExcelGenerator.downloadFromSpec(
            {
                headers: ["Name"],
                rows: [["Ada"]],
            },
            "bad.xlsx",
        );

        expect(result.success).toBe(false);
        expect(result.error).toBeTruthy();
    });

    it("generateAndDownload uses default filename", async () => {
        const result = await ExcelGenerator.generateAndDownload(
            [
                {
                    Date: "2025-01-01 10:00:00",
                    ShareLink: "https://example.com",
                    ShareCommentary: "Hello",
                    SharedUrl: "",
                    MediaUrl: "",
                    Visibility: "PUBLIC",
                },
            ],
            "shares",
        );

        expect(result.success).toBe(true);
        expect(URL.createObjectURL).toHaveBeenCalledOnce();
    });

    it("generateAndDownload reports unknown file type", async () => {
        const result = await ExcelGenerator.generateAndDownload([{ Name: "Ada" }], "unknown");
        expect(result.success).toBe(false);
        expect(result.error).toBeTruthy();
    });

    // Validation errors from normalizeSpec.

    it("returns an error when downloadFromSpec receives a null spec", async () => {
        const result = await ExcelGenerator.downloadFromSpec(null, "out.xlsx");
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/Invalid sheet spec/i);
    });

    it("returns an error when downloadFromSpec is missing sheetName", async () => {
        const result = await ExcelGenerator.downloadFromSpec(
            {
                sheetName: "",
                headers: ["A"],
                rows: [["1"]],
            },
            "out.xlsx",
        );
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/non-empty sheetName/i);
    });

    it("returns an error when downloadFromSpec headers is not an array", async () => {
        const result = await ExcelGenerator.downloadFromSpec(
            {
                sheetName: "Test",
                headers: "not-an-array",
                rows: [["1"]],
            },
            "out.xlsx",
        );
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/headers must be an array/i);
    });

    it("returns an error when downloadFromSpec rows is not an array", async () => {
        const result = await ExcelGenerator.downloadFromSpec(
            {
                sheetName: "Test",
                headers: ["A"],
                rows: "not-an-array",
            },
            "out.xlsx",
        );
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/rows must be an array/i);
    });

    it("returns an error when downloadFromSpec contains a non-array row", async () => {
        const result = await ExcelGenerator.downloadFromSpec(
            {
                sheetName: "Test",
                headers: ["A"],
                rows: ["not-an-array"],
            },
            "out.xlsx",
        );
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/row must be an array/i);
    });

    it("handles hyperlink-only cell objects in generateFromSpec", async () => {
        // A cell with a hyperlink but no explicit value should fall back to the URL text.
        const blob = await ExcelGenerator.generateFromSpec({
            sheetName: "Links",
            headers: ["URL"],
            rows: [[{ hyperlink: "https://example.com" }]],
        });
        expect(blob).toBeInstanceOf(Blob);
    });

    it("preserves numeric cells and writes hyperlink formulas into the workbook", async () => {
        await ExcelGenerator.generateFromSpec({
            sheetName: "Metrics",
            headers: ["Name", "Messages", "Profile"],
            rows: [
                [
                    "Ada",
                    42,
                    {
                        value: "Ada profile",
                        hyperlink: "https://linkedin.com/in/ada",
                    },
                ],
            ],
        });

        expect(writeXlsxFile).toHaveBeenCalledTimes(1);

        const [sheetData] = writeXlsxFile.mock.calls[0];
        const messageCell = sheetData[1][1];
        const profileCell = sheetData[1][2];

        expect(messageCell).toEqual(
            expect.objectContaining({
                type: Number,
                value: 42,
            }),
        );
        expect(profileCell).toEqual(
            expect.objectContaining({
                type: "Formula",
                value: 'HYPERLINK("https://linkedin.com/in/ada","Ada profile")',
            }),
        );
    });
});
