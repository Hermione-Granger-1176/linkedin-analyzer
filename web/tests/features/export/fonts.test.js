import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    FALLBACK_FONTS,
    encodeFontBytes,
    readDrawableCoverage,
    registerPdfFonts,
} from "../../../src/features/export/fonts.js";
import { captureError } from "../../../src/platform/observability/sentry.js";

vi.mock("../../../src/platform/observability/sentry.js", () => ({
    captureError: vi.fn(),
}));

const FONT_DIRECTORY = "web/public/fonts";

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

/**
 * Read one of the faces the app actually ships.
 * @param {string} file - File name under the public fonts directory
 * @returns {ArrayBuffer} Font bytes
 */
function readShippedFont(file) {
    const bytes = readFileSync(join(process.cwd(), FONT_DIRECTORY, file));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/**
 * Write one segmented cmap subtable's segments, terminator included.
 * @param {DataView} view - Font file being built
 * @param {number} offset - Byte offset of the subtable
 * @param {Array<[number, number]>} segments - Start and end code of each segment
 */
function writeSegments(view, offset, segments) {
    const all = [...segments, [0xffff, 0xffff]];
    view.setUint16(offset + 2, 16 + 8 * all.length);
    view.setUint16(offset + 6, all.length * 2);
    const endCodes = offset + 14;
    const startCodes = endCodes + all.length * 2 + 2;
    all.forEach(([start, end], index) => {
        view.setUint16(endCodes + index * 2, end);
        view.setUint16(startCodes + index * 2, start);
    });
}

/**
 * Build a TrueType file carrying one table and nothing else.
 *
 * Hand-built rather than borrowed from a real face: the paths worth testing
 * here are the ones a real face never takes, and the shipped files cover the
 * one it does.
 * @param {Array<{format: number, segments?: Array<[number, number]>}>} subtables - Subtables to write
 * @param {string} [tag] - Table tag, so a file with no cmap at all can be built
 * @returns {ArrayBuffer} Font bytes
 */
function buildFontFile(subtables, tag = "cmap") {
    const tableOffset = 28;
    const headerSize = 4 + subtables.length * 8;
    const sizes = subtables.map((subtable) =>
        subtable.format === 4 ? 16 + 8 * (subtable.segments.length + 1) : 16,
    );
    const total = tableOffset + headerSize + sizes.reduce((sum, size) => sum + size, 0);

    const buffer = new ArrayBuffer(total);
    const view = new DataView(buffer);
    view.setUint32(0, 0x00010000);
    view.setUint16(4, 1);
    for (let index = 0; index < 4; index += 1) {
        view.setUint8(12 + index, tag.charCodeAt(index));
    }
    view.setUint32(20, tableOffset);
    view.setUint32(24, total - tableOffset);
    view.setUint16(tableOffset + 2, subtables.length);

    let subtableOffset = tableOffset + headerSize;
    subtables.forEach((subtable, index) => {
        const record = tableOffset + 4 + index * 8;
        view.setUint16(record, 3);
        view.setUint16(record + 2, 1);
        view.setUint32(record + 4, subtableOffset - tableOffset);
        view.setUint16(subtableOffset, subtable.format);
        if (subtable.format === 4) {
            writeSegments(view, subtableOffset, subtable.segments);
        }
        subtableOffset += sizes[index];
    });
    return buffer;
}

/**
 * Answer every font request with the same bytes.
 * @param {ArrayBuffer} buffer - Font bytes to serve
 */
function serveFont(buffer) {
    globalThis.fetch = vi.fn(() =>
        Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(buffer) }),
    );
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
        // Teardown, not the last line of a test body: an assertion failing above
        // that line used to leave fake timers installed, so one failure turned
        // into a hang in the next test that awaits anything.
        vi.useRealTimers();
        delete globalThis.fetch;
    });

    it("registers each face with its own bytes", async () => {
        // The stub records the file and its data together, but only the names
        // were ever read back. Registering Caveat with Patrick Hand's outlines,
        // or with no bytes at all, ships a visibly broken document and would
        // otherwise pass every assertion in this file.
        const faces = {
            "/fonts/PatrickHand-Regular.ttf": buildFontFile([
                { format: 4, segments: [[0x41, 0x42]] },
            ]),
            "/fonts/Caveat-Regular.ttf": buildFontFile([{ format: 4, segments: [[0x41, 0x43]] }]),
        };
        globalThis.fetch = vi.fn((url) =>
            Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(faces[url]) }),
        );
        const doc = createDocStub();

        await registerPdfFonts(doc);

        expect(doc.vfs).toEqual([
            {
                file: "PatrickHand-Regular.ttf",
                data: encodeFontBytes(faces["/fonts/PatrickHand-Regular.ttf"]),
            },
            {
                file: "Caveat-Regular.ttf",
                data: encodeFontBytes(faces["/fonts/Caveat-Regular.ttf"]),
            },
        ]);
    });

    it("registers both handwritten faces and reports the family names", async () => {
        const requested = [];
        const font = buildFontFile([{ format: 4, segments: [[0x41, 0x5a]] }]);
        globalThis.fetch = vi.fn((url) => {
            requested.push(url);
            return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(font) });
        });
        const doc = createDocStub();

        const families = await registerPdfFonts(doc);

        expect(requested).toEqual([
            "/fonts/PatrickHand-Regular.ttf",
            "/fonts/Caveat-Regular.ttf",
        ]);
        expect(families).toEqual({ body: "PatrickHand", accent: "Caveat" });
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
        expect(FALLBACK_FONTS).toEqual({ body: "helvetica", accent: "helvetica" });
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

    it("falls back to Helvetica when a font request never answers", async () => {
        vi.useFakeTimers();
        // A server that accepts the connection and then goes silent: the fetch
        // only settles when its abort signal fires.
        globalThis.fetch = vi.fn(
            (url, init) =>
                new Promise((resolve, reject) => {
                    init.signal.addEventListener("abort", () =>
                        reject(new DOMException("Aborted", "AbortError")),
                    );
                }),
        );
        const doc = createDocStub();

        let settled = false;
        const pending = registerPdfFonts(doc).then((fonts) => {
            settled = true;
            return fonts;
        });

        // Bounded below as well as above. With only the upper bound, cutting
        // the budget to a millisecond would still pass here while dropping the
        // handwritten faces on any connection slower than instant.
        await vi.advanceTimersByTimeAsync(9999);
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(2);

        expect(await pending).toBe(FALLBACK_FONTS);
        expect(doc.addFont).not.toHaveBeenCalled();
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "register-fonts",
        });
    });

    it("reads what the faces it just embedded can actually draw", async () => {
        // The shipped files themselves, not a guess about them: the document
        // model is sanitized against this, so a wrong answer here is either a
        // name mangled that did not need to be or one lost that did.
        const buffers = [
            readShippedFont("PatrickHand-Regular.ttf"),
            readShippedFont("Caveat-Regular.ttf"),
        ];
        let index = 0;
        globalThis.fetch = vi.fn(() =>
            Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(buffers[index++]) }),
        );

        await registerPdfFonts(createDocStub());
        const coverage = readDrawableCoverage();

        expect(coverage.has("é".codePointAt(0))).toBe(true);
        expect(coverage.has("×".codePointAt(0))).toBe(true);
        // Past WinAnsi and in both faces, so this is the cmap being read rather
        // than the fallback set standing in for it.
        expect(coverage.has("ı".codePointAt(0))).toBe(true);
        expect(coverage.has("李".codePointAt(0))).toBe(false);
        expect(coverage.has("Ň".codePointAt(0))).toBe(false);
        // In Caveat and not in Patrick Hand. The collector does not know which
        // face will draw which string, so only what both carry counts.
        expect(coverage.has("µ".codePointAt(0))).toBe(false);
        expect(coverage.size).toBe(219);
    });

    it("falls back to WinAnsi when a face has no character map", async () => {
        serveFont(buildFontFile([{ format: 4, segments: [[0x41, 0x5a]] }], "glyf"));

        await registerPdfFonts(createDocStub());
        const coverage = readDrawableCoverage();

        expect(coverage.has("€".codePointAt(0))).toBe(true);
        expect(coverage.has("ı".codePointAt(0))).toBe(false);
    });

    it("falls back to WinAnsi when the character map is in a format it cannot read", async () => {
        // A face with glyphs beyond the basic plane would use one. This under-
        // uses such a face; it never claims a glyph that is not there.
        serveFont(buildFontFile([{ format: 12 }]));

        expect(readDrawableCoverage().has("ı".codePointAt(0))).toBe(false);

        await registerPdfFonts(createDocStub());

        expect(readDrawableCoverage().has("A".codePointAt(0))).toBe(true);
        expect(readDrawableCoverage().has("ı".codePointAt(0))).toBe(false);
    });

    it("stops reading a character map whose segments run backwards", async () => {
        // Segments are ordered and never overlap in a table this can trust, and
        // walking a corrupt one would go over the same ranges again and again.
        serveFont(
            buildFontFile([
                {
                    format: 4,
                    segments: [
                        [0x41, 0x5a],
                        [0x30, 0x39],
                    ],
                },
            ]),
        );

        await registerPdfFonts(createDocStub());
        const coverage = readDrawableCoverage();

        expect(coverage.has("A".codePointAt(0))).toBe(true);
        expect(coverage.has("0".codePointAt(0))).toBe(false);
    });

    it("stops reading a character map whose segment ends before it starts", async () => {
        // A distinct guard from the ordering one above, and the only one of the
        // three with nothing behind it. A segment that ends before it starts
        // covers nothing either way, so the reading has to stop rather than
        // carry on into the segments after it, which a corrupt table has given
        // no reason to trust.
        serveFont(
            buildFontFile([
                {
                    format: 4,
                    segments: [
                        [0x41, 0x43],
                        [0x5a, 0x50],
                        [0x61, 0x7a],
                    ],
                },
            ]),
        );

        await registerPdfFonts(createDocStub());
        const coverage = readDrawableCoverage();

        // A to C, read before the reading stopped. The backwards segment covers
        // nothing whether or not the guard is there, so the segment after it is
        // what tells the two apart: without the guard its lowercase range is
        // claimed on the strength of a table already known to be broken.
        expect(coverage.has("A".codePointAt(0))).toBe(true);
        expect(coverage.has("a".codePointAt(0))).toBe(false);
    });

    it("falls back to WinAnsi coverage when the fonts never arrive", async () => {
        // The core font encodes as WinAnsi and turns a string holding anything
        // outside it into mojibake, so this path narrows what may be drawn
        // rather than skipping the question.
        serveFont(buildFontFile([{ format: 4, segments: [[0x41, 0x5a]] }]));
        await registerPdfFonts(createDocStub());
        expect(readDrawableCoverage().has("é".codePointAt(0))).toBe(false);

        globalThis.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 404 }));
        await registerPdfFonts(createDocStub());
        const coverage = readDrawableCoverage();

        expect(coverage.has("é".codePointAt(0))).toBe(true);
        expect(coverage.has("—".codePointAt(0))).toBe(true);
        expect(coverage.has("李".codePointAt(0))).toBe(false);
    });

    it("falls back to Helvetica when a face is too short to read", async () => {
        // Read before anything is registered, so a file that is not a font goes
        // the way a file that never arrived does: a document drawn with bytes
        // this cannot walk would not be much of a document either.
        serveFont(new Uint8Array([1, 2, 3]).buffer);
        const doc = createDocStub();

        expect(await registerPdfFonts(doc)).toBe(FALLBACK_FONTS);
        expect(doc.addFont).not.toHaveBeenCalled();
        expect(readDrawableCoverage().has("é".codePointAt(0))).toBe(true);
    });

    it("falls back to Helvetica when registration itself throws", async () => {
        serveFont(buildFontFile([{ format: 4, segments: [[0x41, 0x5a]] }]));
        const doc = createDocStub();
        doc.addFont = vi.fn(() => {
            throw new Error("bad font table");
        });

        expect(await registerPdfFonts(doc)).toBe(FALLBACK_FONTS);
        // All-or-nothing, which is the whole point of the surrounding catch: a
        // document carrying one embedded face and one core face looks broken.
        expect(doc.fonts).toEqual([]);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "register-fonts",
        });
    });
});
