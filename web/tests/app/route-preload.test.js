import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getDeviceProfile: vi.fn(),
    loadController: vi.fn(),
}));

vi.mock("../../src/platform/device/capabilities.js", () => ({
    getDeviceProfile: mocks.getDeviceProfile,
}));

vi.mock("../../src/app/screen-manager.js", () => ({
    ScreenManager: { loadController: mocks.loadController },
}));

/**
 * Load a fresh copy, so each test starts with nothing requested.
 * @returns {Promise<typeof import("../../src/app/route-preload.js")>}
 */
function loadModule() {
    vi.resetModules();
    return import("../../src/app/route-preload.js");
}

describe("preloadRouteWhenIdle", () => {
    beforeEach(() => {
        mocks.getDeviceProfile.mockReturnValue({ tier: "full", signals: { saveData: false } });
        mocks.loadController.mockReset();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it("loads the route when the browser is idle, once", async () => {
        const idle = vi.fn();
        vi.stubGlobal("requestIdleCallback", idle);
        const { preloadRouteWhenIdle } = await loadModule();
        preloadRouteWhenIdle("analytics");
        preloadRouteWhenIdle("analytics");
        expect(idle).toHaveBeenCalledTimes(1);
        expect(idle).toHaveBeenCalledWith(expect.any(Function), { timeout: 5000 });
        idle.mock.calls[0][0]();
        expect(mocks.loadController).toHaveBeenCalledWith("analytics");
    });

    it("falls back to a timer without requestIdleCallback", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("requestIdleCallback", undefined);
        const { preloadRouteWhenIdle } = await loadModule();
        preloadRouteWhenIdle("analytics");
        expect(mocks.loadController).not.toHaveBeenCalled();
        vi.advanceTimersByTime(2000);
        expect(mocks.loadController).toHaveBeenCalledWith("analytics");
    });

    it("skips the preload on the lite tier with Save-Data on", async () => {
        const idle = vi.fn();
        vi.stubGlobal("requestIdleCallback", idle);
        mocks.getDeviceProfile.mockReturnValue({ tier: "lite", signals: { saveData: true } });
        const { preloadRouteWhenIdle } = await loadModule();
        preloadRouteWhenIdle("analytics");
        expect(idle).not.toHaveBeenCalled();

        // Lite without Save-Data still preloads.
        mocks.getDeviceProfile.mockReturnValue({ tier: "lite", signals: { saveData: false } });
        preloadRouteWhenIdle("analytics");
        expect(idle).toHaveBeenCalledTimes(1);
    });
});
