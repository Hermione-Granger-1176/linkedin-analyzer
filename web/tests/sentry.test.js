import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/browser", () => ({
    init: vi.fn(),
    close: vi.fn(),
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
                sendDefaultPii: false,
                maxBreadcrumbs: 20,
                beforeSend: expect.any(Function),
                beforeBreadcrumb: expect.any(Function),
            }),
        );

        import.meta.env.VITE_SENTRY_DSN = original;
        import.meta.env.MODE = originalMode;
        import.meta.env.VITE_APP_RELEASE = originalRelease;
    });

    it("scrubs sensitive breadcrumbs via beforeBreadcrumb", async () => {
        const original = import.meta.env.VITE_SENTRY_DSN;
        import.meta.env.VITE_SENTRY_DSN = "https://example@sentry.io/123";

        const sentry = await import("@sentry/browser");
        sentry.init.mockClear();

        const { initSentry, setTelemetryConsent } = await import("../src/sentry.js");
        setTelemetryConsent(true);
        initSentry();

        const { beforeBreadcrumb } = sentry.init.mock.calls[0][0];

        // Categories that can carry user input are dropped entirely.
        expect(beforeBreadcrumb({ category: "console", message: "typed secret" })).toBeNull();
        expect(beforeBreadcrumb({ category: "ui.input", message: "name field" })).toBeNull();
        expect(beforeBreadcrumb(null)).toBeNull();

        // DOM breadcrumbs are kept for context but their message is stripped.
        const ui = beforeBreadcrumb({ category: "ui", message: "div.contact 'Jane Doe'" });
        expect(ui).toEqual({ category: "ui", message: undefined });
        const dom = beforeBreadcrumb({ category: "dom", message: "input[value='secret']" });
        expect(dom).toEqual({ category: "dom", message: undefined });

        // Benign breadcrumbs pass through untouched.
        const nav = { category: "navigation", data: { to: "#/insights" } };
        expect(beforeBreadcrumb(nav)).toBe(nav);

        import.meta.env.VITE_SENTRY_DSN = original;
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

    it("omits filename-related context from error extras", async () => {
        const original = import.meta.env.VITE_SENTRY_DSN;
        import.meta.env.VITE_SENTRY_DSN = "https://example@sentry.io/123";

        const sentry = await import("@sentry/browser");
        const setExtra = vi.fn();
        sentry.withScope.mockImplementationOnce((callback) => {
            callback({
                setExtra,
                setTag: vi.fn(),
                setLevel: vi.fn(),
            });
        });

        const { initSentry, captureError, setTelemetryConsent } = await import("../src/sentry.js");
        setTelemetryConsent(true);
        initSentry();
        captureError(new Error('Reading "private-connections.csv" timed out.'), {
            module: "upload",
            fileName: "private-connections.csv",
            original_file_name: "private-messages.csv",
            fileType: "connections",
        });

        expect(setExtra).toHaveBeenCalledWith("module", "upload");
        expect(setExtra).toHaveBeenCalledWith("fileType", "connections");
        expect(setExtra).not.toHaveBeenCalledWith("fileName", expect.anything());
        expect(setExtra).not.toHaveBeenCalledWith("original_file_name", expect.anything());
        const capturedError = sentry.captureException.mock.calls.at(-1)[0];
        expect(capturedError.message).toBe('Reading "[file]" timed out.');
        expect(capturedError.stack).not.toContain("private-connections.csv");

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

    it("buffers metrics and flushes them as one numeric session-metrics event", async () => {
        const original = import.meta.env.VITE_SENTRY_DSN;
        import.meta.env.VITE_SENTRY_DSN = "https://example@sentry.io/123";

        const sentry = await import("@sentry/browser");
        sentry.captureMessage.mockClear();
        const setExtra = vi.fn();
        sentry.withScope.mockImplementationOnce((callback) => {
            callback({ setExtra, setTag: vi.fn(), setLevel: vi.fn() });
        });

        const { initSentry, captureMetric, flushMetrics, setTelemetryConsent } = await import(
            "../src/sentry.js"
        );
        setTelemetryConsent(true);
        initSentry();

        // Buffering does not send anything on its own.
        captureMetric("web-vital:LCP", 2500);
        captureMetric("web-vital:LCP", 2600);
        captureMetric("perf:load", 123.4);
        expect(sentry.captureMessage).not.toHaveBeenCalled();

        flushMetrics();
        expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
        expect(sentry.captureMessage).toHaveBeenCalledWith("session-metrics");
        // Latest value wins; repeated metrics carry a count.
        expect(setExtra).toHaveBeenCalledWith("metric:web-vital:LCP", 2600);
        expect(setExtra).toHaveBeenCalledWith("metric:web-vital:LCP:count", 2);
        expect(setExtra).toHaveBeenCalledWith("metric:perf:load", 123.4);
        // Only numeric extras are emitted.
        for (const [, value] of setExtra.mock.calls) {
            expect(typeof value).toBe("number");
        }

        import.meta.env.VITE_SENTRY_DSN = original;
    });

    it("flushMetrics is a no-op when nothing is buffered", async () => {
        const original = import.meta.env.VITE_SENTRY_DSN;
        import.meta.env.VITE_SENTRY_DSN = "https://example@sentry.io/123";

        const sentry = await import("@sentry/browser");
        sentry.captureMessage.mockClear();

        const { initSentry, flushMetrics, setTelemetryConsent } = await import("../src/sentry.js");
        setTelemetryConsent(true);
        initSentry();
        flushMetrics();

        expect(sentry.captureMessage).not.toHaveBeenCalled();

        import.meta.env.VITE_SENTRY_DSN = original;
    });

    it("flushes buffered metrics when the page is hidden", async () => {
        const original = import.meta.env.VITE_SENTRY_DSN;
        import.meta.env.VITE_SENTRY_DSN = "https://example@sentry.io/123";

        const sentry = await import("@sentry/browser");
        sentry.captureMessage.mockClear();

        const { initSentry, captureMetric, setTelemetryConsent } = await import("../src/sentry.js");
        setTelemetryConsent(true);
        initSentry();
        captureMetric("perf:load", 10);

        Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => "hidden",
        });
        document.dispatchEvent(new Event("visibilitychange"));

        expect(sentry.captureMessage).toHaveBeenCalledWith("session-metrics");

        import.meta.env.VITE_SENTRY_DSN = original;
    });

    it("does not flush on visibilitychange while the page stays visible", async () => {
        const original = import.meta.env.VITE_SENTRY_DSN;
        import.meta.env.VITE_SENTRY_DSN = "https://example@sentry.io/123";

        const sentry = await import("@sentry/browser");
        sentry.captureMessage.mockClear();

        const { initSentry, captureMetric, setTelemetryConsent } = await import("../src/sentry.js");
        setTelemetryConsent(true);
        initSentry();
        captureMetric("perf:load", 10);

        Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => "visible",
        });
        document.dispatchEvent(new Event("visibilitychange"));

        expect(sentry.captureMessage).not.toHaveBeenCalled();

        import.meta.env.VITE_SENTRY_DSN = original;
    });

    it("re-initializing keeps a single flush batch", async () => {
        const original = import.meta.env.VITE_SENTRY_DSN;
        import.meta.env.VITE_SENTRY_DSN = "https://example@sentry.io/123";

        const sentry = await import("@sentry/browser");
        sentry.captureMessage.mockClear();

        const { initSentry, captureMetric, flushMetrics, setTelemetryConsent } = await import(
            "../src/sentry.js"
        );
        setTelemetryConsent(true);
        // A second init (e.g. re-enabling after revoke) must not duplicate flush wiring.
        initSentry();
        initSentry();
        captureMetric("perf:load", 10);
        flushMetrics();

        expect(sentry.captureMessage).toHaveBeenCalledTimes(1);

        import.meta.env.VITE_SENTRY_DSN = original;
    });

    it("ignores invalid metric payloads", async () => {
        const original = import.meta.env.VITE_SENTRY_DSN;
        import.meta.env.VITE_SENTRY_DSN = "https://example@sentry.io/123";

        const sentry = await import("@sentry/browser");
        sentry.captureMessage.mockClear();

        const { initSentry, captureMetric, flushMetrics, setTelemetryConsent } = await import(
            "../src/sentry.js"
        );
        setTelemetryConsent(true);
        initSentry();
        captureMetric("", 123);
        captureMetric("perf:bad", Number.NaN);
        flushMetrics();

        expect(sentry.captureMessage).not.toHaveBeenCalled();

        import.meta.env.VITE_SENTRY_DSN = original;
    });

    it("stops capturing after telemetry is disabled at runtime", async () => {
        const original = import.meta.env.VITE_SENTRY_DSN;
        import.meta.env.VITE_SENTRY_DSN = "https://example@sentry.io/123";

        const sentry = await import("@sentry/browser");
        sentry.captureMessage.mockClear();
        sentry.captureException.mockClear();

        const {
            initSentry,
            captureMetric,
            captureError,
            disableTelemetry,
            flushMetrics,
            setTelemetryConsent,
        } = await import("../src/sentry.js");
        setTelemetryConsent(true);
        initSentry();
        captureMetric("perf:load", 10);

        disableTelemetry();
        expect(sentry.close).toHaveBeenCalled();

        // Buffered metrics are dropped and later captures are no-ops.
        flushMetrics();
        captureMetric("perf:load", 20);
        captureError(new Error("after-revoke"));
        flushMetrics();
        expect(sentry.captureMessage).not.toHaveBeenCalled();
        expect(sentry.captureException).not.toHaveBeenCalled();

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
