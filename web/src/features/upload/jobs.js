/**
 * Job bookkeeping helpers for upload processing.
 *
 * Worker replies may arrive without a job ID (or with a stale one), so these
 * helpers resolve which in-flight job a message belongs to. The collections are
 * passed in rather than owned here, keeping the upload page the single owner of
 * job state and these helpers free of hidden state.
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
 * @param {Map<string, object>} pendingFiles - Pending uploads by job ID
 * @param {string|null} jobId - Worker job ID
 * @param {string} fileName - Original file name
 * @returns {{text: string, fileName: string, usedFallback?: boolean}|null}
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
 * @param {Map<string, object>} pendingFiles - Pending uploads by job ID
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

    return getFirstActiveJobId(activeJobs);
}

/**
 * Resolve pending job ID by uploaded file name.
 * @param {Map<string, object>} pendingFiles - Pending uploads by job ID
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
 * Only resolves when exactly one job is in flight: a worker message that
 * lacks both a jobId and a matching fileName is unambiguous in that case.
 * With concurrent uploads, guessing the "first" job would complete the wrong
 * file, so we return null and let that job's watchdog handle it instead.
 * @param {Set<string>} activeJobs - In-flight job IDs
 * @returns {string|null}
 */
function getFirstActiveJobId(activeJobs) {
    if (activeJobs.size !== 1) {
        return null;
    }
    return activeJobs.values().next().value;
}
