import { describe, expect, it, vi } from "vitest";

import { LinkedInCleaner } from "../../../src/features/cleaning/cleaner.js";
import { processCsvSource } from "../../../src/features/cleaning/process-source.js";
import { storedUpload } from "../../helpers/stored-upload.js";

const SHARES_CSV = [
    "Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility",
    '"2025-01-01 10:00:00 UTC","https://www.linkedin.com/feed/update/urn:li:activity:1","Post","","","PUBLIC"',
].join("\n");

describe("processCsvSource", () => {
    it("cleans CSV text and a streamed upload alike", async () => {
        const fromText = await processCsvSource(SHARES_CSV, "shares");
        const fromBlob = await processCsvSource(storedUpload(SHARES_CSV), "shares");
        expect(fromText.success).toBe(true);
        expect(fromBlob.cleanedData).toEqual(fromText.cleanedData);
    });

    it.each([
        ["a streamed upload", () => storedUpload(SHARES_CSV)],
        ["a whole read", () => new Blob([SHARES_CSV])],
    ])("rejects without cleaning when aborted during %s", async (_, source) => {
        const process = vi.spyOn(LinkedInCleaner, "process");
        const controller = new AbortController();
        controller.abort();
        await expect(
            processCsvSource(source(), "shares", { signal: controller.signal }),
        ).rejects.toThrow();
        expect(process).not.toHaveBeenCalled();
        process.mockRestore();
    });
});
