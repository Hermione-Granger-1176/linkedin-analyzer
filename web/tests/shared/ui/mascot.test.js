import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockMatchMedia, resetDom, setupDom } from "../../helpers/dom.js";

/* Kept in step with mascot.js, which keeps its timings to itself. */
const SPLAT_LIFETIME_MS = 800;
const CHEER_MS = 2000;
const STAPLE_MS = 1700;
const ERASER_MS = 1700;

/* mascot.js binds a click listener on the document for the life of the page,
   and the document outlives every test in this file. Recording what gets bound
   lets afterEach hand the next test a clean document rather than one carrying
   the previous tests' splats. */
const boundListeners = [];
/** @type {Map<EventTarget, Function>} */
const realAddEventListener = new Map();

/**
 * Record every listener the module binds, and pass it on to the real thing.
 * @returns {void}
 */
function recordListeners() {
    realAddEventListener.set(document, document.addEventListener);
    const original = document.addEventListener.bind(document);
    document.addEventListener = (type, handler, options) => {
        boundListeners.push({ type, handler, options });
        original(type, handler, options);
    };
}

/**
 * Give the document its own addEventListener back, then take every listener
 * bound during the test off again.
 * @returns {void}
 */
function releaseListeners() {
    realAddEventListener.forEach((original, target) => {
        target.addEventListener = /** @type {typeof target.addEventListener} */ (original);
    });
    realAddEventListener.clear();
    boundListeners.splice(0).forEach(({ type, handler, options }) => {
        document.removeEventListener(type, handler, options);
    });
}

/**
 * Load a fresh copy of the module, so the one-shot init flag, the moment timers
 * and the cache it subscribes to all start from nothing in every test. The
 * cache comes from the same fresh graph, or a notification sent from this file
 * would reach an instance the module never subscribed to.
 * @returns {Promise<object>} The module's exports, plus the DataCache it reads.
 */
async function loadMascot() {
    vi.resetModules();
    const mascot = await import("../../../src/shared/ui/mascot.js");
    const { DataCache } = await import("../../../src/platform/persistence/data-cache.js");
    return { ...mascot, DataCache };
}

/**
 * Click an element with pointer coordinates, the way the splat reads them. The
 * detail count is what a pointer click carries and a keyboard one does not.
 * @param {Element} element - Element to click.
 * @param {number} clientX - Pointer x in client space.
 * @param {number} clientY - Pointer y in client space.
 * @returns {void}
 */
function clickAt(element, clientX, clientY) {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX, clientY, detail: 1 }));
}

/**
 * Give an element a measurable box, since jsdom lays nothing out.
 * @param {Element} element - The element to measure.
 * @param {{left?: number, top?: number, width?: number, height?: number}} box - The box to report.
 * @returns {void}
 */
