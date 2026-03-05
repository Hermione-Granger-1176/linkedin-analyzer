import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setupDom } from './helpers/dom.js';

vi.mock('../src/cleaner.js', () => ({
    LinkedInCleaner: {
        configs: {
            shares: { columns: [{ name: 'Title' }, { name: 'Link' }] },
            comments: { columns: [{ name: 'Text' }] }
        },
        process: vi.fn()
    }
}));

vi.mock('../src/data-cache.js', () => {
    const values = new Map();
    return {
        DataCache: {
            get: vi.fn((key) => values.get(key)),
            set: vi.fn((key, value) => values.set(key, value))
        }
    };
});

vi.mock('../src/excel.js', () => ({
    ExcelGenerator: { generateAndDownload: vi.fn() }
}));

vi.mock('../src/session.js', () => ({
    Session: { waitForCleanup: vi.fn(() => Promise.resolve()) }
}));

vi.mock('../src/storage.js', () => ({
    Storage: { getAllFiles: vi.fn() }
}));

vi.mock('../src/sentry.js', () => ({
    captureError: vi.fn()
}));

let CleanPage;
let DataCache;
let ExcelGenerator;
let LinkedInCleaner;
let Storage;
let captureError;

describe('CleanPage', () => {
    beforeEach(async () => {
        setupDom(`
            <div id="cleanEmpty"></div>
            <div id="cleanPanel" hidden></div>
            <div id="cleanerHint"></div>
            <section id="cleanPreviewSection" hidden>
                <table id="cleanPreviewTable">
                    <thead></thead>
                    <tbody></tbody>
                </table>
                <div id="cleanFileInfo"></div>
                <div id="cleanPreviewNote"></div>
            </section>
            <section id="cleanDownloadSection" hidden></section>
            <button id="cleanDownloadBtn"></button>
            <div id="cleanErrorMessage" hidden><span id="cleanErrorText"></span></div>
            <label><input type="radio" name="cleanFileType" value="shares" checked /></label>
            <label><input type="radio" name="cleanFileType" value="comments" /></label>
            <label><input type="radio" name="cleanFileType" value="messages" /></label>
            <label><input type="radio" name="cleanFileType" value="connections" /></label>
        `);

        vi.resetModules();
        ({ CleanPage } = await import('../src/clean.js'));
        ({ DataCache } = await import('../src/data-cache.js'));
        ({ ExcelGenerator } = await import('../src/excel.js'));
        ({ LinkedInCleaner } = await import('../src/cleaner.js'));
        ({ Storage } = await import('../src/storage.js'));
        ({ captureError } = await import('../src/sentry.js'));

        DataCache.get.mockReturnValue(null);
        LinkedInCleaner.process.mockReset();
        ExcelGenerator.generateAndDownload.mockReset();
        captureError.mockReset();
    });

    it('shows empty state when no files are loaded', async () => {
        Storage.getAllFiles.mockResolvedValue([]);

        await CleanPage.init();

        expect(document.getElementById('cleanEmpty').hidden).toBe(false);
        expect(document.getElementById('cleanPanel').hidden).toBe(true);
        expect(document.getElementById('cleanerHint').textContent).toContain('Upload');
    });

    it('renders preview and download when file parses', async () => {
        Storage.getAllFiles.mockResolvedValue([
            { type: 'shares', text: 'csv', updatedAt: 10 }
        ]);
        LinkedInCleaner.process.mockReturnValue({
            success: true,
            rowCount: 2,
            cleanedData: [
                { Title: 'Hello', Link: 'https://example.com' },
                { Title: 'World', Link: 'https://example.com/2' }
            ]
        });

        await CleanPage.init();
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(document.getElementById('cleanPreviewSection').hidden).toBe(false);
        expect(document.getElementById('cleanDownloadSection').hidden).toBe(false);
        expect(document.getElementById('cleanFileInfo').textContent).toContain('Shares');
        expect(document.querySelector('#cleanPreviewTable tbody').innerHTML).toContain('Hello');
    });

    it('shows parse error when cleaning fails', async () => {
        Storage.getAllFiles.mockResolvedValue([
            { type: 'shares', text: 'csv', updatedAt: 12 }
        ]);
        LinkedInCleaner.process.mockReturnValue({
            success: false,
            error: 'Bad CSV'
        });

        await CleanPage.init();
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(document.getElementById('cleanErrorMessage').hidden).toBe(false);
        expect(document.getElementById('cleanErrorText').textContent).toContain('Bad CSV');
        expect(document.getElementById('cleanDownloadSection').hidden).toBe(true);
    });

    it('reports Excel generation errors', async () => {
        Storage.getAllFiles.mockResolvedValue([
            { type: 'shares', text: 'csv', updatedAt: 2 }
        ]);
        LinkedInCleaner.process.mockReturnValue({
            success: true,
            rowCount: 1,
            cleanedData: [{ Title: 'Hello', Link: 'https://example.com' }]
        });
        ExcelGenerator.generateAndDownload.mockReturnValue({
            success: false,
            error: 'Failed'
        });

        await CleanPage.init();
        await new Promise(resolve => setTimeout(resolve, 0));
        document.getElementById('cleanDownloadBtn').click();

        expect(document.getElementById('cleanErrorMessage').hidden).toBe(false);
        expect(document.getElementById('cleanErrorText').textContent).toContain('Failed');
    });

    it('shows error when download is attempted with no cached data (line 265)', async () => {
        // Load no files so cache[type] remains null
        Storage.getAllFiles.mockResolvedValue([]);

        await CleanPage.init();
        await new Promise(resolve => setTimeout(resolve, 0));

        // Clicking download when there is no cached result triggers showError
        document.getElementById('cleanDownloadBtn').click();

        expect(document.getElementById('cleanErrorMessage').hidden).toBe(false);
        expect(document.getElementById('cleanErrorText').textContent).toContain('No data to download');
    });

    it('uses cached result on second onRouteChange without re-processing (line 248)', async () => {
        Storage.getAllFiles.mockResolvedValue([
            { type: 'shares', text: 'csv', updatedAt: 5 }
        ]);
        LinkedInCleaner.process.mockReturnValue({
            success: true,
            rowCount: 1,
            cleanedData: [{ Title: 'Cached', Link: 'https://example.com' }]
        });

        await CleanPage.init();
        await new Promise(resolve => setTimeout(resolve, 0));

        const callCountAfterInit = LinkedInCleaner.process.mock.calls.length;

        // Second route change — initialized is true, calls refresh() which calls renderPreview()
        await CleanPage.onRouteChange();
        await new Promise(resolve => setTimeout(resolve, 0));

        // process() should NOT be called again because updatedAt hasn't changed
        expect(LinkedInCleaner.process.mock.calls.length).toBe(callCountAfterInit);
    });

    it('shows "many files" hint when 2-3 files are loaded (line 23)', async () => {
        Storage.getAllFiles.mockResolvedValue([
            { type: 'shares', text: 'csv', updatedAt: 1 },
            { type: 'comments', text: 'csv', updatedAt: 2 }
        ]);
        LinkedInCleaner.process.mockReturnValue({
            success: true, rowCount: 1, cleanedData: [{ Title: 'T', Link: 'L' }]
        });

        await CleanPage.init();

        const hint = document.getElementById('cleanerHint').textContent;
        expect(hint).toContain('2 files loaded');
    });

    it('shows "single file" hint when exactly 1 file is loaded (line 24)', async () => {
        Storage.getAllFiles.mockResolvedValue([
            { type: 'shares', text: 'csv', updatedAt: 1 }
        ]);
        LinkedInCleaner.process.mockReturnValue({
            success: true, rowCount: 1, cleanedData: [{ Title: 'T', Link: 'L' }]
        });

        await CleanPage.init();

        const hint = document.getElementById('cleanerHint').textContent;
        expect(hint).toContain('Only one file');
    });

    it('onRouteChange calls init when not yet initialized (lines 73-75)', async () => {
        Storage.getAllFiles.mockResolvedValue([]);

        // onRouteChange before init() — should call init internally
        await CleanPage.onRouteChange();

        expect(document.getElementById('cleanEmpty').hidden).toBe(false);
    });

    it('second init call returns early without reinitializing (line 64)', async () => {
        Storage.getAllFiles.mockResolvedValue([]);

        await CleanPage.init();
        const firstCallCount = Storage.getAllFiles.mock.calls.length;

        // Second init should be a no-op (line 63-65)
        await CleanPage.init();
        expect(Storage.getAllFiles.mock.calls.length).toBe(firstCallCount);
    });

    it('updateView falls back to first loaded type when selected type has no file (lines 143-148)', async () => {
        Storage.getAllFiles.mockResolvedValue([
            { type: 'comments', text: 'csv', updatedAt: 1 }
        ]);
        LinkedInCleaner.process.mockReturnValue({
            success: true, rowCount: 1, cleanedData: [{ Text: 'Hi' }]
        });

        // 'shares' radio is checked by default but no shares file loaded
        // → fallback should select 'comments' and render its preview
        await CleanPage.init();

        // The preview should render with comments data (fallback type)
        expect(document.getElementById('cleanPreviewSection').hidden).toBe(false);
        expect(document.getElementById('cleanFileInfo').textContent).toContain('Comments');
    });

    it('shows "all files" hint when all 4 file types are loaded (line 22)', async () => {
        Storage.getAllFiles.mockResolvedValue([
            { type: 'shares', text: 'csv', updatedAt: 1 },
            { type: 'comments', text: 'csv', updatedAt: 2 },
            { type: 'messages', text: 'csv', updatedAt: 3 },
            { type: 'connections', text: 'csv', updatedAt: 4 }
        ]);
        LinkedInCleaner.process.mockReturnValue({
            success: true, rowCount: 1, cleanedData: [{ Title: 'T', Link: 'L' }]
        });

        await CleanPage.init();

        const hint = document.getElementById('cleanerHint').textContent;
        expect(hint).toContain('All files loaded');
    });

    it('uses cached files from DataCache when available (line 104)', async () => {
        const files = [{ type: 'shares', text: 'csv', updatedAt: 1 }];
        DataCache.get.mockImplementation((key) => key === 'storage:files' ? files : null);
        LinkedInCleaner.process.mockReturnValue({
            success: true, rowCount: 1, cleanedData: [{ Title: 'T', Link: 'L' }]
        });

        const callsBefore = Storage.getAllFiles.mock.calls.length;
        await CleanPage.init();

        // Storage.getAllFiles should NOT have been called since DataCache had the data
        expect(Storage.getAllFiles.mock.calls.length).toBe(callsBefore);
    });

    it('shows "Showing all N rows" when row count is within preview limit (line 232)', async () => {
        Storage.getAllFiles.mockResolvedValue([
            { type: 'shares', text: 'csv', updatedAt: 1 }
        ]);
        LinkedInCleaner.process.mockReturnValue({
            success: true,
            rowCount: 3,
            cleanedData: [
                { Title: 'A', Link: 'https://a.com' },
                { Title: 'B', Link: 'https://b.com' },
                { Title: 'C', Link: 'https://c.com' }
            ]
        });

        await CleanPage.init();
        await new Promise(resolve => setTimeout(resolve, 0));

        const note = document.getElementById('cleanPreviewNote').textContent;
        expect(note).toContain('Showing all');
    });

    it('truncates long cell values in preview table (line 310)', async () => {
        Storage.getAllFiles.mockResolvedValue([
            { type: 'shares', text: 'csv', updatedAt: 99 }
        ]);
        // PREVIEW_CELL_LIMIT is 50; use a string clearly longer than that
        const longText = 'A'.repeat(200);
        LinkedInCleaner.process.mockReturnValue({
            success: true,
            rowCount: 1,
            cleanedData: [{ Title: longText, Link: 'https://example.com' }]
        });

        await CleanPage.init();
        await new Promise(resolve => setTimeout(resolve, 0));

        const tbody = document.querySelector('#cleanPreviewTable tbody');
        // The cell text content (not title attribute) must be truncated
        const cellText = tbody.querySelector('td').textContent;
        expect(cellText.length).toBeLessThan(longText.length);
        expect(cellText).toContain('...');
    });

    it('shows load error state when storage read fails', async () => {
        Storage.getAllFiles.mockRejectedValue(new Error('idb-failed'));

        await CleanPage.init();
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(document.getElementById('cleanErrorMessage').hidden).toBe(false);
        expect(document.getElementById('cleanErrorText').textContent).toContain('Unable to load saved files');
        expect(captureError).toHaveBeenCalled();
    });

    it('shows parse error state when cleaner throws unexpectedly', async () => {
        Storage.getAllFiles.mockResolvedValue([
            { type: 'shares', text: 'csv', updatedAt: 10, name: 'Shares.csv' }
        ]);
        LinkedInCleaner.process.mockImplementation(() => {
            throw new Error('cleaner-crashed');
        });

        await CleanPage.init();
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(document.getElementById('cleanErrorMessage').hidden).toBe(false);
        expect(document.getElementById('cleanErrorText').textContent).toContain('Unable to parse file');
        expect(captureError).toHaveBeenCalled();
    });
});
