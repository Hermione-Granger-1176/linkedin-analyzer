import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LinkedInCleaner } from "../../../src/features/cleaning/cleaner.js";
import {
    loadConnectionsData,
    terminateConnectionsWorker,
} from "../../../src/features/export/connections-transport.js";
import { captureError } from "../../../src/platform/observability/sentry.js";
import { createWorkerHarness } from "../../helpers/mock-worker.js";
import { expectFixedError, piiError } from "../../helpers/pii-sentinel.js";

vi.mock("../../../src/platform/observability/sentry.js", () => ({
    captureError: vi.fn(),
}));

const ADA_URL = "https://linkedin.com/in/ada";

const CONNECTIONS_CSV = [
    "Notes:",
    "Export metadata",
    "",
    "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
    `Ada,Lovelace,${ADA_URL},,Analytical Engines,Mathematician,01 Jan 2024`,
    "Grace,Hopper,https://linkedin.com/in/grace,,Navy,Rear Admiral,02 Feb 2024",
].join("\n");

// An export LinkedIn wrote but nobody is in: the cleaner reads it happily and
// hands back no rows at all.
const EMPTY_CONNECTIONS_CSV = [
    "Notes:",
    "Export metadata",
    "",
    "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
].join("\n");

const ADA_CONNECTED_MS = new Date(2024, 0, 1).getTime();

// The cleaned rows the worker sends on for the view to aggregate, in the
// cleaner's own title-case keys.
const WORKER_ROWS = Object.freeze([
    {
        "First Name": "Ada",
        "Last Name": "Lovelace",
        URL: ADA_URL,
        Company: "Analytical Engines",
        Position: "Mathematician",
        "Connected On": "2024-01-01",
    },
]);

const WORKER_ANALYTICS = Object.freeze({
    growthTimeline: [{ key: "2024-01", label: "Jan 2024", value: 1 }],
    stats: { total: 1, networkAgeMonths: 30 },
});

const harness = createWorkerHarness();

/**
 * Answer the request the worker was just given.
 * @param {object} payload - Worker payload, success flag and all
 * @param {number} [idOffset] - Shift applied to the request id, for stale replies
 */
function replyToRequest(payload, idOffset = 0) {
    const [request] = harness.instance.postMessage.mock.calls[0];
    harness.instance.emit("message", {
        data: { type: "processed", requestId: request.requestId + idOffset, payload },
    });
}