function measure(element, { left = 0, top = 0, width = 100, height = 40 } = {}) {
    element.getBoundingClientRect = /** @type {typeof Element.prototype.getBoundingClientRect} */ (
        () => ({ left, top, width, height, right: left + width, bottom: top + height })
    );
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
            <svg class="pip-staple" id="pdfStaple" hidden></svg>
            <svg class="pip-eraser" id="clearEraser" hidden></svg>
        `);
        recordListeners();
    });

    afterEach(() => {
        releaseListeners();
        resetDom();
        vi.useRealTimers();
    });

    describe("ink splat", () => {
        it("drops a splat inside a clicked primary button", async () => {
            const { initMascot } = await loadMascot();
            initMascot();

            clickAt(document.getElementById("primary"), 24, 12);

            const splat = document.querySelector("#primary .pip-splat");
            expect(splat).not.toBeNull();
            expect(splat.style.left).toBe("24px");
            expect(splat.style.top).toBe("12px");
            expect(splat.getAttribute("aria-hidden")).toBe("true");
            expect(splat.querySelector("svg path")).not.toBeNull();
        });

        it("drops a splat on download buttons too", async () => {
            const { initMascot } = await loadMascot();
            initMascot();

            clickAt(document.getElementById("download"), 5, 5);

            expect(document.querySelector("#download .pip-splat")).not.toBeNull();
        });

        it("centres the splat when the button was activated from the keyboard", async () => {
            const { initMascot } = await loadMascot();
            initMascot();
            const button = document.getElementById("primary");
            measure(button, { left: 10, top: 20, width: 100, height: 40 });

            // Space and Enter raise a click with no pointer behind it, which
            // reports 0,0 for the position.
            button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));

            const splat = document.querySelector("#primary .pip-splat");
            expect(splat.style.left).toBe("50px");
            expect(splat.style.top).toBe("20px");
        });

        it("removes the splat once its animation ends", async () => {
            const { initMascot } = await loadMascot();
            initMascot();
            clickAt(document.getElementById("primary"), 4, 4);
            const splat = document.querySelector("#primary .pip-splat");

            splat.dispatchEvent(new Event("animationend"));

            expect(document.querySelector("#primary .pip-splat")).toBeNull();
        });

        it("drops the backstop timer once the animation has ended", async () => {
            vi.useFakeTimers();
            const { initMascot } = await loadMascot();
            initMascot();
            clickAt(document.getElementById("primary"), 4, 4);
            expect(vi.getTimerCount()).toBe(1);

            document.querySelector("#primary .pip-splat").dispatchEvent(new Event("animationend"));

            expect(vi.getTimerCount()).toBe(0);
        });

        it("clears the splat on a timer when no animation ever ends", async () => {
            vi.useFakeTimers();
            const { initMascot } = await loadMascot();
            initMascot();
            clickAt(document.getElementById("primary"), 4, 4);
            expect(document.querySelector("#primary .pip-splat")).not.toBeNull();

            vi.advanceTimersByTime(SPLAT_LIFETIME_MS);

            expect(document.querySelector("#primary .pip-splat")).toBeNull();
        });

        it("binds once, so a repeat init cannot double up the splats", async () => {
            const { initMascot } = await loadMascot();
            initMascot();
            initMascot();

            clickAt(document.getElementById("primary"), 4, 4);

            expect(document.querySelectorAll("#primary .pip-splat")).toHaveLength(1);
        });

        it("ignores clicks that miss a splattable button", async () => {
            const { initMascot } = await loadMascot();
            initMascot();

            clickAt(document.getElementById("plain"), 4, 4);

            expect(document.querySelector(".pip-splat")).toBeNull();
        });

        it("stays out of the way when reduced motion is requested", async () => {
            mockMatchMedia(true);
            const { initMascot } = await loadMascot();
            initMascot();

            clickAt(document.getElementById("primary"), 4, 4);

            expect(document.querySelector(".pip-splat")).toBeNull();
        });
    });

    describe("celebrateDownload", () => {
        it("shows the cheer, then hides it again", async () => {
            vi.useFakeTimers();
            const { celebrateDownload } = await loadMascot();

            celebrateDownload();

            const cheer = document.getElementById("cleanCheer");
            expect(cheer.hasAttribute("hidden")).toBe(false);
            expect(cheer.classList.contains("is-cheering")).toBe(true);

            vi.advanceTimersByTime(CHEER_MS);

            expect(cheer.hasAttribute("hidden")).toBe(true);
            expect(cheer.classList.contains("is-cheering")).toBe(false);
        });

        it("replays cleanly when a second download lands", async () => {
            vi.useFakeTimers();
            const { celebrateDownload } = await loadMascot();

            celebrateDownload();
            vi.advanceTimersByTime(500);
            celebrateDownload();
            vi.advanceTimersByTime(CHEER_MS - 400);

            const cheer = document.getElementById("cleanCheer");
            // The first timer was cleared, so the second run is still on screen.
            expect(cheer.hasAttribute("hidden")).toBe(false);
            expect(cheer.classList.contains("is-cheering")).toBe(true);

            vi.advanceTimersByTime(400);

            expect(cheer.hasAttribute("hidden")).toBe(true);
        });

        it("does nothing when the cheer element is absent", async () => {
            const { celebrateDownload } = await loadMascot();
            setupDom("");

            expect(() => celebrateDownload()).not.toThrow();
        });

        it("does nothing when reduced motion is requested", async () => {
            mockMatchMedia(true);
            const { celebrateDownload } = await loadMascot();

            celebrateDownload();

            expect(document.getElementById("cleanCheer").hasAttribute("hidden")).toBe(true);
        });
    });

    describe("celebrateStaple", () => {
        it("shows the staple, then hides it again", async () => {
            vi.useFakeTimers();
            const { celebrateStaple } = await loadMascot();

            celebrateStaple();

            const staple = document.getElementById("pdfStaple");
            expect(staple.hasAttribute("hidden")).toBe(false);
            expect(staple.classList.contains("is-stapling")).toBe(true);

            vi.advanceTimersByTime(STAPLE_MS);

            expect(staple.hasAttribute("hidden")).toBe(true);
            expect(staple.classList.contains("is-stapling")).toBe(false);
        });

        it("keeps each moment on its own timer", async () => {
            vi.useFakeTimers();
            const { celebrateDownload, celebrateStaple } = await loadMascot();

            celebrateDownload();
            celebrateStaple();
            vi.advanceTimersByTime(STAPLE_MS);

            // The staple's own timer has fired; the longer cheer is still up.
            expect(document.getElementById("pdfStaple").hasAttribute("hidden")).toBe(true);
            expect(document.getElementById("cleanCheer").hasAttribute("hidden")).toBe(false);
        });

        it("does nothing when reduced motion is requested", async () => {
            mockMatchMedia(true);
            const { celebrateStaple } = await loadMascot();

            celebrateStaple();

            expect(document.getElementById("pdfStaple").hasAttribute("hidden")).toBe(true);
        });
    });

    describe("the eraser sweep", () => {
        it("runs when a wipe has actually gone through", async () => {
            vi.useFakeTimers();
            const { initMascot, DataCache } = await loadMascot();
            initMascot();

            DataCache.notify({ type: "storageCleared" });

            const eraser = document.getElementById("clearEraser");
            expect(eraser.hasAttribute("hidden")).toBe(false);
            expect(eraser.classList.contains("is-erasing")).toBe(true);

            vi.advanceTimersByTime(ERASER_MS);

            expect(eraser.hasAttribute("hidden")).toBe(true);
            expect(eraser.classList.contains("is-erasing")).toBe(false);
        });

        it("ignores every other cache notification", async () => {
            const { initMascot, DataCache } = await loadMascot();
            initMascot();

            DataCache.notify({ type: "filesChanged" });

            expect(document.getElementById("clearEraser").hasAttribute("hidden")).toBe(true);
        });

        it("stays out of the way when reduced motion is requested", async () => {
            mockMatchMedia(true);
            const { initMascot, DataCache } = await loadMascot();
            initMascot();

            DataCache.notify({ type: "storageCleared" });

            expect(document.getElementById("clearEraser").hasAttribute("hidden")).toBe(true);
        });
    });
});
