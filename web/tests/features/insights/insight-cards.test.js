import { mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";

import InsightCards from "../../../src/features/insights/InsightCards.svelte";

/**
 * Mount the card grid into a fresh host.
 * @returns {{host: HTMLElement, view: {showSkeleton: () => void, showCards: (cards: object[]) => void}, component: object}}
 */
function setup() {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const component = mount(InsightCards, { target: host });
    return { host, view: /** @type {any} */ (component), component };
}

const card = (overrides = {}) => ({
    id: "weekday",
    title: "Weekday warrior",
    body: "Most of your activity lands on weekdays.",
    icon: "calendar",
    accent: "accent-green",
    ...overrides,
});

describe("InsightCards", () => {
    /** @type {object|null} */
    let mounted = null;

    afterEach(() => {
        if (mounted) {
            unmount(mounted);
            mounted = null;
        }
        document.body.innerHTML = "";
    });

    it("renders nothing until the controller asks", () => {
        const { host, component } = setup();
        mounted = component;
        expect(host.querySelectorAll(".insight-card")).toHaveLength(0);
    });

    it("shows three placeholder cards while loading", () => {
        const { host, view, component } = setup();
        mounted = component;
        view.showSkeleton();
        expect(host.querySelectorAll(".skeleton-insight")).toHaveLength(3);
    });

    it("shows at most six cards with their accent, icon, and reaction", () => {
        const { host, view, component } = setup();
        mounted = component;
        view.showCards(Array.from({ length: 8 }, (_, index) => card({ id: `card-${index}` })));
        const cards = host.querySelectorAll(".insight-card");
        expect(cards).toHaveLength(6);
        expect(cards[0].getAttribute("data-accent")).toBe("accent-green");
        expect(cards[0].querySelector(".insight-icon.accent-green svg")).not.toBeNull();
        expect(cards[0].querySelector(".insight-reaction")).not.toBeNull();
        expect(host.querySelector(".skeleton-insight")).toBeNull();
    });

    it("prints worker text as text and falls back for unknown accents and icons", () => {
        const { host, view, component } = setup();
        mounted = component;
        view.showCards([
            card({ title: "<img src=x>", body: "<b>bold</b>", accent: "evil", icon: "nope" }),
        ]);
        const rendered = /** @type {HTMLElement} */ (host.querySelector(".insight-card"));
        expect(rendered.querySelector("h3")?.textContent).toBe("<img src=x>");
        expect(rendered.querySelector("p")?.textContent).toBe("<b>bold</b>");
        expect(rendered.querySelector("img, b")).toBeNull();
        expect(rendered.getAttribute("data-accent")).toBe("accent-blue");
        expect(rendered.querySelector(".insight-icon svg rect")).not.toBeNull();
    });
});
