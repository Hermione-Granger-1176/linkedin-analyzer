/* Shared runtime constants used on the main thread and inside workers. */

/** Maximum accepted CSV payload size, in characters (60 * 1024 * 1024 ≈ 63M chars; roughly 60 MB of ASCII text). */
export const MAX_CSV_CHARS = 60 * 1024 * 1024;

/** window[] key coordinating async session cleanup across modules. */
export const SESSION_CLEANUP_PROMISE_KEY = "__linkedinAnalyzerSessionCleanupPromise";

/** Human-readable display labels for each LinkedIn export file type, keyed by internal type id. */
export const FILE_TYPE_LABELS = Object.freeze({
    shares: "Shares",
    comments: "Comments",
    messages: "Messages",
    connections: "Connections",
});
