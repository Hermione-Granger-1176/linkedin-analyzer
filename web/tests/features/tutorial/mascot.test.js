/**
 * Vitest unit tests for Pip's tutorial poses.
 *
 * The mascot is pure decoration, so the tests cover the two things the tutorial
 * engine relies on: the drawing is inert (aria-hidden, unfocusable, carrying no
 * focusable nodes), and the pose and facing attributes flip on demand.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
    buildTutorialMascot,
    setTutorialMascotFacing,
    setTutorialMascotPose,
} from "../../../src/features/tutorial/mascot.js";

afterEach(() => {
    document.body.innerHTML = "";
});

describe("buildTutorialMascot()", () => {
    it("builds an SVG with both arm poses and sensible defaults", () => {
        const mascot = buildTutorialMascot();

        expect(mascot.tagName.toLowerCase()).toBe("svg");
        expect(mascot.classList.contains("tutorial-mascot")).toBe(true);
        expect(mascot.dataset.pose).toBe("present");
        expect(mascot.dataset.facing).toBe("right");
        expect(mascot.querySelectorAll(".tutorial-mascot-arm").length).toBe(2);
        expect(mascot.querySelector('.tutorial-mascot-arm[data-pose="present"]')).not.toBeNull();
        expect(mascot.querySelector('.tutorial-mascot-arm[data-pose="wave"]')).not.toBeNull();
    });

    it("is decoration: hidden from assistive tech and out of the tab order", () => {
        const mascot = buildTutorialMascot();
        document.body.appendChild(mascot);

        expect(mascot.getAttribute("aria-hidden")).toBe("true");
        expect(mascot.getAttribute("focusable")).toBe("false");
        expect(mascot.querySelectorAll("a, button, input, [tabindex]").length).toBe(0);
    });

    it("draws in the app's ink so the poses follow the theme", () => {
        const mascot = buildTutorialMascot();

        expect(mascot.querySelectorAll(".pip-ink").length).toBeGreaterThan(0);
        expect(mascot.querySelector(".pip-blink")).not.toBeNull();
    });
});

describe("setTutorialMascotPose()", () => {
    it("waves on the last step and presents everywhere else", () => {
        const mascot = buildTutorialMascot();

        setTutorialMascotPose(mascot, true);
        expect(mascot.dataset.pose).toBe("wave");

        setTutorialMascotPose(mascot, false);
        expect(mascot.dataset.pose).toBe("present");
    });

    it("ignores a missing mascot", () => {
        expect(() => setTutorialMascotPose(null, true)).not.toThrow();
    });
});

describe("setTutorialMascotFacing()", () => {
    it("flips toward a target on the left and back again", () => {
        const mascot = buildTutorialMascot();

        setTutorialMascotFacing(mascot, true);
        expect(mascot.dataset.facing).toBe("left");

        setTutorialMascotFacing(mascot, false);
        expect(mascot.dataset.facing).toBe("right");
    });

    it("ignores a missing mascot", () => {
        expect(() => setTutorialMascotFacing(null, true)).not.toThrow();
    });
});
