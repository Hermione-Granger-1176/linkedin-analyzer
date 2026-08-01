import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetDom, setupDom } from "../../helpers/dom.js";

/* The hero markup alive.js reaches for, cut down to the hooks it uses. */
const HERO_HTML = `
    <section class="screen active" id="screen-home">
        <svg class="pip-hero">
            <g class="pip-bob">
                <g class="pip-blink">
                    <g class="pip-gaze">
                        <circle class="pip-eye"></circle>
                        <circle class="pip-eye"></circle>
                    </g>
                </g>
                <path class="pip-mouth"></path>
                <g class="pip-flick"></g>
            </g>
        </svg>
    </section>
`;

/* Kept in step with alive.js, which keeps them to itself. */
const IDLE_DELAY_MS = 20000;
const IDLE_DOODLE_MS = 2600;
const WAKE_MS = 800;

let frames = [];

/* alive.js binds for the life of the page, and window and document outlive every
   test in this file. Recording what gets bound lets afterEach hand the next test
   a clean pair of globals, instead of one carrying four tests' worth of eyes.
   The options go in the record too: a capture-phase listener only comes off
   again when it is removed with the same options it was added with. */
const boundListeners = [];
/** @type {Map<EventTarget, Function>} */
const realAddEventListener = new Map();

/**
 * Record every listener the module binds, and pass it on to the real thing.
 * @returns {void}
 */
function recordListeners() {
    [window, document].forEach((target) => {
        realAddEventListener.set(target, target.addEventListener);
        const original = target.addEventListener.bind(target);
        target.addEventListener = (type, handler, options) => {
            boundListeners.push({ target, type, handler, options });
            original(type, handler, options);
        };
    });
}

/**
 * Give the globals their own addEventListener back, then take every listener
 * bound during the test off again.
 * @returns {void}
 */
function releaseListeners() {
    realAddEventListener.forEach((original, target) => {
        target.addEventListener = /** @type {typeof target.addEventListener} */ (original);
    });
    realAddEventListener.clear();
    boundListeners.splice(0).forEach(({ target, type, handler, options }) => {
        target.removeEventListener(type, handler, options);
    });
}

/**
 * Answer media queries per query rather than with one shared verdict, which is
 * what alive.js needs: it asks about motion and about the pointer separately.
 * @param {{reduceMotion?: boolean, finePointer?: boolean}} preferences - What to answer.
 * @returns {void}
 */
function mockPreferences({ reduceMotion = false, finePointer = true } = {}) {
    window.matchMedia = /** @type {typeof window.matchMedia} */ (
        (query) => ({
            matches: query.includes("prefers-reduced-motion") ? reduceMotion : finePointer,
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
        })
    );
}

/**
 * Load a fresh copy of the module, so the one-shot init flag and the timers it
 * holds start from nothing in every test.
 * @returns {Promise<{initAlive: () => void}>} The freshly imported module.
 */
async function loadAlive() {
    vi.resetModules();
    return import("../../../src/shared/ui/alive.js");
}

/**
 * Find the hero drawing in the test DOM.
 * @returns {Element} The hero svg.
 */
function hero() {
    return /** @type {Element} */ (document.querySelector(".pip-hero"));
}

/**
 * Give the hero a measurable box, since jsdom lays nothing out.
 * @param {{left?: number, top?: number, width?: number, height?: number}} box - The box to report.
 * @returns {void}
 */
function measureHero({ left = 100, top = 100, width = 100, height = 100 } = {}) {
    hero().getBoundingClientRect = /** @type {typeof Element.prototype.getBoundingClientRect} */ (
        () => ({ left, top, width, height, right: left + width, bottom: top + height })
    );
}

/**
 * Send a pointer move and run the frame it books.
 * @param {number} clientX - Pointer x in client space.
 * @param {number} clientY - Pointer y in client space.
 * @returns {void}
 */