describe("loadConnectionsData", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
        harness.install();
    });

    afterEach(() => {
        terminateConnectionsWorker();
        vi.restoreAllMocks();
        vi.useRealTimers();
        harness.uninstall();
    });

    it("returns nothing for blank input without starting a worker", async () => {
        expect(await loadConnectionsData("")).toBeNull();
        expect(await loadConnectionsData(null)).toBeNull();
        expect(harness.instance).toBeNull();
    });

    it("starts no worker for a run that has already been cancelled", async () => {
        expect(await loadConnectionsData(CONNECTIONS_CSV, { isCancelled: () => true })).toBeNull();
        expect(harness.instance).toBeNull();
    });

    it("normalizes the worker's rows and terminates the worker", async () => {
        const pending = loadConnectionsData(CONNECTIONS_CSV);
        const worker = harness.instance;
        const [request] = worker.postMessage.mock.calls[0];

        expect(request.type).toBe("process");
        expect(request.payload).toEqual({ connectionsCsv: CONNECTIONS_CSV });

        replyToRequest({ success: true, analytics: WORKER_ANALYTICS, rows: WORKER_ROWS });

        const data = await pending;
        // The shape the view aggregates over, built from the cleaner's own
        // title-case keys without a second pass over the CSV.
        expect(data.rows).toEqual([
            {
                connectedOn: ADA_CONNECTED_MS,
                company: "Analytical Engines",
                position: "Mathematician",
            },
        ]);
        expect(data.timeline).toEqual(WORKER_ANALYTICS.growthTimeline);
        expect(data.stats).toEqual(WORKER_ANALYTICS.stats);
        expect(worker.terminate).toHaveBeenCalled();
    });

    it("takes an analytics payload with neither half the way the screen does", async () => {
        // The contract checks only that analytics is an object, so the two
        // fields on it are read defensively: the view draws an empty timeline
        // and counts the rows itself rather than throwing.
        const pending = loadConnectionsData(CONNECTIONS_CSV);
        replyToRequest({ success: true, analytics: {}, rows: WORKER_ROWS });

        const data = await pending;
        expect(data.timeline).toEqual([]);
        expect(data.stats).toBeNull();
        expect(data.rows).toHaveLength(1);
    });

    it("builds the data on the main thread when the platform has no worker", async () => {
        harness.uninstall();

        const data = await loadConnectionsData(CONNECTIONS_CSV);

        expect(data.rows).toHaveLength(2);
        expect(data.rows[0]).toEqual({
            connectedOn: ADA_CONNECTED_MS,
            company: "Analytical Engines",
            position: "Mathematician",
        });
        expect(data.timeline[0]).toMatchObject({ key: "2024-01", label: "Jan 2024" });
        expect(data.stats.total).toBe(2);
        expect(data.stats.networkAgeMonths).toBeGreaterThan(0);
    });

    it("returns nothing on the main thread when the file will not parse", async () => {
        harness.uninstall();

        expect(await loadConnectionsData("not,a,connections,export")).toBeNull();
    });

    it("returns nothing on the main thread when the file holds no rows", async () => {
        // The cleaner reads a connections export with only its header quite
        // happily, so an empty result is not a parse failure and has to be
        // checked for on its own.
        harness.uninstall();

        expect(await loadConnectionsData(EMPTY_CONNECTIONS_CSV)).toBeNull();
    });

    it("refuses the main-thread fallback for very large exports", async () => {
        // Re-parsing this on the UI thread would freeze the page, which is the
        // whole reason this transport exists.
        harness.uninstall();
        const huge = `${CONNECTIONS_CSV}\n${"# padding\n".repeat(600000)}`;

        expect(huge.length).toBeGreaterThan(5 * 1024 * 1024);
        expect(await loadConnectionsData(huge)).toBeNull();
    });

    it("still builds on the main thread just under the fallback ceiling", async () => {
        // The positive control for the test above: same padded shape, only
        // shorter. Without this, a null there could equally mean the padding
        // broke the parser, and deleting the size guard would not fail.
        harness.uninstall();
        const padded = `${CONNECTIONS_CSV}\n${"# padding\n".repeat(10)}`;

        expect(padded.length).toBeLessThan(5 * 1024 * 1024);
        expect((await loadConnectionsData(padded)).rows).toHaveLength(2);
    });

    it("does not re-parse on the main thread when a run is cancelled across the worker", async () => {
        // The worker answered nothing usable, but by then the user had asked to
        // stop: falling back would redo the abandoned work on the UI thread.
        let cancelled = false;
        const pending = loadConnectionsData(CONNECTIONS_CSV, {
            isCancelled: () => cancelled,
        });
        cancelled = true;
        harness.instance.emit("error", { type: "error" });

        expect(await pending).toBeNull();
    });

    it("does not re-parse on the main thread when the worker reports failure", async () => {
        // The worker has already run this exact CSV through this exact code and
        // reported that it cannot parse it; the main thread would only freeze
        // the page to reach the same answer.
        const pending = loadConnectionsData(CONNECTIONS_CSV);
        replyToRequest({ success: false, error: "bad csv" });

        expect(await pending).toBeNull();
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "connections-worker-failure",
            requestId: expect.any(Number),
        });
    });

    it("falls back when a failure envelope names no request it was given", async () => {
        // The worker answers under the request's own id when it read the request
        // and the parse is what failed, and under id zero when it fell over
        // before or outside of that. Only the first is evidence about the file.
        // This one never touched the CSV, so the small export is still parsed
        // here rather than dropped, which is what the test above pins for a
        // failure the worker did attribute to its request.
        //
        // It settles at once either way: no timer is advanced, so a request left
        // to sit out its watchdog fails this test.
        vi.useFakeTimers();
        const pending = loadConnectionsData(CONNECTIONS_CSV);
        replyToRequest({ success: false, error: "invalid request" }, 99);
        vi.useRealTimers();

        expect((await pending).rows).toHaveLength(2);
        expect(harness.instance.terminate).toHaveBeenCalled();
    });

    it("does not re-parse on the main thread for an error envelope under its own id", async () => {
        // This worker answers a request it threw on with an error envelope under
        // that request's id. It ran this exact CSV through this exact code, so
        // the UI thread would only freeze to reach the same answer.
        vi.useFakeTimers();
        const pending = loadConnectionsData(CONNECTIONS_CSV);
        const [request] = harness.instance.postMessage.mock.calls[0];
        harness.instance.emit("message", {
            data: {
                type: "error",
                requestId: request.requestId,
                payload: { message: "runtime failure" },
            },
        });
        vi.useRealTimers();

        expect(await pending).toBeNull();
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "connections-worker-error-payload",
            requestId: request.requestId,
        });
    });

    it("falls back for an error envelope under id zero", async () => {
        // Id zero is how this worker answers a global failure, or a request the
        // contract parser would not let it read. Neither says the file cannot be
        // parsed, so a small export is still parsed here.
        vi.useFakeTimers();
        const pending = loadConnectionsData(CONNECTIONS_CSV);
        harness.instance.emit("message", {
            data: { type: "error", requestId: 0, payload: { message: "runtime failure" } },
        });
        vi.useRealTimers();

        expect((await pending).rows).toHaveLength(2);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "connections-worker-error-payload",
            requestId: expect.any(Number),
        });
    });

    it("answers a crash the same way whichever of its two routes lands first", async () => {
        // A crash inside this worker reaches the main thread twice over: as the
        // posted error envelope under id zero, and as a propagated error event
        // on the Worker object, which this worker does not cancel. Nothing in
        // the spec orders the two, so what the export does must not depend on
        // which one wins.
        const postCrashEnvelope = (worker) => {
            worker.emit("message", {
                data: { type: "error", requestId: 0, payload: { message: "runtime failure" } },
            });
        };
        const propagateErrorEvent = (worker) => {
            worker.emit("error", { type: "error", error: new Error("worker blew up") });
        };

        const outcomes = [];
        for (const routes of [
            [postCrashEnvelope, propagateErrorEvent],
            [propagateErrorEvent, postCrashEnvelope],
        ]) {
            const pending = loadConnectionsData(CONNECTIONS_CSV);
            const worker = harness.instance;
            for (const route of routes) {
                route(worker);
            }
            outcomes.push(await pending);
        }

        // Both fall back, because neither route said anything about the file.
        expect(outcomes.map((data) => data.rows.length)).toEqual([2, 2]);
    });

    it("settles a success the contract parser emptied", async () => {
        // The parser nulls an analytics payload that is not an object and
        // normalizes a missing row list to an empty array, so a reply can be
        // well-formed enough to accept and still carry nothing to draw. No timer
        // is advanced here, so leaving it to the watchdog fails the test.
        vi.useFakeTimers();
        const pending = loadConnectionsData(CONNECTIONS_CSV);
        replyToRequest({ success: true, analytics: "not an object", rows: WORKER_ROWS });
        vi.useRealTimers();

        // Null, not FAILED: a reply the parser had to empty out says nothing
        // about whether the file itself can be parsed, so the fallback still
        // runs for a small export.
        expect((await pending).rows).toHaveLength(2);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "connections-message-parse",
            requestId: expect.any(Number),
        });
    });

    it("settles a success carrying no rows", async () => {
        vi.useFakeTimers();
        const pending = loadConnectionsData(CONNECTIONS_CSV);
        replyToRequest({ success: true, analytics: WORKER_ANALYTICS, rows: [] });
        vi.useRealTimers();

        expect((await pending).rows).toHaveLength(2);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "connections-message-parse",
            requestId: expect.any(Number),
        });
    });

    it("ignores stale successes for other requests and invalid envelopes", async () => {
        const pending = loadConnectionsData(CONNECTIONS_CSV);

        harness.instance.emit("message", { data: { type: "nope" } });
        replyToRequest({ success: true, analytics: WORKER_ANALYTICS, rows: [...WORKER_ROWS] }, 99);
        replyToRequest({ success: true, analytics: WORKER_ANALYTICS, rows: WORKER_ROWS });

        expect((await pending).rows).toHaveLength(1);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "connections-message-parse",
            requestId: expect.any(Number),
        });
    });

    it("drops a stale reply before reading it, so an empty one cannot settle the live request", async () => {
        // The id is checked ahead of the parse, as it is in the messages and
        // threads transports. Read the other way round, a stale reply the parser
        // has to empty out settles the request that is still waiting, which then
        // answers from the main thread instead of from the worker.
        const pending = loadConnectionsData(CONNECTIONS_CSV);

        replyToRequest({ success: true, analytics: null, rows: [] }, 99);
        replyToRequest({ success: true, analytics: WORKER_ANALYTICS, rows: WORKER_ROWS });

        expect((await pending).rows).toHaveLength(1);
    });

    it("falls back to the main thread when the worker errors", async () => {
        const pending = loadConnectionsData(CONNECTIONS_CSV);
        harness.instance.emit("error", { type: "error", error: new Error("worker blew up") });

        expect((await pending).rows).toHaveLength(2);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "connections-worker-error-event",
            requestId: expect.any(Number),
        });
    });

    it("cancels a worker error event so the browser cannot report it", async () => {
        const preventDefault = vi.fn();
        const pending = loadConnectionsData(CONNECTIONS_CSV);
        // An uncancelled error event on a Worker is reported by the browser
        // itself, and that report reaches the console with the worker's own
        // message - here, text parsed straight out of the connections CSV.
        harness.instance.emit("error", { type: "error", error: piiError("worker"), preventDefault });
        await pending;

        expect(preventDefault).toHaveBeenCalled();
    });

    it("falls back to the main thread when the watchdog fires", async () => {
        vi.useFakeTimers();
        const pending = loadConnectionsData(CONNECTIONS_CSV);
        vi.advanceTimersByTime(30001);
        vi.useRealTimers();

        expect((await pending).rows).toHaveLength(2);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "connections-worker-timeout",
            requestId: expect.any(Number),
        });
    });

    it("scales the watchdog with the size of the export", async () => {
        // 30s base plus 5s per whole megabyte, the same budget the messages
        // parse is given. The timeout test above advances 30s against a
        // six-line CSV, so it would pass for a constant.
        vi.useFakeTimers();
        const threeMb = `${CONNECTIONS_CSV}\n${"# padding\n".repeat(320000)}`;
        expect(threeMb.length).toBeGreaterThan(3 * 1024 * 1024);
        expect(threeMb.length).toBeLessThan(4 * 1024 * 1024);

        const pending = loadConnectionsData(threeMb);

        vi.advanceTimersByTime(44999);
        expect(captureError).not.toHaveBeenCalled();

        vi.advanceTimersByTime(2);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "connections-worker-timeout",
            requestId: expect.any(Number),
        });

        vi.useRealTimers();
        await pending;
    });

    it("falls back to the main thread when posting to the worker throws", async () => {
        harness.postMessageError = new Error("clone failed");

        const data = await loadConnectionsData(CONNECTIONS_CSV);

        expect(data.rows).toHaveLength(2);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "connections-worker-post-message",
            requestId: expect.any(Number),
        });
    });

    it("falls back to the main thread when the worker cannot be constructed", async () => {
        harness.constructorError = new Error("no workers here");

        const data = await loadConnectionsData(CONNECTIONS_CSV);

        expect(data.rows).toHaveLength(2);
        expect(captureError).toHaveBeenCalledWith(expect.any(Error), {
            module: "pdf-export",
            operation: "init-connections-worker",
        });
    });

    it("ends an earlier request rather than letting two share the worker", async () => {
        // Both requests would otherwise own the same module-level watchdog and
        // settle hook, and whichever the worker answered first would clear the
        // other's, leaving that promise pending for the life of the page.
        const first = loadConnectionsData(CONNECTIONS_CSV);
        const worker = harness.instance;
        const second = loadConnectionsData(CONNECTIONS_CSV);
        const [, secondRequest] = worker.postMessage.mock.calls;

        worker.emit("message", {
            data: {
                type: "processed",
                requestId: secondRequest[0].requestId,
                payload: { success: true, analytics: WORKER_ANALYTICS, rows: WORKER_ROWS },
            },
        });

        // The cancelled one resolves rather than hanging, and does not re-run
        // the abandoned work on the UI thread.
        expect(await first).toBeNull();
        expect((await second).rows).toHaveLength(1);
    });

    it("settles a terminated request instead of leaving it pending", async () => {
        vi.useFakeTimers();
        const pending = loadConnectionsData(CONNECTIONS_CSV);
        const worker = harness.instance;
        expect(worker.postMessage).toHaveBeenCalled();

        terminateConnectionsWorker();
        // No timer is advanced and no event is emitted: terminating removed
        // every one of them, so cancellation alone has to end the request. Left
        // pending, its frame keeps the raw connections CSV alive for the life of
        // the page.
        expect(await pending).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
        expect(captureError).not.toHaveBeenCalled();
        vi.useRealTimers();
    });

    it("detaches a cancelled request from the worker it was listening to", async () => {
        const pending = loadConnectionsData(CONNECTIONS_CSV);
        const worker = harness.instance;

        terminateConnectionsWorker();
        await pending;

        expect(worker.listeners.get("message")).toEqual([]);
        expect(worker.listeners.get("error")).toEqual([]);
        expect(worker.listeners.get("messageerror")).toEqual([]);

        // A late answer from a worker that was already killed changes nothing.
        replyToRequest({ success: true, analytics: WORKER_ANALYTICS, rows: WORKER_ROWS });
        expect(await pending).toBeNull();
    });

    it("tolerates a second termination with nothing in flight", async () => {
        const pending = loadConnectionsData(CONNECTIONS_CSV);
        terminateConnectionsWorker();
        await pending;

        expect(() => terminateConnectionsWorker()).not.toThrow();
        expect(harness.instance.terminate).toHaveBeenCalledTimes(1);
    });

    it("runs a fresh request after a cancelled one", async () => {
        const cancelled = loadConnectionsData(CONNECTIONS_CSV);
        terminateConnectionsWorker();
        expect(await cancelled).toBeNull();

        const pending = loadConnectionsData(CONNECTIONS_CSV);
        replyToRequest({ success: true, analytics: WORKER_ANALYTICS, rows: WORKER_ROWS });

        expect((await pending).rows).toHaveLength(1);
    });

    it("never reports the error a worker failure event carried", async () => {
        const thrown = piiError("worker");
        const pending = loadConnectionsData(CONNECTIONS_CSV);
        harness.instance.emit("messageerror", { type: "messageerror", error: thrown });
        await pending;

        expectFixedError(captureError.mock.calls[0][0], thrown);
    });

    it("never reports the error a failed postMessage carried", async () => {
        harness.postMessageError = piiError("clone");

        await loadConnectionsData(CONNECTIONS_CSV);

        expectFixedError(captureError.mock.calls[0][0], harness.postMessageError);
    });

    it("never reports the message a worker error envelope carried", async () => {
        // The worker normalizes whatever it caught into that message, so it can
        // carry a row of the user's own connections.
        const thrown = piiError("worker-envelope");
        const pending = loadConnectionsData(CONNECTIONS_CSV);
        harness.instance.emit("message", {
            data: { type: "error", requestId: 0, payload: { message: thrown.message } },
        });
        await pending;

        expectFixedError(captureError.mock.calls[0][0], thrown);
    });

    it("never reports what a failed main-thread parse carried", async () => {
        const thrown = piiError("main-thread");
        harness.uninstall();
        vi.spyOn(LinkedInCleaner, "process").mockImplementation(() => {
            throw thrown;
        });

        expect(await loadConnectionsData(CONNECTIONS_CSV)).toBeNull();

        const [reported, context] = captureError.mock.calls[0];
        expectFixedError(reported, thrown);
        expect(context).toEqual({
            module: "pdf-export",
            operation: "connections-main-thread-parse",
        });
    });
});
