import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ExcelGenerator } from '../src/excel.js';

describe('ExcelGenerator', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:excel');
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        document.body.innerHTML = '';
    });

    it('generates a workbook from spec with hyperlinks', () => {
        const blob = ExcelGenerator.generateFromSpec({
            sheetName: 'Sheet A',
            headers: ['Name', 'Profile'],
            rows: [
                ['Ada', { value: 'https://linkedin.com/in/ada', hyperlink: 'https://linkedin.com/in/ada' }],
                ['Bob', '']
            ],
            columnWidths: [5, 'bad'],
            wrapColumns: [false, true]
        });

        expect(blob).toBeInstanceOf(Blob);
        expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    });

    it('downloads a spec and returns success', () => {
        const result = ExcelGenerator.downloadFromSpec({
            sheetName: 'Export',
            headers: ['Name'],
            rows: [['Ada']]
        }, 'export.xlsx');

        expect(result.success).toBe(true);
        expect(URL.createObjectURL).toHaveBeenCalledOnce();
    });

    it('returns errors for invalid specs', () => {
        const result = ExcelGenerator.downloadFromSpec({
            headers: ['Name'],
            rows: [['Ada']]
        }, 'bad.xlsx');

        expect(result.success).toBe(false);
        expect(result.error).toBeTruthy();
    });

    it('generateAndDownload uses default filename', () => {
        const result = ExcelGenerator.generateAndDownload([
            { Date: '2025-01-01 10:00:00', ShareLink: 'https://example.com', ShareCommentary: 'Hello', SharedUrl: '', MediaUrl: '', Visibility: 'PUBLIC' }
        ], 'shares');

        expect(result.success).toBe(true);
        expect(URL.createObjectURL).toHaveBeenCalledOnce();
    });

    it('generateAndDownload reports unknown file type', () => {
        const result = ExcelGenerator.generateAndDownload([{ Name: 'Ada' }], 'unknown');
        expect(result.success).toBe(false);
        expect(result.error).toBeTruthy();
    });

    // ── normalizeSpec validation paths (lines 239, 249, 253, 258) ─────────────

    it('downloadFromSpec returns error when spec is null (line 239)', () => {
        const result = ExcelGenerator.downloadFromSpec(null, 'out.xlsx');
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/Invalid sheet spec/i);
    });

    it('downloadFromSpec returns error when sheetName is missing (line 244-245)', () => {
        const result = ExcelGenerator.downloadFromSpec({
            sheetName: '',
            headers: ['A'],
            rows: [['1']]
        }, 'out.xlsx');
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/non-empty sheetName/i);
    });

    it('downloadFromSpec returns error when headers is not an array (line 249)', () => {
        const result = ExcelGenerator.downloadFromSpec({
            sheetName: 'Test',
            headers: 'not-an-array',
            rows: [['1']]
        }, 'out.xlsx');
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/headers must be an array/i);
    });

    it('downloadFromSpec returns error when rows is not an array (line 253)', () => {
        const result = ExcelGenerator.downloadFromSpec({
            sheetName: 'Test',
            headers: ['A'],
            rows: 'not-an-array'
        }, 'out.xlsx');
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/rows must be an array/i);
    });

    it('downloadFromSpec returns error when a row is not an array (line 258)', () => {
        const result = ExcelGenerator.downloadFromSpec({
            sheetName: 'Test',
            headers: ['A'],
            rows: ['not-an-array']
        }, 'out.xlsx');
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/row must be an array/i);
    });

    it('generateFromSpec handles hyperlink-only cell objects (line 83)', () => {
        // A cell with a hyperlink property but no value property — value should
        // fall back to the hyperlink string itself (normalizeCell line 83)
        const blob = ExcelGenerator.generateFromSpec({
            sheetName: 'Links',
            headers: ['URL'],
            rows: [
                [{ hyperlink: 'https://example.com' }]
            ]
        });
        expect(blob).toBeInstanceOf(Blob);
    });
});
