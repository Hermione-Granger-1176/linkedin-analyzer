/* Shared chart tooltip positioning helpers */

/**
 * Position and show a chart tooltip near the pointer.
 * @param {HTMLElement|null} tooltipEl - Tooltip element
 * @param {number} clientX - Pointer X coordinate
 * @param {number} clientY - Pointer Y coordinate
 * @param {string} text - Tooltip text content
 */
export function showChartTooltip(tooltipEl, clientX, clientY, text) {
    if (!tooltipEl) {
        return;
    }

    tooltipEl.textContent = text;
    tooltipEl.hidden = false;

    const tooltipRect = tooltipEl.getBoundingClientRect();
    let left = clientX + 12;
    let top = clientY + 12;

    if (left + tooltipRect.width > window.innerWidth) {
        left = clientX - tooltipRect.width - 12;
    }
    if (top + tooltipRect.height > window.innerHeight) {
        top = clientY - tooltipRect.height - 12;
    }

    tooltipEl.style.left = `${left}px`;
    tooltipEl.style.top = `${top}px`;
}

/**
 * Hide a chart tooltip.
 * @param {HTMLElement|null} tooltipEl - Tooltip element
 */
export function hideChartTooltip(tooltipEl) {
    if (!tooltipEl) {
        return;
    }
    tooltipEl.hidden = true;
}