function movePointerTo(clientX, clientY) {
    window.dispatchEvent(new MouseEvent("pointermove", { clientX, clientY }));
    const queued = frames;
    frames = [];
    queued.forEach((callback) => callback());
}

/**
 * Read the inline transform alive.js wrote onto the gaze group.
 * @returns {string} The transform, or the empty string when none was written.
 */
function gazeTransform() {
    const gaze = /** @type {SVGElement} */ (document.querySelector(".pip-gaze"));
    return gaze.style.transform;
}

describe("alive", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        frames = [];
        // Vitest's fake timers do not stand in for rAF here, and the gaze needs a
        // frame queue it can drain on demand.
        window.requestAnimationFrame = /** @type {typeof window.requestAnimationFrame} */ (
            (callback) => {
                frames.push(callback);
                return frames.length;
            }
        );
        mockPreferences();
        setupDom(HERO_HTML);
        recordListeners();
    });

    afterEach(() => {
        releaseListeners();
        vi.useRealTimers();
        resetDom();
    });

    describe("cursor-following eyes", () => {
        it("shifts the pupils toward a pointer to the lower right", async () => {
            const { initAlive } = await loadAlive();
            initAlive();
            measureHero();

            // Hero centre is (150, 150); the pointer is well past the reach.
            movePointerTo(600, 600);

            expect(gazeTransform()).toBe("translate(1.60px, 0.80px)");
        });

        it("shifts them the other way for a pointer above and to the left", async () => {
            const { initAlive } = await loadAlive();
            initAlive();
            measureHero();

            // Centre is (150, 150), so this is past the reach on both axes.
            movePointerTo(-200, -200);

            expect(gazeTransform()).toBe("translate(-1.60px, -0.80px)");
        });

        it("scales the glance with distance rather than jumping to the cap", async () => {
            const { initAlive } = await loadAlive();
            initAlive();
            measureHero();

            // 140px right of centre is half of the 280px reach.
            movePointerTo(290, 150);

            expect(gazeTransform()).toBe("translate(0.80px, 0.00px)");
        });

        it("moves the eyes once per frame however many moves arrive", async () => {
            const { initAlive } = await loadAlive();
            initAlive();
            measureHero();

            window.dispatchEvent(new MouseEvent("pointermove", { clientX: 200, clientY: 150 }));
            window.dispatchEvent(new MouseEvent("pointermove", { clientX: 300, clientY: 150 }));
            window.dispatchEvent(new MouseEvent("pointermove", { clientX: 600, clientY: 150 }));

            expect(frames).toHaveLength(1);
            frames[0]();
            // The frame lands on the newest position, not the first one queued.
            expect(gazeTransform()).toBe("translate(1.60px, 0.00px)");
        });

        it("stays out of it entirely on a device without a fine pointer", async () => {
            mockPreferences({ finePointer: false });
            const { initAlive } = await loadAlive();
            initAlive();
            measureHero();

            movePointerTo(600, 600);

            expect(frames).toHaveLength(0);
            expect(gazeTransform()).toBe("");
        });

        it("writes nothing when the hero has left the page", async () => {
            const { initAlive } = await loadAlive();
            initAlive();
            measureHero();
            const gaze = document.querySelector(".pip-gaze");
            hero().remove();

            movePointerTo(600, 600);

            expect(/** @type {SVGElement} */ (gaze).style.transform).toBe("");
        });

        it("writes nothing when the hero carries no gaze group", async () => {
            const { initAlive } = await loadAlive();
            initAlive();
            measureHero();
            const gaze = document.querySelector(".pip-gaze");
            gaze.remove();

            expect(() => movePointerTo(600, 600)).not.toThrow();
            expect(/** @type {SVGElement} */ (gaze).style.transform).toBe("");
        });

        it("writes nothing while the hero measures nothing", async () => {
            const { initAlive } = await loadAlive();
            initAlive();
            // A hidden screen reports a zero box, and its centre is not a place
            // worth looking at.
            measureHero({ left: 0, top: 0, width: 0, height: 0 });

            movePointerTo(600, 600);

            expect(gazeTransform()).toBe("");
        });

        it("writes nothing while the hero measures nothing on one axis", async () => {
            const { initAlive } = await loadAlive();
            initAlive();
            measureHero({ left: 0, top: 0, width: 100, height: 100 });
            movePointerTo(600, 600);
            expect(gazeTransform()).toBe("translate(1.60px, 0.80px)");

            // A box with height but no width has no centre worth aiming at
            // either, and the glance it was holding comes off.
            measureHero({ left: 0, top: 0, width: 0, height: 120 });
            movePointerTo(600, 600);

            expect(gazeTransform()).toBe("");
        });
    });

    describe("idle doodle", () => {
        it("yawns once the page has been still long enough, then stops", async () => {
            const { initAlive } = await loadAlive();
            initAlive();

            vi.advanceTimersByTime(IDLE_DELAY_MS - 1);
            expect(hero().classList.contains("is-bored")).toBe(false);

            vi.advanceTimersByTime(1);
            expect(hero().classList.contains("is-bored")).toBe(true);

            vi.advanceTimersByTime(IDLE_DOODLE_MS);
            expect(hero().classList.contains("is-bored")).toBe(false);
        });

        it("starts the wait over on a keypress", async () => {
            const { initAlive } = await loadAlive();
            initAlive();

            vi.advanceTimersByTime(IDLE_DELAY_MS - 1000);
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));

            vi.advanceTimersByTime(IDLE_DELAY_MS - 1000);
            expect(hero().classList.contains("is-bored")).toBe(false);

            vi.advanceTimersByTime(1000);
            expect(hero().classList.contains("is-bored")).toBe(true);
        });

        it("starts the wait over on a pointer move as well", async () => {
            const { initAlive } = await loadAlive();
            initAlive();
            measureHero();

            vi.advanceTimersByTime(IDLE_DELAY_MS - 1);
            movePointerTo(200, 200);

            vi.advanceTimersByTime(IDLE_DELAY_MS - 1);
            expect(hero().classList.contains("is-bored")).toBe(false);
        });

        it("cuts a yawn short the moment the visitor comes back", async () => {
            const { initAlive } = await loadAlive();
            initAlive();

            vi.advanceTimersByTime(IDLE_DELAY_MS);
            expect(hero().classList.contains("is-bored")).toBe(true);

            window.dispatchEvent(new MouseEvent("pointerdown"));
            expect(hero().classList.contains("is-bored")).toBe(false);
        });

        it("yawns once per quiet spell rather than on a loop", async () => {
            const { initAlive } = await loadAlive();
            initAlive();

            vi.advanceTimersByTime(IDLE_DELAY_MS + IDLE_DOODLE_MS);
            expect(hero().classList.contains("is-bored")).toBe(false);

            // Nothing has happened since, so nothing re-arms the yawn.
            vi.advanceTimersByTime(IDLE_DELAY_MS * 3);
            expect(hero().classList.contains("is-bored")).toBe(false);
        });

        it("holds off while another screen is the one on show", async () => {
            const { initAlive } = await loadAlive();
            initAlive();
            document.getElementById("screen-home").classList.remove("active");

            vi.advanceTimersByTime(IDLE_DELAY_MS);

            expect(hero().classList.contains("is-bored")).toBe(false);
        });

        it("holds off when the hero has left the page", async () => {
            const { initAlive } = await loadAlive();
            initAlive();
            hero().remove();

            expect(() => vi.advanceTimersByTime(IDLE_DELAY_MS)).not.toThrow();
        });

        it("survives activity arriving after the hero has left the page", async () => {
            const { initAlive } = await loadAlive();
            initAlive();
            hero().remove();

            expect(() =>
                window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" })),
            ).not.toThrow();
        });

        it("survives the visitor coming back to a yawn whose hero has left", async () => {
            const { initAlive } = await loadAlive();
            initAlive();

            vi.advanceTimersByTime(IDLE_DELAY_MS);
            hero().remove();

            expect(() => window.dispatchEvent(new MouseEvent("pointerdown"))).not.toThrow();
        });
    });

    describe("theme reaction", () => {
        it("ignores the announcement the theme makes at boot", async () => {
            const { initAlive } = await loadAlive();
            initAlive();

            document.dispatchEvent(new CustomEvent("themechange", { detail: { boot: true } }));

            expect(hero().classList.contains("is-waking")).toBe(false);
        });

        it("flinches at a switch the visitor actually threw, briefly", async () => {
            const { initAlive } = await loadAlive();
            initAlive();

            document.dispatchEvent(new CustomEvent("themechange"));
            expect(hero().classList.contains("is-waking")).toBe(true);

            vi.advanceTimersByTime(WAKE_MS - 1);
            expect(hero().classList.contains("is-waking")).toBe(true);

            vi.advanceTimersByTime(1);
            expect(hero().classList.contains("is-waking")).toBe(false);
        });

        it("replays the flinch when the theme is toggled straight back", async () => {
            const { initAlive } = await loadAlive();
            initAlive();
            document.dispatchEvent(new CustomEvent("themechange"));

            vi.advanceTimersByTime(WAKE_MS / 2);
            document.dispatchEvent(new CustomEvent("themechange"));
            expect(hero().classList.contains("is-waking")).toBe(true);

            // The second flinch gets its own full run rather than the tail of the first.
            vi.advanceTimersByTime(WAKE_MS - 1);
            expect(hero().classList.contains("is-waking")).toBe(true);

            vi.advanceTimersByTime(1);
            expect(hero().classList.contains("is-waking")).toBe(false);
        });

        it("holds off while another screen is the one on show", async () => {
            const { initAlive } = await loadAlive();
            initAlive();
            document.getElementById("screen-home").classList.remove("active");

            document.dispatchEvent(new CustomEvent("themechange"));

            expect(hero().classList.contains("is-waking")).toBe(false);
        });

        it("holds off when the hero has left the page", async () => {
            const { initAlive } = await loadAlive();
            initAlive();
            hero().remove();

            expect(() => document.dispatchEvent(new CustomEvent("themechange"))).not.toThrow();
        });
    });

    describe("guards", () => {
        it("does nothing at all when the visitor asked for reduced motion", async () => {
            mockPreferences({ reduceMotion: true });
            const { initAlive } = await loadAlive();
            initAlive();
            measureHero();

            movePointerTo(600, 600);
            vi.advanceTimersByTime(IDLE_DELAY_MS);
            document.dispatchEvent(new CustomEvent("themechange"));
            document.dispatchEvent(new CustomEvent("themechange"));

            expect(gazeTransform()).toBe("");
            expect(hero().classList.contains("is-bored")).toBe(false);
            expect(hero().classList.contains("is-waking")).toBe(false);
        });

        it("binds its listeners once however often it is initialized", async () => {
            const { initAlive } = await loadAlive();
            const onWindow = vi.spyOn(window, "addEventListener");
            // The theme reaction goes on the document, so a second binding
            // would only show up there.
            const onDocument = vi.spyOn(document, "addEventListener");

            initAlive();
            const afterFirstWindow = onWindow.mock.calls.length;
            const afterFirstDocument = onDocument.mock.calls.length;
            initAlive();

            expect(afterFirstWindow).toBeGreaterThan(0);
            expect(afterFirstDocument).toBeGreaterThan(0);
            expect(onWindow.mock.calls).toHaveLength(afterFirstWindow);
            expect(onDocument.mock.calls).toHaveLength(afterFirstDocument);
            onWindow.mockRestore();
            onDocument.mockRestore();
        });
    });
});
