import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { celebrateDownload, initMascot } from "../../../src/shared/ui/mascot.js";
import { mockMatchMedia, resetDom, setupDom } from "../../helpers/dom.js";

/**
 * Click an element with pointer coordinates, the way the splat reads them.
 * @param {Element} element - Element to click.
 * @param {number} clientX - Pointer x in client space.
 * @param {number} clientY - Pointer y in client space.
 * @returns {void}
 */
function clickAt(element, clientX, clientY) {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX, clientY }));
}

describe("mascot", () => {
    beforeEach(() => {
        // jsdom has no matchMedia, and every entry point here asks it whether
        // the visitor wants motion at all.
        mockMatchMedia(false);
        setupDom(`
            <button class="primary-btn" id="primary">Go</button>
            <button class="download-btn" id="download">Download</button>
            <button id="plain">Plain</button>
            <svg class="pip-cheer" id="cleanCheer" hidden></svg>
        `);
    });

    afterEach(() => {
        resetDom();
        vi.useRealTimers();
    });

    describe("ink splat", () => {
        it("drops a splat inside a clicked primary button", () => {
            initMascot();

            clickAt(document.getElementById("primary"), 24, 12);

            const splat = document.querySelector("#primary .pip-splat");
            expect(splat).not.toBeNull();
            expect(splat.style.left).toBe("24px");
            expect(splat.style.top).toBe("12px");
            expect(splat.getAttribute("aria-hidden")).toBe("true");
            expect(splat.querySelector("svg path")).not.toBeNull();
        });

        it("drops a splat on download buttons too", () => {
            initMascot();

            clickAt(document.getElementById("download"), 5, 5);

            expect(document.querySelector("#download .pip-splat")).not.toBeNull();
        });

        it("removes the splat once its animation ends", () => {
            initMascot();
            clickAt(document.getElementById("primary"), 4, 4);
            const splat = document.querySelector("#primary .pip-splat");

            splat.dispatchEvent(new Event("animationend"));

            expect(document.querySelector("#primary .pip-splat")).toBeNull();
        });

        it("clears the splat on a timer when no animation ever ends", () => {
            vi.useFakeTimers();
            initMascot();
            clickAt(document.getElementById("primary"), 4, 4);
            expect(document.querySelector("#primary .pip-splat")).not.toBeNull();

            vi.advanceTimersByTime(800);

            expect(document.querySelector("#primary .pip-splat")).toBeNull();
        });

        it("binds once, so a repeat init cannot double up the splats", () => {
            initMascot();
            initMascot();

            clickAt(document.getElementById("primary"), 4, 4);

            expect(document.querySelectorAll("#primary .pip-splat")).toHaveLength(1);
        });

        it("ignores clicks that miss a splattable button", () => {
            initMascot();

            clickAt(document.getElementById("plain"), 4, 4);

            expect(document.querySelector(".pip-splat")).toBeNull();
        });

        it("stays out of the way when reduced motion is requested", () => {
            mockMatchMedia(true);
            initMascot();

            clickAt(document.getElementById("primary"), 4, 4);

            expect(document.querySelector(".pip-splat")).toBeNull();
        });
    });

    describe("celebrateDownload", () => {
        it("shows the cheer, then hides it again", () => {
            vi.useFakeTimers();

            celebrateDownload();

            const cheer = document.getElementById("cleanCheer");
            expect(cheer.hasAttribute("hidden")).toBe(false);
            expect(cheer.classList.contains("is-cheering")).toBe(true);

            vi.advanceTimersByTime(2000);

            expect(cheer.hasAttribute("hidden")).toBe(true);
            expect(cheer.classList.contains("is-cheering")).toBe(false);
        });

        it("replays cleanly when a second download lands", () => {
            vi.useFakeTimers();

            celebrateDownload();
            vi.advanceTimersByTime(500);
            celebrateDownload();
            vi.advanceTimersByTime(1600);

            const cheer = document.getElementById("cleanCheer");
            // The first timer was cleared, so the second run is still on screen.
            expect(cheer.hasAttribute("hidden")).toBe(false);
            expect(cheer.classList.contains("is-cheering")).toBe(true);

            vi.advanceTimersByTime(400);

            expect(cheer.hasAttribute("hidden")).toBe(true);
        });

        it("does nothing when the cheer element is absent", () => {
            setupDom("");

            expect(() => celebrateDownload()).not.toThrow();
        });

        it("does nothing when reduced motion is requested", () => {
            mockMatchMedia(true);

            celebrateDownload();

            expect(document.getElementById("cleanCheer").hasAttribute("hidden")).toBe(true);
        });
    });
});
