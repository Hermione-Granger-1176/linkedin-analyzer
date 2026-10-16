/* Shared runtime constants used on the main thread and inside workers. */

/** Window property key coordinating async session cleanup across modules. */
export const SESSION_CLEANUP_PROMISE_KEY = "__linkedinAnalyzerSessionCleanupPromise";

/**
 * The window, carrying the in-flight session cleanup under its coordination key.
 * @typedef {Window & {[SESSION_CLEANUP_PROMISE_KEY]?: Promise<boolean>}} SessionCleanupWindow
 */

/** DataCache key the Insights screen publishes its on-screen snapshot under, for the PDF export to reuse. */
export const INSIGHTS_EXPORT_CACHE_KEY = "insights:exportSnapshot";

/** Supported file types, in auto-detection priority order. */
export const FILE_TYPES = Object.freeze(["shares", "comments", "messages", "connections"]);

/** Human-readable display labels for each LinkedIn export file type, keyed by internal type id. */
export const FILE_TYPE_LABELS = Object.freeze({
    shares: "Shares",
    comments: "Comments",
    messages: "Messages",
    connections: "Connections",
});
