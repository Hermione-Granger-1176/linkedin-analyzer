import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/browser", () => ({
    init: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    withScope: vi.fn((callback) => {
        const scope = {
            setExtra: vi.fn(),
            setTag: vi.fn(),
            setLevel: vi.fn(),
        };
        callback(scope);
    }),
}));

describe("sentry", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        window.localStorage.clear();
    });

    it("does nothing when DSN is missing", async () => {
        const { initSentry, captureError, captureMetric } = await import("../src/sentry.js");
        initSentry();
        captureError(new Error("boom"));
        captureMetric("perf:test", 10);
        const sentry = await import("@sentry/browser");
        expect(sentry.init).not.toHaveBeenCalled();
        expect(sentry.captureException).not.toHaveBeenCalled();
        expect(sentry.captureMessage).not.toHaveBeenCalled();
    });

    it("does not initialize Sentry until telemetry consent is granted", async () => {
        const original = import.meta.env.VITE_SENTRY_DSN;
        import.meta.env.VITE_SENTRY_DSN = "https://example@sentry.io/123";

        const sentry = await import("@sentry/browser");
        const { initSentry } = await import("../src/sentry.js");
        window.localStorage.removeItem("linkedin-analyzer:telemetry-consent");

        initSentry();
        expect(sentry.init).not.toHaveBeenCalled();

        import.meta.env.VITE_SENTRY_DSN = original;
    });

    it("stores telemetry consent when enabled", async () => {
        const { setTelemetryConsent, telemetryConsentGranted } = await import("../src/sentry.js");
        setTelemetryConsent(true);
        expect(telemetryConsentGranted()).toBe(true);
        setTelemetryConsent(false);
        expect(telemetryConsentGranted()).toBe(false);
    });

    it("initializes and captures when DSN is present", async () => {
        const original = import.meta.env.VITE_SENTRY_DSN;
        import.meta.env.VITE_SENTRY_DSN = "https://example@sentry.io/123";
        import.meta.env.MODE = "test";

        const { initSentry, captureError, setTelemetryConsent } = await import("../src/sentry.js");
        setTelemetryConsent(true);
        initSentry();
        captureError(new Error("boom"));

        const sentry = await import("@sentry/browser");
        expect(sentry.init).toHaveBeenCalled();
        expect(sentry.captureException).toHaveBeenCalled();

        import.meta.env.VITE_SENTRY_DSN = original;
    });

    it("initializes Sentry with DSN, environment, and release metadata", async () => {
        const original = import.meta.env.VITE_SENTRY_DSN;
        const originalMode = import.meta.env.MODE;
        const originalRelease = import.meta.env.VITE_APP_RELEASE;
        import.meta.env.VITE_SENTRY_DSN = "https://key@sentry.io/999";
        import.meta.env.MODE = "production";
        import.meta.env.VITE_APP_RELEASE = "sha-123";

        const { initSentry, setTelemetryConsent } = await import("../src/sentry.js");
        setTelemetryConsent(true);
        initSentry();

        const sentry = await import("@sentry/browser");
        expect(sentry.init).toHaveBeenCalledWith(
            expect.objectContaining({
                dsn: "https://key@sentry.io/999",
                environment: "production",
                release: "sha-123",
                beforeSend: expect.any(Function),
            }),
        );

        import.meta.env.VITE_SENTRY_DSN = original;
        import.meta.env.MODE = originalMode;
        import.meta.env.VITE_APP_RELEASE = originalRelease;
    });

    it("captureError is a no-op when sentryReady is false (DSN not set)", async () => {
        // Ensure no DSN is set
        const savedDsn = import.meta.env.VITE_SENTRY_DSN;
        import.meta.env.VITE_SENTRY_DSN = "";

        const sentry = await import("@sentry/browser");
        sentry.captureException.mockClear();

        const { initSentry, captureError } = await import("../src/sentry.js");
        initSentry(); // DSN is '' → sentryReady = false

        // Must not throw; captureException must not be called
        expect(() => captureError(new Error("silent"))).not.toThrow();
        expect(sentry.captureException).not.toHaveBeenCalled();

        import.meta.env.VITE_SENTRY_DSN = savedDsn;
    });

    it("captures with context via Sentry scope", async () => {
        const original = import.meta.env.VITE_SENTRY_DSN;
        import.meta.env.VITE_SENTRY_DSN = "https://example@sentry.io/123";

        const sentry = await import("@sentry/browser");
        sentry.captureException.mockClear();
        sentry.withScope.mockClear();

        const { initSentry, captureError, setTelemetryConsent } = await import("../src/sentry.js");
        setTelemetryConsent(true);
        initSentry();
        captureError(new Error("ctx"), { feature: "upload", count: undefined });

        expect(sentry.withScope).toHaveBeenCalledTimes(1);
        expect(sentry.captureException).toHaveBeenCalledTimes(1);

        import.meta.env.VITE_SENTRY_DSN = original;
    });

    it("filters noisy browser-extension errors via beforeSend", async () => {
        const original = import.meta.env.VITE_SENTRY_DSN;
        import.meta.env.VITE_SENTRY_DSN = "https://example@sentry.io/123";

        const sentry = await import("@sentry/browser");
        sentry.init.mockClear();

        const { initSentry, setTelemetryConsent } = await import("../src/sentry.js");
        setTelemetryConsent(true);
        initSentry();

        const initArgs = sentry.init.mock.calls[0][0];
        const noisyEvent = {
            exception: {
                values: [
                    {
                        value: "Script error from chrome-extension://abcdef",
                        stacktrace: {
                            frames: [{ filename: "chrome-extension://abcdef/content.js" }],
                        },
                    },
                ],
            },
        };
        const cleanEvent = { message: "Something real happened" };

        expect(initArgs.beforeSend(noisyEvent)).toBeNull();
        expect(initArgs.beforeSend(cleanEvent)).toEqual(cleanEvent);

        import.meta.env.VITE_SENTRY_DSN = original;
    });

    it("filters noisy stack frame filenames and ignores malformed events", async () => {
        const original = import.meta.env.VITE_SENTRY_DSN;
        import.meta.env.VITE_SENTRY_DSN = "https://example@sentry.io/123";

        const sentry = await import("@sentry/browser");
        sentry.init.mockClear();

        const { initSentry, setTelemetryConsent } = await import("../src/sentry.js");
        setTelemetryConsent(true);
        initSentry();

        const initArgs = sentry.init.mock.calls[0][0];
        const stackNoiseEvent = {
            exception: {
                values: [
                    {
                        value: "TypeError: boom",
                        stacktrace: {
                            frames: [{ filename: "moz-extension://abcdef/content.js" }],
                        },
                    },
                ],
            },
        };

        expect(initArgs.beforeSend(stackNoiseEvent)).toBeNull();
        expect(initArgs.beforeSend(null)).toBeNull();
        expect(initArgs.beforeSend("not-an-object")).toBe("not-an-object");

        import.meta.env.VITE_SENTRY_DSN = original;
    });

    it("captures metric messages when Sentry is ready", async () => {
        const original = import.meta.env.VITE_SENTRY_DSN;
        import.meta.env.VITE_SENTRY_DSN = "https://example@sentry.io/123";

        const sentry = await import("@sentry/browser");
        sentry.captureMessage.mockClear();

        const { initSentry, captureMetric, setTelemetryConsent } = await import("../src/sentry.js");
        setTelemetryConsent(true);
        initSentry();
        captureMetric("perf:load", 123.4, { module: "unit-test" });

        expect(sentry.withScope).toHaveBeenCalledTimes(1);
        expect(sentry.captureMessage).toHaveBeenCalledWith("metric:perf:load");

        import.meta.env.VITE_SENTRY_DSN = original;
    });

    it("ignores invalid metric payloads", async () => {
        const original = import.meta.env.VITE_SENTRY_DSN;
        import.meta.env.VITE_SENTRY_DSN = "https://example@sentry.io/123";

        const sentry = await import("@sentry/browser");
        sentry.captureMessage.mockClear();

        const { initSentry, captureMetric, setTelemetryConsent } = await import("../src/sentry.js");
        setTelemetryConsent(true);
        initSentry();
        captureMetric("", 123);
        captureMetric("perf:bad", Number.NaN);

        expect(sentry.captureMessage).not.toHaveBeenCalled();

        import.meta.env.VITE_SENTRY_DSN = original;
    });

    it("swallows Sentry capture failures", async () => {
        const original = import.meta.env.VITE_SENTRY_DSN;
        import.meta.env.VITE_SENTRY_DSN = "https://example@sentry.io/123";

        const sentry = await import("@sentry/browser");
        sentry.withScope.mockImplementation(() => {
            throw new Error("scope-failed");
        });

        const { initSentry, captureError, setTelemetryConsent } = await import("../src/sentry.js");
        setTelemetryConsent(true);
        initSentry();

        expect(() => captureError(new Error("boom"), { route: "/upload" })).not.toThrow();

        import.meta.env.VITE_SENTRY_DSN = original;
        sentry.withScope.mockImplementation((callback) => {
            const scope = {
                setExtra: vi.fn(),
                setTag: vi.fn(),
                setLevel: vi.fn(),
            };
            callback(scope);
        });
    });
});
