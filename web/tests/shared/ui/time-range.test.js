import { describe, expect, it } from "vitest";

import { markActiveRange } from "../../../src/shared/ui/time-range.js";

/**
 * Build range buttons for the given keys.
 * @param {string[]} ranges - Range keys
 * @returns {HTMLButtonElement[]}
 */
function rangeButtons(ranges) {
    return ranges.map((range) => {
        const button = document.createElement("button");
        button.setAttribute("data-range", range);
        return button;
    });
}

describe("markActiveRange", () => {
    it("presses only the matching button and updates the select", () => {
        const buttons = rangeButtons(["1m", "12m"]);
        const select = document.createElement("select");
        select.innerHTML = '<option value="1m"></option><option value="12m"></option>';

        markActiveRange(buttons, select, "12m");

        expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual([
            "false",
            "true",
        ]);
        expect(buttons[1].classList.contains("active")).toBe(true);
        expect(select.value).toBe("12m");
    });

    it("works without a select", () => {
        const buttons = rangeButtons(["1m"]);

        markActiveRange(buttons, null, "1m");

        expect(buttons[0].classList.contains("active")).toBe(true);
    });
});
