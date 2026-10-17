/*
 * What the current device offers, and the effects tier the app picks from it.
 *
 * The tier controls decoration only: motion, filters, and future canvas or
 * WebGL scenes. It never decides how files are processed: nothing in the
 * processing path reads the tier, so an effects override, Save-Data, or
 * reduced motion cannot change how files are handled.
 *
 * A missing API reads as unknown, never as low: Safari and Firefox do not
 * expose deviceMemory, and that must not push them into the lite tier.
 */

export const EFFECTS_TIERS = Object.freeze(["lite", "standard", "rich"]);
export const EFFECTS_OVERRIDES = Object.freeze(["auto", "lite", "full"]);
const OVERRIDE_STORAGE_KEY = "linkedin-analyzer-effects";

/**
 * @typedef {object} DeviceSignals
 * @property {number|null} cores - navigator.hardwareConcurrency, or null when unknown
 * @property {number|null} deviceMemory - Approximate RAM in GB, or null when unknown
 * @property {boolean} saveData - Whether the data-saver setting is on
 * @property {boolean} coarsePointer - Whether the primary pointer is touch-first
 * @property {boolean|null} acceleratedWebgl - Whether WebGL works without a major performance caveat, or null when not probed
 */

/** @typedef {Navigator & { deviceMemory?: number, connection?: { saveData?: boolean } }} DeviceNavigator */

/**
 * @typedef {object} DeviceProfile
 * @property {string} tier - The effects tier in use
 * @property {string} autoTier - The tier the signals alone pick
 * @property {string} override - The user's choice: auto, lite, or full
 * @property {DeviceSignals} signals - Raw device signals
 */

/**
 * Read a positive finite number, or null.
 * @param {unknown} value - Raw value
 * @returns {number|null}
 */
function positiveNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Probe for a WebGL context that the browser will give without a major
 * performance penalty. A null result means software rendering, a blocklisted
 * driver, WebGL turned off, or no GPU; it reads as "accelerated WebGL
 * unavailable", not as "no GPU". A successful context is released at once so
 * the probe holds no graphics memory.
 * @param {() => HTMLCanvasElement|OffscreenCanvas|null} createCanvas - Canvas factory
 * @returns {boolean}
 */
