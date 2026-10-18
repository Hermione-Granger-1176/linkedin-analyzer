import { describe, expect, it, vi } from "vitest";

import { createRangeFilter, markActiveRange } from "../../../src/shared/ui/time-range.js";

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

describe("createRangeFilter", () => {
    /**
     * Build a filter over 1m, 12m, and all, with a select and reset button.
     * @param {{routeName?: string|null, currentRoute?: string|null}} [options] - Route wiring
     */
    function setup({ routeName = "screen", currentRoute = "screen" } = {}) {
        const buttons = rangeButtons(["1m", "12m", "all"]);
        const select = document.createElement("select");
        select.innerHTML =
            '<option value="1m"></option><option value="12m"></option><option value="all"></option><option value="BOGUS"></option>';
        const resetButton = document.createElement("button");
        const onChange = vi.fn();
        const router = {
            getCurrentRoute: vi.fn(() => (currentRoute ? { name: currentRoute } : null)),
            setParams: vi.fn(),
        };
        const filter = createRangeFilter({
            ranges: ["1m", "12m", "all"],
            fallback: "12m",
            buttons,
            select,
            resetButton,
            onChange,
            route: routeName ? { router, name: routeName } : null,
        });
        return { buttons, select, resetButton, onChange, router, filter };
    }

    it("parses case-insensitively and falls back for unknown values", () => {
        const { filter } = setup();
        expect(filter.parse("ALL")).toBe("all");
        expect(filter.parse("bogus")).toBe("12m");
        expect(filter.parse(undefined)).toBe("12m");
        expect(filter.parse("bogus", "")).toBe("");
    });

    it("applies a clicked range, marks it, and writes it into the route", () => {
        const { buttons, onChange, router } = setup();
        buttons[0].click();
        expect(onChange).toHaveBeenCalledWith("1m");
        expect(buttons[0].getAttribute("aria-pressed")).toBe("true");
        expect(router.setParams).toHaveBeenCalledWith({ range: "1m" }, { replaceHistory: false });
    });

    it("ignores a button with no range", () => {
        const { buttons, onChange } = setup();
        buttons[0].removeAttribute("data-range");
        buttons[0].click();
        expect(onChange).not.toHaveBeenCalled();
    });

    it("applies a known select value and ignores an unknown one", () => {
        const { select, onChange } = setup();
        select.value = "BOGUS";
        select.dispatchEvent(new Event("change"));
        expect(onChange).not.toHaveBeenCalled();
        select.value = "all";
        select.dispatchEvent(new Event("change"));
        expect(onChange).toHaveBeenCalledWith("all");
    });

    it("resets to the fallback", () => {
        const { resetButton, onChange } = setup();
        resetButton.click();
        expect(onChange).toHaveBeenCalledWith("12m");
    });

    it("leaves the route alone on another route, with no route, or without route wiring", () => {
        const other = setup({ currentRoute: "elsewhere" });
        other.buttons[0].click();
        expect(other.router.setParams).not.toHaveBeenCalled();

        const none = setup({ currentRoute: null });
        none.buttons[0].click();
        expect(none.router.setParams).not.toHaveBeenCalled();

        const unrouted = setup({ routeName: null });
        unrouted.buttons[0].click();
        expect(unrouted.onChange).toHaveBeenCalledWith("1m");
        expect(unrouted.router.getCurrentRoute).not.toHaveBeenCalled();
    });

    it("shows a range without applying it, and works without a select or reset button", () => {
        const buttons = rangeButtons(["1m"]);
        const onChange = vi.fn();
        const filter = createRangeFilter({
            ranges: ["1m"],
            fallback: "1m",
            buttons,
            select: null,
            resetButton: null,
            onChange,
        });
        filter.show("1m");
        expect(buttons[0].classList.contains("active")).toBe(true);
        expect(onChange).not.toHaveBeenCalled();
    });
});
