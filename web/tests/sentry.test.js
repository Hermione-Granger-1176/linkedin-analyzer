import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/browser", () => ({
    init: vi.fn(),
    close: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
}));

const CONSENT_KEY = "linkedin-analyzer:telemetry-consent";
const VALID_EVENT_ID = "0123456789abcdef0123456789abcdef";
const VALID_DEBUG_ID = "12345678-1234-4abc-8def-1234567890ab";
const PRIVATE_MARKER = "PRIVATE_MARKER_7f9d";

async function enableSentry({ environment = "test", release = "release-test" } = {}) {
    import.meta.env.VITE_SENTRY_DSN = "https://key@sentry.io/123";
    import.meta.env.MODE = environment;
    import.meta.env.VITE_APP_RELEASE = release;

    const sentry = await import("@sentry/browser");
    const api = await import("../src/sentry.js");
    api.setTelemetryConsent(true);
    api.initSentry();
    return { api, sentry, options: sentry.init.mock.calls.at(-1)[0] };
}

describe("sentry", () => {
    const originalDsn = import.meta.env.VITE_SENTRY_DSN;
    const originalMode = import.meta.env.MODE;
    const originalRelease = import.meta.env.VITE_APP_RELEASE;

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        window.localStorage.clear();
        import.meta.env.VITE_SENTRY_DSN = originalDsn;
        import.meta.env.MODE = originalMode;
        import.meta.env.VITE_APP_RELEASE = originalRelease;
    });

    afterEach(() => {
        delete document.visibilityState;
    });

    it("keeps telemetry disabled without both a DSN and explicit consent", async () => {
        const sentry = await import("@sentry/browser");
        const { captureError, captureMetric, initSentry } = await import("../src/sentry.js");

        import.meta.env.VITE_SENTRY_DSN = "";
        initSentry();
        captureError(new Error("ignored"));
        captureMetric("web-vital:LCP", 10);
        expect(sentry.init).not.toHaveBeenCalled();
        expect(sentry.captureException).not.toHaveBeenCalled();

        import.meta.env.VITE_SENTRY_DSN = "https://key@sentry.io/123";
        initSentry();
        expect(sentry.init).not.toHaveBeenCalled();
    });

    it("stores and revokes telemetry consent", async () => {
        const { setTelemetryConsent, telemetryConsentGranted } = await import("../src/sentry.js");

        setTelemetryConsent(true);
        expect(window.localStorage.getItem(CONSENT_KEY)).toBe("granted");
        expect(telemetryConsentGranted()).toBe(true);

        setTelemetryConsent(false);
        expect(window.localStorage.getItem(CONSENT_KEY)).toBeNull();
        expect(telemetryConsentGranted()).toBe(false);
    });

    it("initializes the SDK without integrations, PII, or breadcrumbs", async () => {
        const { options } = await enableSentry({ environment: "production", release: "sha-123" });

        expect(options).toEqual(
            expect.objectContaining({
                dsn: "https://key@sentry.io/123",
                environment: "production",
                release: "sha-123",
                defaultIntegrations: false,
                sendDefaultPii: false,
                maxBreadcrumbs: 0,
                beforeSend: expect.any(Function),
                beforeBreadcrumb: expect.any(Function),
            }),
        );
        expect(options.beforeBreadcrumb({ category: "navigation", message: PRIVATE_MARKER })).toBeNull();
    });

    it("omits a blank release from SDK configuration and reduced events", async () => {
        const { options } = await enableSentry({ release: "   " });
        expect(options.release).toBeUndefined();

        const reduced = options.beforeSend({
            exception: { values: [{ type: "TypeError", value: PRIVATE_MARKER }] },
        });
        expect(reduced.release).toBeUndefined();
    });

    it("reduces crafted error events to the fixed outbound privacy schema", async () => {
        const { options } = await enableSentry({
            environment: "production",
            release: "release-safe",
        });
        const origin = window.location.origin;
        const hint = {
            attachments: [{ filename: `${PRIVATE_MARKER}.txt`, data: PRIVATE_MARKER }],
        };
        const event = {
            event_id: VALID_EVENT_ID.toUpperCase(),
            timestamp: 1234.5,
            level: PRIVATE_MARKER,
            platform: PRIVATE_MARKER,
            environment: PRIVATE_MARKER,
            release: PRIVATE_MARKER,
            message: PRIVATE_MARKER,
            exception: {
                values: [
                    {
                        type: `Custom${PRIVATE_MARKER}`,
                        value: PRIVATE_MARKER,
                        module: PRIVATE_MARKER,
                        mechanism: { type: PRIVATE_MARKER, data: { secret: PRIVATE_MARKER } },
                        stacktrace: {
                            frames: [
                                {
                                    filename: `${origin}/src/app.js?token=${PRIVATE_MARKER}#${PRIVATE_MARKER}`,
                                    abs_path: `/home/${PRIVATE_MARKER}/app.js`,
                                    function: PRIVATE_MARKER,
                                    module: PRIVATE_MARKER,
                                    context_line: PRIVATE_MARKER,
                                    pre_context: [PRIVATE_MARKER],
                                    post_context: [PRIVATE_MARKER],
                                    vars: { secret: PRIVATE_MARKER },
                                    lineno: 12,
                                    colno: 7,
                                    in_app: true,
                                    unknown: PRIVATE_MARKER,
                                },
                                {
                                    filename: `https://cross-origin.example/src/${PRIVATE_MARKER}.js`,
                                    lineno: 99,
                                },
                            ],
                        },
                        custom: PRIVATE_MARKER,
                    },
                    { type: "Error", value: PRIVATE_MARKER },
                ],
            },
            request: { url: `https://example.com/?q=${PRIVATE_MARKER}`, data: PRIVATE_MARKER },
            user: { name: PRIVATE_MARKER, email: `${PRIVATE_MARKER}@example.com` },
            breadcrumbs: [{ message: PRIVATE_MARKER, data: { secret: PRIVATE_MARKER } }],
            contexts: { trace: { data: PRIVATE_MARKER }, custom: { secret: PRIVATE_MARKER } },
            tags: {
                module: "upload",
                operation: "read-file",
                fileType: "connections",
                expectedType: "messages",
                exportType: "top-contacts",
                private: PRIVATE_MARKER,
            },
            extra: {
                private: PRIVATE_MARKER,
                serialized: { nested: [PRIVATE_MARKER] },
                url: `https://example.com/${PRIVATE_MARKER}?q=${PRIVATE_MARKER}`,
            },
            logentry: { message: PRIVATE_MARKER },
            logger: PRIVATE_MARKER,
            transaction: PRIVATE_MARKER,
            fingerprint: [PRIVATE_MARKER],
            modules: { [PRIVATE_MARKER]: PRIVATE_MARKER },
            threads: { values: [{ name: PRIVATE_MARKER }] },
            spans: [{ description: PRIVATE_MARKER }],
            measurements: { private: { value: 1, unit: PRIVATE_MARKER } },
            sdk: { name: PRIVATE_MARKER, integrations: [PRIVATE_MARKER] },
            debug_meta: {
                images: [
                    {
                        type: "sourcemap",
                        code_file: `${origin}/assets/index-safe.js?token=${PRIVATE_MARKER}#${PRIVATE_MARKER}`,
                        debug_id: VALID_DEBUG_ID.toUpperCase(),
                        private: PRIVATE_MARKER,
                    },
                    {
                        type: "sourcemap",
                        code_file: `${origin}/assets/${PRIVATE_MARKER}.js`,
                        debug_id: PRIVATE_MARKER,
                    },
                ],
                private: PRIVATE_MARKER,
            },
            unknown: PRIVATE_MARKER,
        };

        const reduced = options.beforeSend(event, hint);
        expect(JSON.stringify(reduced)).not.toContain(PRIVATE_MARKER);
        expect(hint.attachments).toEqual([]);
        expect(reduced).toEqual({
            level: "error",
            platform: "javascript",
            environment: "production",
            release: "release-safe",
            event_id: VALID_EVENT_ID,
            timestamp: 1234.5,
            exception: {
                values: [
                    {
                        type: "Error",
                        value: "upload.read-file",
                        stacktrace: {
                            frames: [
                                {
                                    filename: "/src/app.js",
                                    lineno: 12,
                                    colno: 7,
                                    in_app: true,
                                },
                            ],
                        },
                    },
                ],
            },
            tags: {
                module: "upload",
                operation: "read-file",
                fileType: "connections",
                expectedType: "messages",
                exportType: "top-contacts",
            },
            debug_meta: {
                images: [
                    {
                        type: "sourcemap",
                        code_file: "/assets/index-safe.js",
                        debug_id: VALID_DEBUG_ID,
                    },
                ],
            },
        });
    });

    it("keeps only same-origin app, development, and service-worker script paths", async () => {
        const { options } = await enableSentry();
        const origin = window.location.origin;
        const safeFilenames = [
            `${origin}/src/app.js?private=query#fragment`,
            "/assets/index-abc.mjs",
            "/node_modules/.vite/deps/chunk-ABC.js?v=1",
            "/@vite/client",
            "/sw.js",
        ];
        const unsafeFilenames = [
            "https://cross-origin.example/src/app.js",
            "file:///home/private/app.js",
            "blob:https://localhost/private",
            "data:text/javascript,private",
            "C:\\Users\\Private\\app.js",
            "/home/private/app.js",
            "/tmp/private.js",
            "//cross-origin.example/assets/app.js",
            "/index.html",
        ];
        const frames = [
            ...safeFilenames.map((filename, index) => ({
                filename,
                lineno: index,
                colno: index + 1,
                in_app: index % 2 === 0,
            })),
            ...unsafeFilenames.map((filename) => ({ filename, lineno: 99 })),
            { filename: "/src/invalid.js", lineno: -1, colno: 1.5, in_app: "yes" },
            ...Array.from({ length: 25 }, (_, index) => ({
                filename: `/src/frame-${index}.js`,
                lineno: index,
            })),
        ];

        const reduced = options.beforeSend({
            exception: { values: [{ type: "DOMException", stacktrace: { frames } }] },
        });
        const reducedFrames = reduced.exception.values[0].stacktrace.frames;

        expect(reducedFrames).toHaveLength(20);
        expect(reducedFrames.slice(0, 5).map((frame) => frame.filename)).toEqual([
            "/src/app.js",
            "/assets/index-abc.mjs",
            "/node_modules/.vite/deps/chunk-ABC.js",
            "/@vite/client",
            "/sw.js",
        ]);
        expect(reducedFrames[5]).toEqual({ filename: "/src/invalid.js" });
        expect(reduced.exception.values[0].type).toBe("DOMException");
        const serialized = JSON.stringify(reducedFrames);
        for (const unsafe of unsafeFilenames) {
            expect(serialized).not.toContain(unsafe);
        }
        expect(
            options.beforeSend({
                exception: {
                    values: [
                        {
                            type: "Error",
                            stacktrace: {
                                frames: [{ filename: "chrome-extension://abcdef/content.js" }],
                            },
                        },
                    ],
                },
            }),
        ).toBeNull();
    });

    it.each([
        "DOMException",
        "DataCloneError",
        "InvalidStateError",
        "NonError",
        "QuotaExceededError",
    ])("preserves the allowlisted exception type %s", async (type) => {
        const { options } = await enableSentry();

        const reduced = options.beforeSend({ exception: { values: [{ type }] } });

        expect(reduced.exception.values[0].type).toBe(type);
    });

    it("drops malformed debug images and unsupported event shapes", async () => {
        const { options } = await enableSentry();
        const baseEvent = {
            exception: {
                values: [
                    {
                        type: "TypeError",
                        stacktrace: { frames: [{ filename: "/src/app.js" }] },
                    },
                ],
            },
            debug_meta: {
                images: [
                    null,
                    { type: "elf", code_file: "/assets/app.js", debug_id: VALID_DEBUG_ID },
                    { type: "sourcemap", code_file: "/home/private/app.js", debug_id: VALID_DEBUG_ID },
                    { type: "sourcemap", code_file: "/assets/app.js", debug_id: "invalid" },
                ],
            },
        };

        expect(options.beforeSend(baseEvent).debug_meta).toBeUndefined();

        const cappedDebugMeta = options.beforeSend({
            exception: { values: [{ type: "Error" }] },
            debug_meta: {
                images: Array.from({ length: 25 }, () => ({
                    type: "sourcemap",
                    code_file: "/assets/app.js",
                    debug_id: VALID_DEBUG_ID,
                })),
            },
        }).debug_meta;
        expect(cappedDebugMeta.images).toHaveLength(20);

        expect(options.beforeSend(null)).toBeNull();
        expect(options.beforeSend("not-an-event")).toBeNull();
        expect(options.beforeSend({ message: "unsupported" })).toBeNull();
        expect(options.beforeSend({ exception: {} })).toBeNull();
        expect(options.beforeSend({ exception: { values: [] } })).toBeNull();
        expect(options.beforeSend({ exception: { values: [null] } })).toBeNull();
    });

    it("filters known browser noise before reducing the original event", async () => {
        const { options } = await enableSentry();
        const hint = { attachments: [{ data: PRIVATE_MARKER }] };

        expect(
            options.beforeSend(
                {
                    message: "ResizeObserver loop limit exceeded",
                    exception: { values: [{ type: "Error" }] },
                },
                hint,
            ),
        ).toBeNull();
        expect(hint.attachments).toEqual([]);
        expect(
            options.beforeSend({
                exception: {
                    values: [
                        {
                            value: "worker failed",
                            stacktrace: {
                                frames: [{ filename: "moz-extension://abcdef/content.js" }],
                            },
                        },
                    ],
                },
            }),
        ).toBeNull();
    });

    it("replaces every non-Error input with a fresh generic Error", async () => {
        const { api, sentry } = await enableSentry();
        const inputs = [
            `string-${PRIVATE_MARKER}`,
            {
                secret: PRIVATE_MARKER,
                toString() {
                    throw new Error("must not inspect");
                },
                toJSON() {
                    throw new Error("must not serialize");
                },
            },
            [PRIVATE_MARKER],
            Symbol(PRIVATE_MARKER),
            function privateFunction() {
                throw new Error(PRIVATE_MARKER);
            },
        ];

        inputs.forEach((input) => api.captureError(input));
        const captures = sentry.captureException.mock.calls.map(([error]) => error);
        expect(captures).toHaveLength(inputs.length);
        captures.forEach((error) => {
            expect(error).toBeInstanceOf(Error);
            expect(error.name).toBe("NonError");
            expect(error.message).toBe("Non-Error value captured");
            expect(`${error.name}:${error.message}`).not.toContain(PRIVATE_MARKER);
        });
        expect(new Set(captures).size).toBe(inputs.length);
    });

    it("keeps Error instances and passes only allowlisted diagnostic tags", async () => {
        const { api, sentry } = await enableSentry();
        const error = new TypeError(PRIVATE_MARKER);

        api.captureError(error, {
            module: "upload",
            operation: "persist-processed-file",
            fileType: "shares",
            expectedType: "connections",
            exportType: "silent-connections",
            fileName: `${PRIVATE_MARKER}.csv`,
            jobId: PRIVATE_MARKER,
            requestId: PRIVATE_MARKER,
            size: 123,
            url: `https://example.com/?q=${PRIVATE_MARKER}`,
            route: PRIVATE_MARKER,
            source: PRIVATE_MARKER,
            object: { private: PRIVATE_MARKER },
            array: [PRIVATE_MARKER],
            unknown: PRIVATE_MARKER,
        });

        expect(sentry.captureException).toHaveBeenCalledWith(error, {
            tags: {
                module: "upload",
                operation: "persist-processed-file",
                fileType: "shares",
                expectedType: "connections",
                exportType: "silent-connections",
            },
        });

        const unknownError = new Error("unknown");
        api.captureError(unknownError, {
            module: PRIVATE_MARKER,
            operation: PRIVATE_MARKER,
            fileType: PRIVATE_MARKER,
        });
        expect(sentry.captureException).toHaveBeenLastCalledWith(unknownError);
    });

    it("uses captured-error when validated module and operation tags are incomplete", async () => {
        const { options } = await enableSentry();
        const reduced = options.beforeSend({
            event_id: "not-valid",
            timestamp: Number.NaN,
            exception: { values: [{ type: "RangeError" }] },
            tags: { module: "upload", operation: PRIVATE_MARKER },
        });

        expect(reduced.event_id).toBeUndefined();
        expect(reduced.timestamp).toBeUndefined();
        expect(reduced.tags).toEqual({ module: "upload" });
        expect(reduced.exception.values[0]).toEqual({
            type: "RangeError",
            value: "captured-error",
        });
    });

    it("buffers only allowlisted nonnegative finite metrics and flushes once", async () => {
        const { api, sentry } = await enableSentry();

        api.captureMetric("web-vital:LCP", 2500);
        api.captureMetric("web-vital:LCP", 2600);
        api.captureMetric("perf:messages:render", 0);
        api.captureMetric(`perf:${PRIVATE_MARKER}`, 10);
        api.captureMetric("web-vital:CLS", -1);
        api.captureMetric("web-vital:FCP", Number.NaN);
        api.captureMetric("web-vital:INP", Number.POSITIVE_INFINITY);
        api.flushMetrics();
        api.flushMetrics();

        expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
        expect(sentry.captureMessage).toHaveBeenCalledWith("session-metrics", {
            level: "info",
            tags: { "telemetry.type": "session-metrics" },
            extra: {
                "metric:web-vital:LCP": 2600,
                "metric:web-vital:LCP:count": 2,
                "metric:perf:messages:render": 0,
            },
        });
    });

    it("reduces crafted session metrics to allowlisted numeric fields", async () => {
        const { options } = await enableSentry({ environment: "production", release: "release-safe" });
        const event = {
            event_id: VALID_EVENT_ID,
            timestamp: 42,
            message: "session-metrics",
            level: PRIVATE_MARKER,
            platform: PRIVATE_MARKER,
            tags: { "telemetry.type": "session-metrics", private: PRIVATE_MARKER },
            extra: {
                "metric:web-vital:CLS": 0.12,
                "metric:web-vital:CLS:count": 2,
                "metric:perf:connections:render": 15,
                "metric:perf:connections:render:count": 0,
                "metric:web-vital:LCP": -1,
                "metric:web-vital:FCP": Number.POSITIVE_INFINITY,
                [`metric:${PRIVATE_MARKER}`]: 99,
                private: PRIVATE_MARKER,
                serialized: { private: PRIVATE_MARKER },
            },
            request: { url: `https://example.com/?q=${PRIVATE_MARKER}` },
            contexts: { private: PRIVATE_MARKER },
            sdk: { name: PRIVATE_MARKER },
            unknown: PRIVATE_MARKER,
        };

        const reduced = options.beforeSend(event);
        expect(JSON.stringify(reduced)).not.toContain(PRIVATE_MARKER);
        expect(reduced).toEqual({
            level: "info",
            platform: "javascript",
            environment: "production",
            release: "release-safe",
            event_id: VALID_EVENT_ID,
            timestamp: 42,
            message: "session-metrics",
            tags: { "telemetry.type": "session-metrics" },
            extra: {
                "metric:perf:connections:render": 15,
                "metric:web-vital:CLS": 0.12,
                "metric:web-vital:CLS:count": 2,
            },
        });

        expect(options.beforeSend({ message: "session-metrics", tags: {}, extra: {} })).toBeNull();
        expect(
            options.beforeSend({
                message: "session-metrics",
                tags: { "telemetry.type": "session-metrics" },
                extra: { "metric:web-vital:CLS": -1 },
            }),
        ).toBeNull();
    });

    it("flushes metrics on hidden and pagehide lifecycle events", async () => {
        const { api, sentry } = await enableSentry();

        api.captureMetric("perf:connections:render", 10);
        Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => "visible",
        });
        document.dispatchEvent(new Event("visibilitychange"));
        expect(sentry.captureMessage).not.toHaveBeenCalled();

        Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => "hidden",
        });
        document.dispatchEvent(new Event("visibilitychange"));
        expect(sentry.captureMessage).toHaveBeenCalledTimes(1);

        api.captureMetric("perf:connections:render", 11);
        window.dispatchEvent(new Event("pagehide"));
        expect(sentry.captureMessage).toHaveBeenCalledTimes(2);
    });

    it("drops buffered telemetry and stops capture after revocation", async () => {
        const { api, sentry } = await enableSentry();
        api.captureMetric("web-vital:TTFB", 20);

        api.disableTelemetry();
        api.flushMetrics();
        api.captureMetric("web-vital:TTFB", 30);
        api.captureError(new Error("after revoke"));

        expect(sentry.close).toHaveBeenCalledTimes(1);
        expect(sentry.captureMessage).not.toHaveBeenCalled();
        expect(sentry.captureException).not.toHaveBeenCalled();
    });

    it("swallows SDK, shutdown, and localStorage failures", async () => {
        const { api, sentry } = await enableSentry();
        sentry.captureException.mockImplementationOnce(() => {
            throw new Error("capture failed");
        });
        expect(() =>
            api.captureError(new Error("boom"), { module: "app", operation: "session-cleanup" }),
        ).not.toThrow();

        sentry.close.mockImplementationOnce(() => {
            throw new Error("close failed");
        });
        expect(() => api.disableTelemetry()).not.toThrow();

        const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("storage failed");
        });
        expect(api.telemetryConsentGranted()).toBe(false);
        getItem.mockRestore();

        const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("storage failed");
        });
        expect(() => api.setTelemetryConsent(true)).not.toThrow();
        setItem.mockRestore();
    });
});
