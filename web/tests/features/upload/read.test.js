import { afterEach, describe, expect, it, vi } from "vitest";

import { readFileAsText } from "../../../src/features/upload/read.js";
import { MAX_CSV_CHARS } from "../../../src/shared/limits.js";

const STREAM_SIZE = 6 * 1024 * 1024;
const encodeBuf = (str) => new TextEncoder().encode(str).buffer;

/**
 * Replace FileReader with one whose read runs the given body.
 * @param {(reader: object) => void} readAsArrayBuffer - Read body
 */
function stubFileReader(readAsArrayBuffer) {
    function FileReader() {
        return { result: null, onload: null, onerror: null, readAsArrayBuffer, abort() {} };
    }
    vi.stubGlobal("FileReader", FileReader);
}

/**
 * Build a streaming File-like object whose stream yields the given byte chunks.
 * @param {Uint8Array[]} chunks - Byte chunks in order
 * @param {{onCancel?: () => void, onRead?: (index: number) => void}} [hooks] - Test hooks
 */
function makeStreamFile(chunks, hooks = {}) {
    let index = 0;
    return /** @type {File} */ (
        /** @type {unknown} */ ({
            name: "Messages.csv",
            size: STREAM_SIZE,
            stream() {
                return {
                    getReader() {
                        return {
                            read() {
                                if (hooks.onRead) {
                                    hooks.onRead(index);
                                }
                                if (index < chunks.length) {
                                    return Promise.resolve({ done: false, value: chunks[index++] });
                                }
                                return Promise.resolve({ done: true, value: undefined });
                            },
                            cancel() {
                                if (hooks.onCancel) {
                                    hooks.onCancel();
                                }
                                return Promise.resolve();
                            },
                        };
                    },
                };
            },
        })
    );
}

describe("readFileAsText with FileReader", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it("reads a small file and reports its bytes once", async () => {
        const onProgress = vi.fn();
        const file = new File(["col\nval"], "Shares.csv", { type: "text/csv" });
        await expect(readFileAsText(file, { onProgress })).resolves.toEqual({
            text: "col\nval",
            usedFallback: false,
        });
        expect(onProgress).toHaveBeenCalledWith(7, 7);
    });

    it("falls back to windows-1252 when the read is not valid UTF-8", async () => {
        const file = new File([new Uint8Array([0xe9])], "Messages.csv");
        await expect(readFileAsText(file)).resolves.toEqual({ text: "é", usedFallback: true });
    });

    it("rejects a read cancelled while it was in flight", async () => {
        const controller = new AbortController();
        const file = new File(["col\nval"], "Shares.csv");
        const pending = readFileAsText(file, { signal: controller.signal });
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    });

    it("rejects when FileReader errors", async () => {
        stubFileReader(function readAsArrayBuffer() {
            this.onerror(new Error("read error"));
        });
        await expect(readFileAsText(new File(["bad"], "Messages.csv"))).rejects.toThrow(
            "Error reading file",
        );
    });

    it("rejects a missing or non-buffer result instead of treating it as empty", async () => {
        for (const result of [null, "not-a-buffer"]) {
            stubFileReader(function readAsArrayBuffer() {
                this.result = result;
                this.onload();
            });
            await expect(readFileAsText(new File(["x"], "Messages.csv"))).rejects.toThrow(
                "Error reading file",
            );
        }
    });

    it("rejects with a clear message when TextDecoder is unavailable", async () => {
        stubFileReader(function readAsArrayBuffer() {
            this.result = encodeBuf("col\nval");
            this.onload();
        });
        vi.stubGlobal("TextDecoder", undefined);
        await expect(readFileAsText(new File(["x"], "Messages.csv"))).rejects.toThrow(
            "text-decoding support",
        );
    });

    it("aborts a read that exceeds the timeout", async () => {
        vi.useFakeTimers();
        let aborted = false;
        function FileReader() {
            return {
                onerror: null,
                // Never resolves, so only the 30s watchdog can settle the read.
                readAsArrayBuffer() {},
                abort() {
                    aborted = true;
                    // A late error after the watchdog settled the read is ignored.
                    setTimeout(() => this.onerror(), 0);
                },
            };
        }
        vi.stubGlobal("FileReader", FileReader);
        const pending = readFileAsText(new File(["csv"], "Shares.csv"));
        const assertion = expect(pending).rejects.toThrow(/timed out/i);
        await vi.advanceTimersByTimeAsync(30001);
        await assertion;
        expect(aborted).toBe(true);
    });
});

describe("readFileAsText with a stream", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("streams UTF-8 bytes and reports bytes read per chunk", async () => {
        const onProgress = vi.fn();
        const file = makeStreamFile([new Uint8Array([99, 111, 108]), new Uint8Array([10, 118])]);
        await expect(readFileAsText(file, { onProgress })).resolves.toEqual({
            text: "col\nv",
            usedFallback: false,
        });
        expect(onProgress.mock.calls).toEqual([
            [3, STREAM_SIZE],
            [5, STREAM_SIZE],
        ]);
    });

    it("streams non-UTF-8 bytes and falls back to windows-1252", async () => {
        const file = makeStreamFile([new Uint8Array([0xe9])]);
        await expect(readFileAsText(file)).resolves.toEqual({ text: "é", usedFallback: true });
    });

    it("rejects a file whose decoded length exceeds the character limit", async () => {
        // Bytes (NUL) decode 1:1 to characters, so the post-decode check trips.
        const file = makeStreamFile([new Uint8Array(MAX_CSV_CHARS + 1)]);
        await expect(readFileAsText(file)).rejects.toThrow("text limit");
    });

    it("cancels the stream when the signal aborts between chunks", async () => {
        const controller = new AbortController();
        const onCancel = vi.fn();
        const file = makeStreamFile([new Uint8Array([99]), new Uint8Array([100])], {
            onCancel,
            onRead: (index) => {
                if (index === 1) {
                    controller.abort();
                }
            },
        });
        await expect(readFileAsText(file, { signal: controller.signal })).rejects.toMatchObject({
            name: "AbortError",
        });
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("rejects when the stream read rejects with a non-error value", async () => {
        const file = /** @type {File} */ (
            /** @type {unknown} */ ({
                name: "Messages.csv",
                size: STREAM_SIZE,
                stream: () => ({
                    getReader: () => ({
                        read: () => ({ then: (_resolve, reject) => reject("read failed") }),
                        cancel: () => Promise.resolve(),
                    }),
                }),
            })
        );
        await expect(readFileAsText(file)).rejects.toBe("read failed");
    });

    it("aborts a read that times out mid-stream", async () => {
        vi.useFakeTimers();
        let cancelled = false;
        let reads = 0;
        const file = /** @type {File} */ (
            /** @type {unknown} */ ({
                name: "Messages.csv",
                size: STREAM_SIZE,
                stream: () => ({
                    getReader: () => ({
                        read() {
                            reads += 1;
                            if (reads === 1) {
                                return Promise.resolve({
                                    done: false,
                                    value: new Uint8Array([99]),
                                });
                            }
                            // The next chunk arrives after the watchdog fires.
                            return new Promise((resolve) => {
                                setTimeout(
                                    () => resolve({ done: false, value: new Uint8Array([100]) }),
                                    40000,
                                );
                            });
                        },
                        cancel() {
                            cancelled = true;
                            return Promise.resolve();
                        },
                    }),
                }),
            })
        );
        const pending = readFileAsText(file);
        const assertion = expect(pending).rejects.toThrow(/timed out/i);
        await vi.advanceTimersByTimeAsync(41000);
        await assertion;
        expect(cancelled).toBe(true);
    });
});
