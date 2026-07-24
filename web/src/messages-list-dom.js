/**
 * DOM builders for the messages insights list panels.
 *
 * These construct detached elements from their arguments only. They read no
 * page state, so the messages page owns all decisions about what to render and
 * this module owns only how a row looks.
 */

import { getInitials, pickAvatarColor } from "./avatar.js";
import { MessagesAnalytics } from "./messages-analytics.js";

/** Skeleton markup repeated in each list panel while data loads. */
export const SKELETON_ITEM = `
            <li class="message-item skeleton-row">
                <span class="skeleton-block skeleton-avatar"></span>
                <div class="message-item-main">
                    <div class="skeleton-block skeleton-title"></div>
                    <div class="skeleton-block skeleton-meta"></div>
                </div>
                <div class="skeleton-block skeleton-value"></div>
            </li>
        `;

/**
 * Trim any value into a string.
 * @param {unknown} value - Raw value
 * @returns {string}
 */
function cleanText(value) {
    return MessagesAnalytics.cleanText(value);
}

/**
 * Append contact name as link when URL is available.
 * @param {HTMLElement} container - Name container
 * @param {string} label - Display name (already cleaned, never empty)
 * @param {string} url - Contact profile URL
 */
function appendContactName(container, label, url) {
    const cleanUrl = cleanText(url);
    // Defense in depth: current callers pass URLs already validated by MessagesAnalytics, but
    // guard the scheme here so a future caller cannot introduce a javascript: URL.
    if (!cleanUrl || !/^https?:\/\//i.test(cleanUrl)) {
        container.textContent = label;
        return;
    }

    const link = document.createElement("a");
    link.href = cleanUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = label;
    container.appendChild(link);
}

/**
 * Create one list item element for messages panels.
 * @param {{name: string, url: string, meta: string, value: string}} item - Render payload
 * @returns {HTMLElement}
 */
export function createMessageItem(item) {
    const listItem = document.createElement("li");
    listItem.className = "message-item";

    const label = cleanText(item.name) || "Unknown";
    const avatar = document.createElement("span");
    avatar.className = `message-item-avatar avatar-${pickAvatarColor(label)}`;
    avatar.textContent = getInitials(label);
    avatar.setAttribute("aria-hidden", "true");
    listItem.appendChild(avatar);

    const main = document.createElement("div");
    main.className = "message-item-main";

    const title = document.createElement("p");
    title.className = "message-item-title";
    appendContactName(title, label, item.url);

    const meta = document.createElement("p");
    meta.className = "message-item-meta";
    meta.textContent = item.meta;

    const value = document.createElement("span");
    value.className = "message-item-value";
    value.textContent = item.value;

    main.appendChild(title);
    main.appendChild(meta);
    listItem.appendChild(main);
    listItem.appendChild(value);
    return listItem;
}

/**
 * Render list empty message.
 * @param {HTMLElement} listElement - Target list element
 * @param {string} message - Empty message text
 */
export function renderEmptyList(listElement, message) {
    const item = document.createElement("li");
    item.className = "message-empty";
    item.textContent = message;
    listElement.replaceChildren(item);
}
