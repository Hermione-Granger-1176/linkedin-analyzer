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

/**
 * Router methods for reading the active route and updating its parameters.
 * The caller supplies them so this module does not import the app router.
 * @typedef {object} RangeRouter
 * @property {() => {name: string}|null} getCurrentRoute - The active route
 * @property {(params: Record<string, string>, options: {replaceHistory: boolean}) => void} setParams - Replace the active route's params
 */

/**
 * @typedef {object} RangeFilterOptions
 * @property {Iterable<string>} ranges - Supported range keys
 * @property {string} fallback - Range for an unknown value, and the reset target
 * @property {Iterable<Element>} buttons - Time range buttons, each with a data-range value
 * @property {HTMLSelectElement|null} select - Compact range select, when the screen has one
 * @property {Element|null} resetButton - Reset filters button, when the screen has one
 * @property {(range: string) => void} onChange - Apply a range the visitor chose
 * @property {{router: RangeRouter, name: string}|null} [route] - Route to write the range into; omit when the screen syncs its own params
 */

/**
 * @typedef {object} RangeFilter
 * @property {(value: unknown, fallback?: string) => string} parse - Normalize a raw value to a range key, or the fallback
 * @property {(range: string) => void} show - Mark a range active without applying it
 * @property {(value: unknown) => void} set - Apply a range as if the visitor chose it; an unknown value applies the fallback
 */

/**
 * Wire a screen's range buttons, compact select, and reset button.
 *
 * When applying route state, call `parse` and `show` to avoid writing the route
 * back.
 * @param {RangeFilterOptions} options - Controls, ranges, and what a choice does
 * @returns {RangeFilter}
 */
export function createRangeFilter(options) {
    const { buttons, select, resetButton, fallback, onChange } = options;
    const ranges = new Set(options.ranges);
    const route = options.route || null;

    /** @type {RangeFilter["parse"]} */
    const parse = (value, otherwise = fallback) => {
        const range = String(value || "").toLowerCase();
        return ranges.has(range) ? range : otherwise;
    };

    /** @type {RangeFilter["show"]} */
    const show = (range) => markActiveRange(buttons, select, range);

    /** @type {RangeFilter["set"]} */
    const set = (value) => {
        const range = parse(value);
        show(range);
        onChange(range);
        if (!route) {
            return;
        }
        const current = route.router.getCurrentRoute();
        if (current && current.name === route.name) {
            route.router.setParams({ range }, { replaceHistory: false });
        }
    };

    for (const button of buttons) {
        button.addEventListener("click", () => {
            // A button without a range is not a range control; ignore it
            // rather than resetting the screen to the fallback.
            const range = button.getAttribute("data-range");
            if (range) {
                set(range);
            }
        });
        button.setAttribute("aria-pressed", button.classList.contains("active") ? "true" : "false");
    }
    if (select) {
        select.addEventListener("change", () => {
            // An unknown option is ignored rather than reset, so a stray value
            // never moves the screen.
            const range = parse(select.value, "");
            if (range) {
                set(range);
            }
        });
    }
    if (resetButton) {
        resetButton.addEventListener("click", () => set(fallback));
    }

    return { parse, show, set };
}
