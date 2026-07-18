/* Mobile navigation menu (hamburger toggle) */

import { DomEvents } from "./dom-events.js";

export const NavMenu = (() => {
    "use strict";

    const OPEN_LABEL = "Open navigation menu";
    const CLOSE_LABEL = "Close navigation menu";

    /** Wire every nav toggle button to the nav it controls. */
    function init() {
        const toggles = document.querySelectorAll(".nav-toggle");
        toggles.forEach((toggle) => wireToggle(/** @type {HTMLElement} */ (toggle)));
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

        toggle.addEventListener("click", () => {
            if (nav.classList.contains("is-open")) {
                setOpen(toggle, nav, false);
            } else {
                setOpen(toggle, nav, true);
            }
        });

        // A route link click navigates; collapse the panel behind it.
        nav.addEventListener("click", (event) => {
            if (DomEvents.closest(event, "a[data-route]")) {
                setOpen(toggle, nav, false);
            }
        });

        // Escape closes and returns focus to the toggle for keyboard users.
        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && nav.classList.contains("is-open")) {
                setOpen(toggle, nav, false);
                toggle.focus();
            }
        });

        // A click anywhere outside the nav or its toggle dismisses the panel.
        document.addEventListener("click", (event) => {
            if (!nav.classList.contains("is-open")) {
                return;
            }
            const target = /** @type {Node|null} */ (event.target);
            if (nav.contains(target) || toggle.contains(target)) {
                return;
            }
            setOpen(toggle, nav, false);
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
