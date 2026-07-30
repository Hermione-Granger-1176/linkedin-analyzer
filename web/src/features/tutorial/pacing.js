/* Engagement-aware pacing math for tutorial mini-tip callouts */

const MINI_TIP_INITIAL_DELAY_MS = 2200;
const MINI_TIP_DELAY_GROWTH_MS = 90;
const MINI_TIP_DELAY_MAX_EXTRA_MS = 2200;
const MINI_TIP_BASE_COOLDOWN_MS = 30000;
const MINI_TIP_COOLDOWN_GROWTH_MS = 2500;
const MINI_TIP_COOLDOWN_MAX_MS = 240000;
const MINI_TIP_MIN_INTERVAL_VISITS = 2;
const MINI_TIP_MAX_INTERVAL_VISITS = 6;
const MINI_TIP_INTERVAL_STEP = 12;

/**
 * Normalize engagement visit count.
 * @param {number} value - Raw visit count
 * @returns {number}
 */
export function normalizeVisitCount(value) {
    const count = Number(value);
    if (!Number.isFinite(count) || count < 1) {
        return 1;
    }
    return Math.floor(count);
}

/**
 * Compute mini-tip delay for current engagement level.
 * @param {number} visitCount - Engagement visit count
 * @returns {number}
 */
export function getMiniTipDisplayDelayMs(visitCount) {
    const normalizedVisitCount = normalizeVisitCount(visitCount);
    const extraDelay = Math.min(
        normalizedVisitCount * MINI_TIP_DELAY_GROWTH_MS,
        MINI_TIP_DELAY_MAX_EXTRA_MS,
    );
    return MINI_TIP_INITIAL_DELAY_MS + extraDelay;
}

/**
 * Compute minimum cooldown between mini-tip callouts.
 * @param {number} visitCount - Engagement visit count
 * @returns {number}
 */
export function getMiniTipCooldownMs(visitCount) {
    const normalizedVisitCount = normalizeVisitCount(visitCount);
    const growth = normalizedVisitCount * MINI_TIP_COOLDOWN_GROWTH_MS;
    return Math.min(MINI_TIP_COOLDOWN_MAX_MS, MINI_TIP_BASE_COOLDOWN_MS + growth);
}

/**
 * Compute route-visit interval between mini-tip appearances.
 * @param {number} visitCount - Engagement visit count
 * @returns {number}
 */
export function getMiniTipVisitInterval(visitCount) {
    const normalizedVisitCount = normalizeVisitCount(visitCount);
    const growthSteps = Math.floor(normalizedVisitCount / MINI_TIP_INTERVAL_STEP);
    return Math.min(MINI_TIP_MAX_INTERVAL_VISITS, MINI_TIP_MIN_INTERVAL_VISITS + growthSteps);
}
