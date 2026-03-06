import { afterEach, describe, expect, it, vi } from "vitest";

import { Theme } from "../src/theme.js";

import { mockMatchMedia, resetDom, setupDom } from "./helpers/dom.js";

describe("Theme", () => {
    afterEach(() => {
        resetDom();
        window.localStorage.clear();
    });

    it("applies theme to document root", () => {
        setupDom('<button id="themeToggle"></button>');
        mockMatchMedia();
        document.documentElement.setAttribute("data-theme", "light");
        Theme.init();
        expect(document.documentElement.getAttribute("data-theme")).toBeTruthy();
    });

    it("returns early when theme toggle is missing", () => {
        setupDom("");
        mockMatchMedia();
        expect(() => Theme.init()).not.toThrow();
    });

    it("toggles theme on button click and persists", () => {
        setupDom('<button id="themeToggle"></button>');
        mockMatchMedia();
        document.documentElement.setAttribute("data-theme", "light");
        Theme.init();
        document.getElementById("themeToggle").click();
        expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
        expect(window.localStorage.getItem("linkedin-analyzer-theme")).toBe("dark");
    });

    it("reacts to system preference changes when no stored theme", () => {
        setupDom('<button id="themeToggle"></button>');
        const mql = mockMatchMedia(false);
        Theme.init();
        mql.dispatch(true);
        expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    });

    it("ignores system preference changes when a stored theme exists", () => {
        setupDom('<button id="themeToggle"></button>');
        const mql = mockMatchMedia(false);
        // Pre-set a stored preference so getStoredTheme() returns "light".
        window.localStorage.setItem("linkedin-analyzer-theme", "light");
        Theme.init();
        // Simulate the system switching to dark mode; the stored preference should win.
        mql.dispatch(true);
        expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    });

    it("falls back to the system theme when localStorage.getItem throws", () => {
        setupDom('<button id="themeToggle"></button>');
        const mql = mockMatchMedia(false);
        // Force localStorage.getItem to throw so Theme.init falls back to the system preference.
        vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
            throw new Error("SecurityError");
        });

        Theme.init();
        // The mocked system preference is light, so the document should stay light.
        expect(document.documentElement.getAttribute("data-theme")).toBe("light");

        // A later system preference change should still apply when no stored theme is available.
        mql.dispatch(true);
        expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

        vi.restoreAllMocks();
    });

    it("does not throw when localStorage.setItem throws during theme toggle", () => {
        setupDom('<button id="themeToggle"></button>');
        mockMatchMedia();
        document.documentElement.setAttribute("data-theme", "light");
        Theme.init();

        vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
            throw new Error("QuotaExceededError");
        });

        expect(() => document.getElementById("themeToggle").click()).not.toThrow();
        // Theme should still toggle in the DOM even if the storage write fails.
        expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    });
});
