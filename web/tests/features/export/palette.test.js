import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    PDF_PALETTE_TOKENS,
    parseCssColor,
    readPdfPalette,
} from "../../../src/features/export/palette.js";

describe("parseCssColor", () => {
    it("parses opaque rgb() and rgba()", () => {
        expect(parseCssColor("rgb(66, 133, 244)")).toEqual({ r: 66, g: 133, b: 244 });
        expect(parseCssColor("rgba(28, 25, 23, 1)")).toEqual({ r: 28, g: 25, b: 23 });
    });

    it("parses space and slash separated modern syntax", () => {
        expect(parseCssColor("rgb(66 133 244)")).toEqual({ r: 66, g: 133, b: 244 });
        expect(parseCssColor("rgb(0 0 0 / 100%)")).toEqual({ r: 0, g: 0, b: 0 });
    });

    it("flattens transparency over the warm paper color", () => {
        // 50% black over rgb(255, 253, 247).
        expect(parseCssColor("rgba(0, 0, 0, 0.5)")).toEqual({ r: 128, g: 127, b: 124 });
        expect(parseCssColor("rgba(0, 0, 0, 50%)")).toEqual({ r: 128, g: 127, b: 124 });
    });

    it("treats a fully transparent color as the paper color", () => {
        expect(parseCssColor("rgba(0, 0, 0, 0)")).toEqual({ r: 255, g: 253, b: 247 });
    });

    it("rejects a color whose alpha is not numeric syntax at all", () => {
        // "none" does not match the alpha group, so the whole color fails to
        // parse: that is a different outcome from falling back to opaque.
        expect(parseCssColor("rgba(10, 20, 30, none)")).toBeNull();
    });

    it("falls back to opaque when the alpha component parses to NaN", () => {
        expect(parseCssColor("rgba(10, 20, 30, .)")).toEqual({ r: 10, g: 20, b: 30 });
    });

    it("clamps out-of-range channels", () => {
        expect(parseCssColor("rgb(300, 0, 128.6)")).toEqual({ r: 255, g: 0, b: 129 });
    });

    it("parses three and six digit hex", () => {
        expect(parseCssColor("#fff")).toEqual({ r: 255, g: 255, b: 255 });
        expect(parseCssColor("#4285F4")).toEqual({ r: 66, g: 133, b: 244 });
    });

    it("flattens four and eight digit hex, which the build minifier emits", () => {
        // #fbbc0526 is the minified form of rgba(251, 188, 5, 0.15).
        expect(parseCssColor("#fbbc0526")).toEqual({ r: 254, g: 243, b: 211 });
        // #0008 doubles to alpha 0x88, which is 0.533, not 0.5.
        expect(parseCssColor("#0008")).toEqual({ r: 119, g: 118, b: 115 });
        expect(parseCssColor("#000f")).toEqual({ r: 0, g: 0, b: 0 });
    });

    it("returns null for blank and unrecognized values", () => {
        expect(parseCssColor("")).toBeNull();
        expect(parseCssColor("   ")).toBeNull();
        expect(parseCssColor(null)).toBeNull();
        expect(parseCssColor(undefined)).toBeNull();
        expect(parseCssColor("papayawhip")).toBeNull();
        expect(parseCssColor("#ff004")).toBeNull();
        expect(parseCssColor("#ff004455aa")).toBeNull();
    });

    it("returns frozen colors", () => {
        expect(Object.isFrozen(parseCssColor("#fff"))).toBe(true);
        expect(Object.isFrozen(parseCssColor("rgb(1, 2, 3)"))).toBe(true);
    });
});

describe("readPdfPalette", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        document.body.innerHTML = "";
    });

    it("returns a frozen palette covering every token", () => {
        const palette = readPdfPalette();

        expect(Object.isFrozen(palette)).toBe(true);
        for (const token of PDF_PALETTE_TOKENS) {
            expect(palette[token]).toMatchObject({
                r: expect.any(Number),
                g: expect.any(Number),
                b: expect.any(Number),
            });
        }
    });

    it("falls back to the built-in light values when the environment resolves nothing", () => {
        // jsdom does not resolve custom properties, so this is the live path.
        const palette = readPdfPalette();

        expect(palette["--bg-primary"]).toEqual({ r: 255, g: 253, b: 247 });
        expect(palette["--accent-blue"]).toEqual({ r: 66, g: 133, b: 244 });
        expect(palette["--text-primary"]).toEqual({ r: 28, g: 25, b: 23 });
    });

    it("prefers stylesheet values when the environment resolves them", () => {
        vi.spyOn(window, "getComputedStyle").mockReturnValue({
            getPropertyValue: (token) =>
                token === "--accent-blue" ? "rgb(1, 2, 3)" : "rgba(9, 9, 9, 1)",
        });

        const palette = readPdfPalette();

        expect(palette["--accent-blue"]).toEqual({ r: 1, g: 2, b: 3 });
        expect(palette["--bg-primary"]).toEqual({ r: 9, g: 9, b: 9 });
    });

    it("mounts a detached light-theme probe and removes it again", () => {
        let probe = null;
        vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
            probe = element;
            return { getPropertyValue: () => "" };
        });

        readPdfPalette();

        // The probe is briefly mounted into the live document, so it has to be
        // out of the accessibility tree and out of layout while it is there.
        expect(probe.className).toBe("theme-light");
        expect(probe.getAttribute("aria-hidden")).toBe("true");
        expect(probe.style.position).toBe("absolute");
        expect(probe.style.left).toBe("-9999px");
        expect(document.querySelectorAll(".theme-light")).toHaveLength(0);
    });

    it("removes the probe even when reading a token throws", () => {
        vi.spyOn(window, "getComputedStyle").mockReturnValue({
            getPropertyValue: () => {
                throw new Error("boom");
            },
        });

        expect(() => readPdfPalette()).toThrow("boom");
        expect(document.querySelectorAll(".theme-light")).toHaveLength(0);
    });

    it("uses fallbacks when getComputedStyle is unavailable", () => {
        const original = window.getComputedStyle;
        // @ts-expect-error deliberately removing the API to exercise the guard
        delete window.getComputedStyle;

        try {
            expect(readPdfPalette()["--accent-green"]).toEqual({ r: 41, g: 181, b: 113 });
        } finally {
            window.getComputedStyle = original;
        }
    });

    it("uses fallbacks when the computed style has no getPropertyValue", () => {
        vi.spyOn(window, "getComputedStyle").mockReturnValue(
            /** @type {CSSStyleDeclaration} */ ({}),
        );

        expect(readPdfPalette()["--accent-red"]).toEqual({ r: 249, g: 74, b: 54 });
    });
});

describe("readPdfPalette without a document body", () => {
    let originalBody;

    beforeEach(() => {
        originalBody = document.body;
        Object.defineProperty(document, "body", { value: null, configurable: true });
    });

    afterEach(() => {
        Object.defineProperty(document, "body", { value: originalBody, configurable: true });
    });

    it("still returns the fallback palette", () => {
        expect(readPdfPalette()["--border-color"]).toEqual({ r: 68, g: 64, b: 60 });
    });
});
