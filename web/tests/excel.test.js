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
});
