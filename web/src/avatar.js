/* Offline initials avatars for contacts (no network, derived from name only) */

/** Avatar color class suffixes, mapped to accent vars in CSS. */
export const AVATAR_COLORS = ["blue", "yellow", "red", "green", "purple"];

/**
 * Derive up-to-two-letter uppercase initials from a person's name.
 * Uses the first and last whitespace-separated tokens; falls back to the
 * first one or two letters of a single token, or "?" when empty.
 * @param {string} name - Contact name
 * @returns {string}
 */
export function getInitials(name) {
    const tokens = String(name ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);

    if (!tokens.length) {
        return "?";
    }

    if (tokens.length === 1) {
        return tokens[0].slice(0, 2).toUpperCase();
    }

    const first = tokens[0][0];
    const last = tokens[tokens.length - 1][0];
    return `${first}${last}`.toUpperCase();
}

/**
 * Deterministically pick an avatar color class suffix for a name, so the same
 * person always gets the same color.
 * @param {string} name - Contact name
 * @returns {string} One of {@link AVATAR_COLORS}
 */
export function pickAvatarColor(name) {
    const text = String(name ?? "").trim();
    let hash = 0;
    for (let index = 0; index < text.length; index += 1) {
        hash = (hash + text.charCodeAt(index)) % AVATAR_COLORS.length;
    }
    return AVATAR_COLORS[hash];
}
