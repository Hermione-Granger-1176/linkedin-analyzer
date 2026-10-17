import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentryMocks = vi.hoisted(() => ({ setTelemetryEffectsTier: vi.fn() }));
vi.mock("../../../src/platform/observability/sentry.js", () => sentryMocks);

const jankMocks = vi.hoisted(() => ({ watchForJank: vi.fn() }));
vi.mock("../../../src/platform/device/jank.js", () => jankMocks);

function mountOverlays() {
    document.body.innerHTML = `
        <div id="progressOverlay" hidden></div>
        <div id="contentLoadingOverlay" hidden></div>
        <section class="screen"></section>`;
}

async function loadEffects() {
    const { Effects } = await import("../../../src/shared/ui/effects.js");
    return Effects;
}

describe("Effects", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        // jsdom has no WebGL, so the probe reads "accelerated WebGL unavailable".
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        document.body.innerHTML = "";
        delete document.documentElement.dataset.effects;
    });

    it("applies the device's tier to the page and telemetry", async () => {
        mountOverlays();
        const Effects = await loadEffects();
        Effects.init();
        Effects.init();

        expect(document.documentElement.dataset.effects).toBe("standard");
        expect(sentryMocks.setTelemetryEffectsTier).toHaveBeenCalledWith("standard");
        expect(jankMocks.watchForJank).toHaveBeenCalledTimes(1);
    });

    it("drops a tier on jank and only counts long frames while idle", async () => {
        mountOverlays();
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

    it("forgets the retired override and survives blocked storage", async () => {
        window.localStorage.setItem("linkedin-analyzer-effects", "lite");
        const Effects = await loadEffects();
        Effects.init();
        expect(window.localStorage.getItem("linkedin-analyzer-effects")).toBeNull();

        vi.resetModules();
        vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        const Blocked = await loadEffects();
        expect(() => Blocked.init()).not.toThrow();
    });

    it("works without the overlays or PerformanceObserver", async () => {
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
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("leaves the raw processing signals unchanged by Save-Data", async () => {
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
            capabilities.buildDeviceProfile(env(false)),
            capabilities.buildDeviceProfile(env(true)),
        ];

        // The tier moves with Save-Data...
        expect(profiles.map((profile) => profile.tier)).toEqual(["standard", "lite"]);
        // ...but the signals that decide processing concurrency do not.
        for (const profile of profiles) {
            expect(profile.signals.deviceMemory).toBe(4);
            expect(profile.signals.cores).toBe(8);
        }
    });
});
