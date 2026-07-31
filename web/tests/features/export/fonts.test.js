import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    FALLBACK_FONTS,
    encodeFontBytes,
    registerPdfFonts,
} from "../../../src/features/export/fonts.js";
import { captureError } from "../../../src/platform/observability/sentry.js";

vi.mock("../../../src/platform/observability/sentry.js", () => ({
    captureError: vi.fn(),
}));

/**
 * Build a minimal jsPDF-like document that records font registration calls.
 * @returns {{addFileToVFS: Function, addFont: Function, vfs: Array, fonts: Array}}
 */
function createDocStub() {
    const vfs = [];
    const fonts = [];
    return {
        vfs,
        fonts,
        addFileToVFS: vi.fn((file, data) => vfs.push({ file, data })),
        addFont: vi.fn((file, family, style) => fonts.push({ file, family, style })),
    };
}

describe("encodeFontBytes", () => {
    it("base64-encodes a buffer", () => {
        const buffer = new Uint8Array([0x4d, 0x61, 0x6e]).buffer;

        expect(encodeFontBytes(buffer)).toBe("TWFu");
    });

    it("encodes buffers larger than one chunk", () => {
        const size = 0x8000 + 7;
        const bytes = new Uint8Array(size);
        for (let index = 0; index < size; index += 1) {
            bytes[index] = index % 256;
        }

        const encoded = encodeFontBytes(bytes.buffer);

        expect(encoded).toBe(Buffer.from(bytes).toString("base64"));
    });

    it("encodes an empty buffer", () => {
        expect(encodeFontBytes(new ArrayBuffer(0))).toBe("");
    });
});

describe("registerPdfFonts", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        delete globalThis.fetch;
    });

    it("registers both handwritten faces and reports the family names", async () => {
        const requested = [];
        globalThis.fetch = vi.fn((url) => {
            requested.push(url);
            return Promise.resolve({
                ok: true,
                arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
            });
        });
        const doc = createDocStub();

        const families = await registerPdfFonts(doc);

        expect(requested).toEqual([
            "/fonts/PatrickHand-Regular.ttf",
            "/fonts/Caveat-Regular.ttf",
        ]);
        expect(families).toEqual({ body: "PatrickHand", accent: "Caveat", embedded: true });
        expect(Object.isFrozen(families)).toBe(true);
        expect(doc.vfs.map((entry) => entry.file)).toEqual([
            "PatrickHand-Regular.ttf",
            "Caveat-Regular.ttf",
        ]);
        expect(doc.fonts).toEqual([
            { file: "PatrickHand-Regular.ttf", family: "PatrickHand", style: "normal" },
            { file: "Caveat-Regular.ttf", family: "Caveat", style: "normal" },
        ]);
        expect(captureError).not.toHaveBeenCalled();
    });

    it("falls back to Helvetica when a font request is not ok", async () => {
        globalThis.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 404 }));
        const doc = createDocStub();

        expect(await registerPdfFonts(doc)).toBe(FALLBACK_FONTS);
        expect(FALLBACK_FONTS).toEqual({
            body: "helvetica",
            accent: "helvetica",
            embedded: false,
        });
        expect(doc.addFont).not.toHaveBeenCalled();
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "register-fonts",
        });
    });

    it("falls back to Helvetica when the network rejects", async () => {
        const thrown = new Error("offline");
        globalThis.fetch = vi.fn(() => Promise.reject(thrown));
        const doc = createDocStub();

        expect(await registerPdfFonts(doc)).toBe(FALLBACK_FONTS);
        expect(captureError).toHaveBeenCalledTimes(1);
        expect(captureError.mock.calls[0][0]).not.toBe(thrown);
    });

    it("falls back to Helvetica when registration itself throws", async () => {
        globalThis.fetch = vi.fn(() =>
            Promise.resolve({
                ok: true,
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(2)),
            }),
        );
        const doc = createDocStub();
        doc.addFont = vi.fn(() => {
            throw new Error("bad font table");
        });

        expect(await registerPdfFonts(doc)).toBe(FALLBACK_FONTS);
    });
});
