/* Global runtime guards */

import { DomEvents } from './dom-events.js';
import { SketchCharts } from './charts.js';
import { captureError } from './sentry.js';

export function initRuntime() {
    'use strict';

    const BANNER_ID = 'globalErrorBanner';
    const MESSAGE = 'Something went wrong. Refresh the page or re-upload your files.';

    /**
     * Create the global error banner element and append it to the document body.
     * @returns {HTMLDivElement} The newly created banner element
     */
    function createBanner() {
        const banner = document.createElement('div');
        banner.id = BANNER_ID;
        banner.className = 'global-error-banner';
        banner.hidden = true;

        const content = document.createElement('div');
        content.className = 'global-error-content';

        const text = document.createElement('p');
        text.className = 'global-error-text';
        text.textContent = MESSAGE;

        const actions = document.createElement('div');
        actions.className = 'global-error-actions';

        const reloadBtn = document.createElement('button');
        reloadBtn.type = 'button';
        reloadBtn.className = 'ghost-btn';
        reloadBtn.textContent = 'Reload';
        reloadBtn.addEventListener('click', () => window.location.reload());

        const dismissBtn = document.createElement('button');
        dismissBtn.type = 'button';
        dismissBtn.className = 'ghost-btn';
        dismissBtn.textContent = 'Dismiss';
        dismissBtn.addEventListener('click', () => {
            banner.hidden = true;
        });

        actions.appendChild(reloadBtn);
        actions.appendChild(dismissBtn);
        content.appendChild(text);
        content.appendChild(actions);
        banner.appendChild(content);

        const container = document.body || document.documentElement;
        if (container) {
            container.appendChild(banner);
        }
        return banner;
    }

    /**
     * Retrieve the existing error banner or create one if it doesn't exist.
     * @returns {HTMLDivElement} The error banner element
     */
    function getBanner() {
        return document.getElementById(BANNER_ID) || createBanner();
    }

    /**
     * Show the global error banner to the user.
     */
    function showBanner() {
        const banner = getBanner();
        banner.hidden = false;
    }

    /**
     * Handle uncaught errors by logging and showing the error banner.
     * @param {ErrorEvent} event - The error event from window.onerror
     */
    function handleError(event) {
        const error = event && event.error ? event.error : event;
        if (error) {
            console.error('Unhandled error', error);
            captureError(error);
        }
        showBanner();
    }

    /**
     * Handle unhandled promise rejections by logging and showing the error banner.
     * @param {PromiseRejectionEvent} event - The rejection event
     */
    function handleRejection(event) {
        if (event && event.reason) {
            console.error('Unhandled rejection', event.reason);
            captureError(event.reason);
        }
        showBanner();
    }

    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleRejection);

    /* Chart PNG export — delegated handler for .chart-export-btn buttons */
    document.addEventListener('click', event => {
        const btn = DomEvents.closest(event, '.chart-export-btn');
        if (!btn) return;
        const canvasId = btn.dataset.exportCanvas;
        if (!canvasId || !SketchCharts) {
            return;
        }

        const filename = btn.dataset.exportName || 'chart.png';
        const canvas = document.getElementById(canvasId);
        if (!canvas) {
            return;
        }

        SketchCharts.exportPng(canvas, filename);
    });

    /* Service Worker registration */
    if (import.meta.env && import.meta.env.PROD && 'serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
                .then(registration => registration.update())
                .catch(() => {
                    // SW registration failure is non-critical
                });
        });
    }
}
