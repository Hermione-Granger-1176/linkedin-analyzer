import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hideCatcher, playCatch, showCatcher } from "../../../src/features/upload/mascot.js";
import { mockMatchMedia, resetDom, setupDom } from "../../helpers/dom.js";

/**
 * Read the catcher out of the drop zone.
 * @returns {HTMLElement} The catcher element.
 */
function catcher() {
    return document.getElementById("uploadCatcher");
}

describe("upload catcher", () => {
    beforeEach(() => {
        // jsdom has no matchMedia, and the catch asks it whether the visitor
        // wants motion at all.
        mockMatchMedia(false);
        setupDom(`
            <div class="drop-zone" id="multiDropZone">
                <svg class="pip-catcher" id="uploadCatcher" data-pose="ready" hidden></svg>
            </div>
        `);
    });

    afterEach(() => {
        resetDom();
        vi.useRealTimers();
    });

    describe("showCatcher", () => {
        it("brings Pip up in the ready pose", () => {
            showCatcher();

            expect(catcher().hasAttribute("hidden")).toBe(false);
            expect(catcher().getAttribute("data-pose")).toBe("ready");
        });

        it("leaves him alone once he is already up", () => {
            showCatcher();
            const revealed = vi.spyOn(catcher(), "removeAttribute");

            showCatcher();

            expect(revealed).not.toHaveBeenCalled();
            expect(catcher().hasAttribute("hidden")).toBe(false);
        });

        it("takes him back to the ready pose when a drag follows a catch", () => {
            vi.useFakeTimers();
            playCatch();
            expect(catcher().getAttribute("data-pose")).toBe("catch");

            showCatcher();

            expect(catcher().getAttribute("data-pose")).toBe("ready");
            expect(catcher().hasAttribute("hidden")).toBe(false);
            // The catch's own timer was cleared with it, so he stays up.
            vi.advanceTimersByTime(2000);
            expect(catcher().hasAttribute("hidden")).toBe(false);
        });

        it("does nothing on a screen without a catcher", () => {
            setupDom("");

            expect(() => showCatcher()).not.toThrow();
        });
    });

    describe("hideCatcher", () => {
        it("puts him away again when the drag leaves", () => {
            showCatcher();

            hideCatcher();

            expect(catcher().hasAttribute("hidden")).toBe(true);
            expect(catcher().getAttribute("data-pose")).toBe("ready");
        });

        it("does nothing on a screen without a catcher", () => {
            setupDom("");

            expect(() => hideCatcher()).not.toThrow();
        });
    });

    describe("playCatch", () => {
        it("plays the catch, then puts him away", () => {
            vi.useFakeTimers();

            playCatch();

            expect(catcher().hasAttribute("hidden")).toBe(false);
            expect(catcher().getAttribute("data-pose")).toBe("catch");

            vi.advanceTimersByTime(1100);

            expect(catcher().hasAttribute("hidden")).toBe(true);
            expect(catcher().getAttribute("data-pose")).toBe("ready");
        });

        it("replays cleanly when a second file lands", () => {
            vi.useFakeTimers();

            playCatch();
            vi.advanceTimersByTime(600);
            playCatch();
            vi.advanceTimersByTime(600);

            // The first timer went with the replay, so the second catch is
            // still on screen.
            expect(catcher().hasAttribute("hidden")).toBe(false);
            expect(catcher().getAttribute("data-pose")).toBe("catch");

            vi.advanceTimersByTime(500);

            expect(catcher().hasAttribute("hidden")).toBe(true);
        });

        it("stays out of the way when reduced motion is requested", () => {
            mockMatchMedia(true);
            showCatcher();

            playCatch();

            expect(catcher().hasAttribute("hidden")).toBe(true);
            expect(catcher().getAttribute("data-pose")).toBe("ready");
        });

        it("does nothing on a screen without a catcher", () => {
            setupDom("");

            expect(() => playCatch()).not.toThrow();
        });
    });
});
