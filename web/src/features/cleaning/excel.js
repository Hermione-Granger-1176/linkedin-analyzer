/**
 * Excel generation module.
 * Uses write-excel-file for browser-safe XLSX creation.
 */

import { FILE_TYPE_LABELS } from "../../shared/constants.js";
import { downloadBlob } from "../../shared/ui/download.js";

import { LinkedInCleaner } from "./cleaner.js";

/** @typedef {import("write-excel-file/browser").CellObject} CellObject */
/** @typedef {import("write-excel-file/browser").Value} CellValue */
/** @typedef {StringConstructor|NumberConstructor|BooleanConstructor|DateConstructor} CellTypeName */

/**
 * A sheet cell as given in a spec: a plain value, or `{value, hyperlink}` for a link.
 * @typedef {unknown} SheetCellInput
 */

/**
 * A worksheet to build: headers, rows of cells in header order, and optional layout.
 * @typedef {object} SheetSpec
 * @property {string} sheetName - Worksheet name
 * @property {string[]} headers - Header row
 * @property {SheetCellInput[][]} rows - Data rows, cells in header order
 * @property {number[]} [columnWidths] - Column widths; computed from content when omitted
 * @property {boolean[]} [wrapColumns] - Per-column text wrapping
 */

/**
 * A cell after normalization.
 * @typedef {object} NormalizedCell
 * @property {unknown} value - Cell value
 * @property {string} hyperlink - Link target, or "" for a plain cell
 */

/**
 * A validated sheet spec with every row padded to the header width.
 * @typedef {object} NormalizedSheetSpec
 * @property {string} sheetName - Trimmed worksheet name
 * @property {string[]} headers - Header row
 * @property {NormalizedCell[][]} rows - Normalized data rows
 * @property {number[]} columnWidths - Clamped column widths
 * @property {boolean[]} wrapColumns - Per-column text wrapping
 */

/**
 * Outcome of a download attempt.
 * @typedef {{success: boolean, error: string|null}} DownloadResult
 */

