/* Upload progress overlay: sketch-style canvas bar and its animation loop */

import rough from "roughjs/bundled/rough.esm.js";

export const UploadProgress = (() => {
    "use strict";

    const elements = {
        overlay: document.getElementById("progressOverlay"),
        canvas: /** @type {HTMLCanvasElement|null} */ (
            document.getElementById("progressCanvas")
        ),
        percent: document.getElementById("progressPercent"),
    };

    let progressValue = 0;
    let progressAnimationId = null;
    let progressSessionId = 0;
    let lastProgressPercent = 0;
    let hasActiveJobs = () => false;

    /**
     * Show the progress overlay and start animation.
     * @param {() => boolean} activeJobsPredicate - Reports whether jobs are still in flight
     */
    function show(activeJobsPredicate) {
        hasActiveJobs =
            typeof activeJobsPredicate === "function" ? activeJobsPredicate : () => false;
        if (!elements.overlay) {
            return;
        }
        progressSessionId += 1;
        const sessionId = progressSessionId;
        elements.overlay.hidden = false;
        progressValue = 0;
        lastProgressPercent = 0;
        drawProgressBar(progressValue);
        animateProgressTo(
            0.72,
            650,
            () => {
                if (sessionId !== progressSessionId || !hasActiveJobs()) {
                    return;
                }
                startProgressCrawl(sessionId);
            },
            sessionId,
        );
    }

    /** Animate progress to 100% then hide the overlay. */
    function hide() {
        const overlay = elements.overlay;
        if (!overlay || overlay.hidden) {
            return;
        }
        const sessionId = progressSessionId;
        animateProgressTo(
            1,
            320,
            () => {
                if (sessionId !== progressSessionId) {
                    return;
                }
                overlay.hidden = true;
            },
            sessionId,
        );
    }

    /**
     * Apply an incremental worker progress update to the bar.
     * @param {number} percent - Progress fraction between 0 and 1
     */
    function reportPercent(percent) {
        const normalized = Math.max(0, Math.min(1, percent));
        const capped = Math.min(0.98, Math.max(progressValue, normalized * 0.98));
        progressValue = capped;
        if (Math.abs(normalized - lastProgressPercent) >= 0.02) {
            lastProgressPercent = normalized;
        }
        drawProgressBar(progressValue);
    }

    /** Redraw the bar at the current value (e.g. on viewport resize). */
    function redraw() {
        drawProgressBar(progressValue);
    }

    /**
     * Smoothly animate progress bar to target value.
     * @param {number} target - Target progress value (0-1)
     * @param {number} duration - Animation duration in ms
     * @param {(() => void) | null} [callback] - Optional callback when animation completes
     * @param {number} [sessionId] - Progress animation session token
     */
    function animateProgressTo(target, duration, callback, sessionId) {
        stopProgressAnimation();
        const start = performance.now();
        const startValue = progressValue;
        // show()/hide() always pass a live session token, so the fallback is defensive.
        /* v8 ignore next */
        const animationSession = sessionId || progressSessionId;

        function step(now) {
            /* v8 ignore next 4 */
            if (animationSession !== progressSessionId) {
                progressAnimationId = null;
                return;
            }
            const elapsed = now - start;
            const t = Math.min(elapsed / duration, 1);
            const eased = 1 - Math.pow(1 - t, 3);
            progressValue = startValue + (target - startValue) * eased;
            drawProgressBar(progressValue);
            if (t < 1) {
                progressAnimationId = requestAnimationFrame(step);
                return;
            }

            progressAnimationId = null;
            // show()/hide() always pass a completion callback, so the guard is defensive.
            /* v8 ignore next */
            if (callback) {
                queueMicrotask(callback);
            }
        }

        progressAnimationId = requestAnimationFrame(step);
    }

    /** Stop any in-flight progress animation frame loop. */
    function stopProgressAnimation() {
        if (!progressAnimationId) {
            return;
        }
        cancelAnimationFrame(progressAnimationId);
        progressAnimationId = null;
    }

    /**
     * Slowly crawl progress toward completion while jobs are active.
     * @param {number} sessionId - Progress animation session token
     */
    function startProgressCrawl(sessionId) {
        stopProgressAnimation();
        const crawlCap = 0.985;
        let previousTime = 0;

        function crawl(now) {
            /* v8 ignore next 4 */
            if (sessionId !== progressSessionId) {
                progressAnimationId = null;
                return;
            }

            /* v8 ignore next */
            if (!hasActiveJobs()) {
                progressAnimationId = null;
                return;
            }

            if (!previousTime) {
                previousTime = now;
            }

            const deltaMs = Math.max(0, now - previousTime);
            previousTime = now;
            const remaining = Math.max(0, crawlCap - progressValue);

            if (remaining > 0.0005) {
                const normalizedRemaining = Math.min(1, remaining / 0.265);
                const unitsPerSecond = 0.007 + 0.06 * normalizedRemaining;
                const increment = (unitsPerSecond * deltaMs) / 1000;
                progressValue = Math.min(crawlCap, progressValue + increment);
                drawProgressBar(progressValue);
            }

            progressAnimationId = requestAnimationFrame(crawl);
        }

        progressAnimationId = requestAnimationFrame(crawl);
    }

    /**
     * Draw the progress bar on canvas at the given value (0-1).
     * @param {number} value - Progress value between 0 and 1
     */
    function drawProgressBar(value) {
        const canvas = elements.canvas;
        /* v8 ignore next */
        if (!canvas) {
            return;
        }
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) {
            return;
        }
        const ratio = window.devicePixelRatio || 1;
        canvas.width = rect.width * ratio;
        canvas.height = rect.height * ratio;
        const ctx = canvas.getContext("2d");
        /* v8 ignore next */
        if (!ctx) {
            return;
        }
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.clearRect(0, 0, rect.width, rect.height);

        /* v8 ignore next 3 */
        if (typeof document === "undefined" || !document.documentElement) {
            return;
        }
        const styles = getComputedStyle(document.documentElement);
        const border = styles.getPropertyValue("--border-color").trim();
        const fill = styles.getPropertyValue("--accent-purple").trim();

        const trackX = 8;
        const trackY = rect.height / 2 - 14;
        const trackWidth = rect.width - 16;
        const trackHeight = 28;

        /* v8 ignore next */
        if (rough) {
            const rc = rough.canvas(canvas);
            rc.rectangle(trackX, trackY, trackWidth, trackHeight, {
                stroke: border,
                strokeWidth: 1.5,
                roughness: 1.4,
            });
            const fillWidth = Math.max(4, (trackWidth - 4) * value);
            ctx.fillStyle = fill;
            ctx.globalAlpha = 0.6;
            ctx.fillRect(trackX + 2, trackY + 2, fillWidth, trackHeight - 4);
            ctx.globalAlpha = 1;
            rc.rectangle(trackX + 2, trackY + 2, fillWidth, trackHeight - 4, {
                stroke: fill,
                strokeWidth: 1.2,
                roughness: 1.2,
            });
        }

        if (elements.percent) {
            elements.percent.textContent = `${Math.round(value * 100)}%`;
        }
    }

    return {
        show,
        hide,
        reportPercent,
        redraw,
    };
})();
