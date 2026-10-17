import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    HEARTBEAT_MS,
    STALE_MS,
    createRunTracker,
    memoryBucket,
    sizeBucket,
} from "../../../src/platform/observability/run-tracker.js";

const MB = 1024 * 1024;
const PREFIX = "linkedin-analyzer:run:";

/** In-memory BroadcastChannel bus: a post reaches every other open channel. */
function createBus() {
    const open = new Set();
    return (name) => {
        const listeners = [];
        const channel = {
            name,
            addEventListener: (_type, listener) => listeners.push(listener),
            postMessage: (data) => {
                open.forEach((other) => {
                    if (other !== channel && other.name === name) {
                        queueMicrotask(() =>
                            other.listeners.forEach((listener) => listener({ data })),
                        );
                    }
                });
            },
            close: () => open.delete(channel),
            listeners,
        };
        open.add(channel);
        return channel;
    };
}

function markerKeys() {
    return Object.keys(window.localStorage).filter((key) => key.startsWith(PREFIX));
}

/** Leave a marker the way a tab that crashed mid-run would. */
function writeCrashedMarker(heartbeatAt, overrides = {}) {
    window.localStorage.setItem(
        `${PREFIX}crashed`,
        JSON.stringify({
            tabId: "dead-tab",
            startedAt: heartbeatAt,
            heartbeatAt,
            sizeBucket: "60-100mb",
            mode: "single",
            ...overrides,
        }),
    );
}

function readOnlyMarker() {
    const keys = markerKeys();
    expect(keys).toHaveLength(1);
    return JSON.parse(window.localStorage.getItem(keys[0]));
}

