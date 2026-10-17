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

    it("records busy spans for late long frames", async () => {
        mountOverlays();
        document.getElementById("progressOverlay").hidden = false;
        const Effects = await loadEffects();
        Effects.init();
        const { isBusy, busySpans } = jankMocks.watchForJank.mock.calls[0][0];
        const progress = document.getElementById("progressOverlay");
        const screen = document.querySelector(".screen");

        // Busy at start opens a span that closes when the work ends.
        expect(busySpans()).toHaveLength(1);
        expect(busySpans()[0].end).toBe(Infinity);
        progress.hidden = true;
        await Promise.resolve();
        expect(busySpans()[0].end).toBeLessThan(Infinity);

        // Busy again opens one span, however many changes keep it busy.
        progress.hidden = false;
        await Promise.resolve();
        screen.classList.add("is-loading");
        await Promise.resolve();
        expect(busySpans()).toHaveLength(2);
        progress.hidden = true;
        screen.classList.remove("is-loading");
        await Promise.resolve();

        // A busy flash within one task leaves a zero-length span.
        for (let index = 0; index < 20; index += 1) {
            progress.hidden = false;
            progress.hidden = true;
            await Promise.resolve();
        }
        expect(busySpans()).toHaveLength(16);
        const last = busySpans()[busySpans().length - 1];
        expect(last.end).toBe(last.start);

        expect(isBusy()).toBe(false);
    });

    it("works without the overlays or the observers", async () => {
        vi.stubGlobal("PerformanceObserver", undefined);
        vi.stubGlobal("MutationObserver", undefined);
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
