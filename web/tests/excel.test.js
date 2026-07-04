import { beforeEach, describe, expect, it, vi } from "vitest";
import writeXlsxFile from "write-excel-file/browser";

import { ExcelGenerator } from "../src/excel.js";

vi.mock("write-excel-file/browser", () => ({
    default: vi.fn(() => ({
        toBlob: vi.fn(
            async () =>
                new Blob(["xlsx"], {
                    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                }),
        ),
    })),
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

    it("writes boolean and date cells with their native types", async () => {
        const when = new Date(2024, 0, 2);
        await ExcelGenerator.generateFromSpec({
            sheetName: "Types",
            headers: ["Flag", "When"],
            rows: [[true, when]],
        });

        const [sheetData] = writeXlsxFile.mock.calls[0];
        expect(sheetData[1][0]).toEqual(expect.objectContaining({ type: Boolean, value: true }));
        expect(sheetData[1][1]).toEqual(expect.objectContaining({ type: Date, value: when }));
    });

    it("renders null cells as empty strings", async () => {
        // Omitting columnWidths forces the auto-width path, which reads every
        // cell (and the header) through valueToText.
        await ExcelGenerator.generateFromSpec({
            sheetName: "Blanks",
            headers: ["", "Value"],
            rows: [[null, null]],
        });

        const [sheetData] = writeXlsxFile.mock.calls[0];
        expect(sheetData[1][0]).toEqual(expect.objectContaining({ type: String, value: "" }));
    });

    it("ignores a non-string hyperlink and keeps the plain value", async () => {
        await ExcelGenerator.generateFromSpec({
            sheetName: "Links",
            headers: ["Profile"],
            rows: [[{ value: "Ada", hyperlink: 123 }]],
        });

        const [sheetData] = writeXlsxFile.mock.calls[0];
        // A non-string hyperlink is dropped, so the cell stays a plain value
        // rather than becoming a HYPERLINK formula.
        expect(sheetData[1][0]).toEqual(expect.objectContaining({ type: String, value: "Ada" }));
        expect(sheetData[1][0].type).not.toBe("Formula");
    });

    it("pads rows shorter than the header with empty cells", async () => {
        await ExcelGenerator.generateFromSpec({
            sheetName: "Short",
            headers: ["A", "B"],
            rows: [["only-one"]],
        });

        const [sheetData] = writeXlsxFile.mock.calls[0];
        expect(sheetData[1]).toHaveLength(2);
        expect(sheetData[1][1]).toEqual(expect.objectContaining({ value: "" }));
    });

    it("fills missing data fields with empty strings when generating by type", async () => {
        const blob = await ExcelGenerator.generate([{ Date: "2025-01-01 10:00:00" }], "shares");
        expect(blob).toBeInstanceOf(Blob);
        const [sheetData] = writeXlsxFile.mock.calls[0];
        // Columns absent from the source row are written as blank cells.
        expect(sheetData[1].some((cell) => cell.value === "")).toBe(true);
    });

    it("stringifies a non-Error thrown by downloadFromSpec", async () => {
        writeXlsxFile.mockImplementationOnce(() => {
            throw "raw-string-failure";
        });
        const result = await ExcelGenerator.downloadFromSpec(
            { sheetName: "X", headers: ["A"], rows: [["1"]] },
            "x.xlsx",
        );
        expect(result.success).toBe(false);
        expect(result.error).toBe("raw-string-failure");
    });

    it("stringifies a non-Error thrown by generateAndDownload", async () => {
        writeXlsxFile.mockImplementationOnce(() => {
            throw "raw-string-failure";
        });
        const result = await ExcelGenerator.generateAndDownload(
            [{ Date: "2025-01-01 10:00:00" }],
            "shares",
        );
        expect(result.success).toBe(false);
        expect(result.error).toBe("raw-string-failure");
    });

    it("uses write-excel-file v4 browser workbook options", async () => {
        await ExcelGenerator.generateFromSpec({
            sheetName: "Metrics",
            headers: ["Name"],
            rows: [["Ada"]],
            columnWidths: [16],
        });

        expect(writeXlsxFile).toHaveBeenCalledWith(
            expect.any(Array),
            {
                sheet: "Metrics",
                columns: [{ width: 16 }],
            },
            {
                fontFamily: "Calibri",
                fontSize: 11,
            },
        );
        expect(writeXlsxFile.mock.results[0].value.toBlob).toHaveBeenCalledOnce();
    });
});
