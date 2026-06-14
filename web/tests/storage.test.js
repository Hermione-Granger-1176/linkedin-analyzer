import { afterEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";

import { Storage } from "../src/storage.js";

describe("Storage", () => {
    it("reports isAvailable as true when IndexedDB exists", () => {
        expect(Storage.isAvailable).toBe(true);
    });

    it("saves and retrieves files", async () => {
        await Storage.saveFile("shares", { name: "Shares.csv", text: "a,b", rowCount: 2 });
        const file = await Storage.getFile("shares");
        expect(file.name).toBe("Shares.csv");
        expect(file.text).toBe("a,b");
        const files = await Storage.getAllFiles();
        expect(files.length).toBe(1);
    });

    it("saves and retrieves analytics", async () => {
        await Storage.saveAnalytics({ months: { "2024-01": { total: 1 } } });
        const analytics = await Storage.getAnalytics();
        expect(analytics.months["2024-01"].total).toBe(1);
    });

    it("clears data", async () => {
        await Storage.saveFile("comments", { name: "Comments.csv", text: "a,b", rowCount: 1 });
        await Storage.clearAll();
        const files = await Storage.getAllFiles();
        expect(files.length).toBe(0);
    });

    it("getAnalytics returns null when no analytics stored", async () => {
        await Storage.clearAll();
        const analytics = await Storage.getAnalytics();
        expect(analytics).toBeNull();
    });

    it("getFile returns null for a type that has not been saved", async () => {
        await Storage.clearAll();
        const file = await Storage.getFile("connections");
        expect(file).toBeNull();
    });

    it("getAllFiles returns empty array after clearAll", async () => {
        await Storage.saveFile("shares", { name: "Shares.csv", text: "a,b", rowCount: 1 });
        await Storage.clearAll();
        const files = await Storage.getAllFiles();
        expect(files).toEqual([]);
    });

    it("getAllFiles returns multiple file records", async () => {
        await Storage.clearAll();
        await Storage.saveFile("shares", { name: "Shares.csv", text: "a,b", rowCount: 2 });
        await Storage.saveFile("connections", {
            name: "Connections.csv",
            text: "x,y",
            rowCount: 5,
        });
        const files = await Storage.getAllFiles();
        expect(files.length).toBe(2);
        const types = files.map((f) => f.type).sort();
        expect(types).toEqual(["connections", "shares"]);
    });

    it("saveFile stores rowCount as 0 when not provided", async () => {
        await Storage.clearAll();
        await Storage.saveFile("shares", { name: "Shares.csv", text: "a,b" });
        const file = await Storage.getFile("shares");
        expect(file.rowCount).toBe(0);
    });

    it("saveFile overwrites existing record with same type", async () => {
        await Storage.clearAll();
        await Storage.saveFile("shares", { name: "OldShares.csv", text: "old", rowCount: 1 });
        await Storage.saveFile("shares", { name: "NewShares.csv", text: "new", rowCount: 99 });
        const file = await Storage.getFile("shares");
        expect(file.name).toBe("NewShares.csv");
        expect(file.rowCount).toBe(99);
    });

    it("saveAnalytics overwrites previous analytics record", async () => {
        await Storage.clearAll();
        await Storage.saveAnalytics({ months: { "2024-01": { total: 5 } } });
        await Storage.saveAnalytics({ months: { "2024-06": { total: 10 } } });
        const analytics = await Storage.getAnalytics();
        expect(analytics.months["2024-06"].total).toBe(10);
        expect(analytics.months["2024-01"]).toBeUndefined();
    });

    it("saveFile stores updatedAt timestamp", async () => {
        await Storage.clearAll();
        const before = Date.now();
        await Storage.saveFile("shares", { name: "Shares.csv", text: "a,b", rowCount: 1 });
        const after = Date.now();
        const file = await Storage.getFile("shares");
        expect(file.updatedAt).toBeGreaterThanOrEqual(before);
        expect(file.updatedAt).toBeLessThanOrEqual(after);
    });

    it("saveFile stores schemaVersion on persisted records", async () => {
        await Storage.clearAll();
        await Storage.saveFile("shares", { name: "Shares.csv", text: "a,b", rowCount: 1 });
        const file = await Storage.getFile("shares");
        expect(file.schemaVersion).toBe(2);
    });

    it("ignores future-version file records during reads", async () => {
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open("linkedin-analyzer", 3);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });

        await new Promise((resolve, reject) => {
            const tx = db.transaction("files", "readwrite");
            tx.objectStore("files").put({
                type: "shares",
                name: "future.csv",
                text: "a,b",
                rowCount: 1,
                updatedAt: Date.now(),
                schemaVersion: 999,
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });

        const file = await Storage.getFile("shares");
        expect(file).toBeNull();
        db.close();
    });

    it("ignores future-version analytics records during reads", async () => {
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open("linkedin-analyzer", 3);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });

        await new Promise((resolve, reject) => {
            const tx = db.transaction("analytics", "readwrite");
            tx.objectStore("analytics").put({
                id: "base",
                updatedAt: Date.now(),
                schemaVersion: 999,
                data: { months: {} },
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });

        const analytics = await Storage.getAnalytics();
        expect(analytics).toBeNull();
        db.close();
    });

    it("reads legacy analytics records without wrapped data payload", async () => {
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open("linkedin-analyzer", 3);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });

        await new Promise((resolve, reject) => {
            const tx = db.transaction("analytics", "readwrite");
            tx.objectStore("analytics").put({
                id: "base",
                updatedAt: Date.now(),
                schemaVersion: 1,
                months: { "2024-01": { total: 2 } },
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });

        const analytics = await Storage.getAnalytics();
        expect(analytics.months["2024-01"].total).toBe(2);
        db.close();
    });

    describe("transaction abort handling", () => {
        afterEach(() => {
            vi.restoreAllMocks();
        });

        // Abort the next transaction once handlers are wired (mimics a quota-exceeded
        // write, where the browser fires `abort` rather than `error`).
        function abortNextTransaction() {
            const original = IDBDatabase.prototype.transaction;
            vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (...args) {
                const tx = original.apply(this, args);
                queueMicrotask(() => tx.abort());
                return tx;
            });
        }

        it("saveFile rejects with an Error when the write transaction aborts", async () => {
            await Storage.clearAll();
            abortNextTransaction();
            // tx.error is null on an explicit abort, so the rejection must still be a
            // concrete Error (not null) for telemetry and callers to be actionable.
            let reason;
            await Storage.saveFile("shares", { name: "x.csv", text: "a,b", rowCount: 1 }).catch(
                (error) => {
                    reason = error;
                },
            );
            expect(reason).toBeInstanceOf(Error);
            expect(reason.message).toBe("IndexedDB transaction failed");
        });

        it("clearAll rejects with an Error when the clear transaction aborts", async () => {
            abortNextTransaction();
            let reason;
            await Storage.clearAll().catch((error) => {
                reason = error;
            });
            expect(reason).toBeInstanceOf(Error);
            expect(reason.message).toBe("IndexedDB transaction failed");
        });
    });

    describe("connection lifecycle", () => {
        it("memoizes a single database connection across operations", async () => {
            // Open the shared connection within this test, then assert further
            // ops reuse it rather than calling indexedDB.open again — keeping the
            // test independent of execution order.
            await Storage.getAllFiles();
            const openSpy = vi.spyOn(indexedDB, "open");
            await Storage.getAllFiles();
            await Storage.getAnalytics();
            expect(openSpy).not.toHaveBeenCalled();
            openSpy.mockRestore();
        });

        it("closes the shared connection on an external version change", async () => {
            await Storage.getAllFiles();
            // A newer connection upgrading the DB would block unless our
            // versionchange handler closes the shared connection first.
            await new Promise((resolve, reject) => {
                // Open above the current schema version to force an upgrade, which
                // fires versionchange on the shared connection.
                const request = indexedDB.open("linkedin-analyzer", 4);
                request.onupgradeneeded = () => {};
                request.onsuccess = () => {
                    request.result.close();
                    resolve();
                };
                request.onblocked = () =>
                    reject(new Error("upgrade blocked: shared connection was not closed"));
                request.onerror = () => reject(request.error);
            });
        });
    });

    // Runs last: it rebuilds the database from a legacy v2 shape, so it must not
    // pollute the shared connection used by earlier tests.
    describe("v2 to v3 migration", () => {
        it("moves inline CSV text into the text store on upgrade", async () => {
            // Drop the v3 database left by earlier tests so we can recreate a v2 one.
            await new Promise((resolve, reject) => {
                const request = indexedDB.deleteDatabase("linkedin-analyzer");
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
                request.onblocked = () => resolve();
            });

            // Build a legacy v2 database: a single "files" store with inline text.
            await new Promise((resolve, reject) => {
                const request = indexedDB.open("linkedin-analyzer", 2);
                request.onupgradeneeded = () => {
                    const db = request.result;
                    db.createObjectStore("files", { keyPath: "type" });
                    db.createObjectStore("analytics", { keyPath: "id" });
                };
                request.onsuccess = () => {
                    const db = request.result;
                    const tx = db.transaction("files", "readwrite");
                    tx.objectStore("files").put({
                        type: "messages",
                        name: "messages.csv",
                        text: "legacy-csv-text",
                        rowCount: 5,
                        updatedAt: 111,
                        schemaVersion: 2,
                    });
                    tx.oncomplete = () => {
                        db.close();
                        resolve();
                    };
                    tx.onerror = () => reject(tx.error);
                };
                request.onerror = () => reject(request.error);
            });

            // A fresh Storage module opens at v3 and runs the upgrade migration.
            vi.resetModules();
            const { Storage: MigratedStorage } = await import("../src/storage.js");

            // getAllFiles returns metadata only, and getFile still returns the text.
            const all = await MigratedStorage.getAllFiles();
            expect(all).toHaveLength(1);
            expect(all[0].type).toBe("messages");
            expect(all[0].rowCount).toBe(5);
            expect(all[0].text).toBeUndefined();
            const file = await MigratedStorage.getFile("messages");
            expect(file.text).toBe("legacy-csv-text");

            // Inspect the raw stores to prove the migration actually moved the text
            // out of the metadata store (rather than getFile falling back to inline).
            const rawDb = await new Promise((resolve, reject) => {
                const request = indexedDB.open("linkedin-analyzer", 3);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            const [fileRecord, textRecord] = await new Promise((resolve, reject) => {
                const tx = rawDb.transaction(["files", "fileTexts"], "readonly");
                const fileRequest = tx.objectStore("files").get("messages");
                const textRequest = tx.objectStore("fileTexts").get("messages");
                tx.oncomplete = () => resolve([fileRequest.result, textRequest.result]);
                tx.onerror = () => reject(tx.error);
            });
            rawDb.close();
            expect(fileRecord.text).toBeUndefined();
            expect(textRecord.text).toBe("legacy-csv-text");
        });
    });
});
