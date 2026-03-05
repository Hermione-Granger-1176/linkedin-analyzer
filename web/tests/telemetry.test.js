import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("web-vitals", () => ({
    onCLS: vi.fn(),
    onFCP: vi.fn(),
    onINP: vi.fn(),
    onLCP: vi.fn(),
    onTTFB: vi.fn(),
}));

vi.mock("../src/sentry.js", () => ({
    captureError: vi.fn(),
    captureMetric: vi.fn(),
}));

describe("telemetry", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it("initializes web-vitals reporters once", async () => {
        const vitals = await import("web-vitals");
        const handlers = {
            onCLS: vitals.onCLS,
            onFCP: vitals.onFCP,
            onINP: vitals.onINP,
            onLCP: vitals.onLCP,
            onTTFB: vitals.onTTFB,
        };

        Object.values(handlers).forEach((handler) => {
            handler.mockImplementation((callback) =>
                callback({
                    name: "CLS",
                    value: 123,
                    delta: 12,
                    rating: "good",
                    id: "vital-1",
                    navigationType: "navigate",
                }),
            );
        });

        const sentry = await import("../src/sentry.js");
        const { initTelemetry } = await import("../src/telemetry.js");

        initTelemetry();
        initTelemetry();

        expect(vitals.onCLS).toHaveBeenCalledTimes(1);
        expect(vitals.onFCP).toHaveBeenCalledTimes(1);
        expect(vitals.onINP).toHaveBeenCalledTimes(1);
        expect(vitals.onLCP).toHaveBeenCalledTimes(1);
        expect(vitals.onTTFB).toHaveBeenCalledTimes(1);
        expect(sentry.captureMetric).toHaveBeenCalled();
    });

    it("reports measured durations with perf prefix", async () => {
        const sentry = await import("../src/sentry.js");
        const { reportPerformanceMeasure } = await import("../src/telemetry.js");

        reportPerformanceMeasure("messages:render", 44.7, { module: "messages-insights" });

        expect(sentry.captureMetric).toHaveBeenCalledWith("perf:messages:render", 44.7, {
            module: "messages-insights",
            unit: "ms",
        });
    });

    it("ignores invalid measure payloads", async () => {
        const sentry = await import("../src/sentry.js");
        const { reportPerformanceMeasure } = await import("../src/telemetry.js");

        reportPerformanceMeasure("", 10);
        reportPerformanceMeasure("render", Number.NaN);
        reportPerformanceMeasure("render", -1);

        expect(sentry.captureMetric).not.toHaveBeenCalled();
    });

    it("captures init errors from web-vitals hooks", async () => {
        const vitals = await import("web-vitals");
        vitals.onCLS.mockImplementation(() => {
            throw new Error("vitals-failed");
        });

        const sentry = await import("../src/sentry.js");
        const { initTelemetry } = await import("../src/telemetry.js");

        initTelemetry();

        expect(sentry.captureError).toHaveBeenCalled();
    });

    it("ignores malformed web-vitals callback payloads", async () => {
        const vitals = await import("web-vitals");

        vitals.onCLS.mockImplementation((callback) => callback(null));
        vitals.onINP.mockImplementation((callback) => callback({ name: "INP", value: Number.NaN }));
        vitals.onLCP.mockImplementation((callback) =>
            callback({ name: "LCP", value: "not-a-number" }),
        );
        vitals.onFCP.mockImplementation((callback) => callback({ name: "FCP", value: 123 }));
        vitals.onTTFB.mockImplementation((callback) => callback({ name: "TTFB", value: 42 }));

        const sentry = await import("../src/sentry.js");
        const { initTelemetry } = await import("../src/telemetry.js");

        initTelemetry();

        expect(sentry.captureMetric).toHaveBeenCalledTimes(2);
    });

    it("reports CLS with empty unit and timing vitals with ms", async () => {
        const vitals = await import("web-vitals");

        vitals.onCLS.mockImplementation((callback) =>
            callback({
                name: "CLS",
                value: 0.12,
                delta: 0.01,
                rating: "good",
                id: "cls-1",
                navigationType: "navigate",
            }),
        );
        vitals.onLCP.mockImplementation((callback) =>
            callback({
                name: "LCP",
                value: 2500,
                delta: 100,
                rating: "needs-improvement",
                id: "lcp-1",
                navigationType: "navigate",
            }),
        );
        vitals.onINP.mockImplementation(() => {});
        vitals.onFCP.mockImplementation(() => {});
        vitals.onTTFB.mockImplementation(() => {});

        const sentry = await import("../src/sentry.js");
        const { initTelemetry } = await import("../src/telemetry.js");

        initTelemetry();

        const calls = sentry.captureMetric.mock.calls;
        const clsCall = calls.find((c) => c[0] === "web-vital:CLS");
        const lcpCall = calls.find((c) => c[0] === "web-vital:LCP");

        expect(clsCall[2].unit).toBe("");
        expect(lcpCall[2].unit).toBe("ms");
    });
});
