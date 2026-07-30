/* Guided tutorial and contextual mini-tip callouts */

import { AppRouter } from "../../app/router.js";
import { ScreenManager } from "../../app/screen-manager.js";
import { DomEvents } from "../../shared/dom-events.js";
import { LoadingOverlay } from "../../shared/ui/loading-overlay.js";

import { resolvePointerVariant } from "./arrows.js";
import {
    calculatePopoverPosition,
    clamp,
    EDGE_PADDING,
    getRectEdgePoint,
    resolvePlacement,
} from "./geometry.js";
import {
    getMiniTipCooldownMs,
    getMiniTipDisplayDelayMs,
    getMiniTipVisitInterval,
    normalizeVisitCount,
} from "./pacing.js";
import { buildTutorialShell } from "./shell.js";
import { TutorialMiniTips, TutorialSteps } from "./steps.js";
import {
    getCompletionKey,
    getMiniTipKey,
    getMiniTipLastShownAtKey,
    getMiniTipVisitCountKey,
    getStorageNumberValue,
    getStorageValue,
    removeStorageValue,
    setStorageValue,
} from "./storage.js";
import {
    ensureTargetInView,
    getFocusableElements,
    hasStepTarget,
    isElementVisible,
    resolveStepTarget,
} from "./targets.js";

