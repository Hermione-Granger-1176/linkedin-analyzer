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

// The mechanism the three export transports share is exercised through them
// everywhere else in the suite, one transport per file. What no single-transport
// file can see is whether the state behind it is per transport or shared between
// them, and that is the whole reason the export owns these workers rather than
// borrowing the screens': a screen keeps its worker, its watchdog and its
// request counter in module scope, so two users of one set clear each other's.
// Made module-level inside the factory, the rest of the suite would still pass.
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

        // The terminated one settles, as it must, and takes nothing else with
        // it: the connections worker is still alive and still listening.
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

        // Another request on the other transport in between. A counter shared
        // between the two would skip an id here, and the only reply a request
        // recognizes as its own is the one carrying the id it posted under.
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
