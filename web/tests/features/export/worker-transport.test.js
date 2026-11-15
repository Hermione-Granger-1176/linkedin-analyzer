import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    loadConnectionsData,
    terminateConnectionsWorker,
} from "../../../src/features/export/connections-transport.js";
import {
    loadMessagesState,
    terminateMessagesWorker,
} from "../../../src/features/export/messages-transport.js";
import { createWorkerHarness } from "../../helpers/mock-worker.js";

vi.mock("../../../src/platform/observability/sentry.js", () => ({
    captureError: vi.fn(),
}));

const ADA_URL = "https://linkedin.com/in/ada";
const SAM_URL = "https://linkedin.com/in/sam";

const MESSAGES_CSV = [
    "CONVERSATION ID,FROM,TO,DATE,CONTENT,FOLDER,SENDER PROFILE URL,RECIPIENT PROFILE URLS",
    `c1,Sam Self,Ada Lovelace,2025-01-01 10:00:00 UTC,"Hello Ada",INBOX,${SAM_URL},${ADA_URL}`,
].join("\n");

const CONNECTIONS_CSV = [
    "Notes:",
    "Export metadata",
    "",
    "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
    `Ada,Lovelace,${ADA_URL},,Analytical Engines,Mathematician,01 Jan 2024`,
].join("\n");

const WORKER_CONNECTIONS_PAYLOAD = Object.freeze({
    success: true,
    rows: [
        {
            "First Name": "Ada",
            "Last Name": "Lovelace",
            URL: ADA_URL,
            Company: "Analytical Engines",
            Position: "Mathematician",
            "Connected On": "2024-01-01",
        },
    ],
    analytics: {
        growthTimeline: [{ key: "2024-01", label: "Jan 2024", value: 1 }],
        stats: { total: 1, networkAgeMonths: 30 },
    },
});

const harness = createWorkerHarness();

// Each test uses two transports to check that workers, timeouts and request
// IDs are independent. One transport alone cannot expose shared factory state.
describe("transports built on the shared worker mechanism", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        harness.install();
    });

    afterEach(() => {
        terminateMessagesWorker();
        terminateConnectionsWorker();
        vi.restoreAllMocks();
        harness.uninstall();
    });

    it("gives each transport a worker of its own", () => {
        loadMessagesState(MESSAGES_CSV, "");
        loadConnectionsData(CONNECTIONS_CSV);

        expect(harness.created).toHaveLength(2);
        expect(harness.created[0].url).toContain("messages-worker.js");
        expect(harness.created[1].url).toContain("connections-worker.js");
    });

    it("leaves one transport's request alone when the other is terminated", async () => {
        const messages = loadMessagesState(MESSAGES_CSV, "");
        const connections = loadConnectionsData(CONNECTIONS_CSV);
        const [messagesWorker, connectionsWorker] = harness.created;

        terminateMessagesWorker();

        // The terminated transport settles to null. The connections worker stays
        // alive and keeps listening.
        expect(await messages).toBeNull();
        expect(messagesWorker.terminate).toHaveBeenCalled();
        expect(connectionsWorker.terminate).not.toHaveBeenCalled();

        const [request] = connectionsWorker.postMessage.mock.calls[0];
        connectionsWorker.emit("message", {
            data: {
                type: "processed",
                requestId: request.requestId,
                payload: WORKER_CONNECTIONS_PAYLOAD,
            },
        });

        expect((await connections).rows).toHaveLength(1);
    });

    it("counts request ids per transport rather than across them", async () => {
        loadMessagesState(MESSAGES_CSV, "");
        const supersededConnections = loadConnectionsData(CONNECTIONS_CSV);
        const [, connectionsWorker] = harness.created;
        const [firstRequest] = connectionsWorker.postMessage.mock.calls[0];

        // A request on the other transport runs in between. The second
        // connections request still gets the next id on its own transport.
        // Replies are matched by request id.
        loadMessagesState(MESSAGES_CSV, "");
        const connections = loadConnectionsData(CONNECTIONS_CSV);
        const [secondRequest] = connectionsWorker.postMessage.mock.calls[1];

        expect(secondRequest.requestId).toBe(firstRequest.requestId + 1);

        connectionsWorker.emit("message", {
            data: {
                type: "processed",
                requestId: secondRequest.requestId,
                payload: WORKER_CONNECTIONS_PAYLOAD,
            },
        });

        expect(await supersededConnections).toBeNull();
        expect((await connections).rows).toHaveLength(1);
    });
});