export const Tutorial = (() => {
    "use strict";

    const AUTO_START_DELAY_MS = 1500;
    const AUTO_START_RETRY_MS = 260;
    const AUTO_START_VISIBLE_PAUSE_MS = 900;
    const INITIAL_TARGET_RETRY_MS = 160;
    const INITIAL_TARGET_RETRY_MAX = 8;
    const MINI_TIP_RETRY_MS = 300;
    const MINI_TIP_RETRY_MAX = 8;
    const POINTER_BASE_ANGLE_DEG = -45;
    const POINTER_ICON_HALF = 46;

    /** @type {{initialized: boolean, active: boolean, routeName: string, steps: object[], renderableIndices: number[], currentIndex: number, retryCount: number, token: number, autoTimer: number, retryTimer: number, highlightedTarget: HTMLElement | null, highlightedStyle: {position: string, zIndex: string} | null, previousFocus: HTMLElement | null, miniTipsRoute: string, miniTipTimer: number, miniTipRetryTimer: number, miniTipRetryCount: number, miniTipEntries: Array<{node: HTMLElement, tip: object, routeName: string, tipId: string, placement: string | undefined, target: Element | null}>}} */
    const state = {
        initialized: false,
        active: false,
        routeName: "",
        steps: [],
        renderableIndices: [],
        currentIndex: -1,
        retryCount: 0,
        token: 0,
        autoTimer: 0,
        retryTimer: 0,
        highlightedTarget: null,
        highlightedStyle: null,
        previousFocus: null,
        miniTipsRoute: "",
        miniTipTimer: 0,
        miniTipRetryTimer: 0,
        miniTipRetryCount: 0,
        miniTipEntries: [],
    };

    /** @type {{root: HTMLDivElement | null, overlay: HTMLDivElement | null, spotlight: HTMLDivElement | null, pointer: SVGSVGElement | null, pointerMainPath: SVGPathElement | null, pointerEchoPath: SVGPathElement | null, pointerHeadPath: SVGPathElement | null, popover: HTMLElement | null, title: HTMLHeadingElement | null, body: HTMLParagraphElement | null, counter: HTMLSpanElement | null, dots: HTMLDivElement | null, backButton: HTMLButtonElement | null, nextButton: HTMLButtonElement | null, skipButton: HTMLButtonElement | null, miniTipsLayer: HTMLDivElement | null}} */
    const ui = {
        root: null,
        overlay: null,
        spotlight: null,
        pointer: null,
        pointerMainPath: null,
        pointerEchoPath: null,
        pointerHeadPath: null,
        popover: null,
        title: null,
        body: null,
        counter: null,
        dots: null,
        backButton: null,
        nextButton: null,
        skipButton: null,
        miniTipsLayer: null,
    };

    /**
     * Allow automated environments to opt out of tutorial overlays.
     * @returns {boolean}
     */
    function tutorialsDisabled() {
        const globalWindow =
            /** @type {Window & { __LINKEDIN_ANALYZER_DISABLE_TUTORIALS__?: boolean }} */ (window);
        return Boolean(globalWindow.__LINKEDIN_ANALYZER_DISABLE_TUTORIALS__);
    }

    /** Initialize tutorial shell and listeners once. */
    function init() {
        if (tutorialsDisabled()) {
            return;
        }
        if (state.initialized) {
            return;
        }

        buildTutorialShell(ui);
        bindEvents();
        state.initialized = true;
    }

    /**
     * Handle route transitions and first-time auto run.
     * @param {string} routeName - Active route name
     */
    function onRouteChange(routeName) {
        if (tutorialsDisabled()) {
            return;
        }
        init();

        const normalized = normalizeRouteName(routeName);
        if (!normalized) {
            return;
        }

        const isSameActiveRoute = state.active && state.routeName === normalized;
        const isSamePendingRoute = !state.active && state.miniTipsRoute === normalized;
        if (isSameActiveRoute || isSamePendingRoute) {
            return;
        }

        cancelPendingAutoStart();
        cancelPendingMiniTipStart();
        clearRetryTimer();
        clearMiniTipRetry();
        state.miniTipRetryCount = 0;

        if (state.active) {
            teardownActiveTutorial(false);
        }

        const token = ++state.token;
        const visitCount = incrementMiniTipVisitCount();

        clearMiniTips();
        state.miniTipsRoute = normalized;
        scheduleMiniTips(normalized, token, visitCount);

        if (isComplete(normalized)) {
            return;
        }

        if (!getRouteSteps(normalized).length) {
            return;
        }

        scheduleAutoStart(normalized, token, AUTO_START_DELAY_MS, false);
    }

    /**
     * Start a route tutorial.
     * @param {string} routeName - Route name
     * @param {{force?: boolean, auto?: boolean}} [options] - Start options
     * @returns {boolean}
     */
    function start(routeName, options) {
        if (tutorialsDisabled()) {
            return false;
        }
        init();

        const normalized = normalizeRouteName(routeName);
        if (!normalized) {
            return false;
        }

        const startOptions = options || {};
        if (isComplete(normalized) && !startOptions.force) {
            return false;
        }

        const steps = getRouteSteps(normalized);
        if (!steps.length) {
            return false;
        }

        cancelPendingAutoStart();
        cancelPendingMiniTipStart();
        clearRetryTimer();
        clearMiniTipRetry();
        state.miniTipRetryCount = 0;

        if (state.active) {
            teardownActiveTutorial(false);
        }

        state.active = true;
        state.routeName = normalized;
        state.steps = steps;
        state.renderableIndices = [];
        state.currentIndex = -1;
        state.retryCount = 0;
        state.token += 1;
        state.previousFocus = /** @type {HTMLElement | null} */ (document.activeElement);

        clearMiniTips();

        // Defensive: the tutorial shell (root + popover) is mounted by init()
        // before any start(), so this guard is unreachable in normal flows.
        /* v8 ignore next 3 */
        if (!ui.root || !ui.popover) {
            return false;
        }
        ui.root.hidden = false;
        ui.root.setAttribute("aria-hidden", "false");
        ui.popover.hidden = false;
        document.body.classList.add("tutorial-open");

        return moveToStep(0, 1, Boolean(startOptions.auto));
    }

    /**
     * Reset completion state for a route.
     * @param {string} routeName - Route name
     */
    function reset(routeName) {
        const normalized = normalizeRouteName(routeName);
        if (!normalized) {
            return;
        }

        removeStorageValue(getCompletionKey(normalized));
        if (state.active && state.routeName === normalized) {
            teardownActiveTutorial(false);
        }
    }

    /**
     * Read completion state for a route.
     * @param {string} routeName - Route name
     * @returns {boolean}
     */
    function isComplete(routeName) {
        const normalized = normalizeRouteName(routeName);
        if (!normalized) {
            return false;
        }
        return getStorageValue(getCompletionKey(normalized)) === "1";
    }

    /** Attach event handlers for controls, keyboard, and layout updates. */
    function bindEvents() {
        // Defensive: bindEvents runs after the popover controls are built, so the
        // missing-control guard never trips in the mounted shell.
        /* v8 ignore next 3 */
        if (!ui.backButton || !ui.nextButton || !ui.skipButton || !ui.popover) {
            return;
        }
        ui.backButton.addEventListener("click", handleBackClick);
        ui.nextButton.addEventListener("click", handleNextClick);
        ui.skipButton.addEventListener("click", handleSkipClick);
        ui.popover.addEventListener("click", handleDotClick);
        document.addEventListener("click", handleRestartClick);

        document.addEventListener("keydown", handleKeyDown, true);
        document.addEventListener("wheel", handleScrollLock, { passive: false, capture: true });
        document.addEventListener("touchmove", handleScrollLock, { passive: false, capture: true });
        window.addEventListener("resize", handleViewportChange);
        window.addEventListener("scroll", handleViewportChange, true);
    }

    /** Move tutorial flow to previous step. */
    function handleBackClick() {
        if (!state.active) {
            return;
        }

        const currentStep = getCurrentStep();
        if (currentStep.allowBack === false) {
            return;
        }

        moveToStep(state.currentIndex - 1, -1, false);
    }

    /** Move tutorial flow to next step or finish. */
    function handleNextClick() {
        if (!state.active) {
            return;
        }

        const currentStep = getCurrentStep();
        if (currentStep.allowNext === false) {
            completeCurrentRoute();
            return;
        }

        const nextIndex = findRenderableStepIndex(state.currentIndex + 1, 1);
        if (nextIndex === -1) {
            completeCurrentRoute();
            return;
        }

        moveToStep(nextIndex, 1, false);
    }

    /** End tutorial and persist completion. */
    function handleSkipClick() {
        if (!state.active) {
            return;
        }

        const currentStep = getCurrentStep();
        if (currentStep.allowSkip === false) {
            return;
        }

        completeCurrentRoute();
    }

    /**
     * Handle step-dot navigation clicks.
     * @param {Event} event
     */
    function handleDotClick(event) {
        if (!state.active) {
            return;
        }

        const dot = DomEvents.closest(event, ".tutorial-dot[data-step-index]");
        if (!dot) {
            return;
        }

        const index = Number(dot.getAttribute("data-step-index"));
        if (!Number.isFinite(index)) {
            return;
        }

        const direction = index >= state.currentIndex ? 1 : -1;
        moveToStep(index, direction, false);
    }

    /**
     * Handle tutorial restart button clicks.
     * @param {Event} event
     */
    function handleRestartClick(event) {
        const trigger = /** @type {HTMLElement|null} */ (
            DomEvents.closest(
                event,
                '[data-tutorial-action="restart"], .tutorial-restart-btn[data-tutorial-route]',
            )
        );
        if (!trigger) {
            return;
        }

        const routeName = resolveRestartRoute(trigger);
        if (!routeName) {
            return;
        }

        event.preventDefault();
        reset(routeName);
        start(routeName, { force: true, auto: false });
    }

    /**
     * Resolve which route tutorial to restart.
     * @param {HTMLElement} trigger - Restart trigger element
     * @returns {string}
     */
    function resolveRestartRoute(trigger) {
        const explicitRoute = normalizeRouteName(trigger.getAttribute("data-tutorial-route"));
        if (explicitRoute) {
            return explicitRoute;
        }

        const activeRoute = normalizeRouteName(ScreenManager.getCurrentRouteName());
        if (activeRoute) {
            return activeRoute;
        }

        const currentRoute = AppRouter.getCurrentRoute();
        const routeName = normalizeRouteName(currentRoute && currentRoute.name);
        if (routeName) {
            return routeName;
        }

        return normalizeRouteName(state.routeName || state.miniTipsRoute || "");
    }

    /**
     * Keyboard shortcuts and focus trap while dialog is open.
     * @param {KeyboardEvent} event
     */
    function handleKeyDown(event) {
        if (!state.active) {
            return;
        }

        switch (event.key) {
            case "Escape":
                event.preventDefault();
                completeCurrentRoute();
                return;
            case "ArrowRight":
                event.preventDefault();
                handleNextClick();
                return;
            case "Enter":
                if (shouldUseNativeEnter(event.target)) {
                    return;
                }
                event.preventDefault();
                handleNextClick();
                return;
            case "ArrowLeft":
                event.preventDefault();
                handleBackClick();
                return;
            case "Tab":
                trapFocus(event);
                return;
            default:
                return;
        }
    }

    /**
     * Block page scroll while tutorial is active.
     * Allows scroll inside the popover so overflowing step content remains reachable.
     * @param {WheelEvent|TouchEvent} event
     */
    function handleScrollLock(event) {
        if (!state.active) {
            return;
        }
        if (ui.popover && ui.popover.contains(/** @type {Node | null} */ (event.target))) {
            return;
        }
        event.preventDefault();
    }

    /** Keep spotlight/pointer aligned on viewport updates. */
    function handleViewportChange() {
        const token = state.token;
        const miniTipsRoute = state.miniTipsRoute;

        window.requestAnimationFrame(() => {
            if (state.active && token === state.token) {
                updateCurrentStepGeometry();
            }
            if (!state.active && miniTipsRoute && miniTipsRoute === state.miniTipsRoute) {
                positionMiniTips();
            }
        });
    }

    /**
     * Read current step config safely.
     * @returns {object}
     */
    function getCurrentStep() {
        return state.steps[state.currentIndex] || {};
    }

    /**
     * Keep native Enter behavior for focused interactive controls.
     * @param {EventTarget|null} target - Event target
     * @returns {boolean}
     */
    function shouldUseNativeEnter(target) {
        const element = target instanceof Element ? target : null;
        if (!element) {
            return false;
        }

        if (element === ui.popover) {
            return false;
        }

        return Boolean(
            element.closest('button, a[href], input, select, textarea, [role="button"]'),
        );
    }

    /** Update spotlight and popover position without rerendering text/progress. */
    function updateCurrentStepGeometry() {
        // Defensive: viewport handlers only reposition while a tutorial is active.
        /* v8 ignore next 3 */
        if (!state.active) {
            return;
        }

        const step = getCurrentStep();
        const target = resolveStepTarget(step);
        setHighlightedTarget(target);
        updateGeometry(target, step);
    }

    /**
     * Move to the next renderable step.
     * @param {number} requestedIndex - Requested base index
     * @param {number} direction - Search direction
     * @param {boolean} allowInitialRetry - Retry while route elements settle
     * @returns {boolean}
     */
    function moveToStep(requestedIndex, direction, allowInitialRetry) {
        // Defensive: navigation helpers are only invoked within an active flow.
        /* v8 ignore next 3 */
        if (!state.active) {
            return false;
        }

        const index = findRenderableStepIndex(requestedIndex, direction);
        if (index === -1) {
            if (allowInitialRetry && state.currentIndex === -1) {
                return scheduleInitialRetry();
            }
            completeCurrentRoute();
            return false;
        }

        state.currentIndex = index;
        state.retryCount = 0;
        clearRetryTimer();
        renderCurrentStep(true);
        return true;
    }

    /**
     * Retry first step lookup for delayed UI renders.
     * @returns {boolean}
     */
    function scheduleInitialRetry() {
        // Defensive: retries are only scheduled during an active render attempt.
        /* v8 ignore next 3 */
        if (!state.active) {
            return false;
        }
        if (state.retryCount >= INITIAL_TARGET_RETRY_MAX) {
            completeCurrentRoute();
            return false;
        }

        const currentToken = state.token;
        state.retryCount += 1;
        clearRetryTimer();
        state.retryTimer = window.setTimeout(() => {
            if (!state.active || currentToken !== state.token) {
                return;
            }
            moveToStep(0, 1, true);
        }, INITIAL_TARGET_RETRY_MS);
        return true;
    }

    /**
     * Find nearest renderable step index from a base index.
     * @param {number} fromIndex - Starting index
     * @param {number} direction - Search direction
     * @returns {number}
     */
    function findRenderableStepIndex(fromIndex, direction) {
        // Defensive: a started route always has at least one step.
        /* v8 ignore next 3 */
        if (!state.steps.length) {
            return -1;
        }

        if (fromIndex < 0 || fromIndex >= state.steps.length) {
            return -1;
        }

        const stepDirection = direction >= 0 ? 1 : -1;

        for (
            let index = fromIndex;
            index >= 0 && index < state.steps.length;
            index += stepDirection
        ) {
            const step = state.steps[index];
            const target = resolveStepTarget(step);
            if (!hasStepTarget(step) || target) {
                return index;
            }
        }

        return -1;
    }

    /**
     * Paint current step text, controls, and geometry.
     * @param {boolean} focusPopover - Focus the dialog after render
     */
    function renderCurrentStep(focusPopover) {
        // Defensive: renderCurrentStep runs on an active tutorial with the full
        // popover shell mounted, so neither guard trips in the unit environment.
        /* v8 ignore start */
        if (!state.active) {
            return;
        }
        if (
            !ui.title ||
            !ui.body ||
            !ui.backButton ||
            !ui.skipButton ||
            !ui.nextButton ||
            !ui.popover
        ) {
            return;
        }
        /* v8 ignore stop */

        const step = getCurrentStep();
        const title = step.title || step.heading || "Quick tour";
        const body = step.body || step.text || step.content || step.description || "";

        ui.title.textContent = String(title);
        ui.body.textContent = String(body);

        state.renderableIndices = computeRenderableIndices();
        renderProgress();

        const target = resolveStepTarget(step);
        ensureTargetInView(target);
        setHighlightedTarget(target);
        updateGeometry(target, step);

        const previousIndex = findRenderableStepIndex(state.currentIndex - 1, -1);
        const nextIndex = findRenderableStepIndex(state.currentIndex + 1, 1);
        const isFirstStep = previousIndex === -1;
        const isLastStep = nextIndex === -1;
        const allowBack = step.allowBack !== false;
        const allowSkip = step.allowSkip !== false;
        const allowNext = step.allowNext !== false;
        const showBack = allowBack && !isFirstStep;
        const showSkip = allowSkip && !isLastStep;

        ui.backButton.hidden = !showBack;
        ui.backButton.disabled = !showBack;
        ui.skipButton.hidden = !showSkip;
        ui.nextButton.hidden = !allowNext;
        ui.nextButton.textContent = isLastStep ? "Finish" : "Next";

        if (focusPopover) {
            ui.popover.focus();
        }
    }

    /** Render step counter and dot navigation. */
    function renderProgress() {
        // Defensive: the counter and dots are part of the mounted popover shell.
        /* v8 ignore next 3 */
        if (!ui.counter || !ui.dots) {
            return;
        }
        const visibleIndices = state.renderableIndices.length
            ? state.renderableIndices
            : computeRenderableIndices();
        const visiblePosition = visibleIndices.indexOf(state.currentIndex);
        const currentNumber = visiblePosition === -1 ? 1 : visiblePosition + 1;
        const total = visibleIndices.length || 1;

        ui.counter.textContent = `Step ${currentNumber} of ${total}`;

        const dots = ui.dots;
        dots.innerHTML = "";
        visibleIndices.forEach((index, dotIndex) => {
            const dot = document.createElement("button");
            dot.type = "button";
            dot.className = "tutorial-dot";
            dot.setAttribute("data-step-index", String(index));
            dot.setAttribute("aria-label", `Go to step ${dotIndex + 1}`);
            if (index === state.currentIndex) {
                dot.classList.add("is-active");
            }
            dots.appendChild(dot);
        });
    }

    /**
     * Get all currently renderable step indices.
     * @returns {number[]}
     */
    function computeRenderableIndices() {
        const indices = [];
        state.steps.forEach((step, index) => {
            if (!hasStepTarget(step) || resolveStepTarget(step)) {
                indices.push(index);
            }
        });
        return indices;
    }

    /**
     * Position spotlight, popover, and pointer.
     * @param {Element|null} target - Highlight target
     * @param {object} step - Step config
     */
    function updateGeometry(target, step) {
        // Defensive: spotlight and popover are part of the mounted shell.
        /* v8 ignore next 3 */
        if (!ui.spotlight || !ui.popover) {
            return;
        }
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const placement = String((step && step.placement) || "auto").toLowerCase();

        let targetRect = null;
        if (target) {
            targetRect = target.getBoundingClientRect();
            const spotlightPadding = 8;
            const x = Math.max(EDGE_PADDING, targetRect.left - spotlightPadding);
            const y = Math.max(EDGE_PADDING, targetRect.top - spotlightPadding);
            const width = Math.max(
                44,
                Math.min(viewportWidth - EDGE_PADDING * 2, targetRect.width + spotlightPadding * 2),
            );
            const height = Math.max(
                34,
                Math.min(
                    viewportHeight - EDGE_PADDING * 2,
                    targetRect.height + spotlightPadding * 2,
                ),
            );

            ui.spotlight.style.display = "block";
            ui.spotlight.style.left = `${x}px`;
            ui.spotlight.style.top = `${y}px`;
            ui.spotlight.style.width = `${width}px`;
            ui.spotlight.style.height = `${height}px`;
        } else {
            ui.spotlight.style.display = "none";
        }

        ui.popover.style.maxWidth = `${Math.min(420, viewportWidth - EDGE_PADDING * 2)}px`;
        ui.popover.style.left = "0px";
        ui.popover.style.top = "0px";

        const popRect = ui.popover.getBoundingClientRect();
        const resolvedPlacement = resolvePlacement(
            placement,
            targetRect,
            popRect,
            viewportWidth,
            viewportHeight,
        );
        const popPosition = calculatePopoverPosition(
            resolvedPlacement,
            targetRect,
            popRect,
            viewportWidth,
            viewportHeight,
        );

        ui.popover.style.left = `${popPosition.left}px`;
        ui.popover.style.top = `${popPosition.top}px`;

        updatePointer(targetRect, popPosition, popRect, resolvedPlacement, step);
    }

    /**
     * Position and rotate the pointer toward highlighted content.
     * @param {DOMRect|null} targetRect - Target rect
     * @param {{left: number, top: number}} popPosition - Popover position
     * @param {DOMRect} popRect - Popover dimensions
     * @param {string} placement - Final placement
     * @param {object} step - Step config
     */
    function updatePointer(targetRect, popPosition, popRect, placement, step) {
        // Defensive: the pointer SVG and its paths are part of the mounted shell.
        /* v8 ignore next 3 */
        if (!ui.pointer || !ui.pointerMainPath || !ui.pointerEchoPath || !ui.pointerHeadPath) {
            return;
        }
        if (!targetRect || placement === "center") {
            ui.pointer.style.display = "none";
            return;
        }

        const popCenterX = popPosition.left + popRect.width / 2;
        const popCenterY = popPosition.top + popRect.height / 2;
        const targetCenterX = targetRect.left + targetRect.width / 2;
        const targetCenterY = targetRect.top + targetRect.height / 2;
        const angle = Math.atan2(targetCenterY - popCenterY, targetCenterX - popCenterX);

        const popRectBox = {
            left: popPosition.left,
            top: popPosition.top,
            width: popRect.width,
            height: popRect.height,
        };

        const popEdge = getRectEdgePoint(popRectBox, targetCenterX, targetCenterY);
        const pointerX = popEdge.x + Math.cos(angle) * 22;
        const pointerY = popEdge.y + Math.sin(angle) * 22;
        const maxX = window.innerWidth - POINTER_ICON_HALF;
        const maxY = window.innerHeight - POINTER_ICON_HALF;
        const clampedX = clamp(pointerX, POINTER_ICON_HALF, maxX);
        const clampedY = clamp(pointerY, POINTER_ICON_HALF, maxY);
        const variant = resolvePointerVariant(step, state.routeName, state.currentIndex);
        const rotationDeg = (angle * 180) / Math.PI - POINTER_BASE_ANGLE_DEG;

        ui.pointer.dataset.arrowStyle = variant.style;
        ui.pointer.dataset.arrowName = variant.name;
        ui.pointerMainPath.setAttribute("d", variant.body);
        ui.pointerEchoPath.setAttribute("d", variant.echo);
        ui.pointerHeadPath.setAttribute("d", variant.head);

        ui.pointer.style.display = "block";
        ui.pointer.style.left = `${clampedX}px`;
        ui.pointer.style.top = `${clampedY}px`;
        ui.pointer.style.transform = `translate(-50%, -50%) rotate(${rotationDeg}deg)`;
    }

    /**
     * Apply and clear highlighted element class.
     * @param {Element|null} target - Step target
     */
    function setHighlightedTarget(target) {
        if (state.highlightedTarget === target) {
            return;
        }

        clearHighlightedTarget();
        if (!(target instanceof HTMLElement)) {
            return;
        }

        state.highlightedTarget = target;
        state.highlightedStyle = {
            position: target.style.position,
            zIndex: target.style.zIndex,
        };

        if (window.getComputedStyle(target).position === "static") {
            target.style.position = "relative";
        }
        target.style.zIndex = "1201";
        target.classList.add("tutorial-highlighted");
    }

    /** Restore previously highlighted target styles. */
    function clearHighlightedTarget() {
        if (!(state.highlightedTarget instanceof HTMLElement)) {
            state.highlightedTarget = null;
            state.highlightedStyle = null;
            return;
        }

        state.highlightedTarget.classList.remove("tutorial-highlighted");
        const previous = state.highlightedStyle || { position: "", zIndex: "" };
        state.highlightedTarget.style.position = previous.position || "";
        state.highlightedTarget.style.zIndex = previous.zIndex || "";
        state.highlightedTarget = null;
        state.highlightedStyle = null;
    }

    /** Persist completion and close active tutorial. */
    function completeCurrentRoute() {
        // Defensive: completion is only reachable from an active tutorial.
        /* v8 ignore next 3 */
        if (!state.active) {
            return;
        }
        setStorageValue(getCompletionKey(state.routeName), "1");
        teardownActiveTutorial(true);
    }

    /**
     * Tear down active tutorial layers.
     * @param {boolean} keepCompletion - Whether completion was updated
     */
    function teardownActiveTutorial(keepCompletion) {
        const routeName = state.routeName;
        const token = state.token;
        const visitCount = getMiniTipVisitCount();

        cancelPendingMiniTipStart();
        clearRetryTimer();
        clearMiniTipRetry();
        state.miniTipRetryCount = 0;

        setHighlightedTarget(null);
        if (ui.root && ui.popover && ui.pointer && ui.spotlight) {
            ui.root.hidden = true;
            ui.root.setAttribute("aria-hidden", "true");
            ui.popover.hidden = true;
            ui.pointer.style.display = "none";
            ui.spotlight.style.display = "none";
        }
        document.body.classList.remove("tutorial-open");

        state.active = false;

        if (keepCompletion && routeName) {
            state.miniTipsRoute = routeName;
            scheduleMiniTips(routeName, token, visitCount);
        }

        if (state.previousFocus && typeof state.previousFocus.focus === "function") {
            state.previousFocus.focus();
        }

        state.routeName = "";
        state.steps = [];
        state.renderableIndices = [];
        state.currentIndex = -1;
        state.retryCount = 0;
        state.previousFocus = null;

        if (!keepCompletion) {
            state.token += 1;
        }
    }

    /**
     * Render contextual mini-tip callouts for a route.
     * @param {string} routeName
     */
    function renderMiniTips(routeName) {
        if (state.active || isLoadingActive() || !ui.miniTipsLayer) {
            return;
        }

        clearMiniTipRetry();
        clearMiniTips();
        state.miniTipsRoute = routeName;

        const tips = getRouteMiniTips(routeName);
        if (!tips.length) {
            return;
        }

        const miniTipsLayer = ui.miniTipsLayer;
        tips.forEach((tip, index) => {
            const tipId = String(tip.id || tip.key || `${routeName}-${index + 1}`);
            if (isMiniTipDismissed(routeName, tipId)) {
                return;
            }

            const target = resolveMiniTipTarget(tip);
            if (!target) {
                return;
            }

            const node = buildMiniTipNode(routeName, tipId, tip);
            miniTipsLayer.appendChild(node);
            state.miniTipEntries.push({
                node,
                tip,
                routeName,
                tipId,
                placement: tip.placement,
                target,
            });
        });

        if (!state.miniTipEntries.length) {
            scheduleMiniTipRetry(routeName);
            return;
        }

        positionMiniTips();
        const hasVisibleTip = state.miniTipEntries.some(
            (entry) => entry.node && !entry.node.hidden,
        );
        if (hasVisibleTip) {
            markMiniTipShown();
        }
    }

    /**
     * Build a mini-tip element.
     * @param {string} routeName - Route name
     * @param {string} tipId - Tip id
     * @param {object} tip - Tip config
     * @returns {HTMLElement}
     */
    function buildMiniTipNode(routeName, tipId, tip) {
        const node = document.createElement("aside");
        node.className = "tutorial-mini-tip";
        node.setAttribute("role", "note");

        const dismiss = document.createElement("button");
        dismiss.type = "button";
        dismiss.className = "tutorial-mini-dismiss";
        dismiss.setAttribute("aria-label", "Dismiss tip");
        dismiss.textContent = "x";
        dismiss.addEventListener("click", () => {
            setStorageValue(getMiniTipKey(routeName, tipId), "1");
            state.miniTipEntries = state.miniTipEntries.filter(
                (entry) => !(entry.routeName === routeName && entry.tipId === tipId),
            );
            node.remove();
        });

        if (tip.title) {
            const title = document.createElement("strong");
            title.className = "tutorial-mini-title";
            title.textContent = String(tip.title);
            node.appendChild(title);
        }

        const text = document.createElement("p");
        text.className = "tutorial-mini-text";
        text.textContent = String(tip.body || tip.text || tip.content || tip.message || "");

        node.appendChild(dismiss);
        node.appendChild(text);
        return node;
    }

    /**
     * Resolve mini-tip target.
     * @param {object} tip - Tip config
     * @returns {Element|null}
     */
    function resolveMiniTipTarget(tip) {
        return resolveStepTarget(tip);
    }

    /**
     * Position mini-tip near its target.
     * @param {HTMLElement} node - Tip node
     * @param {Element} target - Target node
     * @param {string|undefined} placementValue - Preferred placement
     */
    function positionMiniTip(node, target, placementValue) {
        const placement = String(placementValue || "bottom").toLowerCase();
        const targetRect = target.getBoundingClientRect();
        node.style.left = "0px";
        node.style.top = "0px";

        const tipRect = node.getBoundingClientRect();
        let left = targetRect.left + targetRect.width / 2 - tipRect.width / 2;
        let top = targetRect.bottom + 10;

        switch (placement) {
            case "top":
                top = targetRect.top - tipRect.height - 10;
                break;
            case "left":
                left = targetRect.left - tipRect.width - 10;
                top = targetRect.top + targetRect.height / 2 - tipRect.height / 2;
                break;
            case "right":
                left = targetRect.right + 10;
                top = targetRect.top + targetRect.height / 2 - tipRect.height / 2;
                break;
            default:
                break;
        }

        const maxLeft = window.innerWidth - tipRect.width - EDGE_PADDING;
        const maxTop = window.innerHeight - tipRect.height - EDGE_PADDING;
        node.style.left = `${clamp(left, EDGE_PADDING, maxLeft)}px`;
        node.style.top = `${clamp(top, EDGE_PADDING, maxTop)}px`;
    }

    /** Position rendered mini-tip callouts against viewport geometry. */
    function positionMiniTips() {
        if (!state.miniTipEntries.length) {
            return;
        }

        state.miniTipEntries = state.miniTipEntries.filter(
            (entry) => entry.node && entry.node.isConnected,
        );
        state.miniTipEntries.forEach((entry) => {
            let target = entry.target && entry.target.isConnected ? entry.target : null;
            if (!target) {
                target = resolveMiniTipTarget(entry.tip);
            }

            if (!isElementVisible(target)) {
                entry.node.hidden = true;
                entry.target = null;
                return;
            }

            entry.target = target;
            entry.node.hidden = false;
            positionMiniTip(entry.node, target, entry.placement);
        });
    }

    /** Clear rendered mini-tip nodes and tracked entries. */
    function clearMiniTips() {
        state.miniTipEntries = [];
        // Defensive: the mini-tips layer is part of the mounted shell.
        /* v8 ignore next 3 */
        if (!ui.miniTipsLayer) {
            return;
        }
        ui.miniTipsLayer.innerHTML = "";
    }

    /**
     * Retry mini-tip target resolution while route content settles.
     * @param {string} routeName - Route name
     */
    function scheduleMiniTipRetry(routeName) {
        if (state.miniTipRetryCount >= MINI_TIP_RETRY_MAX) {
            return;
        }

        state.miniTipRetryCount += 1;
        state.miniTipRetryTimer = window.setTimeout(() => {
            state.miniTipRetryTimer = 0;

            if (state.active) {
                return;
            }
            if (routeName !== state.miniTipsRoute) {
                return;
            }
            if (isLoadingActive()) {
                scheduleMiniTipRetry(routeName);
                return;
            }
            renderMiniTips(routeName);
        }, MINI_TIP_RETRY_MS);
    }

    /**
     * Keep keyboard focus inside the tutorial dialog.
     * @param {KeyboardEvent} event - Key event
     */
    function trapFocus(event) {
        // Defensive: focus trapping only runs while the popover is mounted.
        /* v8 ignore next 3 */
        if (!ui.popover) {
            return;
        }
        const focusable = getFocusableElements(ui.popover);
        // Defensive: the popover always renders Back/Next/Skip buttons, so it is
        // never devoid of focusable controls while a step is shown.
        /* v8 ignore next 5 */
        if (!focusable.length) {
            event.preventDefault();
            ui.popover.focus();
            return;
        }

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        const insidePopover = ui.popover.contains(active);

        if (!insidePopover) {
            event.preventDefault();
            if (event.shiftKey) {
                last.focus();
            } else {
                first.focus();
            }
            return;
        }

        if (event.shiftKey && active === first) {
            event.preventDefault();
            last.focus();
            return;
        }

        if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
        }
    }

    /**
     * Read route tutorial steps from the imported TutorialSteps config.
     * @param {string} routeName - Route name
     * @returns {object[]}
     */
    function getRouteSteps(routeName) {
        return getRouteConfigItems(TutorialSteps, routeName);
    }

    /**
     * Read route mini-tip callouts from the imported TutorialMiniTips config.
     * @param {string} routeName - Route name
     * @returns {object[]}
     */
    function getRouteMiniTips(routeName) {
        return getRouteConfigItems(TutorialMiniTips, routeName);
    }

    /**
     * Read route-scoped items from a tutorial config object.
     * @param {object[]|{[key: string]: object[]}|undefined} config - Route config source
     * @param {string} routeName - Route name
     * @returns {object[]}
     */
    function getRouteConfigItems(config, routeName) {
        /* v8 ignore next 3 */
        if (!config) {
            return [];
        }

        if (Array.isArray(config)) {
            return config.filter((item) => normalizeRouteName(item.route) === routeName);
        }

        if (typeof config === "object") {
            const list = config[routeName];
            return Array.isArray(list) ? list.slice() : [];
        }

        /* v8 ignore next */
        return [];
    }

    /**
     * Cancel scheduled auto tutorial start.
     */
    function cancelPendingAutoStart() {
        if (!state.autoTimer) {
            return;
        }
        window.clearTimeout(state.autoTimer);
        state.autoTimer = 0;
    }

    /** Cancel pending mini-tip show timer. */
    function cancelPendingMiniTipStart() {
        if (!state.miniTipTimer) {
            return;
        }
        window.clearTimeout(state.miniTipTimer);
        state.miniTipTimer = 0;
    }

    /**
     * Schedule mini-tip callouts for a route after engagement-aware pacing.
     * @param {string} routeName - Route name
     * @param {number} token - Route token
     * @param {number} visitCount - Engagement visit count
     */
    function scheduleMiniTips(routeName, token, visitCount) {
        cancelPendingMiniTipStart();

        const normalized = normalizeRouteName(routeName);
        if (!normalized || state.active) {
            return;
        }
        if (!isComplete(normalized)) {
            return;
        }
        if (!getRouteMiniTips(normalized).length) {
            return;
        }
        if (!shouldScheduleMiniTips(visitCount)) {
            return;
        }

        const delayMs = getMiniTipDisplayDelayMs(visitCount);
        scheduleMiniTipStart(normalized, token, delayMs);
    }

    /**
     * Check whether a delayed callback token is stale.
     * @param {number} token - Route token snapshot
     * @returns {boolean}
     */
    function isTokenStale(token) {
        return token !== state.token;
    }

    /**
     * Check whether mini-tip callouts can start for the route/token.
     * @param {string} routeName - Route name
     * @param {number} token - Route token snapshot
     * @returns {boolean}
     */
    function canStartMiniTips(routeName, token) {
        /* v8 ignore next 3 */
        if (isTokenStale(token) || state.active) {
            return false;
        }
        return routeName === state.miniTipsRoute;
    }

    /**
     * Queue a mini-tip render attempt.
     * @param {string} routeName - Route name
     * @param {number} token - Route token
     * @param {number} delayMs - Delay before attempt
     */
    function scheduleMiniTipStart(routeName, token, delayMs) {
        state.miniTipTimer = window.setTimeout(() => {
            state.miniTipTimer = 0;

            /* v8 ignore next 3 */
            if (!canStartMiniTips(routeName, token)) {
                return;
            }
            /* v8 ignore next 4 */
            if (isLoadingActive()) {
                scheduleMiniTipStart(routeName, token, MINI_TIP_RETRY_MS);
                return;
            }

            renderMiniTips(routeName);
        }, delayMs);
    }

    /**
     * Decide whether mini-tip callouts should be shown for this visit.
     * @param {number} visitCount - Engagement visit count
     * @returns {boolean}
     */
    function shouldScheduleMiniTips(visitCount) {
        const normalizedVisitCount = normalizeVisitCount(visitCount);
        const interval = getMiniTipVisitInterval(normalizedVisitCount);
        if (normalizedVisitCount % interval !== 0) {
            return false;
        }

        const lastShownAt = getMiniTipLastShownAt();
        if (!lastShownAt) {
            return true;
        }

        const cooldownMs = getMiniTipCooldownMs(normalizedVisitCount);
        return Date.now() - lastShownAt >= cooldownMs;
    }

    /**
     * Increment and persist engagement visit count for mini-tip pacing.
     * @returns {number}
     */
    function incrementMiniTipVisitCount() {
        const key = getMiniTipVisitCountKey();
        const current = getStorageNumberValue(key, 0);
        const next = Math.max(0, Math.floor(current)) + 1;
        setStorageValue(key, String(next));
        return next;
    }

    /**
     * Read persisted mini-tip engagement visit count.
     * @returns {number}
     */
    function getMiniTipVisitCount() {
        return getStorageNumberValue(getMiniTipVisitCountKey(), 0);
    }

    /** Persist mini-tip display timestamp for cooldown pacing. */
    function markMiniTipShown() {
        setStorageValue(getMiniTipLastShownAtKey(), String(Date.now()));
    }

    /**
     * Read mini-tip display timestamp.
     * @returns {number}
     */
    function getMiniTipLastShownAt() {
        return getStorageNumberValue(getMiniTipLastShownAtKey(), 0);
    }

    /**
     * Retry auto tutorial start until loading overlay finishes.
     * @param {string} routeName - Route name
     * @param {number} token - Route token
     * @param {number} delayMs - Delay before attempt
     * @param {boolean} needsVisiblePause - Whether to wait once loading settles
     */
    function scheduleAutoStart(routeName, token, delayMs, needsVisiblePause) {
        state.autoTimer = window.setTimeout(() => {
            /* v8 ignore next 3 */
            if (isTokenStale(token)) {
                return;
            }

            if (isLoadingActive()) {
                scheduleAutoStart(routeName, token, AUTO_START_RETRY_MS, true);
                return;
            }

            if (needsVisiblePause) {
                scheduleAutoStart(routeName, token, AUTO_START_VISIBLE_PAUSE_MS, false);
                return;
            }

            start(routeName, { auto: true });
        }, delayMs);
    }

    /**
     * Read loading overlay activity state when available.
     * @returns {boolean}
     */
    function isLoadingActive() {
        if (LoadingOverlay.isActive()) {
            return true;
        }

        const contentOverlay = document.getElementById("contentLoadingOverlay");
        if (contentOverlay && !contentOverlay.hidden) {
            return true;
        }

        const uploadOverlay = document.getElementById("progressOverlay");
        if (uploadOverlay && !uploadOverlay.hidden) {
            return true;
        }

        return false;
    }

    /** Clear initial retry timer. */
    function clearRetryTimer() {
        if (!state.retryTimer) {
            return;
        }
        window.clearTimeout(state.retryTimer);
        state.retryTimer = 0;
    }

    /** Clear pending mini-tip retry timer. */
    function clearMiniTipRetry() {
        if (!state.miniTipRetryTimer) {
            return;
        }
        window.clearTimeout(state.miniTipRetryTimer);
        state.miniTipRetryTimer = 0;
    }

    /**
     * Check whether a mini tip has been dismissed.
     * @param {string} routeName - Route name
     * @param {string} tipId - Tip id
     * @returns {boolean}
     */
    function isMiniTipDismissed(routeName, tipId) {
        return getStorageValue(getMiniTipKey(routeName, tipId)) === "1";
    }

    /**
     * Normalize route names.
     * @param {string | null | undefined} value - Raw route
     * @returns {string}
     */
    function normalizeRouteName(value) {
        return String(value || "")
            .trim()
            .toLowerCase();
    }

    return {
        init,
        onRouteChange,
        start,
        reset,
        isComplete,
    };
})();
