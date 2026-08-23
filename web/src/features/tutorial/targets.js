/**
 * Step target resolution and visibility checks for the tutorial overlay.
 *
 * A step points at page elements by selector or reference, with optional
 * fallbacks, and a target only counts when it is actually visible. These
 * helpers query the live document but hold no tutorial state, so both the
 * step flow and the mini-tip callouts share them.
 */

/** Space kept between a scrolled-to target and the viewport edge. */
const STEP_SCROLL_MARGIN = 56;

/**
 * Collect primary and fallback step targets.
 * @param {object} step - Step config
 * @returns {(string|Element)[]}
 */
function collectTargetCandidates(step) {
    // Return no candidates when the step config is missing or malformed.
    /* v8 ignore next 3 */
    if (!step || typeof step !== "object") {
        return [];
    }

    const fields = [
        step.target,
        step.selector,
        step.el,
        step.fallbackTarget,
        step.fallbackSelector,
        step.fallbackEl,
    ];

    return fields.flat().filter(Boolean);
}

/**
 * Resolve selector/element references to a DOM element.
 * @param {string|Element|undefined} ref - Target reference
 * @returns {Element|null}
 */
function resolveElementReference(ref) {
    if (!ref) {
        return null;
    }
    if (typeof ref === "string") {
        return document.querySelector(ref);
    }
    if (ref instanceof Element) {
        return ref;
    }
    return null;
}

/**
 * Check if a target is visible enough for spotlighting.
 * @param {Element|null} element - DOM element
 * @returns {element is HTMLElement}
 */
export function isElementVisible(element) {
    if (!(element instanceof HTMLElement)) {
        return false;
    }

    const styles = window.getComputedStyle(element);
    if (
        styles.display === "none" ||
        styles.visibility === "hidden" ||
        styles.visibility === "collapse"
    ) {
        return false;
    }
    if (Number(styles.opacity || "1") <= 0) {
        return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

/**
 * Resolve a step target from selector/element.
 * @param {object} step - Step config
 * @returns {Element|null}
 */
export function resolveStepTarget(step) {
    const candidates = collectTargetCandidates(step);
    if (!candidates.length) {
        return null;
    }

    for (const candidate of candidates) {
        const element = resolveElementReference(candidate);
        if (isElementVisible(element)) {
            return element;
        }
    }

    return null;
}

/**
 * Check whether a step defines any target selector/element.
 * @param {object} step - Step config
 * @returns {boolean}
 */
export function hasStepTarget(step) {
    return collectTargetCandidates(step).length > 0;
}

/**
 * Check whether element stays pinned to viewport.
 * @param {HTMLElement} element - DOM element
 * @returns {boolean}
 */
function isViewportPinned(element) {
    const position = window.getComputedStyle(element).position;
    return position === "fixed" || position === "sticky";
}

/**
 * Keep the step target inside viewport when possible.
 * @param {Element|null} target - Step target
 */
export function ensureTargetInView(target) {
    if (!(target instanceof HTMLElement)) {
        return;
    }
    if (isViewportPinned(target)) {
        return;
    }

    const rect = target.getBoundingClientRect();
    const minTop = STEP_SCROLL_MARGIN;
    const maxBottom = window.innerHeight - STEP_SCROLL_MARGIN;
    const outOfView = rect.top < minTop || rect.bottom > maxBottom;
    if (!outOfView) {
        return;
    }

    target.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: "instant",
    });
}

/**
 * Collect focusable children for focus trapping.
 * @param {HTMLElement} root - Root container
 * @returns {HTMLElement[]}
 */
export function getFocusableElements(root) {
    // Return no controls when the popover root is missing.
    /* v8 ignore next 3 */
    if (!root) {
        return [];
    }

    const selectors = [
        "button:not([disabled])",
        "a[href]",
        'input:not([disabled]):not([type="hidden"])',
        "select:not([disabled])",
        "textarea:not([disabled])",
        '[tabindex]:not([tabindex="-1"])',
    ];

    const nodes = root.querySelectorAll(selectors.join(","));
    return /** @type {HTMLElement[]} */ (Array.from(nodes)).filter((node) =>
        isElementVisible(node),
    );
}
