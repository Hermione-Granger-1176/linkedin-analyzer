/* Mobile navigation menu (hamburger toggle) */

import { DomEvents } from "./dom-events.js";

export const NavMenu = (() => {
    "use strict";

    const OPEN_LABEL = "Open navigation menu";
    const CLOSE_LABEL = "Close navigation menu";

    /** @type {Array<{toggle: HTMLElement, nav: HTMLElement}>} */
    const pairs = [];
    let documentListenersBound = false;

    /** Wire every nav toggle button to the nav it controls. */
    function init() {
        // Clear in place so re-init drops stale pairs while the shared document
        // listeners keep their reference to this same array.
        pairs.length = 0;
        const toggles = document.querySelectorAll(".nav-toggle");
        toggles.forEach((toggle) => wireToggle(/** @type {HTMLElement} */ (toggle)));
        bindDocumentListeners();
    }

    /**
     * Wire a single toggle button to the nav named by its aria-controls.
     * @param {HTMLElement} toggle - Toggle button element
     */
    function wireToggle(toggle) {
        const navId = toggle.getAttribute("aria-controls");
        const nav = navId ? document.getElementById(navId) : null;
        if (!nav) {
            return;
        }

        pairs.push({ toggle, nav });

        toggle.addEventListener("click", () => {
            setOpen(toggle, nav, !nav.classList.contains("is-open"));
        });

        // A route link click navigates; collapse the panel behind it.
        nav.addEventListener("click", (event) => {
            if (DomEvents.closest(event, "a[data-route]")) {
                setOpen(toggle, nav, false);
            }
        });
    }

    /**
     * Register the shared document-level handlers once. A single keydown and a
     * single click listener drive every wired pair, so app-wide events fan out
     * once rather than through one closure per toggle.
     */
    function bindDocumentListeners() {
        if (documentListenersBound) {
            return;
        }
        documentListenersBound = true;

        // Escape closes whichever nav is open and returns focus to its toggle.
        document.addEventListener("keydown", (event) => {
            if (event.key !== "Escape") {
                return;
            }
            pairs.forEach(({ toggle, nav }) => {
                if (nav.classList.contains("is-open")) {
                    setOpen(toggle, nav, false);
                    toggle.focus();
                }
            });
        });

        // A click outside an open nav and its toggle dismisses that panel.
        document.addEventListener("click", (event) => {
            const target = /** @type {Node|null} */ (event.target);
            pairs.forEach(({ toggle, nav }) => {
                if (!nav.classList.contains("is-open")) {
                    return;
                }
                if (nav.contains(target) || toggle.contains(target)) {
                    return;
                }
                setOpen(toggle, nav, false);
            });
        });
    }

    /**
     * Reflect the open state on the nav panel and its toggle button.
     * @param {HTMLElement} toggle - Toggle button
     * @param {HTMLElement} nav - Nav element
     * @param {boolean} open - Whether the panel should be open
     */
    function setOpen(toggle, nav, open) {
        nav.classList.toggle("is-open", open);
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
        toggle.setAttribute("aria-label", open ? CLOSE_LABEL : OPEN_LABEL);
    }

    return { init };
})();
