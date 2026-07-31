import { describe, expect, it, vi } from "vitest";

import { LinkedInCleaner } from "../../../src/features/cleaning/cleaner.js";
import { processConnections } from "../../../src/features/connections/connections-worker.js";

describe("connections worker", () => {
    it("processConnections succeeds with valid CSV", () => {
        const csv = [
            "Notes:",
            "Export metadata",
            "",
            "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
            "Ada,Lovelace,https://linkedin.com/in/ada,,Engines,Mathematician,30 Jan 2024",
            "Bob,Smith,https://linkedin.com/in/bob,,Acme,Engineer,15 Jun 2024"
        ].join("\n");

        const result = processConnections(csv);

        expect(result.success).toBe(true);
        expect(result.rows.length).toBe(2);
        expect(result.analytics.growthTimeline.length).toBeGreaterThan(0);
        expect(result.analytics.stats.total).toBe(2);
        expect(result.analytics.stats.networkAgeMonths).toBeGreaterThan(0);
    });

    it("processConnections rejects empty input", () => {
        expect(processConnections("").success).toBe(false);
        expect(processConnections(null).success).toBe(false);
        expect(processConnections("").error).toBeTruthy();
    });

    it("processConnections uses fallback parser error message when cleaner omits error", () => {
        const processSpy = vi.spyOn(LinkedInCleaner, "process").mockReturnValueOnce({
            success: false,
            error: ""
        });

        const result = processConnections("First Name,Last Name\nAda,Lovelace");

        expect(result.success).toBe(false);
        expect(result.error).toBe("Unable to parse Connections.csv.");

        processSpy.mockRestore();
    });


    it("processConnections returns error when CSV parses but yields no valid rows (line 172)", () => {
        // A valid connections header but every row is empty (all identity fields missing)
        const csv = [
            "Notes:",
            "Export metadata",
            "",
            "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
            ",,,,,,",
            ",,,,,,"
        ].join("\n");

        const result = processConnections(csv);

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/no valid rows/i);
    });

    // ── Worker message listener (lines 187-194) ───────────────────────────────

    it("connections worker listener ignores non-process messages", () => {
        const postMessageSpy = vi.spyOn(globalThis, "postMessage").mockImplementation(() => {});

        globalThis.dispatchEvent(
            Object.assign(new Event("message"), { data: { type: "ping", requestId: "r0", payload: {} } })
        );

        expect(postMessageSpy).not.toHaveBeenCalled();
        postMessageSpy.mockRestore();
    });

    it("connections worker listener posts result for process message type", () => {
        const postMessageSpy = vi.spyOn(globalThis, "postMessage").mockImplementation(() => {});

        const csv = [
            "Notes:",
            "Export metadata",
            "",
            "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
            "Ada,Lovelace,https://linkedin.com/in/ada,,Engines,Mathematician,30 Jan 2024"
        ].join("\n");

        globalThis.dispatchEvent(
            Object.assign(new Event("message"), {
                data: {
                    type: "process",
                    requestId: "conn-req-1",
                    payload: { connectionsCsv: csv }
                }
            })
        );

        expect(postMessageSpy).toHaveBeenCalledOnce();
        const [msg] = postMessageSpy.mock.calls[0];
        expect(msg.type).toBe("processed");
        expect(msg.requestId).toBe("conn-req-1");
        expect(msg.payload.success).toBe(true);
        expect(msg.payload.rows).toBeTruthy();

        postMessageSpy.mockRestore();
    });

    it("connections worker forwards runtime error events", () => {
        const postMessageSpy = vi.spyOn(globalThis, "postMessage").mockImplementation(() => {});

        const event = new Event("error");
        Object.defineProperty(event, "error", { value: new Error("connections-runtime") });
        globalThis.dispatchEvent(event);

        expect(postMessageSpy).toHaveBeenCalled();
        const [message] = postMessageSpy.mock.calls[0];
        expect(message.type).toBe("error");
        expect(message.payload.message).toContain("connections-runtime");

        postMessageSpy.mockRestore();
    });

    it("connections worker forwards unhandled rejections", () => {
        const postMessageSpy = vi.spyOn(globalThis, "postMessage").mockImplementation(() => {});

        const event = new Event("unhandledrejection");
        Object.defineProperty(event, "reason", { value: new Error("connections-rejection") });
        globalThis.dispatchEvent(event);

        expect(postMessageSpy).toHaveBeenCalled();
        const [message] = postMessageSpy.mock.calls[0];
        expect(message.type).toBe("error");
        expect(message.payload.message).toContain("connections-rejection");

        postMessageSpy.mockRestore();
    });

    it("connections worker reports invalid process payloads", () => {
        const postMessageSpy = vi.spyOn(globalThis, "postMessage").mockImplementation(() => {});

        globalThis.dispatchEvent(
            Object.assign(new Event("message"), {
                data: {
                    type: "process",
                    requestId: "conn-invalid",
                    payload: {}
                }
            })
        );

        expect(postMessageSpy).toHaveBeenCalledOnce();
        const [message] = postMessageSpy.mock.calls[0];
        expect(message.type).toBe("error");
        expect(message.payload.message).toContain("Missing connectionsCsv payload");

        postMessageSpy.mockRestore();
    });

    it("connections worker catches processing exceptions and posts normalized error", () => {
        const postMessageSpy = vi.spyOn(globalThis, "postMessage").mockImplementation(() => {});
        const processSpy = vi.spyOn(LinkedInCleaner, "process").mockImplementationOnce(() => {
            throw new Error("connections-failure");
        });

        globalThis.dispatchEvent(
            Object.assign(new Event("message"), {
                data: {
                    type: "process",
                    requestId: "conn-fail",
                    payload: { connectionsCsv: "First Name,Last Name\nAda,Lovelace" }
                }
            })
        );

        expect(postMessageSpy).toHaveBeenCalledOnce();
        const [message] = postMessageSpy.mock.calls[0];
        expect(message.type).toBe("error");
        expect(message.requestId).toBe("conn-fail");
        expect(message.payload.message).toBe("connections-failure");

        processSpy.mockRestore();
        postMessageSpy.mockRestore();
    });

    it("connections worker falls back to generic runtime message for unknown rejection reasons", () => {
        const postMessageSpy = vi.spyOn(globalThis, "postMessage").mockImplementation(() => {});

        const event = new Event("unhandledrejection");
        Object.defineProperty(event, "reason", { value: { unknown: true } });
        globalThis.dispatchEvent(event);

        expect(postMessageSpy).toHaveBeenCalledOnce();
        const [message] = postMessageSpy.mock.calls[0];
        expect(message.type).toBe("error");
        expect(message.payload.message).toBe("Connections worker runtime failure.");

        postMessageSpy.mockRestore();
    });

    it("connections worker error listener falls back when event has no payload", () => {
        const postMessageSpy = vi.spyOn(globalThis, "postMessage").mockImplementation(() => {});

        globalThis.dispatchEvent(new Event("error"));

        expect(postMessageSpy).toHaveBeenCalledOnce();
        const [message] = postMessageSpy.mock.calls[0];
        expect(message.type).toBe("error");
        expect(message.payload.message).toBe("Connections worker runtime failure.");

        postMessageSpy.mockRestore();
    });

    it("connections worker rejection listener falls back when reason is missing", () => {
        const postMessageSpy = vi.spyOn(globalThis, "postMessage").mockImplementation(() => {});

        globalThis.dispatchEvent(new Event("unhandledrejection"));

        expect(postMessageSpy).toHaveBeenCalledOnce();
        const [message] = postMessageSpy.mock.calls[0];
        expect(message.type).toBe("error");
        expect(message.payload.message).toBe("Connections worker runtime failure.");

        postMessageSpy.mockRestore();
    });
});
