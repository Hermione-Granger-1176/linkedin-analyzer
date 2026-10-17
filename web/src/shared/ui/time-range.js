/* Time range controls shared by the screens that filter by range. */

/**
 * Mark the button for a range as pressed and show the range in the compact select.
 * @param {Iterable<Element>} buttons - Time range buttons, each with a data-range value
 * @param {HTMLSelectElement|null} select - Compact range select, when the screen has one
 * @param {string} range - Active range key
 */
export function markActiveRange(buttons, select, range) {
    for (const button of buttons) {
        const isActive = button.getAttribute("data-range") === range;
        button.classList.toggle("active", isActive);
        button.setAttribute("aria-pressed", isActive ? "true" : "false");
    }
    if (select) {
        select.value = range;
    }
}
