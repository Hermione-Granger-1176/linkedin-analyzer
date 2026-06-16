/**
 * Pure geometry and math helpers for the guided tutorial overlay.
 *
 * These functions resolve popover placement, clamp coordinates inside the
 * viewport, and compute spotlight/pointer edge points. They are stateless and
 * depend only on their arguments, so the Tutorial engine imports them back and
 * they are unit-tested directly in tutorial-geometry.test.js.
 */

/** Minimum padding kept between overlay elements and the viewport edges. */
export const EDGE_PADDING = 12;

/**
 * Clamp a number between a minimum and maximum.
 * @param {number} value - Input value
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @returns {number}
 */
export function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

/**
 * Build a stable integer hash.
 * @param {string} value - Source value
 * @returns {number}
 */
export function hashString(value) {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
        hash = (hash << 5) - hash + value.charCodeAt(index);
        hash |= 0;
    }
    return Math.abs(hash);
}

/**
 * Resolve a point on the edge of a rect facing another point.
 * @param {{left:number, top:number, width:number, height:number}} rect - Source rectangle
 * @param {number} towardX - Target x
 * @param {number} towardY - Target y
 * @returns {{x:number, y:number}}
 */
export function getRectEdgePoint(rect, towardX, towardY) {
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const deltaX = towardX - centerX;
    const deltaY = towardY - centerY;

    if (!deltaX && !deltaY) {
        return { x: centerX, y: centerY };
    }

    const halfWidth = rect.width / 2 || 1;
    const halfHeight = rect.height / 2 || 1;
    const scaleX = deltaX ? halfWidth / Math.abs(deltaX) : Number.POSITIVE_INFINITY;
    const scaleY = deltaY ? halfHeight / Math.abs(deltaY) : Number.POSITIVE_INFINITY;
    const scale = Math.min(scaleX, scaleY);

    return {
        x: centerX + deltaX * scale,
        y: centerY + deltaY * scale,
    };
}

/**
 * Determine best tooltip placement.
 * @param {string} preferred - Preferred placement value
 * @param {DOMRect|null} targetRect - Target rect
 * @param {DOMRect} popRect - Popover rect
 * @param {number} viewportWidth - Viewport width
 * @param {number} viewportHeight - Viewport height
 * @returns {string}
 */
export function resolvePlacement(preferred, targetRect, popRect, viewportWidth, viewportHeight) {
    if (!targetRect) {
        return "center";
    }

    if (preferred !== "auto") {
        const gap = 24;
        const fits =
            (preferred === "top" && targetRect.top >= popRect.height + gap) ||
            (preferred === "bottom" && viewportHeight - targetRect.bottom >= popRect.height + gap) ||
            (preferred === "left" && targetRect.left >= popRect.width + gap) ||
            (preferred === "right" && viewportWidth - targetRect.right >= popRect.width + gap);
        if (fits) {
            return preferred;
        }
    }

    const roomBottom = viewportHeight - targetRect.bottom;
    const roomTop = targetRect.top;
    const roomRight = viewportWidth - targetRect.right;
    const roomLeft = targetRect.left;

    if (roomBottom >= popRect.height + 24) {
        return "bottom";
    }
    if (roomTop >= popRect.height + 24) {
        return "top";
    }
    if (roomRight >= popRect.width + 24) {
        return "right";
    }
    if (roomLeft >= popRect.width + 24) {
        return "left";
    }
    return roomBottom >= roomTop ? "bottom" : "top";
}

/**
 * Calculate popover coordinates.
 * @param {string} placement - Final placement
 * @param {DOMRect|null} targetRect - Target rect
 * @param {DOMRect} popRect - Popover rect
 * @param {number} viewportWidth - Viewport width
 * @param {number} viewportHeight - Viewport height
 * @returns {{left: number, top: number}}
 */
export function calculatePopoverPosition(
    placement,
    targetRect,
    popRect,
    viewportWidth,
    viewportHeight,
) {
    if (!targetRect || placement === "center") {
        return {
            left: clamp(
                (viewportWidth - popRect.width) / 2,
                EDGE_PADDING,
                viewportWidth - popRect.width - EDGE_PADDING,
            ),
            top: clamp(
                (viewportHeight - popRect.height) / 2,
                EDGE_PADDING,
                viewportHeight - popRect.height - EDGE_PADDING,
            ),
        };
    }

    const centerX = targetRect.left + targetRect.width / 2;
    const centerY = targetRect.top + targetRect.height / 2;
    let left = centerX - popRect.width / 2;
    let top = centerY - popRect.height / 2;

    switch (placement) {
        case "top":
            top = targetRect.top - popRect.height - 16;
            break;
        case "bottom":
            top = targetRect.bottom + 16;
            break;
        case "left":
            left = targetRect.left - popRect.width - 16;
            break;
        case "right":
            left = targetRect.right + 16;
            break;
        default:
            break;
    }

    return {
        left: clamp(left, EDGE_PADDING, viewportWidth - popRect.width - EDGE_PADDING),
        top: clamp(top, EDGE_PADDING, viewportHeight - popRect.height - EDGE_PADDING),
    };
}
