/**
 * Excel generation module.
 * Uses write-excel-file for browser-safe XLSX creation.
 */

import writeXlsxFile from "write-excel-file/browser";

import { LinkedInCleaner } from "./cleaner.js";

export const ExcelGenerator = (() => {
    "use strict";

    const HEADER_BACKGROUND = "rgba(232, 232, 232, 1)";
    const HEADER_BORDER = "rgba(0, 0, 0, 1)";
    const DATA_BORDER = "rgba(204, 204, 204, 1)";
    const HEADER_ROW_HEIGHT = 25;
    const DATA_ROW_HEIGHT = 20;
    const MIN_COLUMN_WIDTH = 10;
    const MAX_COLUMN_WIDTH = 60;

    function getConfig(fileType) {
        const config = LinkedInCleaner.configs[fileType];
        if (!config) {
            throw new Error(`Unknown file type: ${fileType}`);
        }
        return config;
    }

    function normalizeCell(rawCell) {
        if (rawCell && typeof rawCell === "object" && !Array.isArray(rawCell)) {
            const hasStructuredShape =
                Object.prototype.hasOwnProperty.call(rawCell, "value") ||
                Object.prototype.hasOwnProperty.call(rawCell, "hyperlink");

            if (hasStructuredShape) {
                const hyperlink =
                    typeof rawCell.hyperlink === "string" ? rawCell.hyperlink.trim() : "";
                const value = Object.prototype.hasOwnProperty.call(rawCell, "value")
                    ? rawCell.value
                    : hyperlink;
                return { value, hyperlink };
            }
        }

        return { value: rawCell, hyperlink: "" };
    }

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

    function isFiniteNumber(value) {
        return typeof value === "number" && Number.isFinite(value);
    }

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

    function normalizeCellValue(value, type) {
        if (value === null || typeof value === "undefined") {
            return "";
        }
        if (type === Number || type === Boolean || type === Date) {
            return value;
        }
        return String(value);
    }

    function clampWidth(width) {
        if (!Number.isFinite(width)) {
            return MIN_COLUMN_WIDTH;
        }
        return Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, width));
    }

    function computeColumnWidths(headers, rows) {
        return headers.map((header, colIdx) => {
            const maxLength = rows.reduce(
                (currentMax, row) => Math.max(currentMax, valueToText(row[colIdx]).length),
                valueToText(header).length,
            );

            return clampWidth(maxLength + 2);
        });
    }

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

    function createValueCell(cell, wrap) {
        const text = valueToText(cell);
        const type = getCellType(cell.value);
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
            textColor: "rgba(5, 99, 193, 1)",
            textDecoration: { underline: true },
        };
    }

    function createSheetData(headers, rows, wrapColumns) {
        const headerRow = headers.map(createHeaderCell);
        const dataRows = rows.map((row) =>
            row.map((cell, index) => createValueCell(cell, wrapColumns[index])),
        );
        return [headerRow, ...dataRows];
    }

    async function generateFromSpec(spec) {
        const normalizedSpec = normalizeSpec(spec);
        const data = createSheetData(
            normalizedSpec.headers,
            normalizedSpec.rows,
            normalizedSpec.wrapColumns,
        );

        return writeXlsxFile(data, {
            sheet: normalizedSpec.sheetName,
            columns: normalizedSpec.columnWidths.map((width) => ({ width })),
            fontFamily: "Calibri",
            fontSize: 11,
        });
    }

    async function downloadFromSpec(spec, filename) {
        try {
            const blob = await generateFromSpec(spec);
            download(blob, filename);
            return { success: true, error: null };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }

    function createSpecFromDataAndType(data, fileType) {
        const config = getConfig(fileType);
        const headers = config.columns.map((column) => column.name);
        const rows = data.map((row) => headers.map((header) => row[header] ?? ""));

        const sheetNames = {
            shares: "Shares",
            comments: "Comments",
            messages: "Messages",
            connections: "Connections",
        };

        return {
            sheetName: sheetNames[fileType] || "Sheet1",
            headers,
            rows,
            columnWidths: config.columns.map((column) => column.width),
            wrapColumns: config.columns.map((column) => Boolean(column.wrapText)),
        };
    }

    async function generate(data, fileType) {
        const spec = createSpecFromDataAndType(data, fileType);
        return generateFromSpec(spec);
    }

    function download(blob, filename) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    async function generateAndDownload(data, fileType, customFilename = null) {
        try {
            const blob = await generate(data, fileType);
            const filename = customFilename || getConfig(fileType).outputName;
            download(blob, filename);
            return { success: true, error: null };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }

    return {
        generate,
        generateAndDownload,
        generateFromSpec,
        downloadFromSpec,
    };
})();
