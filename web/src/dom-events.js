/* DOM event target safety helpers */

export const DomEvents = (() => {
    'use strict';

    /**
     * Safely call Element.closest() from a delegated event target.
     * @param {{target: EventTarget|null}|null|undefined} event - Event-like object
     * @param {string} selector - CSS selector for closest lookup
     * @returns {Element|null}
     */
    function closest(event, selector) {
        if (!event) {
            return null;
        }

        const target = event.target;
        if (!(target instanceof Element)) {
            return null;
        }

        return target.closest(selector);
    }

    return {
        closest
    };
})();
