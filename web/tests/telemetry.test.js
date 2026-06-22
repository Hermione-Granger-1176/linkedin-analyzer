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

        reportPerformanceMeasure("messages:render", 44.7);

        expect(sentry.captureMetric).toHaveBeenCalledWith("perf:messages:render", 44.7);
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

    it("reports web-vital values numerically by name", async () => {
        const vitals = await import("web-vitals");

        vitals.onCLS.mockImplementation((callback) => callback({ name: "CLS", value: 0.12 }));
        vitals.onLCP.mockImplementation((callback) => callback({ name: "LCP", value: 2500 }));
        vitals.onINP.mockImplementation(() => {});
        vitals.onFCP.mockImplementation(() => {});
        vitals.onTTFB.mockImplementation(() => {});

        const sentry = await import("../src/sentry.js");
        const { initTelemetry } = await import("../src/telemetry.js");

        initTelemetry();

        // Metrics carry only a name and a numeric value, no string context payload.
        expect(sentry.captureMetric).toHaveBeenCalledWith("web-vital:CLS", 0.12);
        expect(sentry.captureMetric).toHaveBeenCalledWith("web-vital:LCP", 2500);
        for (const call of sentry.captureMetric.mock.calls) {
            expect(call).toHaveLength(2);
        }
    });
});
