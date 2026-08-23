/* DOM event target helpers. */

export const DomEvents = (() => {
    "use strict";

    /**
     * Call Element.closest() when a delegated event target is an Element.
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
