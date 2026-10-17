import { afterEach, describe, expect, it, vi } from "vitest";

import { processFiles } from "../../../src/features/messages/parse.js";

vi.mock("../../../src/platform/observability/sentry.js", () => ({
    captureError: vi.fn(),
}));

const MESSAGES_CSV = [
    "CONVERSATION ID,FROM,TO,DATE,CONTENT,FOLDER,SENDER PROFILE URL,RECIPIENT PROFILE URLS",
    'abc,Ada,Bob,2025-01-01 10:00:00 UTC,"Hello there",INBOX,https://linkedin.com/in/ada,https://linkedin.com/in/bob',
].join("\n");

describe("processFiles main-thread fallback", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("keeps the messages and warns when Connections.csv will not read", async () => {
        vi.stubGlobal("Worker", undefined);
        vi.spyOn(FileReader.prototype, "readAsArrayBuffer").mockImplementation(function fail() {
            this.onerror();
        });

        const result = await processFiles(MESSAGES_CSV, new Blob(["connections"]));

        expect(result.success).toBe(true);
        expect(result.totalInputRows).toBe(1);
        expect(result.connectionsData).toEqual([]);
        expect(result.connectionError).toBe("Unable to read Connections.csv.");
    });

    it("reports an unreadable messages file instead of rejecting", async () => {
        vi.stubGlobal("Worker", undefined);
        vi.spyOn(FileReader.prototype, "readAsArrayBuffer").mockImplementation(function fail() {
            this.onerror();
        });

        expect(await processFiles(new Blob(["messages"]), "")).toEqual({
            success: false,
            error: "Unable to read messages.csv.",
        });
    });
});
