import { afterEach, describe, expect, it, vi } from "vitest";

describe("Storage runtime degrade to memory on open failure", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.resetModules();
    });

    /** Stub indexedDB so every open() request fails asynchronously. */
    function stubFailingIndexedDB() {
        vi.stubGlobal("indexedDB", {
            open() {
                const request = {
                    error: null,
                    onerror: null,
                    onsuccess: null,
                    onupgradeneeded: null,
                    onblocked: null,
                };
                queueMicrotask(() => {
                    request.error = new DOMException("open failed", "InvalidStateError");
                    if (request.onerror) {
                        request.onerror();
                    }
                });
                return request;
            },
        });
    }

    it("reports isAvailable true but falls back to memory when the first open fails", async () => {
        vi.resetModules();
        stubFailingIndexedDB();
        const { Storage } = await import("../src/storage.js");
        expect(Storage.isAvailable).toBe(true);

        let lostError;
        Storage.onPersistenceLost((error) => {
            lostError = error;
        });

        await Storage.saveFile("shares", { name: "s.csv", text: "a,b", rowCount: 2 });
        const file = await Storage.getFile("shares");
        expect(file).toMatchObject({ type: "shares", name: "s.csv", rowCount: 2 });
        expect(lostError).toBeInstanceOf(DOMException);
    });

    it("notifies persistence-lost listeners only once across many operations", async () => {
        vi.resetModules();
        stubFailingIndexedDB();
        const { Storage } = await import("../src/storage.js");
        const listener = vi.fn();
        Storage.onPersistenceLost(listener);

        // Fire concurrently so both ops share the single memoized open() and both
        // reach degradeToMemory; the idempotent guard must still notify only once.
        await Promise.all([
            Storage.saveFile("shares", { name: "s.csv", text: "a,b" }),
            Storage.getAllFiles(),
        ]);
        await Storage.saveAnalytics({ months: {} });
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it("ignores non-function persistence-lost listeners", async () => {
        vi.resetModules();
        stubFailingIndexedDB();
        const { Storage } = await import("../src/storage.js");
        Storage.onPersistenceLost(null);
        await expect(Storage.saveFile("shares", { name: "s.csv", text: "a,b" })).resolves.toBeUndefined();
    });
});