export const ExcelGenerator = (() => {
    "use strict";

    // write-excel-file requires hex colors (throws if not "#" prefixed)
    const HEADER_BACKGROUND = "#E8E8E8";
    const HEADER_BORDER = "#000000";
    const DATA_BORDER = "#CCCCCC";
    const HEADER_ROW_HEIGHT = 25;
    const DATA_ROW_HEIGHT = 20;
    const MIN_COLUMN_WIDTH = 10;
    const MAX_COLUMN_WIDTH = 60;

    /**
     * Look up a file type's config, throwing for an unknown type.
     * @param {string} fileType - Cleaner file type
     * @returns {import("./configs.js").CleanerConfig}
     */
    function getConfig(fileType) {
        const config = LinkedInCleaner.configs[fileType];
        if (!config) {
            throw new Error(`Unknown file type: ${fileType}`);
        }
        return config;
    }

    /**
     * Normalize a spec cell to `{value, hyperlink}`.
     * @param {SheetCellInput} rawCell - Raw cell
     * @returns {NormalizedCell}
     */
    function normalizeCell(rawCell) {
        if (rawCell && typeof rawCell === "object" && !Array.isArray(rawCell)) {
            const cellObject = /** @type {{value?: unknown, hyperlink?: unknown}} */ (rawCell);
            const hasStructuredShape =
                Object.prototype.hasOwnProperty.call(rawCell, "value") ||
                Object.prototype.hasOwnProperty.call(rawCell, "hyperlink");

            if (hasStructuredShape) {
                const hyperlink =
                    typeof cellObject.hyperlink === "string" ? cellObject.hyperlink.trim() : "";
                const value = Object.prototype.hasOwnProperty.call(rawCell, "value")
                    ? cellObject.value
                    : hyperlink;
                return { value, hyperlink };
            }
        }

        return { value: rawCell, hyperlink: "" };
    }

    /**
     * Display text of a header or normalized cell.
     * @param {NormalizedCell|string} cell - Header text or normalized cell
     * @returns {string}
     */
    function valueToText(cell) {
        if (!cell) {
            return "";
        }
        if (typeof cell === "string") {
            return cell;
        }
        if (cell.value === null || typeof cell.value === "undefined") {
            return "";
        }
        return String(cell.value);
    }

    /**
     * @param {unknown} value - Cell value
     * @returns {value is number}
     */
    function isFiniteNumber(value) {
        return typeof value === "number" && Number.isFinite(value);
    }

    /**
     * Pick the write-excel-file cell type for a value.
     * @param {unknown} value - Cell value
     * @returns {CellTypeName}
     */
    function getCellType(value) {
        if (isFiniteNumber(value)) {
            return Number;
        }
        if (typeof value === "boolean") {
            return Boolean;
        }
        if (value instanceof Date && Number.isFinite(value.getTime())) {
            return Date;
        }
        return String;
    }

    /**
     * Coerce a value to what its cell type expects.
     * @param {unknown} value - Cell value
     * @param {CellTypeName} type - Cell type from getCellType()
     * @returns {CellValue}
     */
    function normalizeCellValue(value, type) {
        if (value === null || typeof value === "undefined") {
            return "";
        }
        if (type === Number || type === Boolean || type === Date) {
            // getCellType() only picks these types for a matching value.
            return /** @type {number|boolean|Date} */ (value);
        }
        return String(value);
    }

    /**
     * @param {number} width - Requested width
     * @returns {number} Width clamped to the allowed range
     */
    function clampWidth(width) {
        if (!Number.isFinite(width)) {
            return MIN_COLUMN_WIDTH;
        }
        return Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, width));
    }

    /**
     * Size each column to its longest text.
     * @param {string[]} headers - Header row
     * @param {NormalizedCell[][]} rows - Normalized rows
     * @returns {number[]}
     */
    function computeColumnWidths(headers, rows) {
        return headers.map((header, colIdx) => {
            const maxLength = rows.reduce(
                (currentMax, row) => Math.max(currentMax, valueToText(row[colIdx]).length),
                valueToText(header).length,
            );

            return clampWidth(maxLength + 2);
        });
    }

    /**
     * Validate a sheet spec and normalize its rows, widths, and wrapping.
     * @param {SheetSpec} spec - Sheet spec
     * @returns {NormalizedSheetSpec}
     */
    function normalizeSpec(spec) {
        if (!spec || typeof spec !== "object") {
            throw new Error("Invalid sheet spec");
        }

        const { sheetName, headers, rows, columnWidths, wrapColumns } = spec;

        if (typeof sheetName !== "string" || !sheetName.trim()) {
            throw new Error("Sheet spec requires a non-empty sheetName");
        }

        if (!Array.isArray(headers)) {
            throw new Error("Sheet spec headers must be an array");
        }

        if (!Array.isArray(rows)) {
            throw new Error("Sheet spec rows must be an array");
        }

        const normalizedRows = rows.map((row) => {
            if (!Array.isArray(row)) {
                throw new Error("Each sheet spec row must be an array");
            }

            return headers.map((_, index) => {
                if (index >= row.length) {
                    return normalizeCell("");
                }
                return normalizeCell(row[index]);
            });
        });

        const normalizedWidths = Array.isArray(columnWidths)
            ? headers.map((_, index) => clampWidth(Number(columnWidths[index])))
            : computeColumnWidths(headers, normalizedRows);

        const normalizedWrapColumns = headers.map((_, index) =>
            Boolean(wrapColumns && wrapColumns[index]),
        );

        return {
            sheetName: sheetName.trim(),
            headers,
            rows: normalizedRows,
            columnWidths: normalizedWidths,
            wrapColumns: normalizedWrapColumns,
        };
    }

    /**
     * @param {string} value - Header text
     * @returns {CellObject}
     */
    function createHeaderCell(value) {
        return {
            type: String,
            value,
            fontWeight: "bold",
            backgroundColor: HEADER_BACKGROUND,
            align: "center",
            alignVertical: "center",
            height: HEADER_ROW_HEIGHT,
            borderStyle: "thin",
            borderColor: HEADER_BORDER,
        };
    }

    /**
     * @param {NormalizedCell} cell - Normalized cell
     * @param {boolean} wrap - Whether to wrap text
     * @returns {CellObject}
     */
    function createValueCell(cell, wrap) {
        const text = valueToText(cell);
        const type = getCellType(cell.value);
        /** @type {CellObject} */
        const baseCell = {
            type,
            value: normalizeCellValue(cell.value, type),
            alignVertical: "top",
            wrap,
            height: DATA_ROW_HEIGHT,
            bottomBorderStyle: "thin",
            bottomBorderColor: DATA_BORDER,
        };

        if (!cell.hyperlink) {
            return baseCell;
        }

        const escapedUrl = cell.hyperlink.replace(/"/g, '""');
        const escapedText = text.replace(/"/g, '""');
        return {
            ...baseCell,
            type: "Formula",
            value: `HYPERLINK("${escapedUrl}","${escapedText}")`,
            textColor: "#0563C1",
            textDecoration: { underline: true },
        };
    }

    /**
     * @param {string[]} headers - Header row
     * @param {NormalizedCell[][]} rows - Normalized rows
     * @param {boolean[]} wrapColumns - Per-column text wrapping
     * @returns {CellObject[][]}
     */
    function createSheetData(headers, rows, wrapColumns) {
        const headerRow = headers.map(createHeaderCell);
        const dataRows = rows.map((row) =>
            row.map((cell, index) => createValueCell(cell, wrapColumns[index])),
        );
        return [headerRow, ...dataRows];
    }

    /**
     * @param {NormalizedSheetSpec} spec - Normalized spec
     * @returns {{sheet: string, columns: Array<{width: number}>}}
     */
    function createSheetOptions(spec) {
        return {
            sheet: spec.sheetName,
            columns: spec.columnWidths.map((width) => ({ width })),
        };
    }

    function createWorkbookOptions() {
        return {
            fontFamily: "Calibri",
            fontSize: 11,
        };
    }

    /**
     * Build a workbook Blob from a sheet spec.
     * @param {SheetSpec} spec - Sheet spec
     * @returns {Promise<Blob>}
     */
    async function generateFromSpec(spec) {
        const normalizedSpec = normalizeSpec(spec);
        const data = createSheetData(
            normalizedSpec.headers,
            normalizedSpec.rows,
            normalizedSpec.wrapColumns,
        );
        // Loaded on demand so the export library stays out of the initial bundle
        // and only downloads when a user actually generates a workbook.
        const { default: writeXlsxFile } = await import("write-excel-file/browser");
        const workbook = writeXlsxFile(
            data,
            createSheetOptions(normalizedSpec),
            createWorkbookOptions(),
        );

        return workbook.toBlob();
    }

    /**
     * Run a download and report how it ended, so a failure reaches the caller as a result.
     * @param {() => Promise<void>} work - Builds and saves the workbook
     * @returns {Promise<DownloadResult>}
     */
    async function toDownloadResult(work) {
        try {
            await work();
            return { success: true, error: null };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }

    /**
     * Build and download a workbook from a sheet spec.
     * @param {SheetSpec} spec - Sheet spec
     * @param {string} filename - Download file name
     * @returns {Promise<DownloadResult>}
     */
    function downloadFromSpec(spec, filename) {
        return toDownloadResult(async () => {
            downloadBlob(await generateFromSpec(spec), filename);
        });
    }

    /**
     * @param {import("./cleaner.js").CleanedRow[]} data - Cleaned rows
     * @param {string} fileType - Cleaner file type
     * @returns {SheetSpec}
     */
    function createSpecFromDataAndType(data, fileType) {
        const config = getConfig(fileType);
        const headers = config.columns.map((column) => column.name);
        const rows = data.map((row) => headers.map((header) => row[header] ?? ""));

        return {
            // Known file types have labels. Use "Sheet1" for malformed config.
            /* v8 ignore next */
            sheetName:
                /** @type {Readonly<Record<string, string|undefined>>} */ (FILE_TYPE_LABELS)[
                    fileType
                ] || "Sheet1",
            headers,
            rows,
            columnWidths: config.columns.map((column) => column.width),
            wrapColumns: config.columns.map((column) => Boolean(column.wrapText)),
        };
    }

    /**
     * Build the workbook Blob for cleaned rows of one file type.
     * @param {import("./cleaner.js").CleanedRow[]} data - Cleaned rows
     * @param {string} fileType - Cleaner file type
     * @returns {Promise<Blob>}
     */
    async function generate(data, fileType) {
        const spec = createSpecFromDataAndType(data, fileType);
        return generateFromSpec(spec);
    }

    /**
     * Build and download the workbook for cleaned rows of one file type.
     * @param {import("./cleaner.js").CleanedRow[]} data - Cleaned rows
     * @param {string} fileType - Cleaner file type
     * @param {string|null} [customFilename=null] - File name override
     * @returns {Promise<DownloadResult>}
     */
    function generateAndDownload(data, fileType, customFilename = null) {
        return toDownloadResult(async () => {
            const blob = await generate(data, fileType);
            downloadBlob(blob, customFilename || getConfig(fileType).outputName);
        });
    }

    return {
        download: downloadBlob,
        generate,
        generateAndDownload,
        generateFromSpec,
        downloadFromSpec,
    };
})();
