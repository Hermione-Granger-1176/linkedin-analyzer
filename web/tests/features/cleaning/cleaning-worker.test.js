import { afterEach, describe, expect, it, vi } from "vitest";

import { runCleanJob } from "../../../src/features/cleaning/clean-job.js";
import { handleMessage } from "../../../src/features/cleaning/cleaning-worker.js";
import { PII_MARKER, piiError } from "../../helpers/pii-sentinel.js";

vi.mock("../../../src/features/cleaning/clean-job.js", () => ({
    runCleanJob: vi.fn(),
}));

describe("cleaning worker", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("answers a request with the job's reply under its id", async () => {
        const post = vi.spyOn(globalThis, "postMessage").mockImplementation(() => {});
        const reply = { success: true, error: null, rowCount: 1, previewRows: [], blob: null };
        runCleanJob.mockResolvedValue(reply);

        await handleMessage({
            type: "clean",
            requestId: 3,
            payload: { fileType: "shares", output: "preview", source: "a,b", key: "k" },
        });

        expect(runCleanJob).toHaveBeenCalledWith({
            fileType: "shares",
            output: "preview",
            source: "a,b",
            key: "k",
        });
        expect(post).toHaveBeenCalledWith({ type: "cleaned", requestId: 3, payload: reply });
    });

    it("rejects an invalid request under the id it arrived with", async () => {
        const post = vi.spyOn(globalThis, "postMessage").mockImplementation(() => {});

        await handleMessage({ type: "clean", requestId: 4, payload: { fileType: "bogus" } });

        const [message] = post.mock.calls[0];
        expect(message.requestId).toBe(4);
        expect(message.payload.success).toBe(false);
        expect(message.payload.error).toContain("Invalid cleaning file type");
    });

    it("never forwards what a failed job threw", async () => {
        const post = vi.spyOn(globalThis, "postMessage").mockImplementation(() => {});
        runCleanJob.mockRejectedValue(piiError("clean"));

        await handleMessage({
            type: "clean",
            requestId: 5,
            payload: { fileType: "shares", output: "csv", source: "a,b", key: "k" },
        });

        const [message] = post.mock.calls[0];
        expect(message.requestId).toBe(5);
        expect(message.payload.error).toBe("Cleaning worker runtime failure.");
        expect(JSON.stringify(message)).not.toContain(PII_MARKER);
    });
});
