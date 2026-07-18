import { beforeEach, describe, expect, it } from "vitest";

import { NavMenu } from "../src/nav-menu.js";

/** Render one toggle + nav pair wired by aria-controls. */
function renderMenu() {
    document.body.innerHTML = `
        <button
            class="nav-toggle"
            type="button"
            aria-expanded="false"
            aria-controls="topNav-home"
            aria-label="Open navigation menu"
        >
            <span aria-hidden="true">menu</span>
        </button>
        <nav class="top-nav" id="topNav-home" aria-label="Primary">
            <a class="top-link" data-route="home" href="#home">Home</a>
            <a class="top-link" data-route="analytics" href="#analytics">Analytics</a>
        </nav>
        <p id="outside">Outside content</p>
    `;
    return {
        toggle: /** @type {HTMLElement} */ (document.querySelector(".nav-toggle")),
        nav: /** @type {HTMLElement} */ (document.getElementById("topNav-home")),
    };
}

/** Render two independent toggle + nav pairs wired by aria-controls. */
function renderTwoMenus() {
    document.body.innerHTML = `
        <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="topNav-a"></button>
        <nav class="top-nav" id="topNav-a" aria-label="Primary A">
            <a class="top-link" data-route="home" href="#home">Home</a>
        </nav>
        <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="topNav-b"></button>
        <nav class="top-nav" id="topNav-b" aria-label="Primary B">
            <a class="top-link" data-route="analytics" href="#analytics">Analytics</a>
        </nav>
        <p id="outside">Outside content</p>
    `;
    const toggles = document.querySelectorAll(".nav-toggle");
    return {
        toggleA: /** @type {HTMLElement} */ (toggles[0]),
        navA: /** @type {HTMLElement} */ (document.getElementById("topNav-a")),
        toggleB: /** @type {HTMLElement} */ (toggles[1]),
        navB: /** @type {HTMLElement} */ (document.getElementById("topNav-b")),
    };
}

