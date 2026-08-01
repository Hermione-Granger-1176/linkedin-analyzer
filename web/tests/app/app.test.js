import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/app/runtime.js", () => ({ initRuntime: vi.fn() }));
vi.mock("../../src/platform/observability/sentry.js", () => ({
    initSentry: vi.fn(),
    setTelemetryConsent: vi.fn(),
    telemetryConsentGranted: vi.fn(() => false),
}));
vi.mock("../../src/platform/observability/telemetry.js", () => ({ initTelemetry: vi.fn() }));
vi.mock("../../src/shared/ui/alive.js", () => ({ initAlive: vi.fn() }));
vi.mock("../../src/shared/ui/decorations.js", () => ({ initDecorations: vi.fn() }));
vi.mock("../../src/shared/ui/theme.js", () => ({ Theme: { init: vi.fn() } }));
vi.mock("../../src/features/tutorial/tutorial.js", () => ({ Tutorial: { init: vi.fn(), onRouteChange: vi.fn() } }));
vi.mock("../../src/features/upload/upload.js", () => ({ UploadPage: { init: vi.fn(), onRouteChange: vi.fn() } }));
vi.mock("../../src/features/cleaning/screen.js", () => ({ CleanPage: { init: vi.fn(), onRouteChange: vi.fn() } }));
vi.mock("../../src/features/analytics/screen.js", () => ({
    AnalyticsPage: { init: vi.fn(), onRouteChange: vi.fn() },
}));
vi.mock("../../src/features/connections/screen.js", () => ({
    ConnectionsPage: { init: vi.fn(), onRouteChange: vi.fn() },
}));
vi.mock("../../src/features/messages/screen.js", () => ({
    MessagesPage: { init: vi.fn(), onRouteChange: vi.fn() },
}));
vi.mock("../../src/features/insights/screen.js", () => ({
    InsightsPage: { init: vi.fn(), onRouteChange: vi.fn() },
}));

describe("app bootstrap", () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <a data-route="home" href="#home"></a>
            <div id="routeAnnouncer"></div>
            <section id="screen-home" class="screen"></section>
            <section id="screen-clean" class="screen"></section>
            <section id="screen-analytics" class="screen"></section>
            <section id="screen-connections" class="screen"></section>
            <section id="screen-messages" class="screen"></section>
            <section id="screen-insights" class="screen"></section>
        `;
    });

    it("bootstraps without throwing", async () => {
        await import("../../src/app.js");
        expect(document.querySelector("#screen-home")).toBeTruthy();
    });
});
