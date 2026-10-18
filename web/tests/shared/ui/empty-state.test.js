import { describe, expect, it } from "vitest";

import { setEmptyStateText } from "../../../src/shared/ui/empty-state.js";

/**
 * @param {string} html - Container markup
 * @returns {HTMLElement}
 */
function container(html) {
    const element = document.createElement("div");
    element.innerHTML = html;
    return element;
}

describe("setEmptyStateText", () => {
    it("writes the title into the heading and the message into the paragraph", () => {
        const empty = container("<h2>Old title</h2><p>Old message</p>");

        setEmptyStateText(empty, "No data yet", "Upload a file.");

        expect(empty.querySelector("h2")?.textContent).toBe("No data yet");
        expect(empty.querySelector("p")?.textContent).toBe("Upload a file.");
    });

    it("fills the paragraph when the heading is missing", () => {
        const empty = container("<p>Old message</p>");

        setEmptyStateText(empty, "No data yet", "Upload a file.");

        expect(empty.querySelector("p")?.textContent).toBe("Upload a file.");
        expect(empty.querySelector("h2")).toBeNull();
    });

    it("fills the heading when the paragraph is missing", () => {
        const empty = container("<h2>Old title</h2>");

        setEmptyStateText(empty, "No data yet", "Upload a file.");

        expect(empty.querySelector("h2")?.textContent).toBe("No data yet");
        expect(empty.querySelector("p")).toBeNull();
    });
});