describe("NavMenu", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
    });

    it("opens the menu on toggle click and reflects the open state", () => {
        const { toggle, nav } = renderMenu();
        NavMenu.init();

        toggle.click();

        expect(nav.classList.contains("is-open")).toBe(true);
        expect(toggle.getAttribute("aria-expanded")).toBe("true");
        expect(toggle.getAttribute("aria-label")).toBe("Close navigation menu");
    });

    it("keeps a single click handler per toggle across repeated init calls", () => {
        const { toggle, nav } = renderMenu();
        NavMenu.init();
        NavMenu.init();

        toggle.click();

        expect(nav.classList.contains("is-open")).toBe(true);
        expect(toggle.getAttribute("aria-expanded")).toBe("true");
    });

    it("closes the menu on a second toggle click", () => {
        const { toggle, nav } = renderMenu();
        NavMenu.init();

        toggle.click();
        toggle.click();

        expect(nav.classList.contains("is-open")).toBe(false);
        expect(toggle.getAttribute("aria-expanded")).toBe("false");
        expect(toggle.getAttribute("aria-label")).toBe("Open navigation menu");
    });

    it("closes when a route link inside the nav is clicked", () => {
        const { toggle, nav } = renderMenu();
        NavMenu.init();

        toggle.click();
        expect(nav.classList.contains("is-open")).toBe(true);

        nav.querySelector('a[data-route="analytics"]').click();

        expect(nav.classList.contains("is-open")).toBe(false);
        expect(toggle.getAttribute("aria-expanded")).toBe("false");
    });

    it("stays open when a non-link element inside the nav is clicked", () => {
        const { toggle, nav } = renderMenu();
        nav.insertAdjacentHTML("beforeend", '<span id="nav-filler">not a link</span>');
        NavMenu.init();

        toggle.click();
        document.getElementById("nav-filler").click();

        expect(nav.classList.contains("is-open")).toBe(true);
    });

    it("closes on Escape and restores focus to the toggle", () => {
        const { toggle, nav } = renderMenu();
        NavMenu.init();

        toggle.click();
        nav.querySelector('a[data-route="home"]').focus();

        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

        expect(nav.classList.contains("is-open")).toBe(false);
        expect(document.activeElement).toBe(toggle);
    });

    it("ignores Escape when the menu is already closed", () => {
        const { toggle, nav } = renderMenu();
        NavMenu.init();

        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

        expect(nav.classList.contains("is-open")).toBe(false);
        expect(toggle.getAttribute("aria-expanded")).toBe("false");
    });

    it("ignores non-Escape keydowns", () => {
        const { toggle, nav } = renderMenu();
        NavMenu.init();

        toggle.click();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

        expect(nav.classList.contains("is-open")).toBe(true);
    });

    it("closes when a click lands outside the nav and toggle", () => {
        const { toggle, nav } = renderMenu();
        NavMenu.init();

        toggle.click();
        document.getElementById("outside").click();

        expect(nav.classList.contains("is-open")).toBe(false);
        expect(toggle.getAttribute("aria-expanded")).toBe("false");
    });

    it("stays open for an outside click while already closed", () => {
        const { toggle, nav } = renderMenu();
        NavMenu.init();

        // Menu starts closed; an outside click must be a no-op.
        document.getElementById("outside").click();

        expect(nav.classList.contains("is-open")).toBe(false);
        expect(toggle.getAttribute("aria-expanded")).toBe("false");
    });

    it("keeps the menu open when the click originates inside the nav", () => {
        const { toggle, nav } = renderMenu();
        nav.insertAdjacentHTML("beforeend", '<span id="nav-inner">inside</span>');
        NavMenu.init();

        toggle.click();
        document.getElementById("nav-inner").click();

        expect(nav.classList.contains("is-open")).toBe(true);
    });

    it("skips toggles whose aria-controls target is missing", () => {
        document.body.innerHTML = `
            <button class="nav-toggle" aria-controls="does-not-exist" aria-expanded="false"></button>
        `;
        const toggle = /** @type {HTMLElement} */ (document.querySelector(".nav-toggle"));

        expect(() => NavMenu.init()).not.toThrow();

        toggle.click();
        expect(toggle.getAttribute("aria-expanded")).toBe("false");
    });

    it("skips toggles that have no aria-controls attribute", () => {
        document.body.innerHTML = '<button class="nav-toggle" aria-expanded="false"></button>';
        expect(() => NavMenu.init()).not.toThrow();
    });

    it("does nothing when there are no toggles", () => {
        document.body.innerHTML = '<nav class="top-nav"></nav>';
        expect(() => NavMenu.init()).not.toThrow();
    });

    it("closes only the open nav on Escape when two menus are wired", () => {
        const { toggleA, navA, toggleB, navB } = renderTwoMenus();
        NavMenu.init();

        toggleA.click();
        expect(navA.classList.contains("is-open")).toBe(true);
        expect(navB.classList.contains("is-open")).toBe(false);

        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

        expect(navA.classList.contains("is-open")).toBe(false);
        expect(document.activeElement).toBe(toggleA);
        expect(navB.classList.contains("is-open")).toBe(false);
        expect(toggleB.getAttribute("aria-expanded")).toBe("false");
    });

    it("closes only the open nav on an outside click when two menus are wired", () => {
        const { toggleA, navA, toggleB, navB } = renderTwoMenus();
        NavMenu.init();

        toggleB.click();
        expect(navB.classList.contains("is-open")).toBe(true);
        expect(navA.classList.contains("is-open")).toBe(false);

        document.getElementById("outside").click();

        expect(navB.classList.contains("is-open")).toBe(false);
        expect(toggleB.getAttribute("aria-expanded")).toBe("false");
        expect(navA.classList.contains("is-open")).toBe(false);
        expect(toggleA.getAttribute("aria-expanded")).toBe("false");
    });
});
