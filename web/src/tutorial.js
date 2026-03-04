/* Guided tutorial and contextual mini-tip callouts */

import { AppRouter } from './router.js';
import { DomEvents } from './dom-events.js';
import { LoadingOverlay } from './loading-overlay.js';
import { ScreenManager } from './screen-manager.js';
import { TutorialMiniTips, TutorialSteps } from './tutorial-steps.js';

export const Tutorial = (() => {
    'use strict';

    const TUTORIAL_STORAGE_VERSION = 'v1';
    const STORAGE_PREFIX = `linkedin-analyzer:tutorial:${TUTORIAL_STORAGE_VERSION}`;
    const AUTO_START_DELAY_MS = 1500;
    const AUTO_START_RETRY_MS = 260;
    const AUTO_START_VISIBLE_PAUSE_MS = 900;
    const INITIAL_TARGET_RETRY_MS = 160;
    const INITIAL_TARGET_RETRY_MAX = 8;
    const MINI_TIP_RETRY_MS = 300;
    const MINI_TIP_RETRY_MAX = 8;
    const MINI_TIP_INITIAL_DELAY_MS = 2200;
    const MINI_TIP_DELAY_GROWTH_MS = 90;
    const MINI_TIP_DELAY_MAX_EXTRA_MS = 2200;
    const MINI_TIP_BASE_COOLDOWN_MS = 30000;
    const MINI_TIP_COOLDOWN_GROWTH_MS = 2500;
    const MINI_TIP_COOLDOWN_MAX_MS = 240000;
    const MINI_TIP_MIN_INTERVAL_VISITS = 2;
    const MINI_TIP_MAX_INTERVAL_VISITS = 6;
    const MINI_TIP_INTERVAL_STEP = 12;
    const EDGE_PADDING = 12;
    const STEP_SCROLL_MARGIN = 56;
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const POINTER_BASE_ANGLE_DEG = -45;
    const POINTER_ICON_HALF = 46;

    const ARROW_VARIANTS = Object.freeze([
        {
            name: 'classic',
            style: 'solid',
            body: 'M 13 78 C 24 58 45 37 74 20',
            echo: 'M 18 77 C 29 58 47 42 70 26',
            head: 'M 63 17 L 81 20 L 70 34'
        },
        {
            name: 'hook',
            style: 'solid',
            body: 'M 12 75 C 21 57 35 48 50 50 C 64 52 74 40 82 22',
            echo: 'M 16 74 C 24 58 37 51 50 53',
            head: 'M 70 19 L 84 22 L 77 34'
        },
        {
            name: 'dash',
            style: 'dashed',
            body: 'M 14 76 C 24 61 39 49 55 41 C 65 35 74 27 82 17',
            echo: 'M 19 76 C 30 62 45 51 60 42',
            head: 'M 71 14 L 84 17 L 77 29'
        },
        {
            name: 'swoop',
            style: 'solid',
            body: 'M 10 79 C 28 68 26 55 40 48 C 54 41 67 30 79 18',
            echo: 'M 16 78 C 31 68 32 56 44 49',
            head: 'M 68 14 L 81 18 L 75 30'
        }
    ]);

    const state = {
        initialized: false,
        active: false,
        routeName: '',
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
        miniTipsRoute: '',
        miniTipTimer: 0,
        miniTipRetryTimer: 0,
        miniTipRetryCount: 0,
        miniTipEntries: []
    };

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
        miniTipsLayer: null
    };

    /** Initialize tutorial shell and listeners once. */
    function init() {
        if (state.initialized) {
            return;
        }

        buildUI();
        bindEvents();
        state.initialized = true;
    }

    /**
     * Handle route transitions and first-time auto run.
     * @param {string} routeName - Active route name
     */
    function onRouteChange(routeName) {
        init();

        const normalized = normalizeRouteName(routeName);
        if (!normalized) {
            return;
        }

        cancelPendingAutoStart();
        cancelPendingMiniTipStart();
        clearRetryTimer();
        clearMiniTipRetry();
        state.miniTipRetryCount = 0;

        if (state.active && state.routeName === normalized) {
            return;
        }

        if (state.active && state.routeName !== normalized) {
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
        state.previousFocus = document.activeElement;

        clearMiniTips();

        ui.root.hidden = false;
        ui.root.setAttribute('aria-hidden', 'false');
        document.body.classList.add('tutorial-open');

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
        return getStorageValue(getCompletionKey(normalized)) === '1';
    }

    /** Build tutorial and mini-tip DOM layers. */
    function buildUI() {
        ui.root = document.createElement('div');
        ui.root.className = 'tutorial-layer';
        ui.root.hidden = true;
        ui.root.setAttribute('aria-hidden', 'true');

        ui.overlay = document.createElement('div');
        ui.overlay.className = 'tutorial-overlay';

        ui.spotlight = document.createElement('div');
        ui.spotlight.className = 'tutorial-spotlight';

        ui.pointer = document.createElementNS(SVG_NS, 'svg');
        ui.pointer.classList.add('tutorial-pointer');
        ui.pointer.setAttribute('aria-hidden', 'true');
        ui.pointer.setAttribute('viewBox', '0 0 96 96');
        ui.pointer.setAttribute('preserveAspectRatio', 'xMidYMid meet');

        ui.pointerMainPath = document.createElementNS(SVG_NS, 'path');
        ui.pointerMainPath.classList.add('tutorial-pointer-path-main');

        ui.pointerEchoPath = document.createElementNS(SVG_NS, 'path');
        ui.pointerEchoPath.classList.add('tutorial-pointer-path-echo');

        ui.pointerHeadPath = document.createElementNS(SVG_NS, 'path');
        ui.pointerHeadPath.classList.add('tutorial-pointer-head');

        ui.pointer.appendChild(ui.pointerEchoPath);
        ui.pointer.appendChild(ui.pointerMainPath);
        ui.pointer.appendChild(ui.pointerHeadPath);

        ui.popover = document.createElement('section');
        ui.popover.className = 'tutorial-popover';
        ui.popover.setAttribute('role', 'dialog');
        ui.popover.setAttribute('aria-modal', 'true');
        ui.popover.setAttribute('aria-labelledby', 'tutorialPopoverTitle');
        ui.popover.setAttribute('aria-describedby', 'tutorialPopoverBody');
        ui.popover.tabIndex = -1;

        ui.title = document.createElement('h3');
        ui.title.className = 'tutorial-title';
        ui.title.id = 'tutorialPopoverTitle';

        ui.body = document.createElement('p');
        ui.body.className = 'tutorial-text';
        ui.body.id = 'tutorialPopoverBody';

        const footer = document.createElement('div');
        footer.className = 'tutorial-footer';

        const progress = document.createElement('div');
        progress.className = 'tutorial-progress';

        ui.counter = document.createElement('span');
        ui.counter.className = 'tutorial-counter';

        ui.dots = document.createElement('div');
        ui.dots.className = 'tutorial-dots';

        progress.appendChild(ui.counter);
        progress.appendChild(ui.dots);

        const controls = document.createElement('div');
        controls.className = 'tutorial-controls';

        ui.backButton = document.createElement('button');
        ui.backButton.type = 'button';
        ui.backButton.className = 'tutorial-btn tutorial-btn-back';
        ui.backButton.textContent = 'Back';

        ui.nextButton = document.createElement('button');
        ui.nextButton.type = 'button';
        ui.nextButton.className = 'tutorial-btn tutorial-btn-next';
        ui.nextButton.textContent = 'Next';

        ui.skipButton = document.createElement('button');
        ui.skipButton.type = 'button';
        ui.skipButton.className = 'tutorial-btn tutorial-btn-skip';
        ui.skipButton.textContent = 'Skip';

        controls.appendChild(ui.backButton);
        controls.appendChild(ui.nextButton);
        controls.appendChild(ui.skipButton);

        footer.appendChild(progress);
        footer.appendChild(controls);

        ui.popover.appendChild(ui.title);
        ui.popover.appendChild(ui.body);
        ui.popover.appendChild(footer);

        ui.root.appendChild(ui.overlay);
        ui.root.appendChild(ui.spotlight);
        ui.root.appendChild(ui.popover);

        ui.miniTipsLayer = document.createElement('div');
        ui.miniTipsLayer.className = 'tutorial-mini-layer';

        document.body.appendChild(ui.root);
        document.body.appendChild(ui.pointer);
        document.body.appendChild(ui.miniTipsLayer);
    }

    /** Attach event handlers for controls, keyboard, and layout updates. */
    function bindEvents() {
        ui.backButton.addEventListener('click', handleBackClick);
        ui.nextButton.addEventListener('click', handleNextClick);
        ui.skipButton.addEventListener('click', handleSkipClick);
        ui.popover.addEventListener('click', handleDotClick);
        document.addEventListener('click', handleRestartClick);

        document.addEventListener('keydown', handleKeyDown, true);
        window.addEventListener('resize', handleViewportChange);
        window.addEventListener('scroll', handleViewportChange, true);
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

    /** Handle step-dot navigation clicks. */
    function handleDotClick(event) {
        if (!state.active) {
            return;
        }

        const dot = DomEvents.closest(event, '.tutorial-dot[data-step-index]');
        if (!dot) {
            return;
        }

        const index = Number(dot.getAttribute('data-step-index'));
        if (!Number.isFinite(index)) {
            return;
        }

        const direction = index >= state.currentIndex ? 1 : -1;
        moveToStep(index, direction, false);
    }

    /** Handle tutorial restart button clicks. */
    function handleRestartClick(event) {
        const trigger = DomEvents.closest(event, '[data-tutorial-action="restart"], .tutorial-restart-btn[data-tutorial-route]');
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
        const explicitRoute = normalizeRouteName(trigger.getAttribute('data-tutorial-route'));
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

        return normalizeRouteName(state.routeName || state.miniTipsRoute || '');
    }

    /** Keyboard shortcuts and focus trap while dialog is open. */
    function handleKeyDown(event) {
        if (!state.active) {
            return;
        }

        switch (event.key) {
            case 'Escape':
                event.preventDefault();
                completeCurrentRoute();
                return;
            case 'ArrowRight':
                event.preventDefault();
                handleNextClick();
                return;
            case 'Enter':
                if (shouldUseNativeEnter(event.target)) {
                    return;
                }
                event.preventDefault();
                handleNextClick();
                return;
            case 'ArrowLeft':
                event.preventDefault();
                handleBackClick();
                return;
            case 'Tab':
                trapFocus(event);
                return;
            default:
                return;
        }
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
     * Keep the step target inside viewport when possible.
     * @param {Element|null} target - Step target
     */
    function ensureTargetInView(target) {
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

        const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        target.scrollIntoView({
            block: 'center',
            inline: 'nearest',
            behavior: prefersReducedMotion ? 'auto' : 'smooth'
        });
    }

    /**
     * Check whether element stays pinned to viewport.
     * @param {HTMLElement} element - DOM element
     * @returns {boolean}
     */
    function isViewportPinned(element) {
        const position = window.getComputedStyle(element).position;
        return position === 'fixed' || position === 'sticky';
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

        return Boolean(element.closest('button, a[href], input, select, textarea, [role="button"]'));
    }

    /** Update spotlight and popover position without rerendering text/progress. */
    function updateCurrentStepGeometry() {
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

    /** Retry first step lookup for delayed UI renders. */
    function scheduleInitialRetry() {
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
        if (!state.steps.length) {
            return -1;
        }

        if (fromIndex < 0 || fromIndex >= state.steps.length) {
            return -1;
        }

        const stepDirection = direction >= 0 ? 1 : -1;

        for (let index = fromIndex; index >= 0 && index < state.steps.length; index += stepDirection) {
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
        if (!state.active) {
            return;
        }

        const step = getCurrentStep();
        const title = step.title || step.heading || 'Quick tour';
        const body = step.body || step.text || step.content || step.description || '';

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
        ui.nextButton.textContent = isLastStep ? 'Finish' : 'Next';

        if (focusPopover) {
            ui.popover.focus();
        }
    }

    /** Render step counter and dot navigation. */
    function renderProgress() {
        const visibleIndices = state.renderableIndices.length ? state.renderableIndices : computeRenderableIndices();
        const visiblePosition = visibleIndices.indexOf(state.currentIndex);
        const currentNumber = visiblePosition === -1 ? 1 : visiblePosition + 1;
        const total = visibleIndices.length || 1;

        ui.counter.textContent = `Step ${currentNumber} of ${total}`;

        ui.dots.innerHTML = '';
        visibleIndices.forEach((index, dotIndex) => {
            const dot = document.createElement('button');
            dot.type = 'button';
            dot.className = 'tutorial-dot';
            dot.setAttribute('data-step-index', String(index));
            dot.setAttribute('aria-label', `Go to step ${dotIndex + 1}`);
            if (index === state.currentIndex) {
                dot.classList.add('is-active');
            }
            ui.dots.appendChild(dot);
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
     * Resolve a step target from selector/element.
     * @param {object} step - Step config
     * @returns {Element|null}
     */
    function resolveStepTarget(step) {
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
    function hasStepTarget(step) {
        return collectTargetCandidates(step).length > 0;
    }

    /**
     * Collect primary and fallback step targets.
     * @param {object} step - Step config
     * @returns {(string|Element)[]}
     */
    function collectTargetCandidates(step) {
        if (!step || typeof step !== 'object') {
            return [];
        }

        const fields = [
            step.target,
            step.selector,
            step.el,
            step.fallbackTarget,
            step.fallbackSelector,
            step.fallbackEl
        ];
        const candidates = [];

        fields.forEach(field => {
            if (!field) {
                return;
            }

            if (Array.isArray(field)) {
                field.forEach(value => {
                    if (value) {
                        candidates.push(value);
                    }
                });
                return;
            }

            candidates.push(field);
        });

        return candidates;
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
        if (typeof ref === 'string') {
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
     * @returns {boolean}
     */
    function isElementVisible(element) {
        if (!(element instanceof HTMLElement)) {
            return false;
        }

        const styles = window.getComputedStyle(element);
        if (styles.display === 'none' || styles.visibility === 'hidden' || styles.visibility === 'collapse') {
            return false;
        }
        if (Number(styles.opacity || '1') <= 0) {
            return false;
        }

        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    /**
     * Position spotlight, popover, and pointer.
     * @param {Element|null} target - Highlight target
     * @param {object} step - Step config
     */
    function updateGeometry(target, step) {
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const placement = String((step && step.placement) || 'auto').toLowerCase();

        let targetRect = null;
        if (target) {
            targetRect = target.getBoundingClientRect();
            const spotlightPadding = 8;
            const x = Math.max(EDGE_PADDING, targetRect.left - spotlightPadding);
            const y = Math.max(EDGE_PADDING, targetRect.top - spotlightPadding);
            const width = Math.max(44, Math.min(viewportWidth - (EDGE_PADDING * 2), targetRect.width + (spotlightPadding * 2)));
            const height = Math.max(34, Math.min(viewportHeight - (EDGE_PADDING * 2), targetRect.height + (spotlightPadding * 2)));

            ui.spotlight.style.display = 'block';
            ui.spotlight.style.left = `${x}px`;
            ui.spotlight.style.top = `${y}px`;
            ui.spotlight.style.width = `${width}px`;
            ui.spotlight.style.height = `${height}px`;
        } else {
            ui.spotlight.style.display = 'none';
        }

        ui.popover.style.maxWidth = Math.min(420, viewportWidth - (EDGE_PADDING * 2)) + 'px';
        ui.popover.style.left = '0px';
        ui.popover.style.top = '0px';

        const popRect = ui.popover.getBoundingClientRect();
        const resolvedPlacement = resolvePlacement(placement, targetRect, popRect, viewportWidth, viewportHeight);
        const popPosition = calculatePopoverPosition(resolvedPlacement, targetRect, popRect, viewportWidth, viewportHeight);

        ui.popover.style.left = `${popPosition.left}px`;
        ui.popover.style.top = `${popPosition.top}px`;

        updatePointer(targetRect, popPosition, popRect, resolvedPlacement, step);
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
    function resolvePlacement(preferred, targetRect, popRect, viewportWidth, viewportHeight) {
        if (!targetRect) {
            return 'center';
        }

        if (preferred !== 'auto') {
            return preferred;
        }

        const roomBottom = viewportHeight - targetRect.bottom;
        const roomTop = targetRect.top;
        const roomRight = viewportWidth - targetRect.right;
        const roomLeft = targetRect.left;

        if (roomBottom >= popRect.height + 24) {
            return 'bottom';
        }
        if (roomTop >= popRect.height + 24) {
            return 'top';
        }
        if (roomRight >= popRect.width + 24) {
            return 'right';
        }
        if (roomLeft >= popRect.width + 24) {
            return 'left';
        }
        return roomBottom >= roomTop ? 'bottom' : 'top';
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
    function calculatePopoverPosition(placement, targetRect, popRect, viewportWidth, viewportHeight) {
        if (!targetRect || placement === 'center') {
            return {
                left: clamp((viewportWidth - popRect.width) / 2, EDGE_PADDING, viewportWidth - popRect.width - EDGE_PADDING),
                top: clamp((viewportHeight - popRect.height) / 2, EDGE_PADDING, viewportHeight - popRect.height - EDGE_PADDING)
            };
        }

        const centerX = targetRect.left + (targetRect.width / 2);
        const centerY = targetRect.top + (targetRect.height / 2);
        let left = centerX - (popRect.width / 2);
        let top = centerY - (popRect.height / 2);

        switch (placement) {
            case 'top':
                top = targetRect.top - popRect.height - 16;
                break;
            case 'bottom':
                top = targetRect.bottom + 16;
                break;
            case 'left':
                left = targetRect.left - popRect.width - 16;
                break;
            case 'right':
                left = targetRect.right + 16;
                break;
            default:
                break;
        }

        return {
            left: clamp(left, EDGE_PADDING, viewportWidth - popRect.width - EDGE_PADDING),
            top: clamp(top, EDGE_PADDING, viewportHeight - popRect.height - EDGE_PADDING)
        };
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
        if (!targetRect || placement === 'center') {
            ui.pointer.style.display = 'none';
            return;
        }

        const popCenterX = popPosition.left + (popRect.width / 2);
        const popCenterY = popPosition.top + (popRect.height / 2);
        const targetCenterX = targetRect.left + (targetRect.width / 2);
        const targetCenterY = targetRect.top + (targetRect.height / 2);
        const angle = Math.atan2(targetCenterY - popCenterY, targetCenterX - popCenterX);

        const popRectBox = {
            left: popPosition.left,
            top: popPosition.top,
            width: popRect.width,
            height: popRect.height
        };

        const popEdge = getRectEdgePoint(popRectBox, targetCenterX, targetCenterY);
        const pointerX = popEdge.x + (Math.cos(angle) * 22);
        const pointerY = popEdge.y + (Math.sin(angle) * 22);
        const maxX = window.innerWidth - POINTER_ICON_HALF;
        const maxY = window.innerHeight - POINTER_ICON_HALF;
        const clampedX = clamp(pointerX, POINTER_ICON_HALF, maxX);
        const clampedY = clamp(pointerY, POINTER_ICON_HALF, maxY);
        const variant = resolvePointerVariant(step);
        const rotationDeg = ((angle * 180) / Math.PI) - POINTER_BASE_ANGLE_DEG;

        ui.pointer.dataset.arrowStyle = variant.style;
        ui.pointer.dataset.arrowName = variant.name;
        ui.pointerMainPath.setAttribute('d', variant.body);
        ui.pointerEchoPath.setAttribute('d', variant.echo);
        ui.pointerHeadPath.setAttribute('d', variant.head);

        ui.pointer.style.display = 'block';
        ui.pointer.style.left = `${clampedX}px`;
        ui.pointer.style.top = `${clampedY}px`;
        ui.pointer.style.transform = `translate(-50%, -50%) rotate(${rotationDeg}deg)`;
    }

    /**
     * Pick an arrow variant for the current step.
     * @param {object} step - Step config
     * @returns {{name:string, style:string, body:string, echo:string, head:string}}
     */
    function resolvePointerVariant(step) {
        const preferredName = String(step && step.arrowStyle ? step.arrowStyle : '').trim().toLowerCase();
        if (preferredName) {
            const preferred = ARROW_VARIANTS.find(variant => variant.name === preferredName);
            if (preferred) {
                return preferred;
            }
        }

        const key = [state.routeName, step && step.id ? step.id : '', String(state.currentIndex)].join(':');
        const hash = hashString(key);
        return ARROW_VARIANTS[hash % ARROW_VARIANTS.length];
    }

    /**
     * Build a stable integer hash.
     * @param {string} value - Source value
     * @returns {number}
     */
    function hashString(value) {
        let hash = 0;
        for (let index = 0; index < value.length; index += 1) {
            hash = ((hash << 5) - hash) + value.charCodeAt(index);
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
    function getRectEdgePoint(rect, towardX, towardY) {
        const centerX = rect.left + (rect.width / 2);
        const centerY = rect.top + (rect.height / 2);
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
            x: centerX + (deltaX * scale),
            y: centerY + (deltaY * scale)
        };
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
            zIndex: target.style.zIndex
        };

        if (window.getComputedStyle(target).position === 'static') {
            target.style.position = 'relative';
        }
        target.style.zIndex = '1201';
        target.classList.add('tutorial-highlighted');
    }

    /** Restore previously highlighted target styles. */
    function clearHighlightedTarget() {
        if (!(state.highlightedTarget instanceof HTMLElement)) {
            state.highlightedTarget = null;
            state.highlightedStyle = null;
            return;
        }

        state.highlightedTarget.classList.remove('tutorial-highlighted');
        const previous = state.highlightedStyle || { position: '', zIndex: '' };
        state.highlightedTarget.style.position = previous.position || '';
        state.highlightedTarget.style.zIndex = previous.zIndex || '';
        state.highlightedTarget = null;
        state.highlightedStyle = null;
    }

    /** Persist completion and close active tutorial. */
    function completeCurrentRoute() {
        if (!state.active) {
            return;
        }
        setStorageValue(getCompletionKey(state.routeName), '1');
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
        ui.root.hidden = true;
        ui.root.setAttribute('aria-hidden', 'true');
        ui.pointer.style.display = 'none';
        ui.spotlight.style.display = 'none';
        document.body.classList.remove('tutorial-open');

        state.active = false;

        if (keepCompletion && routeName) {
            state.miniTipsRoute = routeName;
            scheduleMiniTips(routeName, token, visitCount);
        }

        if (state.previousFocus && typeof state.previousFocus.focus === 'function') {
            state.previousFocus.focus();
        }

        state.routeName = '';
        state.steps = [];
        state.renderableIndices = [];
        state.currentIndex = -1;
        state.retryCount = 0;
        state.previousFocus = null;

        if (!keepCompletion) {
            state.token += 1;
        }
    }

    /** Render contextual mini-tip callouts for a route. */
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
            ui.miniTipsLayer.appendChild(node);
            state.miniTipEntries.push({
                node,
                tip,
                routeName,
                tipId,
                placement: tip.placement,
                target
            });
        });

        if (!state.miniTipEntries.length) {
            scheduleMiniTipRetry(routeName);
            return;
        }

        positionMiniTips();
        const hasVisibleTip = state.miniTipEntries.some(entry => entry.node && !entry.node.hidden);
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
        const node = document.createElement('aside');
        node.className = 'tutorial-mini-tip';
        node.setAttribute('role', 'note');

        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.className = 'tutorial-mini-dismiss';
        dismiss.setAttribute('aria-label', 'Dismiss tip');
        dismiss.textContent = 'x';
        dismiss.addEventListener('click', () => {
            setStorageValue(getMiniTipKey(routeName, tipId), '1');
            state.miniTipEntries = state.miniTipEntries.filter(entry => {
                return !(entry.routeName === routeName && entry.tipId === tipId);
            });
            node.remove();
        });

        if (tip.title) {
            const title = document.createElement('strong');
            title.className = 'tutorial-mini-title';
            title.textContent = String(tip.title);
            node.appendChild(title);
        }

        const text = document.createElement('p');
        text.className = 'tutorial-mini-text';
        text.textContent = String(tip.body || tip.text || tip.content || tip.message || '');

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
        const refs = collectTargetCandidates(tip);

        for (const ref of refs) {
            if (!ref) {
                continue;
            }

            const element = resolveElementReference(ref);
            if (isElementVisible(element)) {
                return element;
            }
        }

        return null;
    }

    /**
     * Position mini-tip near its target.
     * @param {HTMLElement} node - Tip node
     * @param {Element} target - Target node
     * @param {string|undefined} placementValue - Preferred placement
     */
    function positionMiniTip(node, target, placementValue) {
        const placement = String(placementValue || 'bottom').toLowerCase();
        const targetRect = target.getBoundingClientRect();
        node.style.left = '0px';
        node.style.top = '0px';

        const tipRect = node.getBoundingClientRect();
        let left = targetRect.left + (targetRect.width / 2) - (tipRect.width / 2);
        let top = targetRect.bottom + 10;

        switch (placement) {
            case 'top':
                top = targetRect.top - tipRect.height - 10;
                break;
            case 'left':
                left = targetRect.left - tipRect.width - 10;
                top = targetRect.top + (targetRect.height / 2) - (tipRect.height / 2);
                break;
            case 'right':
                left = targetRect.right + 10;
                top = targetRect.top + (targetRect.height / 2) - (tipRect.height / 2);
                break;
            default:
                top = targetRect.bottom + 10;
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

        state.miniTipEntries = state.miniTipEntries.filter(entry => entry.node && entry.node.isConnected);
        state.miniTipEntries.forEach(entry => {
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
        if (!ui.miniTipsLayer) {
            return;
        }
        ui.miniTipsLayer.innerHTML = '';
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
        const focusable = getFocusableElements(ui.popover);
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
     * Collect focusable children for focus trapping.
     * @param {HTMLElement} root - Root container
     * @returns {HTMLElement[]}
     */
    function getFocusableElements(root) {
        if (!root) {
            return [];
        }

        const selectors = [
            'button:not([disabled])',
            'a[href]',
            'input:not([disabled]):not([type="hidden"])',
            'select:not([disabled])',
            'textarea:not([disabled])',
            '[tabindex]:not([tabindex="-1"])'
        ];

        const nodes = root.querySelectorAll(selectors.join(','));
        return Array.from(nodes).filter(node => isElementVisible(node));
    }

    /**
     * Read route tutorial steps from global config.
     * @param {string} routeName - Route name
     * @returns {object[]}
     */
    function getRouteSteps(routeName) {
        return getRouteConfigItems(TutorialSteps, routeName);
    }

    /**
     * Read route mini-tip callouts from global config.
     * @param {string} routeName - Route name
     * @returns {object[]}
     */
    function getRouteMiniTips(routeName) {
        return getRouteConfigItems(TutorialMiniTips, routeName);
    }

    /**
     * Read route-scoped config items from global window config.
     * @param {object[]|Object<string, object[]>|undefined} config - Route config source
     * @param {string} routeName - Route name
     * @returns {object[]}
     */
    function getRouteConfigItems(config, routeName) {
        if (!config) {
            return [];
        }

        if (Array.isArray(config)) {
            return config.filter(item => normalizeRouteName(item.route) === routeName);
        }

        if (typeof config === 'object') {
            const list = config[routeName];
            return Array.isArray(list) ? list.slice() : [];
        }

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

            if (!canStartMiniTips(routeName, token)) {
                return;
            }
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
        if ((normalizedVisitCount % interval) !== 0) {
            return false;
        }

        const lastShownAt = getMiniTipLastShownAt();
        if (!lastShownAt) {
            return true;
        }

        const cooldownMs = getMiniTipCooldownMs(normalizedVisitCount);
        return (Date.now() - lastShownAt) >= cooldownMs;
    }

    /**
     * Compute mini-tip delay for current engagement level.
     * @param {number} visitCount - Engagement visit count
     * @returns {number}
     */
    function getMiniTipDisplayDelayMs(visitCount) {
        const normalizedVisitCount = normalizeVisitCount(visitCount);
        const extraDelay = Math.min(
            normalizedVisitCount * MINI_TIP_DELAY_GROWTH_MS,
            MINI_TIP_DELAY_MAX_EXTRA_MS
        );
        return MINI_TIP_INITIAL_DELAY_MS + extraDelay;
    }

    /**
     * Compute minimum cooldown between mini-tip callouts.
     * @param {number} visitCount - Engagement visit count
     * @returns {number}
     */
    function getMiniTipCooldownMs(visitCount) {
        const normalizedVisitCount = normalizeVisitCount(visitCount);
        const growth = normalizedVisitCount * MINI_TIP_COOLDOWN_GROWTH_MS;
        return Math.min(MINI_TIP_COOLDOWN_MAX_MS, MINI_TIP_BASE_COOLDOWN_MS + growth);
    }

    /**
     * Compute route-visit interval between mini-tip appearances.
     * @param {number} visitCount - Engagement visit count
     * @returns {number}
     */
    function getMiniTipVisitInterval(visitCount) {
        const normalizedVisitCount = normalizeVisitCount(visitCount);
        const growthSteps = Math.floor(normalizedVisitCount / MINI_TIP_INTERVAL_STEP);
        return Math.min(MINI_TIP_MAX_INTERVAL_VISITS, MINI_TIP_MIN_INTERVAL_VISITS + growthSteps);
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

        const contentOverlay = document.getElementById('contentLoadingOverlay');
        if (contentOverlay && !contentOverlay.hidden) {
            return true;
        }

        const uploadOverlay = document.getElementById('progressOverlay');
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
        return getStorageValue(getMiniTipKey(routeName, tipId)) === '1';
    }

    /**
     * Normalize engagement visit count.
     * @param {number} value - Raw visit count
     * @returns {number}
     */
    function normalizeVisitCount(value) {
        const count = Number(value);
        if (!Number.isFinite(count) || count < 1) {
            return 1;
        }
        return Math.floor(count);
    }

    /**
     * Normalize route names.
     * @param {string} value - Raw route
     * @returns {string}
     */
    function normalizeRouteName(value) {
        return String(value || '').trim().toLowerCase();
    }

    /**
     * Clamp a number between a minimum and maximum.
     * @param {number} value - Input value
     * @param {number} min - Minimum value
     * @param {number} max - Maximum value
     * @returns {number}
     */
    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    /**
     * Build completion storage key.
     * @param {string} routeName - Route name
     * @returns {string}
     */
    function getCompletionKey(routeName) {
        return `${STORAGE_PREFIX}:route:${routeName}:complete`;
    }

    /**
     * Build mini-tip storage key.
     * @param {string} routeName - Route name
     * @param {string} tipId - Tip id
     * @returns {string}
     */
    function getMiniTipKey(routeName, tipId) {
        return `${STORAGE_PREFIX}:route:${routeName}:tip:${tipId}:dismissed`;
    }

    /**
     * Build mini-tip engagement visit count storage key.
     * @returns {string}
     */
    function getMiniTipVisitCountKey() {
        return `${STORAGE_PREFIX}:mini-tip:route-visits`;
    }

    /**
     * Build mini-tip last shown timestamp storage key.
     * @returns {string}
     */
    function getMiniTipLastShownAtKey() {
        return `${STORAGE_PREFIX}:mini-tip:last-shown-at`;
    }

    /**
     * Safe localStorage getter.
     * @param {string} key - Storage key
     * @returns {string|null}
     */
    function getStorageValue(key) {
        try {
            return window.localStorage.getItem(key);
        } catch {
            return null;
        }
    }

    /**
     * Safe localStorage number getter.
     * @param {string} key - Storage key
     * @param {number} fallbackValue - Fallback value
     * @returns {number}
     */
    function getStorageNumberValue(key, fallbackValue) {
        const rawValue = getStorageValue(key);
        const parsed = Number(rawValue);
        if (!Number.isFinite(parsed)) {
            return fallbackValue;
        }
        return parsed;
    }

    /**
     * Safe localStorage setter.
     * @param {string} key - Storage key
     * @param {string} value - Value
     */
    function setStorageValue(key, value) {
        try {
            window.localStorage.setItem(key, value);
        } catch {
            return;
        }
    }

    /**
     * Remove a localStorage value safely.
     * @param {string} key - Storage key
     */
    function removeStorageValue(key) {
        try {
            window.localStorage.removeItem(key);
        } catch {
            return;
        }
    }

    return {
        init,
        onRouteChange,
        start,
        reset,
        isComplete
    };
})();
