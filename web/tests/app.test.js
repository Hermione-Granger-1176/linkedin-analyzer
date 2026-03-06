import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/runtime.js", () => ({ initRuntime: vi.fn() }));
vi.mock("../src/sentry.js", () => ({
    initSentry: vi.fn(),
    setTelemetryConsent: vi.fn(),
    telemetryConsentGranted: vi.fn(() => false),
}));
vi.mock("../src/telemetry.js", () => ({ initTelemetry: vi.fn() }));
vi.mock("../src/decorations.js", () => ({ initDecorations: vi.fn() }));
vi.mock("../src/theme.js", () => ({ Theme: { init: vi.fn() } }));
vi.mock("../src/tutorial.js", () => ({ Tutorial: { init: vi.fn(), onRouteChange: vi.fn() } }));
vi.mock("../src/upload.js", () => ({ UploadPage: { init: vi.fn(), onRouteChange: vi.fn() } }));
vi.mock("../src/clean.js", () => ({ CleanPage: { init: vi.fn(), onRouteChange: vi.fn() } }));
vi.mock("../src/analytics-ui.js", () => ({
    AnalyticsPage: { init: vi.fn(), onRouteChange: vi.fn() },
}));
vi.mock("../src/connections-ui.js", () => ({
    ConnectionsPage: { init: vi.fn(), onRouteChange: vi.fn() },
}));
vi.mock("../src/messages-insights.js", () => ({
    MessagesPage: { init: vi.fn(), onRouteChange: vi.fn() },
}));
vi.mock("../src/insights-ui.js", () => ({
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
        await import("../src/app.js");
        expect(document.querySelector("#screen-home")).toBeTruthy();
    });
});
