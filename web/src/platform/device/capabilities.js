/*
 * What the current device offers, and the effects tier the app picks from it.
 *
 * The tier controls decoration only: motion, filters, and future canvas or
 * WebGL scenes. It never decides how files are processed: nothing in the
 * processing path reads the tier, so Save-Data or reduced motion cannot change
 * how files are handled.
 *
 * The app picks the tier from device signals. There is no visitor setting.
 *
 * A missing API reads as unknown. A missing deviceMemory value does not force
 * the lite tier.
 */

export const EFFECTS_TIERS = Object.freeze(["lite", "standard", "rich"]);

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
 * Request a WebGL context with failIfMajorPerformanceCaveat. A failed probe
 * does not establish that the device has no GPU. Call loseContext() when the
 * WEBGL_lose_context extension is available.
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
 * The next tier down, for a session that janks. Lite stays lite.
 * @param {string} tier - Current tier
 * @returns {string}
 */
export function downgradeTier(tier) {
    const index = EFFECTS_TIERS.indexOf(tier);
    return EFFECTS_TIERS[Math.max(0, index - 1)];
}

/**
 * Check whether CPU and memory signals allow the rich tier.
 * Only then can the WebGL probe change the selected tier.
 * @param {DeviceSignals} signals - Signals read without the probe
 * @returns {boolean}
 */
function probeCanMatter(signals) {
    return pickTier({ ...signals, acceleratedWebgl: true }) === "rich";
}

/**
 * Build a device profile. The WebGL probe runs only when the answer can change
 * the tier, so a device that cannot reach Rich never creates a WebGL context.
 * @param {object} env - Browser APIs, injected for tests
 * @param {Navigator|undefined} env.navigator - navigator
 * @param {((query: string) => { matches: boolean })|undefined} env.matchMedia - window.matchMedia
 * @param {(() => HTMLCanvasElement|OffscreenCanvas|null)|null} env.createCanvas - Canvas factory
 * @returns {DeviceProfile}
 */
export function buildDeviceProfile(env) {
    const cheap = readSignals({ ...env, createCanvas: null });
    const signals = probeCanMatter(cheap)
        ? { ...cheap, acceleratedWebgl: readSignals(env).acceleratedWebgl }
        : cheap;
    const autoTier = pickTier(signals);
    return { tier: autoTier, autoTier, signals };
}

/** @type {DeviceProfile|null} */
let cachedProfile = null;

/**
 * The device profile for this page, probed once and cached.
 * @returns {DeviceProfile}
 */
export function getDeviceProfile() {
    if (!cachedProfile) {
        cachedProfile = buildDeviceProfile(browserEnv());
    }
    return cachedProfile;
}

/**
 * The browser APIs buildDeviceProfile reads.
 * @returns {Parameters<typeof buildDeviceProfile>[0]}
 */
function browserEnv() {
    return {
        navigator: typeof navigator === "undefined" ? undefined : navigator,
        matchMedia:
            typeof window.matchMedia === "function"
                ? (query) => window.matchMedia(query)
                : undefined,
        createCanvas: () =>
            typeof OffscreenCanvas === "function"
                ? new OffscreenCanvas(1, 1)
                : document.createElement("canvas"),
    };
}

/**
 * Drop the session one tier after repeated jank. Never upgrades.
 * @returns {DeviceProfile}
 */
export function downgradeForJank() {
    const profile = getDeviceProfile();
    cachedProfile = { ...profile, tier: downgradeTier(profile.tier) };
    return cachedProfile;
}

/**
 * Show the tier on the root element, where stylesheets gate expensive effects.
 * @param {string} tier - Effects tier
 */
export function applyEffectsTier(tier) {
    document.documentElement.dataset.effects = tier;
}
