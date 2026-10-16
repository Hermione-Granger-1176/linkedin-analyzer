import { beforeEach, describe, expect, it, vi } from "vitest";

import { ScreenManager } from "../../src/app/screen-manager.js";
import { captureError } from "../../src/platform/observability/sentry.js";
import { LoadingOverlay } from "../../src/shared/ui/loading-overlay.js";

vi.mock("../../src/platform/observability/sentry.js", () => ({ captureError: vi.fn() }));

/**
 * A loader that resolves only when the test says so.
 * @returns {{load: import("vitest").Mock, resolve: (value: unknown) => void, reject: (error: Error) => void}}
 */
function deferredLoader() {
    let resolve;
    let reject;
    const load = vi.fn(
        () =>
            new Promise((res, rej) => {
                resolve = res;
                reject = rej;
            })
    );
    return { load, resolve: (value) => resolve(value), reject: (error) => reject(error) };
}

describe("ScreenManager", () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <nav>
                <a class="top-link" data-route="home"></a>
                <a class="top-link" data-route="about"></a>
            </nav>
            <div id="routeAnnouncer"></div>
            <section id="screen-home" class="screen" tabindex="-1"><h1 tabindex="-1">Home</h1></section>
            <section id="screen-about" class="screen" tabindex="-1"><h1 tabindex="-1">About</h1></section>
        `;
        vi.spyOn(LoadingOverlay, "syncActiveScreen").mockImplementation(() => {});
    });

    it("activates screens and updates nav state", () => {
        const controller = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        ScreenManager.register("home", { screenId: "screen-home", controller });
        ScreenManager.register("about", { screenId: "screen-about", controller });

        ScreenManager.activate("home", { alpha: "1" });
        expect(document.getElementById("screen-home").classList.contains("active")).toBe(true);
        expect(controller.init).toHaveBeenCalled();

        ScreenManager.activate("about", { beta: "2" });
        expect(document.getElementById("screen-about").classList.contains("active")).toBe(true);
        expect(document.querySelector('.top-link[data-route="about"]').getAttribute("aria-current")).toBe("page");
    });

    it("returns current route name", () => {
        const controller = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        ScreenManager.register("home", { screenId: "screen-home", controller });
        ScreenManager.activate("home", {});
        expect(ScreenManager.getCurrentRouteName()).toBe("home");
    });

    it("calls onRouteLeave on the previous controller when switching routes", () => {
        const homeController = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        const aboutController = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        ScreenManager.register("home", { screenId: "screen-home", controller: homeController });
        ScreenManager.register("about", { screenId: "screen-about", controller: aboutController });

        ScreenManager.activate("home", {});
        expect(homeController.onRouteLeave).not.toHaveBeenCalled();

        ScreenManager.activate("about", {});
        expect(homeController.onRouteLeave).toHaveBeenCalledWith({ from: "home", to: "about" });
    });

    it("does not call onRouteLeave when activating same route twice", () => {
        const controller = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        ScreenManager.register("home", { screenId: "screen-home", controller });

        ScreenManager.activate("home", {});
        ScreenManager.activate("home", { x: "1" });
        expect(controller.onRouteLeave).not.toHaveBeenCalled();
    });

    it("does not call init twice for same route", () => {
        const controller = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        ScreenManager.register("home", { screenId: "screen-home", controller });

        ScreenManager.activate("home", {});
        ScreenManager.activate("home", { x: "1" });
        expect(controller.init).toHaveBeenCalledTimes(1);
    });

    it("gracefully handles route with missing DOM element (screenId not found)", () => {
        const controller = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        ScreenManager.register("ghost", { screenId: "screen-ghost-does-not-exist", controller });

        // Should not throw even when screen element is absent
        expect(() => ScreenManager.activate("ghost", {})).not.toThrow();
        expect(controller.onRouteChange).toHaveBeenCalled();
    });

    it("ignores activate call for unregistered route", () => {
        expect(() => ScreenManager.activate("nonexistent", {})).not.toThrow();
    });

    it("ignores register call with missing screenId", () => {
        expect(() => ScreenManager.register("bad", {})).not.toThrow();
        expect(() => ScreenManager.register("bad", { controller: {} })).not.toThrow();
    });

    it("ignores register call with falsy routeName", () => {
        expect(() => ScreenManager.register("", { screenId: "screen-home" })).not.toThrow();
        expect(() => ScreenManager.register(null, { screenId: "screen-home" })).not.toThrow();
    });

    it("nav link without data-route attribute is not modified", () => {
        document.body.innerHTML += '<a class="top-link"></a>';
        const controller = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        ScreenManager.register("home", { screenId: "screen-home", controller });

        expect(() => ScreenManager.activate("home", {})).not.toThrow();
    });

    it("calls LoadingOverlay.syncActiveScreen on activate", () => {
        const controller = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        ScreenManager.register("home", { screenId: "screen-home", controller });
        ScreenManager.activate("home", {});
        expect(LoadingOverlay.syncActiveScreen).toHaveBeenCalled();
    });

    it("announces route name in routeAnnouncer element", () => {
        const controller = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        ScreenManager.register("analytics", { screenId: "screen-home", controller });
        ScreenManager.activate("analytics", {});
        expect(document.getElementById("routeAnnouncer").textContent).toContain("Analytics");
    });

    it("announces custom route name when not in labels map", () => {
        const controller = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        ScreenManager.register("myspecialroute", { screenId: "screen-home", controller });
        ScreenManager.activate("myspecialroute", {});
        expect(document.getElementById("routeAnnouncer").textContent).toContain("myspecialroute");
    });

    it("handles activate when controller has no onRouteLeave method", () => {
        const homeController = { init: vi.fn(), onRouteChange: vi.fn() };
        const aboutController = { init: vi.fn(), onRouteChange: vi.fn() };
        ScreenManager.register("home", { screenId: "screen-home", controller: homeController });
        ScreenManager.register("about", { screenId: "screen-about", controller: aboutController });

        ScreenManager.activate("home", {});
        expect(() => ScreenManager.activate("about", {})).not.toThrow();
    });

    it("handles activate when route has no controller", () => {
        ScreenManager.register("home", { screenId: "screen-home" });
        expect(() => ScreenManager.activate("home", {})).not.toThrow();
    });

    it("removes aria-current from previously active nav links", () => {
        const controller = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        ScreenManager.register("home", { screenId: "screen-home", controller });
        ScreenManager.register("about", { screenId: "screen-about", controller });

        ScreenManager.activate("home", {});
        expect(document.querySelector('.top-link[data-route="home"]').getAttribute("aria-current")).toBe("page");

        ScreenManager.activate("about", {});
        expect(document.querySelector('.top-link[data-route="home"]').getAttribute("aria-current")).toBeNull();
    });

    it("hides the previous screen immediately when switching routes", () => {
        const controller = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        ScreenManager.register("home", { screenId: "screen-home", controller });
        ScreenManager.register("about", { screenId: "screen-about", controller });

        ScreenManager.activate("home", {});
        ScreenManager.activate("about", {});

        const prevScreen = document.getElementById("screen-home");
        expect(prevScreen.classList.contains("active")).toBe(false);
        expect(prevScreen.classList.contains("enter")).toBe(false);
        expect(prevScreen.classList.contains("exit")).toBe(false);
        expect(prevScreen.classList.contains("is-loading")).toBe(false);
    });

    it("never leaves a stranded screen visible across rapid switches", () => {
        document.body.insertAdjacentHTML("beforeend",
            `<section id="screen-analytics" class="screen" tabindex="-1"><h1 tabindex="-1">Analytics</h1></section>
             <section id="screen-connections" class="screen" tabindex="-1"><h1 tabindex="-1">Connections</h1></section>`);

        const controller = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        ScreenManager.register("home", { screenId: "screen-home", controller });
        ScreenManager.register("analytics", { screenId: "screen-analytics", controller });
        ScreenManager.register("connections", { screenId: "screen-connections", controller });

        ScreenManager.activate("home", {});
        ScreenManager.activate("analytics", {});
        ScreenManager.activate("connections", {});

        for (const id of ["screen-home", "screen-analytics"]) {
            const screen = document.getElementById(id);
            expect(screen.classList.contains("active")).toBe(false);
            expect(screen.classList.contains("enter")).toBe(false);
            expect(screen.classList.contains("exit")).toBe(false);
            expect(screen.classList.contains("is-loading")).toBe(false);
        }
        expect(document.getElementById("screen-connections").classList.contains("active")).toBe(true);
    });

    it("preserves the is-loading class on the incoming screen", () => {
        const controller = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        ScreenManager.register("home", { screenId: "screen-home", controller });
        ScreenManager.register("about", { screenId: "screen-about", controller });

        ScreenManager.activate("home", {});

        const nextScreen = document.getElementById("screen-about");
        nextScreen.classList.add("is-loading");
        ScreenManager.activate("about", {});

        expect(nextScreen.classList.contains("active")).toBe(true);
        expect(nextScreen.classList.contains("is-loading")).toBe(true);
    });

    it("enter class is added and then removed on next screen after transition", () => {
        vi.useFakeTimers();
        window.requestAnimationFrame = (cb) => { cb(0); return 0; };

        const controller = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        ScreenManager.register("home", { screenId: "screen-home", controller });
        ScreenManager.register("about", { screenId: "screen-about", controller });

        ScreenManager.activate("home", {});
        ScreenManager.activate("about", {});

        const nextScreen = document.getElementById("screen-about");
        expect(nextScreen.classList.contains("enter")).toBe(true);

        vi.advanceTimersByTime(400);

        expect(nextScreen.classList.contains("enter")).toBe(false);

        vi.useRealTimers();
    });

    it("focuses h1 in next screen after transition delay", () => {
        vi.useFakeTimers();
        window.requestAnimationFrame = (cb) => { cb(0); return 0; };

        const controller = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        ScreenManager.register("home", { screenId: "screen-home", controller });
        ScreenManager.register("about", { screenId: "screen-about", controller });

        ScreenManager.activate("home", {});
        ScreenManager.activate("about", {});

        const aboutH1 = document.querySelector("#screen-about h1");
        vi.advanceTimersByTime(400);

        expect(document.activeElement).toBe(aboutH1);
        vi.useRealTimers();
    });

    it("adds tabindex to heading without one before focusing", () => {
        vi.useFakeTimers();
        window.requestAnimationFrame = (cb) => { cb(0); return 0; };

        document.getElementById("screen-about").querySelector("h1").removeAttribute("tabindex");

        const controller = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        ScreenManager.register("home", { screenId: "screen-home", controller });
        ScreenManager.register("about", { screenId: "screen-about", controller });

        ScreenManager.activate("home", {});
        ScreenManager.activate("about", {});

        vi.advanceTimersByTime(400);

        const aboutH1 = document.querySelector("#screen-about h1");
        expect(aboutH1.getAttribute("tabindex")).toBe("-1");
        expect(document.activeElement).toBe(aboutH1);
        vi.useRealTimers();
    });

    it("does not announce route when routeAnnouncer element is absent", () => {
        window.requestAnimationFrame = (cb) => { cb(0); return 0; };
        document.getElementById("routeAnnouncer").remove();
        const controller = { init: vi.fn(), onRouteChange: vi.fn(), onRouteLeave: vi.fn() };
        ScreenManager.register("home", { screenId: "screen-home", controller });
        expect(() => ScreenManager.activate("home", {})).not.toThrow();
    });

    describe("lazy routes", () => {
        beforeEach(() => {
            vi.spyOn(LoadingOverlay, "show").mockImplementation(() => {});
            vi.spyOn(LoadingOverlay, "hide").mockImplementation(() => {});
            vi.mocked(captureError).mockClear();
        });

        it("shows the screen at once and initializes the controller once it loads", async () => {
            const controller = { init: vi.fn(), onRouteChange: vi.fn() };
            const loader = deferredLoader();
            ScreenManager.register("lazy-a", { screenId: "screen-about", load: loader.load });

            ScreenManager.activate("lazy-a", { range: "3m" });
            expect(document.getElementById("screen-about").classList.contains("active")).toBe(true);
            expect(ScreenManager.getCurrentRouteName()).toBe("lazy-a");
            expect(LoadingOverlay.show).toHaveBeenCalledWith("route:lazy-a", expect.any(Object));
            // A route change while the code loads is the one the controller sees.
            ScreenManager.activate("lazy-a", { range: "6m" });
            expect(loader.load).toHaveBeenCalledTimes(1);

            loader.resolve(controller);
            await vi.waitFor(() => expect(controller.init).toHaveBeenCalledTimes(1));
            expect(LoadingOverlay.hide).toHaveBeenCalledWith("route:lazy-a");
            expect(controller.onRouteChange).toHaveBeenLastCalledWith(
                { range: "6m" },
                { from: "lazy-a", to: "lazy-a" }
            );

            // Later visits run synchronously on the loaded controller.
            ScreenManager.activate("home", {});
            ScreenManager.activate("lazy-a", {});
            expect(controller.init).toHaveBeenCalledTimes(1);
            expect(loader.load).toHaveBeenCalledTimes(1);
        });

        it("leaves a controller uninitialized when the user moves on before it loads", async () => {
            const controller = { init: vi.fn(), onRouteChange: vi.fn() };
            const loader = deferredLoader();
            ScreenManager.register("lazy-b", { screenId: "screen-about", load: loader.load });

            ScreenManager.activate("lazy-b", {});
            ScreenManager.activate("home", {});
            loader.resolve(controller);
            await vi.waitFor(() => expect(LoadingOverlay.hide).toHaveBeenCalledWith("route:lazy-b"));
            expect(controller.init).not.toHaveBeenCalled();

            ScreenManager.activate("lazy-b", { x: "1" });
            expect(controller.init).toHaveBeenCalledTimes(1);
            expect(controller.onRouteChange).toHaveBeenCalledWith({ x: "1" }, { from: "home", to: "lazy-b" });
        });

        it("reports a failed load and tries again on the next visit", async () => {
            const controller = { init: vi.fn() };
            const loader = deferredLoader();
            ScreenManager.register("lazy-c", { screenId: "screen-about", load: loader.load });

            ScreenManager.activate("lazy-c", {});
            loader.reject(new Error("chunk missing"));
            await vi.waitFor(() => expect(captureError).toHaveBeenCalledTimes(1));
            expect(captureError).toHaveBeenCalledWith(new Error("Screen code could not be loaded."), {
                module: "screen-manager",
                operation: "route-load",
                route: "lazy-c"
            });
            expect(LoadingOverlay.hide).toHaveBeenCalledWith("route:lazy-c");

            ScreenManager.activate("lazy-c", {});
            expect(loader.load).toHaveBeenCalledTimes(2);
            loader.resolve(controller);
            await vi.waitFor(() => expect(controller.init).toHaveBeenCalledTimes(1));
        });

        it("treats a loader that yields nothing as a route without a controller", async () => {
            ScreenManager.register("lazy-d", { screenId: "screen-about", load: () => Promise.resolve(undefined) });
            await expect(ScreenManager.loadController("lazy-d")).resolves.toBeNull();
            expect(() => ScreenManager.activate("lazy-d", {})).not.toThrow();
        });

        it("preloads a controller without initializing it", async () => {
            const controller = { init: vi.fn() };
            ScreenManager.register("lazy-e", { screenId: "screen-about", load: () => Promise.resolve(controller) });
            await expect(ScreenManager.loadController("lazy-e")).resolves.toBe(controller);
            expect(controller.init).not.toHaveBeenCalled();
            await expect(ScreenManager.loadController("missing")).resolves.toBeNull();
            ScreenManager.register("eager", { screenId: "screen-home", controller });
            await expect(ScreenManager.loadController("eager")).resolves.toBe(controller);
        });
    });
});
