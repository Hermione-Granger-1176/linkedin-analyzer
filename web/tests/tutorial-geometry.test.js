/**
 * Vitest unit tests for the pure tutorial geometry helpers.
 *
 * These functions were extracted from tutorial.js. They are stateless and take
 * plain rect-like objects, so they can be exercised directly without a DOM.
 */

import { describe, expect, it } from "vitest";

import {
    calculatePopoverPosition,
    clamp,
    EDGE_PADDING,
    getRectEdgePoint,
    hashString,
    resolvePlacement,
} from "../src/tutorial-geometry.js";

/**
 * Build a rect-like object with the fields the geometry helpers read.
 * @param {{left:number, top:number, width:number, height:number}} parts - Rect parts
 * @returns {{left:number, top:number, right:number, bottom:number, width:number, height:number}}
 */
function rect({ left, top, width, height }) {
    return { left, top, width, height, right: left + width, bottom: top + height };
}

describe("EDGE_PADDING", () => {
    it("is the expected viewport padding constant", () => {
        expect(EDGE_PADDING).toBe(12);
    });
});

describe("clamp", () => {
    it("returns the value when inside the range", () => {
        expect(clamp(5, 0, 10)).toBe(5);
    });

    it("clamps to the minimum when below the range", () => {
        expect(clamp(-3, 0, 10)).toBe(0);
    });

    it("clamps to the maximum when above the range", () => {
        expect(clamp(99, 0, 10)).toBe(10);
    });

    it("returns the boundary value exactly at the edges", () => {
        expect(clamp(0, 0, 10)).toBe(0);
        expect(clamp(10, 0, 10)).toBe(10);
    });
});

describe("hashString", () => {
    it("returns 0 for an empty string", () => {
        expect(hashString("")).toBe(0);
    });

    it("is deterministic for the same input", () => {
        expect(hashString("home:step-1:0")).toBe(hashString("home:step-1:0"));
    });

    it("returns a non-negative integer", () => {
        const value = hashString("some-arbitrary-key");
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
    });

    it("differs for different inputs", () => {
        expect(hashString("a")).not.toBe(hashString("b"));
    });
});

describe("getRectEdgePoint", () => {
    it("returns the center when the target point equals the center", () => {
        const box = { left: 0, top: 0, width: 100, height: 100 };
        // Center is (50, 50)
        expect(getRectEdgePoint(box, 50, 50)).toEqual({ x: 50, y: 50 });
    });

    it("projects to the right edge when target is directly to the right", () => {
        const box = { left: 0, top: 0, width: 100, height: 100 };
        // Center (50,50); toward (200,50) → horizontal, hits right edge x=100
        expect(getRectEdgePoint(box, 200, 50)).toEqual({ x: 100, y: 50 });
    });

    it("projects to the bottom edge when target is directly below", () => {
        const box = { left: 0, top: 0, width: 100, height: 100 };
        // Center (50,50); toward (50,200) → vertical, hits bottom edge y=100
        expect(getRectEdgePoint(box, 50, 200)).toEqual({ x: 50, y: 100 });
    });

    it("projects to a corner along a diagonal", () => {
        const box = { left: 0, top: 0, width: 100, height: 100 };
        // Center (50,50); toward (150,150) diagonal → corner (100,100)
        expect(getRectEdgePoint(box, 150, 150)).toEqual({ x: 100, y: 100 });
    });

    it("treats a zero-size rect with a safe half extent", () => {
        const box = { left: 10, top: 10, width: 0, height: 0 };
        // halfWidth/halfHeight fall back to 1; center is (10,10)
        const point = getRectEdgePoint(box, 100, 10);
        expect(point.x).toBe(11);
        expect(point.y).toBe(10);
    });
});

