import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    EFFECTS_OVERRIDES,
    EFFECTS_TIERS,
    buildDeviceProfile,
    downgradeTier,
    pickTier,
    probeAcceleratedWebgl,
    readEffectsOverride,
    readSignals,
    resolveTier,
    writeEffectsOverride,
} from "../../../src/platform/device/capabilities.js";

const UNKNOWN = Object.freeze({
    cores: null,
    deviceMemory: null,
    saveData: false,
    coarsePointer: false,
    acceleratedWebgl: null,
});

/** A canvas whose getContext answers per context type. */
function fakeCanvas(contexts) {
    const calls = [];
    return {
        calls,
        getContext(type, options) {
            calls.push({ type, options });
            return contexts[type] || null;
        },
    };
}

function fakeContext() {
    const loseContext = vi.fn();
    return {
        loseContext,
        getExtension: (name) => (name === "WEBGL_lose_context" ? { loseContext } : null),
    };
}

describe("probeAcceleratedWebgl", () => {
    it("asks for webgl2 first, refuses a slow context, and releases what it gets", () => {
        const context = fakeContext();
        const canvas = fakeCanvas({ webgl2: context });
        expect(probeAcceleratedWebgl(() => canvas)).toBe(true);
        expect(canvas.calls).toEqual([
            { type: "webgl2", options: { failIfMajorPerformanceCaveat: true } },
        ]);
        expect(context.loseContext).toHaveBeenCalledTimes(1);
    });

    it("falls back to webgl", () => {
        const canvas = fakeCanvas({ webgl: fakeContext() });
        expect(probeAcceleratedWebgl(() => canvas)).toBe(true);
        expect(canvas.calls.map((call) => call.type)).toEqual(["webgl2", "webgl"]);
    });

    it("tolerates a context without the lose-context extension", () => {
        const canvas = fakeCanvas({ webgl: { getExtension: () => null } });
        expect(probeAcceleratedWebgl(() => canvas)).toBe(true);
    });

    it("reads no context, no canvas, or a throwing canvas as unavailable", () => {
        expect(probeAcceleratedWebgl(() => fakeCanvas({}))).toBe(false);
        expect(probeAcceleratedWebgl(() => null)).toBe(false);
        expect(
            probeAcceleratedWebgl(() => {
                throw new Error("no canvas");
            }),
        ).toBe(false);
    });
});

describe("readSignals", () => {
    it("reads every signal the browser exposes", () => {
        const signals = readSignals({
            navigator: /** @type {Navigator} */ (
                /** @type {unknown} */ ({
                    hardwareConcurrency: 8,
                    deviceMemory: 4,
                    connection: { saveData: true },
                })
            ),
            matchMedia: (query) => ({ matches: query === "(pointer: coarse)" }),
            createCanvas: () => fakeCanvas({ webgl2: fakeContext() }),
        });
        expect(signals).toEqual({
            cores: 8,
            deviceMemory: 4,
            saveData: true,
            coarsePointer: true,
            acceleratedWebgl: true,
        });
    });

    it("treats every missing or invalid API as unknown, never as low", () => {
        expect(
            readSignals({ navigator: undefined, matchMedia: undefined, createCanvas: null }),
        ).toEqual(UNKNOWN);
        const signals = readSignals({
            navigator: /** @type {Navigator} */ (
                /** @type {unknown} */ ({ hardwareConcurrency: 0, deviceMemory: Number.NaN })
            ),
            matchMedia: () => {
                throw new Error("unsupported");
            },
            createCanvas: null,
        });
        expect(signals).toEqual(UNKNOWN);
    });
});