export function probeAcceleratedWebgl(createCanvas) {
    try {
        const canvas = createCanvas();
        if (!canvas) {
            return false;
        }
        const options = { failIfMajorPerformanceCaveat: true };
        const context = /** @type {WebGLRenderingContext|null} */ (
            canvas.getContext("webgl2", options) || canvas.getContext("webgl", options)
        );
        if (!context) {
            return false;
        }
        const loseContext = context.getExtension("WEBGL_lose_context");
        if (loseContext) {
            loseContext.loseContext();
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * Read the device signals.
 * @param {object} env - Browser APIs, injected for tests
 * @param {Navigator|undefined} env.navigator - navigator
 * @param {((query: string) => { matches: boolean })|undefined} env.matchMedia - window.matchMedia
 * @param {(() => HTMLCanvasElement|OffscreenCanvas|null)|null} env.createCanvas - Canvas factory, or null to skip the WebGL probe
 * @returns {DeviceSignals}
 */
export function readSignals({ navigator, matchMedia, createCanvas }) {
    const nav = /** @type {DeviceNavigator} */ (navigator || {});
    let coarsePointer = false;
    try {
        coarsePointer = Boolean(matchMedia && matchMedia("(pointer: coarse)").matches);
    } catch {
        coarsePointer = false;
    }
    return {
        cores: positiveNumber(nav.hardwareConcurrency),
        deviceMemory: positiveNumber(nav.deviceMemory),
        saveData: Boolean(nav.connection && nav.connection.saveData),
        coarsePointer,
        acceleratedWebgl: createCanvas ? probeAcceleratedWebgl(createCanvas) : null,
    };
}

/**
 * Pick the effects tier from the signals alone.
 * @param {DeviceSignals} signals - Device signals
 * @returns {string}
 */
export function pickTier({ cores, deviceMemory, saveData, acceleratedWebgl }) {
    const lowMemory = deviceMemory !== null && deviceMemory <= 2;
    const fewCores = cores !== null && cores <= 2;
    if (saveData || lowMemory || fewCores) {
        return "lite";
    }
    if (
        acceleratedWebgl === true &&
        (deviceMemory === null || deviceMemory >= 8) &&
        cores !== null &&
        cores >= 8
    ) {
        return "rich";
    }
    return "standard";
}

/**
 * Apply the user's override to the automatic tier. Full means the most this
 * device can do: rich with accelerated WebGL, standard without it.
 * @param {string} autoTier - Tier from the signals
 * @param {string} override - auto, lite, or full
 * @param {DeviceSignals} signals - Device signals
 * @returns {string}
 */
export function resolveTier(autoTier, override, signals) {
    if (override === "lite") {
        return "lite";
    }
    if (override === "full") {
        return signals.acceleratedWebgl ? "rich" : "standard";
    }
    return autoTier;
}

/**
 * The next tier down, for a session that janks. Lite stays lite.
 * @param {string} tier - Current tier
 * @returns {string}
 */
export function downgradeTier(tier) {
    const index = EFFECTS_TIERS.indexOf(tier);
    return EFFECTS_TIERS[Math.max(0, index - 1)];
}

/**
 * Read the stored override, defaulting to auto.
 * @param {Storage|null} storage - localStorage
 * @returns {string}
 */
export function readEffectsOverride(storage) {
    try {
        const value = storage ? storage.getItem(OVERRIDE_STORAGE_KEY) : null;
        return value && EFFECTS_OVERRIDES.includes(value) ? value : "auto";
    } catch {
        return "auto";
    }
}

/**
 * Store the override. Auto removes the stored value.
 * @param {Storage|null} storage - localStorage
 * @param {string} override - auto, lite, or full
 */
export function writeEffectsOverride(storage, override) {
    try {
        if (!storage) {
            return;
        }
        if (override === "auto") {
            storage.removeItem(OVERRIDE_STORAGE_KEY);
        } else {
            storage.setItem(OVERRIDE_STORAGE_KEY, override);
        }
    } catch {
        // Ignore storage failures: the choice then lasts for this page only.
    }
}

/**
 * Build a device profile. The WebGL probe runs only when the answer can change
 * the tier, so the Lite override never creates a WebGL context.
 * @param {object} env - Browser APIs, injected for tests
 * @param {Navigator|undefined} env.navigator - navigator
 * @param {((query: string) => { matches: boolean })|undefined} env.matchMedia - window.matchMedia
 * @param {(() => HTMLCanvasElement|OffscreenCanvas|null)|null} env.createCanvas - Canvas factory
 * @param {string} override - auto, lite, or full
 * @returns {DeviceProfile}
 */
export function buildDeviceProfile(env, override) {
    const signals = readSignals({
        ...env,
        createCanvas: override === "lite" ? null : env.createCanvas,
    });
    const autoTier = pickTier(signals);
    return { tier: resolveTier(autoTier, override, signals), autoTier, override, signals };
}

/**
 * Read localStorage, or null when the browser blocks it.
 * @returns {Storage|null}
 */
export function safeLocalStorage() {
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}

/** @type {DeviceProfile|null} */
let cachedProfile = null;

/**
 * The device profile for this page, probed once and cached.
 * @returns {DeviceProfile}
 */
export function getDeviceProfile() {
    if (!cachedProfile) {
        cachedProfile = buildDeviceProfile(
            {
                navigator: typeof navigator === "undefined" ? undefined : navigator,
                matchMedia:
                    typeof window.matchMedia === "function"
                        ? (query) => window.matchMedia(query)
                        : undefined,
                createCanvas: () =>
                    typeof OffscreenCanvas === "function"
                        ? new OffscreenCanvas(1, 1)
                        : document.createElement("canvas"),
            },
            readEffectsOverride(safeLocalStorage()),
        );
    }
    return cachedProfile;
}

/**
 * Change the override for this page and future visits, and return the new
 * profile. The cached signals are reused; WebGL is probed only if it was not
 * probed before and the new choice needs it.
 * @param {string} override - auto, lite, or full
 * @returns {DeviceProfile}
 */
export function setEffectsOverride(override) {
    const choice = EFFECTS_OVERRIDES.includes(override) ? override : "auto";
    writeEffectsOverride(safeLocalStorage(), choice);
    const previous = getDeviceProfile();
    if (choice !== "lite" && previous.signals.acceleratedWebgl === null) {
        cachedProfile = null;
        return getDeviceProfile();
    }
    const autoTier = pickTier(previous.signals);
    cachedProfile = {
        tier: resolveTier(autoTier, choice, previous.signals),
        autoTier,
        override: choice,
        signals: previous.signals,
    };
    return cachedProfile;
}

/**
 * Drop the session one tier after repeated jank. Never upgrades, and never
 * overrides an explicit user choice.
 * @returns {DeviceProfile}
 */
export function downgradeForJank() {
    const profile = getDeviceProfile();
    if (profile.override === "auto") {
        cachedProfile = { ...profile, tier: downgradeTier(profile.tier) };
    }
    return /** @type {DeviceProfile} */ (cachedProfile);
}

/**
 * Show the tier on the root element, where stylesheets gate expensive effects.
 * @param {string} tier - Effects tier
 */
export function applyEffectsTier(tier) {
    document.documentElement.dataset.effects = tier;
}
