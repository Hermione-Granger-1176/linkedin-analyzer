/* Shared runtime constants used on the main thread and inside workers. */

/** Maximum accepted CSV payload size, in characters (60 MiB). */
export const MAX_CSV_CHARS = 60 * 1024 * 1024;

/** window[] key coordinating async session cleanup across modules. */
export const SESSION_CLEANUP_PROMISE_KEY = "__linkedinAnalyzerSessionCleanupPromise";