describe("resolvePlacement", () => {
    const popRect = { width: 300, height: 200 };
    const viewportWidth = 1024;
    const viewportHeight = 768;

    it("returns center when there is no target", () => {
        expect(resolvePlacement("auto", null, popRect, viewportWidth, viewportHeight)).toBe(
            "center",
        );
    });

    it("honors a preferred placement when it fits", () => {
        // Target near the bottom area with plenty of room above for 'top'
        const target = rect({ left: 400, top: 500, width: 150, height: 40 });
        expect(resolvePlacement("top", target, popRect, viewportWidth, viewportHeight)).toBe("top");
    });

    it("honors preferred bottom when room below is enough", () => {
        const target = rect({ left: 400, top: 50, width: 150, height: 40 });
        expect(resolvePlacement("bottom", target, popRect, viewportWidth, viewportHeight)).toBe(
            "bottom",
        );
    });

    it("honors preferred left when room to the left is enough", () => {
        const target = rect({ left: 600, top: 300, width: 100, height: 40 });
        expect(resolvePlacement("left", target, popRect, viewportWidth, viewportHeight)).toBe(
            "left",
        );
    });

    it("honors preferred right when room to the right is enough", () => {
        const target = rect({ left: 100, top: 300, width: 100, height: 40 });
        expect(resolvePlacement("right", target, popRect, viewportWidth, viewportHeight)).toBe(
            "right",
        );
    });

    it("falls through to auto resolution when the preferred side does not fit", () => {
        // Prefer 'top' but the target sits at the very top: no room above → auto picks bottom
        const target = rect({ left: 400, top: 0, width: 150, height: 40 });
        expect(resolvePlacement("top", target, popRect, viewportWidth, viewportHeight)).toBe(
            "bottom",
        );
    });

    it("auto resolves to bottom when there is room below", () => {
        const target = rect({ left: 400, top: 50, width: 150, height: 40 });
        expect(resolvePlacement("auto", target, popRect, viewportWidth, viewportHeight)).toBe(
            "bottom",
        );
    });

    it("auto resolves to top when room below is insufficient but room above is enough", () => {
        const target = rect({ left: 400, top: 600, width: 150, height: 120 });
        expect(resolvePlacement("auto", target, popRect, viewportWidth, viewportHeight)).toBe(
            "top",
        );
    });

    it("auto resolves to right when only the right has room", () => {
        // Tall target spanning the full height, hugging the left edge
        const target = rect({ left: 10, top: 0, width: 50, height: 768 });
        expect(resolvePlacement("auto", target, popRect, viewportWidth, viewportHeight)).toBe(
            "right",
        );
    });

    it("auto resolves to left when only the left has room", () => {
        // Tall target spanning the full height, hugging the right edge
        const target = rect({ left: 920, top: 0, width: 104, height: 768 });
        expect(resolvePlacement("auto", target, popRect, viewportWidth, viewportHeight)).toBe(
            "left",
        );
    });

    it("falls back to a bottom/top comparison when no quadrant has room", () => {
        // Target fills nearly the whole viewport: roomBottom >= roomTop → bottom
        const target = rect({ left: 5, top: 5, width: 1014, height: 600 });
        const placement = resolvePlacement(
            "auto",
            target,
            popRect,
            viewportWidth,
            viewportHeight,
        );
        // roomBottom = 768-605 = 163, roomTop = 5 → bottom
        expect(placement).toBe("bottom");
    });

    it("falls back to top when room above exceeds room below in the tie-breaker", () => {
        const target = rect({ left: 5, top: 160, width: 1014, height: 600 });
        // roomTop = 160, roomBottom = 768-760 = 8 → top
        expect(resolvePlacement("auto", target, popRect, viewportWidth, viewportHeight)).toBe(
            "top",
        );
    });
});

describe("calculatePopoverPosition", () => {
    const popRect = { width: 300, height: 200 };
    const viewportWidth = 1024;
    const viewportHeight = 768;

    it("centers within the viewport when there is no target", () => {
        const pos = calculatePopoverPosition(
            "center",
            null,
            popRect,
            viewportWidth,
            viewportHeight,
        );
        expect(pos.left).toBe((viewportWidth - popRect.width) / 2);
        expect(pos.top).toBe((viewportHeight - popRect.height) / 2);
    });

    it("centers when placement is explicitly center even with a target", () => {
        const target = rect({ left: 400, top: 300, width: 100, height: 40 });
        const pos = calculatePopoverPosition(
            "center",
            target,
            popRect,
            viewportWidth,
            viewportHeight,
        );
        expect(pos.left).toBe((viewportWidth - popRect.width) / 2);
        expect(pos.top).toBe((viewportHeight - popRect.height) / 2);
    });

    it("places the popover below the target for bottom placement", () => {
        const target = rect({ left: 400, top: 100, width: 100, height: 40 });
        const pos = calculatePopoverPosition(
            "bottom",
            target,
            popRect,
            viewportWidth,
            viewportHeight,
        );
        expect(pos.top).toBe(target.bottom + 16);
    });

    it("places the popover above the target for top placement", () => {
        const target = rect({ left: 400, top: 400, width: 100, height: 40 });
        const pos = calculatePopoverPosition(
            "top",
            target,
            popRect,
            viewportWidth,
            viewportHeight,
        );
        expect(pos.top).toBe(target.top - popRect.height - 16);
    });

    it("places the popover to the left of the target for left placement", () => {
        const target = rect({ left: 700, top: 300, width: 100, height: 40 });
        const pos = calculatePopoverPosition(
            "left",
            target,
            popRect,
            viewportWidth,
            viewportHeight,
        );
        expect(pos.left).toBe(target.left - popRect.width - 16);
    });

    it("places the popover to the right of the target for right placement", () => {
        const target = rect({ left: 100, top: 300, width: 100, height: 40 });
        const pos = calculatePopoverPosition(
            "right",
            target,
            popRect,
            viewportWidth,
            viewportHeight,
        );
        expect(pos.left).toBe(target.right + 16);
    });

    it("clamps the popover within the viewport edges", () => {
        // Target far to the right forces left near the right edge → clamp applies
        const target = rect({ left: 1000, top: 10, width: 20, height: 20 });
        const pos = calculatePopoverPosition(
            "bottom",
            target,
            popRect,
            viewportWidth,
            viewportHeight,
        );
        expect(pos.left).toBeGreaterThanOrEqual(EDGE_PADDING);
        expect(pos.left).toBeLessThanOrEqual(viewportWidth - popRect.width - EDGE_PADDING);
        expect(pos.top).toBeGreaterThanOrEqual(EDGE_PADDING);
        expect(pos.top).toBeLessThanOrEqual(viewportHeight - popRect.height - EDGE_PADDING);
    });

    it("keeps the default left/top center math for an unknown placement", () => {
        const target = rect({ left: 400, top: 300, width: 100, height: 40 });
        const pos = calculatePopoverPosition(
            "unknown",
            target,
            popRect,
            viewportWidth,
            viewportHeight,
        );
        const centerX = target.left + target.width / 2;
        const centerY = target.top + target.height / 2;
        expect(pos.left).toBe(centerX - popRect.width / 2);
        expect(pos.top).toBe(centerY - popRect.height / 2);
    });
});