describe("pickTier", () => {
    it("picks standard when every signal is unknown", () => {
        expect(pickTier(UNKNOWN)).toBe("standard");
    });

    it("picks lite for Save-Data, 2 GB or less, or 2 cores or fewer", () => {
        expect(pickTier({ ...UNKNOWN, saveData: true })).toBe("lite");
        expect(pickTier({ ...UNKNOWN, deviceMemory: 2 })).toBe("lite");
        expect(pickTier({ ...UNKNOWN, cores: 2 })).toBe("lite");
        // Save-Data wins even on a powerful device.
        expect(
            pickTier({
                cores: 16,
                deviceMemory: 8,
                saveData: true,
                coarsePointer: false,
                acceleratedWebgl: true,
            }),
        ).toBe("lite");
    });

    it("picks rich only with accelerated WebGL, 8 cores, and unknown or 8 GB memory", () => {
        const strong = { ...UNKNOWN, cores: 8, acceleratedWebgl: true };
        expect(pickTier(strong)).toBe("rich");
        expect(pickTier({ ...strong, deviceMemory: 8 })).toBe("rich");
        expect(pickTier({ ...strong, deviceMemory: 4 })).toBe("standard");
        expect(pickTier({ ...strong, cores: 4 })).toBe("standard");
        expect(pickTier({ ...strong, cores: null })).toBe("standard");
        expect(pickTier({ ...strong, acceleratedWebgl: false })).toBe("standard");
        expect(pickTier({ ...strong, acceleratedWebgl: null })).toBe("standard");
    });
});

describe("resolveTier and downgradeTier", () => {
    it("lets lite and full override the automatic tier", () => {
        expect(resolveTier("rich", "lite", UNKNOWN)).toBe("lite");
        expect(resolveTier("lite", "full", { ...UNKNOWN, acceleratedWebgl: true })).toBe("rich");
        expect(resolveTier("lite", "full", { ...UNKNOWN, acceleratedWebgl: false })).toBe(
            "standard",
        );
        expect(resolveTier("standard", "auto", UNKNOWN)).toBe("standard");
    });

    it("steps down one tier and stops at lite", () => {
        expect(downgradeTier("rich")).toBe("standard");
        expect(downgradeTier("standard")).toBe("lite");
        expect(downgradeTier("lite")).toBe("lite");
        expect(EFFECTS_TIERS).toEqual(["lite", "standard", "rich"]);
        expect(EFFECTS_OVERRIDES).toEqual(["auto", "lite", "full"]);
    });
});

describe("effects override storage", () => {
    beforeEach(() => {
        window.localStorage.clear();
    });

    it("stores lite and full, removes auto, and ignores unknown values", () => {
        expect(readEffectsOverride(window.localStorage)).toBe("auto");
        writeEffectsOverride(window.localStorage, "lite");
        expect(readEffectsOverride(window.localStorage)).toBe("lite");
        writeEffectsOverride(window.localStorage, "auto");
        expect(window.localStorage.getItem("linkedin-analyzer-effects")).toBeNull();
        window.localStorage.setItem("linkedin-analyzer-effects", "turbo");
        expect(readEffectsOverride(window.localStorage)).toBe("auto");
    });

    it("tolerates missing or blocked storage", () => {
        const blocked = {
            getItem: () => {
                throw new Error("blocked");
            },
            setItem: () => {
                throw new Error("blocked");
            },
        };
        expect(readEffectsOverride(null)).toBe("auto");
        expect(readEffectsOverride(/** @type {Storage} */ (/** @type {unknown} */ (blocked)))).toBe(
            "auto",
        );
        expect(() => writeEffectsOverride(null, "lite")).not.toThrow();
        expect(() =>
            writeEffectsOverride(/** @type {Storage} */ (/** @type {unknown} */ (blocked)), "lite"),
        ).not.toThrow();
    });
});

describe("buildDeviceProfile", () => {
    const strongEnv = (canvas) => ({
        navigator: /** @type {Navigator} */ (/** @type {unknown} */ ({ hardwareConcurrency: 8 })),
        matchMedia: () => ({ matches: false }),
        createCanvas: () => canvas,
    });

    it("never probes WebGL under the lite override", () => {
        const canvas = fakeCanvas({ webgl2: fakeContext() });
        const profile = buildDeviceProfile(strongEnv(canvas), "lite");
        expect(canvas.calls).toEqual([]);
        expect(profile).toMatchObject({ tier: "lite", override: "lite" });
        expect(profile.signals.acceleratedWebgl).toBeNull();
    });

    it("probes WebGL for auto and full", () => {
        const auto = buildDeviceProfile(strongEnv(fakeCanvas({ webgl2: fakeContext() })), "auto");
        expect(auto).toMatchObject({ tier: "rich", autoTier: "rich", override: "auto" });
        const full = buildDeviceProfile(strongEnv(fakeCanvas({})), "full");
        expect(full).toMatchObject({ tier: "standard", autoTier: "standard", override: "full" });
    });
});

