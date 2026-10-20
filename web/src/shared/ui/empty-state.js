/* Text for a page's empty state */

/**
 * Write the title and message into an empty-state container.
 *
 * The static shell provides the heading and the paragraph; a container that
 * lacks either keeps whatever it has.
 * @param {Element} container - Empty-state container
 * @param {string} title - Heading text
 * @param {string} message - Explanation text
 */
export function setEmptyStateText(container, title, message) {
    const heading = container.querySelector("h2");
    const text = container.querySelector("p");
    if (heading) {
        heading.textContent = title;
    }
    if (text) {
        text.textContent = message;
    }
}
