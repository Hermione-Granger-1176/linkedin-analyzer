import { describe, expect, it } from "vitest";

import { processPayload } from "../../../src/features/export/threads-worker.js";

const MESSAGES_CSV = [
    "CONVERSATION ID,FROM,TO,DATE,CONTENT,FOLDER,SENDER PROFILE URL,RECIPIENT PROFILE URLS",
    'c1,Sam Self,Ada,2025-01-01 10:00:00 UTC,"Hello Ada",INBOX,https://linkedin.com/in/sam,https://linkedin.com/in/ada',
    'c1,Ada,Sam Self,2025-01-02 10:00:00 UTC,"Hi Sam",INBOX,https://linkedin.com/in/ada,https://linkedin.com/in/sam',
    'c2,Sam Self,Bob,2025-01-03 10:00:00 UTC,"Hello Bob",INBOX,https://linkedin.com/in/sam,https://linkedin.com/in/bob',
].join("\n");

describe("threads worker", () => {
    it("cleans the CSV and selects threads", () => {
        const result = processPayload({ messagesCsv: MESSAGES_CSV });

        expect(result.success).toBe(true);
        expect(result.error).toBeNull();
        expect(result.threads.map((thread) => thread.name)).toEqual(["Bob", "Ada"]);
        expect(result.threads[1].messages.map((entry) => entry.body)).toEqual([
            "Hello Ada",
            "Hi Sam",
        ]);
        expect(result.threads[1].messages.map((entry) => entry.direction)).toEqual([
            "sent",
            "received",
        ]);
    });

    it("honours the selection limits from the request", () => {
        const result = processPayload({
            messagesCsv: MESSAGES_CSV,
            people: 1,
            messagesPerPerson: 1,
        });

        expect(result.threads).toHaveLength(1);
        expect(result.threads[0].messages).toHaveLength(1);
    });

    it("reports an error for an unparseable CSV", () => {
        const result = processPayload({ messagesCsv: "not,a,valid,csv" });

        expect(result.success).toBe(false);
        expect(result.threads).toEqual([]);
        expect(result.error).toBeTruthy();
    });
});