describe("shared device profile", () => {
    let getContext;

    beforeEach(() => {
        vi.resetModules();
        window.localStorage.clear();
        getContext = vi.fn(() => null);
        vi.stubGlobal("OffscreenCanvas", undefined);
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(getContext);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        delete document.documentElement.dataset.effects;
    });

    it("probes once, caches the profile, and applies the tier to the root", async () => {
        vi.stubGlobal("matchMedia", (query) => ({ matches: query === "(pointer: coarse)" }));
        const capabilities = await import("../../../src/platform/device/capabilities.js");
        const first = capabilities.getDeviceProfile();
        expect(first.signals.coarsePointer).toBe(true);
        expect(capabilities.getDeviceProfile()).toBe(first);
        expect(getContext).toHaveBeenCalledTimes(2);
        expect(first.override).toBe("auto");

        capabilities.applyEffectsTier("standard");
        expect(document.documentElement.dataset.effects).toBe("standard");
    });

    it("uses OffscreenCanvas where available", async () => {
        const offscreenGetContext = vi.fn(() => null);
        vi.stubGlobal(
            "OffscreenCanvas",
            class {
                getContext(...args) {
                    return offscreenGetContext(...args);
                }
            },
        );
        const capabilities = await import("../../../src/platform/device/capabilities.js");
        capabilities.getDeviceProfile();
        expect(offscreenGetContext).toHaveBeenCalled();
        expect(getContext).not.toHaveBeenCalled();
    });

    it("starts lite without probing when the stored override is lite", async () => {
        window.localStorage.setItem("linkedin-analyzer-effects", "lite");
        const capabilities = await import("../../../src/platform/device/capabilities.js");
        expect(capabilities.getDeviceProfile().tier).toBe("lite");
        expect(getContext).not.toHaveBeenCalled();
    });

    it("changes the override, probing WebGL only when it was skipped and is now needed", async () => {
        window.localStorage.setItem("linkedin-analyzer-effects", "lite");
        const capabilities = await import("../../../src/platform/device/capabilities.js");
        capabilities.getDeviceProfile();

        const full = capabilities.setEffectsOverride("full");
        expect(full.override).toBe("full");
        expect(window.localStorage.getItem("linkedin-analyzer-effects")).toBe("full");
        expect(getContext).toHaveBeenCalledTimes(2);

        const lite = capabilities.setEffectsOverride("lite");
        expect(lite.tier).toBe("lite");
        const auto = capabilities.setEffectsOverride("bogus");
        expect(auto.override).toBe("auto");
        // The earlier probe is reused rather than repeated.
        expect(getContext).toHaveBeenCalledTimes(2);
    });

    it("downgrades on jank only under auto", async () => {
        const capabilities = await import("../../../src/platform/device/capabilities.js");
        expect(capabilities.getDeviceProfile().tier).toBe("standard");
        expect(capabilities.downgradeForJank().tier).toBe("lite");

        capabilities.setEffectsOverride("full");
        expect(capabilities.downgradeForJank().tier).toBe("standard");
    });

    it("works without matchMedia or localStorage", async () => {
        vi.stubGlobal("matchMedia", undefined);
        const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
        Object.defineProperty(window, "localStorage", {
            configurable: true,
            get: () => {
                throw new Error("blocked");
            },
        });
        try {
            const capabilities = await import("../../../src/platform/device/capabilities.js");
            expect(capabilities.safeLocalStorage()).toBeNull();
            expect(capabilities.getDeviceProfile().override).toBe("auto");
        } finally {
            Object.defineProperty(window, "localStorage", descriptor);
        }
    });
});
