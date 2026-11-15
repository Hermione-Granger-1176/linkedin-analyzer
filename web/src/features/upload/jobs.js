/**
 * Job bookkeeping helpers for upload processing.
 *
 * Worker replies may arrive without a job ID or with a stale one. These helpers
 * resolve which in-flight job a message belongs to. The collections are passed
 * in. The upload page owns job state, and these helpers hold none.
 */

/**
 * An upload waiting for the worker to process it.
 * @typedef {object} PendingUpload
 * @property {string} fileName - Original file name
 * @property {File} file - The uploaded File, stored once the worker accepts it
 */

/**
 * Build a unique job ID for pending file processing.
 * @param {File} file - Uploaded file
 * @returns {string}
 */
export function createJobId(file) {
    return `${file.name}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

/**
 * Consume a pending upload entry for a processed worker job.
 * @param {Map<string, PendingUpload>} pendingFiles - Pending uploads by job ID
 * @param {string|null} jobId - Worker job ID
 * @param {string} fileName - Original file name
 * @returns {PendingUpload|null}
 */
export function consumePendingFile(pendingFiles, jobId, fileName) {
    if (jobId && pendingFiles.has(jobId)) {
        const pending = pendingFiles.get(jobId) || null;
        pendingFiles.delete(jobId);
        return pending;
    }

    if (!fileName) {
        return null;
    }

    for (const [key, pending] of pendingFiles.entries()) {
        if (pending.fileName === fileName) {
            pendingFiles.delete(key);
            return pending;
        }
    }
    return null;
}

/**
 * Resolve a job ID from explicit ID, file name, or active queue fallback.
 * @param {Set<string>} activeJobs - In-flight job IDs
 * @param {Map<string, PendingUpload>} pendingFiles - Pending uploads by job ID
 * @param {string|null} jobId - Worker job ID
 * @param {string} fileName - Uploaded file name fallback
 * @returns {string|null}
 */
export function resolveJobId(activeJobs, pendingFiles, jobId, fileName) {
    const normalizedJobId = typeof jobId === "string" && jobId ? jobId : null;
    if (normalizedJobId && (activeJobs.has(normalizedJobId) || pendingFiles.has(normalizedJobId))) {
        return normalizedJobId;
    }

    const pendingJobId = resolvePendingJobIdByFileName(pendingFiles, fileName);
    if (pendingJobId) {
        return pendingJobId;
    }

    return getSoleActiveJobId(activeJobs);
}

/**
 * Resolve pending job ID by uploaded file name.
 * @param {Map<string, PendingUpload>} pendingFiles - Pending uploads by job ID
 * @param {string} fileName - Uploaded file name
 * @returns {string|null}
 */
function resolvePendingJobIdByFileName(pendingFiles, fileName) {
    const normalizedFileName = String(fileName || "");
    if (!normalizedFileName) {
        return null;
    }

    for (const [key, pending] of pendingFiles.entries()) {
        if (pending && pending.fileName === normalizedFileName) {
            return key;
        }
    }

    return null;
}

/**
 * Resolve the sole active job ID as a final fallback.
 *
 * Only resolves when exactly one job is in flight. Returns null when several
 * jobs are in flight, leaving the message to that job's watchdog.
 * @param {Set<string>} activeJobs - In-flight job IDs
 * @returns {string|null}
 */
function getSoleActiveJobId(activeJobs) {
    if (activeJobs.size !== 1) {
        return null;
    }
    // The size check above means the iterator has a value.
    return /** @type {string} */ (activeJobs.values().next().value);
}