describe("run-tracker", () => {
    let ids;
    let createChannel;

    const makeTracker = (overrides = {}) =>
        createRunTracker({
            localStorage: window.localStorage,
            sessionStorage: window.sessionStorage,
            createChannel,
            target: window,
            now: () => Date.now(),
            randomId: () => {
                ids += 1;
                return `id-${ids}`;
            },
            ...overrides,
        });

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
        window.localStorage.clear();
        window.sessionStorage.clear();
        ids = 0;
        createChannel = createBus();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("buckets sizes and device memory without exact values", () => {
        expect(sizeBucket(5 * MB)).toBe("lt-10mb");
        expect(sizeBucket(10 * MB)).toBe("10-30mb");
        expect(sizeBucket(45 * MB)).toBe("30-60mb");
        expect(sizeBucket(99 * MB)).toBe("60-100mb");
        expect(sizeBucket(128 * MB)).toBe("gte-100mb");
        expect(sizeBucket(Number.NaN)).toBe("lt-10mb");
        expect(sizeBucket(-1)).toBe("lt-10mb");

        expect(memoryBucket(undefined)).toBe("unknown");
        expect(memoryBucket(0)).toBe("unknown");
        expect(memoryBucket(Number.POSITIVE_INFINITY)).toBe("unknown");
        expect(memoryBucket(2)).toBe("le-2gb");
        expect(memoryBucket(4)).toBe("4gb");
        expect(memoryBucket(8)).toBe("ge-8gb");
    });

    it("writes a marker with buckets only and removes it on finish", () => {
        const tracker = makeTracker();
        tracker.start({ totalBytes: 55 * MB, fileCount: 4 });

        const marker = readOnlyMarker();
        expect(marker).toEqual({
            tabId: "id-2",
            startedAt: Date.now(),
            heartbeatAt: Date.now(),
            sizeBucket: "30-60mb",
            mode: "parallel",
        });
        expect(window.sessionStorage.getItem("linkedin-analyzer:tab-id")).toBe("id-2");

        tracker.finish();
        tracker.finish();
        expect(markerKeys()).toEqual([]);

        // A later run in the same tab keeps the tab ID it already has.
        tracker.start({ totalBytes: MB, fileCount: 1 });
        expect(readOnlyMarker().tabId).toBe("id-2");
        tracker.finish();
    });

    it("adds a joining upload to the active run instead of starting a second one", () => {
        const tracker = makeTracker();
        tracker.start({ totalBytes: 25 * MB, fileCount: 1 });
        tracker.start({ totalBytes: 10 * MB, fileCount: 1 });

        const marker = readOnlyMarker();
        expect(marker.sizeBucket).toBe("30-60mb");
        expect(marker.mode).toBe("parallel");
        tracker.finish();

        // A small file joining a large run keeps the large run's bucket.
        tracker.start({ totalBytes: 80 * MB, fileCount: 1 });
        tracker.start({ totalBytes: MB, fileCount: 1 });
        expect(readOnlyMarker().sizeBucket).toBe("60-100mb");
        tracker.finish();
    });

    it("reuses the tab ID kept in sessionStorage", () => {
        window.sessionStorage.setItem("linkedin-analyzer:tab-id", "kept-tab");
        const tracker = makeTracker();
        tracker.start({ totalBytes: MB, fileCount: 1 });
        expect(readOnlyMarker().tabId).toBe("kept-tab");
        tracker.finish();
    });

    it("updates the heartbeat every interval while the run lasts", () => {
        const tracker = makeTracker();
        tracker.start({ totalBytes: MB, fileCount: 1 });
        const startedAt = Date.now();

        vi.advanceTimersByTime(HEARTBEAT_MS);
        expect(readOnlyMarker().heartbeatAt).toBe(startedAt + HEARTBEAT_MS);

        tracker.finish();
        vi.advanceTimersByTime(HEARTBEAT_MS);
        expect(markerKeys()).toEqual([]);
    });

    it("treats a page that was left as not unfinished", async () => {
        const tracker = makeTracker();
        tracker.start({ totalBytes: MB, fileCount: 1 });
        window.dispatchEvent(new Event("pagehide"));
        expect(readOnlyMarker().leftAt).toBe(Date.now());

        const onUnfinished = vi.fn();
        await makeTracker().checkPrevious(onUnfinished);
        expect(onUnfinished).not.toHaveBeenCalled();
        expect(markerKeys()).toEqual([]);
    });

    it("clears the left mark when the page returns from the back/forward cache", () => {
        const tracker = makeTracker();
        tracker.start({ totalBytes: MB, fileCount: 1 });
        window.dispatchEvent(new Event("pagehide"));

        window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }));
        expect(readOnlyMarker().leftAt).toBeDefined();
        window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
        expect(readOnlyMarker().leftAt).toBeUndefined();
        tracker.finish();
    });

    it("treats a frozen tab as left and writes its marker back when it resumes", async () => {
        const tracker = makeTracker();
        tracker.start({ totalBytes: MB, fileCount: 1 });
        window.dispatchEvent(new Event("freeze"));
        expect(readOnlyMarker().leftAt).toBe(Date.now());

        // Another tab sweeps the marker while this one cannot answer.
        const onUnfinished = vi.fn();
        await makeTracker().checkPrevious(onUnfinished);
        expect(onUnfinished).not.toHaveBeenCalled();
        expect(markerKeys()).toEqual([]);

        window.dispatchEvent(new Event("resume"));
        expect(readOnlyMarker().leftAt).toBeUndefined();
        tracker.finish();
    });

    it("writes a swept marker back on the next heartbeat", () => {
        const tracker = makeTracker();
        tracker.start({ totalBytes: MB, fileCount: 1 });
        window.localStorage.clear();

        vi.advanceTimersByTime(HEARTBEAT_MS);
        expect(readOnlyMarker().heartbeatAt).toBe(Date.now());
        tracker.finish();
    });

    it("reports a stale run that no open tab owns, once", async () => {
        writeCrashedMarker(Date.now() - STALE_MS);

        const onUnfinished = vi.fn();
        const check = makeTracker().checkPrevious(onUnfinished);
        await vi.advanceTimersByTimeAsync(1000);
        await check;

        expect(onUnfinished).toHaveBeenCalledTimes(1);
        expect(onUnfinished).toHaveBeenCalledWith({ sizeBucket: "60-100mb", mode: "single" });
        expect(markerKeys()).toEqual([]);
    });

    it("leaves a run alone while another open tab owns it", async () => {
        const owner = makeTracker();
        owner.start({ totalBytes: MB, fileCount: 1 });
        vi.setSystemTime(Date.now() + 10 * STALE_MS);

        const onUnfinished = vi.fn();
        const check = makeTracker().checkPrevious(onUnfinished);
        await vi.advanceTimersByTimeAsync(1000);
        await check;

        expect(onUnfinished).not.toHaveBeenCalled();
        expect(markerKeys()).toHaveLength(1);
        owner.finish();
    });

    it("rechecks a recent run with no owner once it turns stale", async () => {
        writeCrashedMarker(Date.now());

        const onUnfinished = vi.fn();
        const check = makeTracker().checkPrevious(onUnfinished);
        await vi.advanceTimersByTimeAsync(1000);
        await check;
        expect(onUnfinished).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(STALE_MS);
        expect(onUnfinished).toHaveBeenCalledTimes(1);
        expect(markerKeys()).toEqual([]);
    });

    it("skips the recheck when the run's heartbeat moved on", async () => {
        const running = makeTracker({ createChannel: null });
        running.start({ totalBytes: MB, fileCount: 1 });

        const onUnfinished = vi.fn();
        await makeTracker({ createChannel: null }).checkPrevious(onUnfinished);
        await vi.advanceTimersByTimeAsync(STALE_MS);

        expect(onUnfinished).not.toHaveBeenCalled();
        expect(markerKeys()).toHaveLength(1);
        running.finish();
    });

    it("removes malformed markers and ignores the tab's own active run", async () => {
        window.localStorage.setItem(`${PREFIX}broken`, "{not json");
        window.localStorage.setItem(`${PREFIX}empty`, "null");
        window.localStorage.setItem("unrelated", "kept");
        const tracker = makeTracker();
        tracker.start({ totalBytes: MB, fileCount: 1 });

        const onUnfinished = vi.fn();
        await tracker.checkPrevious(onUnfinished);

        expect(onUnfinished).not.toHaveBeenCalled();
        expect(markerKeys()).toHaveLength(1);
        expect(window.localStorage.getItem("unrelated")).toBe("kept");
        tracker.finish();
    });

    it("does nothing without localStorage", async () => {
        const tracker = makeTracker({ localStorage: null });
        tracker.start({ totalBytes: MB, fileCount: 1 });
        tracker.finish();
        await expect(tracker.checkPrevious(vi.fn())).resolves.toBeUndefined();
    });

    it("keeps working when storage or channels throw", async () => {
        const broken = {
            getItem: () => {
                throw new Error("blocked");
            },
            setItem: () => {
                throw new Error("blocked");
            },
            removeItem: () => {
                throw new Error("blocked");
            },
        };
        const tracker = makeTracker({
            localStorage: broken,
            sessionStorage: broken,
            createChannel: () => {
                throw new Error("no channels");
            },
        });
        expect(() => tracker.start({ totalBytes: MB, fileCount: 1 })).not.toThrow();
        expect(() => tracker.finish()).not.toThrow();
        await expect(tracker.checkPrevious(vi.fn())).resolves.toBeUndefined();

        const keysThrow = makeTracker({
            localStorage: new Proxy(window.localStorage, {
                ownKeys: () => {
                    throw new Error("blocked");
                },
            }),
        });
        await expect(keysThrow.checkPrevious(vi.fn())).resolves.toBeUndefined();
    });

    it("treats a channel that fails to open for asking as no owner", async () => {
        writeCrashedMarker(Date.now() - STALE_MS);

        const failing = () => {
            throw new Error("no channels");
        };
        const onUnfinished = vi.fn();
        await makeTracker({ createChannel: failing }).checkPrevious(onUnfinished);
        expect(onUnfinished).toHaveBeenCalledTimes(1);
    });

    it("wires the shared tracker to the real browser APIs", async () => {
        vi.resetModules();
        const { RunTracker } = await import("../../../src/platform/observability/run-tracker.js");
        RunTracker.start({ totalBytes: MB, fileCount: 1 });
        expect(readOnlyMarker().tabId).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
        RunTracker.finish();
        expect(markerKeys()).toEqual([]);
    });

    it("disables the shared tracker when the browser blocks storage", async () => {
        vi.resetModules();
        const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
        Object.defineProperty(window, "localStorage", {
            configurable: true,
            get: () => {
                throw new Error("blocked");
            },
        });
        try {
            const { RunTracker } =
                await import("../../../src/platform/observability/run-tracker.js");
            expect(() => RunTracker.start({ totalBytes: MB, fileCount: 1 })).not.toThrow();
        } finally {
            Object.defineProperty(window, "localStorage", descriptor);
        }
        expect(markerKeys()).toEqual([]);
    });
});
