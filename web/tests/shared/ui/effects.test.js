import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentryMocks = vi.hoisted(() => ({ setTelemetryEffectsTier: vi.fn() }));
vi.mock("../../../src/platform/observability/sentry.js", () => sentryMocks);

const jankMocks = vi.hoisted(() => ({ watchForJank: vi.fn() }));
vi.mock("../../../src/platform/device/jank.js", () => jankMocks);

function mountToggle() {
    document.body.innerHTML = `
        <div id="progressOverlay" hidden></div>
        <div id="contentLoadingOverlay" hidden></div>
        <section class="screen"></section>
        <button id="effectsToggle" type="button">
            <span class="effects-toggle-label">Auto</span>
        </button>`;
    return document.getElementById("effectsToggle");
}

async function loadEffects() {
    const { Effects } = await import("../../../src/shared/ui/effects.js");
    return Effects;
}

describe("Effects", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        window.localStorage.clear();
        // jsdom has no WebGL, so the probe reads "accelerated WebGL unavailable".
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        document.body.innerHTML = "";
        delete document.documentElement.dataset.effects;
    });

    it("applies the automatic tier to the page, the toggle, and telemetry", async () => {
        const toggle = mountToggle();
        const Effects = await loadEffects();
        Effects.init();
        Effects.init();

        expect(document.documentElement.dataset.effects).toBe("standard");
        expect(sentryMocks.setTelemetryEffectsTier).toHaveBeenCalledWith("standard");
        expect(toggle.dataset.override).toBe("auto");
        expect(toggle.getAttribute("aria-label")).toBe("Visual effects: Auto. Select to change.");
        expect(toggle.title).toBe("Visual effects: Auto");
        expect(jankMocks.watchForJank).toHaveBeenCalledTimes(1);
    });

    it("cycles Auto, Lite, Full, and back to Auto, remembering the choice", async () => {
        const toggle = mountToggle();
        const Effects = await loadEffects();
        Effects.init();

        toggle.click();
        expect(document.documentElement.dataset.effects).toBe("lite");
        expect(toggle.querySelector(".effects-toggle-label").textContent).toBe("Lite");
        expect(window.localStorage.getItem("linkedin-analyzer-effects")).toBe("lite");

        toggle.click();
        expect(toggle.dataset.override).toBe("full");
        // Without accelerated WebGL, Full is the standard tier.
        expect(document.documentElement.dataset.effects).toBe("standard");

        toggle.click();
        expect(toggle.dataset.override).toBe("auto");
        expect(window.localStorage.getItem("linkedin-analyzer-effects")).toBeNull();
    });

    it("drops a tier on jank and only counts long frames while idle", async () => {
        mountToggle();
        const Effects = await loadEffects();
        Effects.init();
        const { isBusy, onJank } = jankMocks.watchForJank.mock.calls[0][0];

        expect(isBusy()).toBe(false);
        document.getElementById("progressOverlay").hidden = false;
        expect(isBusy()).toBe(true);
        document.getElementById("progressOverlay").hidden = true;
        document.getElementById("contentLoadingOverlay").hidden = false;
        expect(isBusy()).toBe(true);
        document.getElementById("contentLoadingOverlay").hidden = true;
        document.querySelector(".screen").classList.add("is-loading");
        expect(isBusy()).toBe(true);

        onJank();
        expect(document.documentElement.dataset.effects).toBe("lite");
    });

    it("works without the toggle, the overlays, or PerformanceObserver", async () => {
        vi.stubGlobal("PerformanceObserver", undefined);
        try {
            const Effects = await loadEffects();
            expect(() => Effects.init()).not.toThrow();
            expect(jankMocks.watchForJank.mock.calls[0][0].Observer).toBeUndefined();
            expect(jankMocks.watchForJank.mock.calls[0][0].isBusy()).toBe(false);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

describe("effects tier and processing", () => {
    beforeEach(() => {
        vi.resetModules();
        window.localStorage.clear();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("leaves the raw processing signals unchanged by the override and Save-Data", async () => {
        const capabilities = await import("../../../src/platform/device/capabilities.js");
        const env = (saveData) => ({
            navigator: /** @type {Navigator} */ (
                /** @type {unknown} */ ({
                    hardwareConcurrency: 8,
                    deviceMemory: 4,
                    connection: { saveData },
                })
            ),
            matchMedia: () => ({ matches: false }),
            createCanvas: () => null,
        });

        const profiles = [
            capabilities.buildDeviceProfile(env(false), "auto"),
            capabilities.buildDeviceProfile(env(false), "lite"),
            capabilities.buildDeviceProfile(env(false), "full"),
            capabilities.buildDeviceProfile(env(true), "auto"),
        ];

        // The tier moves with the override and Save-Data...
        expect(profiles.map((profile) => profile.tier)).toEqual([
            "standard",
            "lite",
            "standard",
            "lite",
        ]);
        // ...but the signals that decide processing concurrency do not.
        for (const profile of profiles) {
            expect(profile.signals.deviceMemory).toBe(4);
            expect(profile.signals.cores).toBe(8);
        }
    });
});
