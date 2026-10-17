const fs = require("fs");
const os = require("os");
const path = require("path");

const { expect, test } = require("@playwright/test");

const { uploadFiles, waitForLoadedStatus } = require("./helpers/upload.js");

// Large enough that a browser storing it as a Blob has to keep it on disk
// rather than inline, which is where WebKit has lost IndexedDB Blobs before.
const EXPORT_SIZE_MB = 40;
const LOAD_TIMEOUT_MS = 90000;

let exportDir = "";
let messagesCsv = "";
let connectionsCsv = "";

test.beforeAll(async () => {
    const { generateLargeExport } = await import("../../scripts/fixtures/gen-large-export.mjs");
    exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "stored-upload-e2e-"));
    generateLargeExport({ sizeMb: EXPORT_SIZE_MB, dir: exportDir });
    messagesCsv = path.join(exportDir, "messages.csv");
    connectionsCsv = path.join(exportDir, "Connections.csv");
});

test.afterAll(() => {
    fs.rmSync(exportDir, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        /** @type {Window & { __LINKEDIN_ANALYZER_DISABLE_TUTORIALS__?: boolean }} */
        const globalWindow = window;
        globalWindow.__LINKEDIN_ANALYZER_DISABLE_TUTORIALS__ = true;
    });
});

/**
 * Read the size of each stored upload Blob straight from IndexedDB.
 * @param {import('@playwright/test').Page} page - Playwright page instance
 * @returns {Promise<Record<string, number>>} Blob size by file type
 */
function readStoredBlobSizes(page) {
    return page.evaluate(
        () =>
            new Promise((resolve, reject) => {
                const open = indexedDB.open("linkedin-analyzer");
                open.onerror = () => reject(open.error);
                open.onsuccess = () => {
                    const db = open.result;
                    const request = db
                        .transaction("fileBlobs", "readonly")
                        .objectStore("fileBlobs")
                        .getAll();
                    request.onerror = () => reject(request.error);
                    request.onsuccess = () => {
                        db.close();
                        resolve(
                            Object.fromEntries(
                                request.result.map((record) => [
                                    record.type,
                                    // WebKit stores the bytes in an ephemeral session.
                                    record.blob.size ?? record.blob.byteLength,
                                ]),
                            ),
                        );
                    };
                };
            }),
    );
}

test("keeps a large upload as a Blob that survives a reload", async ({ page }) => {
    test.setTimeout(LOAD_TIMEOUT_MS * 3);
    await uploadFiles(page, [messagesCsv, connectionsCsv]);
    await waitForLoadedStatus(page, "messagesStatus", LOAD_TIMEOUT_MS);
    await waitForLoadedStatus(page, "connectionsStatus", LOAD_TIMEOUT_MS);

    await page.reload();

    // The stored record is the original file, byte for byte.
    expect(await readStoredBlobSizes(page)).toEqual({
        messages: fs.statSync(messagesCsv).size,
        connections: fs.statSync(connectionsCsv).size,
    });

    // And the Messages screen reads it back from storage after the reload.
    await page.goto("/#messages");
    await expect(page.locator("#messagesLayout")).toBeVisible({ timeout: LOAD_TIMEOUT_MS });
    await expect(page.locator("#messagesEmpty")).toBeHidden();
    await expect(page.locator("#topContactsList li:not(.skeleton-row)").first()).toBeVisible({
        timeout: LOAD_TIMEOUT_MS,
    });
});
