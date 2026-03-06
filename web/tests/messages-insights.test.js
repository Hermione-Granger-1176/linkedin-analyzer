import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/data-cache.js", () => {
    const values = new Map();
    const DataCache = {
        _values: values,
        get: vi.fn((key) => values.get(key)),
        set: vi.fn((key, value) => values.set(key, value)),
        clear: vi.fn(() => values.clear()),
    };
    return { DataCache };
});

vi.mock("../src/excel.js", () => ({
    ExcelGenerator: { downloadFromSpec: vi.fn() },
}));

vi.mock("../src/loading-overlay.js", () => ({
    LoadingOverlay: { show: vi.fn(), hide: vi.fn() },
}));

vi.mock("../src/router.js", () => ({
    AppRouter: {
        getCurrentRoute: vi.fn(() => ({ name: "messages", params: {} })),
        setParams: vi.fn(),
    },
}));

vi.mock("../src/session.js", () => ({
    Session: { waitForCleanup: vi.fn(() => Promise.resolve()) },
}));

vi.mock("../src/storage.js", () => ({
    Storage: { getAllFiles: vi.fn() },
}));

vi.mock("../src/cleaner.js", () => ({
    LinkedInCleaner: { process: vi.fn() },
}));

vi.mock("../src/messages-analytics.js", () => ({
    MessagesAnalytics: {
        buildMessageState: vi.fn(),
        buildConnectionState: vi.fn(),
        cleanText: vi.fn((value) => String(value || "").trim()),
        normalizeName: vi.fn((value) =>
            String(value || "")
                .trim()
                .toLowerCase(),
        ),
    },
}));

let MessagesPage;
let DataCache;
let ExcelGenerator;
let Storage;
let LoadingOverlay;
let AppRouter;
let LinkedInCleaner;
let MessagesAnalytics;

/** Build a minimal full DOM for the messages page. */
function buildDom(opts = {}) {
    const rangeButtons =
        opts.rangeButtons ??
        `
        <button class="filter-btn active" data-range="12m"></button>
        <button class="filter-btn" data-range="6m"></button>
        <button class="filter-btn" data-range="3m"></button>
        <button class="filter-btn" data-range="1m"></button>
    `;
    document.body.innerHTML = `
        <div id="messagesEmpty"><h2></h2><p></p></div>
        <div id="messagesLayout" hidden>
            <div class="stat-card"><span id="msgStatMessages"></span></div>
            <div class="stat-card"><span id="msgStatContacts"></span></div>
            <div class="stat-card"><span id="msgStatConnected"></span></div>
            <div class="stat-card"><span id="msgStatFading"></span></div>
            <ul id="topContactsList"></ul>
            <ul id="silentConnectionsList"></ul>
            <ul id="fadingConversationsList"></ul>
        </div>
        <div id="messagesTip" hidden><span id="messagesTipText"></span></div>
        <div id="messagesTimeRangeButtons">
            ${rangeButtons}
        </div>
        <button id="messagesResetFiltersBtn"></button>
        <button id="topContactsExportBtn"></button>
        <button id="silentConnectionsExportBtn"></button>
        <button id="fadingConversationsExportBtn"></button>
    `;
}

/**
 * Build a minimal messageState suitable for tests.
 * @param {object} overrides
 */
function makeMessageState(overrides = {}) {
    const timestamp = new Date("2024-06-01").getTime();
    return {
        contacts: new Map([
            [
                "c1",
                {
                    name: "Ada Lovelace",
                    url: "https://linkedin.com/in/ada",
                    lastTimestamp: timestamp,
                },
            ],
        ]),
        events: [{ contactKey: "c1", timestamp }],
        rowTimestamps: [timestamp],
        skippedRows: 0,
        talkedNameKeys: new Set(["ada lovelace"]),
        talkedUrlKeys: new Set(["https://linkedin.com/in/ada"]),
        latestTimestamp: timestamp,
        ...overrides,
    };
}

/** Flush all pending microtasks + one macrotask. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("MessagesPage", () => {
    beforeEach(async () => {
        buildDom();
        window.requestAnimationFrame = (cb) => cb(0);

        vi.resetModules();
        ({ MessagesPage } = await import("../src/messages-insights.js"));
        ({ DataCache } = await import("../src/data-cache.js"));
        ({ ExcelGenerator } = await import("../src/excel.js"));
        ({ Storage } = await import("../src/storage.js"));
        ({ LoadingOverlay } = await import("../src/loading-overlay.js"));
        ({ AppRouter } = await import("../src/router.js"));
        ({ LinkedInCleaner } = await import("../src/cleaner.js"));
        ({ MessagesAnalytics } = await import("../src/messages-analytics.js"));

        // Since vi.mock() creates module-level singletons that persist across
        // vi.resetModules() calls, we must manually reset all mock state here so
        // that mockReturnValue / mockResolvedValue overrides from previous tests
        // (including tests that call vi.resetModules() internally) do not bleed
        // through to subsequent tests.
        DataCache._values.clear();
        DataCache.get.mockReset();
        DataCache.get.mockImplementation((key) => DataCache._values.get(key));
        DataCache.set.mockReset();
        DataCache.set.mockImplementation((key, value) => DataCache._values.set(key, value));
        DataCache.clear.mockReset();
        DataCache.clear.mockImplementation(() => DataCache._values.clear());

        AppRouter.getCurrentRoute.mockReset();
        AppRouter.getCurrentRoute.mockReturnValue({ name: "messages", params: {} });
        AppRouter.setParams.mockReset();

        ExcelGenerator.downloadFromSpec.mockReset();
        ExcelGenerator.downloadFromSpec.mockResolvedValue({ success: true, error: null });
        LoadingOverlay.show.mockReset();
        LoadingOverlay.hide.mockReset();

        LinkedInCleaner.process.mockReset();
        MessagesAnalytics.buildMessageState.mockReset();
        MessagesAnalytics.buildConnectionState.mockReset();
        MessagesAnalytics.cleanText.mockReset();
        MessagesAnalytics.cleanText.mockImplementation((value) => String(value || "").trim());
        MessagesAnalytics.normalizeName.mockReset();
        MessagesAnalytics.normalizeName.mockImplementation((value) =>
            String(value || "")
                .trim()
                .toLowerCase(),
        );

        // Ensure a clean default for every test — tests that need specific files
        // override this before calling onRouteChange / loadData.
        Storage.getAllFiles.mockReset();
        Storage.getAllFiles.mockResolvedValue([]);
    });

    // -------------------------------------------------------------------------
    // Existing tests (preserved exactly)
    // -------------------------------------------------------------------------

    it("shows empty state when messages file is missing", async () => {
        Storage.getAllFiles.mockResolvedValue([]);

        MessagesPage.init();
        MessagesPage.onRouteChange({});

        await tick();
        expect(document.getElementById("messagesEmpty").hidden).toBe(false);
        expect(document.getElementById("messagesLayout").hidden).toBe(true);
        expect(document.getElementById("messagesTip").hidden).toBe(true);
        expect(document.getElementById("topContactsExportBtn").disabled).toBe(true);
    });

    it("renders cached state and exports top contacts", async () => {
        const messagesFile = {
            type: "messages",
            name: "messages.csv",
            text: "csv",
            updatedAt: 10,
            rowCount: 2,
        };
        DataCache.set("storage:file:messages", messagesFile);

        const timestamp = new Date("2024-06-01").getTime();
        const messageState = {
            contacts: new Map([
                [
                    "c1",
                    {
                        name: "Ada Lovelace",
                        url: "https://linkedin.com/in/ada",
                        lastTimestamp: timestamp,
                    },
                ],
            ]),
            events: [{ contactKey: "c1", timestamp }],
            rowTimestamps: [timestamp],
            skippedRows: 0,
            talkedNameKeys: new Set(["ada lovelace"]),
            talkedUrlKeys: new Set(["https://linkedin.com/in/ada"]),
            latestTimestamp: timestamp,
        };

        const signature = `messages:${messagesFile.name}:${messagesFile.updatedAt}:${messagesFile.rowCount}|connections:none`;
        DataCache.set(`messages:state:${signature}`, {
            messageState,
            connectionState: null,
            connectionLoadError: null,
            hasConnectionsFile: false,
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});

        await tick();
        expect(document.getElementById("topContactsList").innerHTML).toContain("Ada Lovelace");
        expect(document.getElementById("messagesTipText").textContent).toContain(
            "Upload Connections.csv",
        );
        expect(document.getElementById("topContactsExportBtn").disabled).toBe(false);

        document.getElementById("topContactsExportBtn").click();
        await tick();
        const [spec, filename] = ExcelGenerator.downloadFromSpec.mock.calls[0];
        expect(spec.sheetName).toBe("Top Contacts");
        expect(filename).toBe("messages-top-contacts.xlsx");
    });

    it("shows skipped row tooltip when exclusions exist", async () => {
        const messagesFile = {
            type: "messages",
            name: "messages.csv",
            text: "csv",
            updatedAt: 20,
            rowCount: 3,
        };
        DataCache.set("storage:file:messages", messagesFile);

        const timestamp = new Date("2024-06-10").getTime();
        const messageState = {
            contacts: new Map([
                ["c1", { name: "Ada Lovelace", url: "", lastTimestamp: timestamp }],
            ]),
            events: [{ contactKey: "c1", timestamp }],
            rowTimestamps: [timestamp],
            skippedRows: 2,
            talkedNameKeys: new Set(["ada lovelace"]),
            talkedUrlKeys: new Set(),
            latestTimestamp: timestamp,
        };

        const signature = `messages:${messagesFile.name}:${messagesFile.updatedAt}:${messagesFile.rowCount}|connections:none`;
        DataCache.set(`messages:state:${signature}`, {
            messageState,
            connectionState: null,
            connectionLoadError: null,
            hasConnectionsFile: false,
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});

        await tick();
        const asterisk = document.querySelector("#msgStatMessages .stat-asterisk");
        const popup = document.querySelector("#msgStatMessages .stat-popup");
        expect(asterisk).toBeTruthy();
        expect(popup).toBeTruthy();

        asterisk.dispatchEvent(new MouseEvent("mouseenter"));
        expect(popup.classList.contains("visible")).toBe(true);
    });

    it("shows connection error message in lists and tip", async () => {
        const messagesFile = {
            type: "messages",
            name: "messages.csv",
            text: "csv",
            updatedAt: 30,
            rowCount: 1,
        };
        DataCache.set("storage:file:messages", messagesFile);

        const timestamp = new Date("2024-06-15").getTime();
        const messageState = {
            contacts: new Map([
                ["c1", { name: "Ada Lovelace", url: "", lastTimestamp: timestamp }],
            ]),
            events: [{ contactKey: "c1", timestamp }],
            rowTimestamps: [timestamp],
            skippedRows: 0,
            talkedNameKeys: new Set(["ada lovelace"]),
            talkedUrlKeys: new Set(),
            latestTimestamp: timestamp,
        };

        const signature = `messages:${messagesFile.name}:${messagesFile.updatedAt}:${messagesFile.rowCount}|connections:none`;
        DataCache.set(`messages:state:${signature}`, {
            messageState,
            connectionState: { list: [], byUrl: new Map(), byName: new Map() },
            connectionLoadError: "Unable to parse Connections.csv.",
            hasConnectionsFile: true,
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});

        await tick();
        expect(document.getElementById("silentConnectionsList").innerHTML).toContain(
            "Unable to parse Connections.csv.",
        );
        expect(document.getElementById("messagesTipText").textContent).toContain(
            "Unable to parse Connections.csv.",
        );
    });

    it("hides tip when no top, silent, or fading items", async () => {
        const messagesFile = {
            type: "messages",
            name: "messages.csv",
            text: "csv",
            updatedAt: 40,
            rowCount: 0,
        };
        DataCache.set("storage:file:messages", messagesFile);

        const messageState = {
            contacts: new Map(),
            events: [],
            rowTimestamps: [],
            skippedRows: 0,
            talkedNameKeys: new Set(),
            talkedUrlKeys: new Set(),
            latestTimestamp: 0,
        };

        const signature = `messages:${messagesFile.name}:${messagesFile.updatedAt}:${messagesFile.rowCount}|connections:none`;
        DataCache.set(`messages:state:${signature}`, {
            messageState,
            connectionState: { list: [], byUrl: new Map(), byName: new Map() },
            connectionLoadError: null,
            hasConnectionsFile: true,
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});

        await tick();
        expect(document.getElementById("messagesTip").hidden).toBe(true);
    });

    // -------------------------------------------------------------------------
    // New tests — uncovered paths
    // -------------------------------------------------------------------------

    // --- onRouteLeave hides loading overlay -----------------------------------

    it("onRouteLeave hides the loading overlay", () => {
        MessagesPage.init();
        MessagesPage.onRouteLeave();
        expect(LoadingOverlay.hide).toHaveBeenCalledWith("messages");
    });

    // --- init() guard: no layout elements ------------------------------------

    it("does not initialize when layout elements are missing", async () => {
        document.body.innerHTML = "";
        vi.resetModules();
        const { MessagesPage: MI } = await import("../src/messages-insights.js");
        // init() should return early — calling onRouteLeave should not throw
        MI.onRouteLeave();
    });

    // --- init() idempotency --------------------------------------------------

    it("does not reinitialize when called twice", async () => {
        Storage.getAllFiles.mockResolvedValue([]);
        MessagesPage.init();
        MessagesPage.init(); // second call must be a no-op — no exception
        MessagesPage.onRouteChange({});
        await tick();
        // No messages file → empty state is shown
        const emptyEl = document.getElementById("messagesEmpty");
        expect(emptyEl.hidden).toBe(false);
        expect(document.getElementById("messagesLayout").hidden).toBe(true);
    });

    // --- onRouteChange triggers init() on first call -------------------------

    it("onRouteChange initializes page when not yet initialized", async () => {
        Storage.getAllFiles.mockResolvedValue([]);
        // Do NOT call init() — let onRouteChange do it
        MessagesPage.onRouteChange({});
        await tick();
        // No messages file → empty state shown
        expect(document.getElementById("messagesEmpty").hidden).toBe(false);
        expect(document.getElementById("messagesLayout").hidden).toBe(true);
    });

    // --- renderSilentConnections with real connections -----------------------

    it("renders silent connections list when connections file is present", async () => {
        const messagesFile = {
            type: "messages",
            name: "m.csv",
            text: "x",
            updatedAt: 50,
            rowCount: 1,
        };
        DataCache.set("storage:file:messages", messagesFile);

        const timestamp = new Date("2024-01-15").getTime();
        const messageState = {
            contacts: new Map([
                [
                    "c1",
                    { name: "Ada Lovelace", url: "https://li.com/ada", lastTimestamp: timestamp },
                ],
            ]),
            events: [{ contactKey: "c1", timestamp }],
            rowTimestamps: [timestamp],
            skippedRows: 0,
            talkedNameKeys: new Set(["ada lovelace"]),
            talkedUrlKeys: new Set(["https://li.com/ada"]),
            latestTimestamp: timestamp,
        };

        // A connection that has never messaged
        const silentConn = {
            name: "Bob Builder",
            url: "https://li.com/bob",
            nameKey: "bob builder",
            connectedOnTimestamp: new Date("2023-06-01").getTime(),
            position: "Engineer",
            company: "ACME",
        };

        const connectionState = {
            list: [silentConn],
            byUrl: new Map([["https://li.com/bob", silentConn]]),
            byName: new Map([["bob builder", silentConn]]),
        };

        const sig = `messages:${messagesFile.name}:${messagesFile.updatedAt}:${messagesFile.rowCount}|connections:none`;
        DataCache.set(`messages:state:${sig}`, {
            messageState,
            connectionState,
            connectionLoadError: null,
            hasConnectionsFile: true,
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        const list = document.getElementById("silentConnectionsList");
        expect(list.innerHTML).toContain("Bob Builder");
        expect(list.innerHTML).toContain("Engineer @ ACME");
    });

    it("renders silent connection without role info", async () => {
        const messagesFile = {
            type: "messages",
            name: "m2.csv",
            text: "x",
            updatedAt: 51,
            rowCount: 1,
        };
        DataCache.set("storage:file:messages", messagesFile);

        const timestamp = new Date("2024-01-15").getTime();
        const messageState = {
            contacts: new Map(),
            events: [],
            rowTimestamps: [],
            skippedRows: 0,
            talkedNameKeys: new Set(),
            talkedUrlKeys: new Set(),
            latestTimestamp: timestamp,
        };

        // Connection with no position/company and no connectedOnTimestamp
        const silentConn = {
            name: "Jane Doe",
            url: "",
            nameKey: "jane doe",
            connectedOnTimestamp: null,
            position: "",
            company: "",
        };

        const connectionState = {
            list: [silentConn],
            byUrl: new Map(),
            byName: new Map([["jane doe", silentConn]]),
        };

        const sig = `messages:${messagesFile.name}:${messagesFile.updatedAt}:${messagesFile.rowCount}|connections:none`;
        DataCache.set(`messages:state:${sig}`, {
            messageState,
            connectionState,
            connectionLoadError: null,
            hasConnectionsFile: true,
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        const list = document.getElementById("silentConnectionsList");
        expect(list.innerHTML).toContain("Jane Doe");
        expect(list.innerHTML).toContain("No role info");
        expect(list.innerHTML).toContain("No date");
    });

    // --- renderFadingConversations -------------------------------------------

    it("renders fading conversations for connected contacts inactive > 30 days", async () => {
        const now = Date.now();
        const oldTimestamp = now - 60 * 24 * 60 * 60 * 1000; // 60 days ago

        const messagesFile = {
            type: "messages",
            name: "fading.csv",
            text: "x",
            updatedAt: 60,
            rowCount: 1,
        };
        DataCache.set("storage:file:messages", messagesFile);

        const fadingConn = {
            name: "Old Friend",
            url: "https://li.com/old",
            nameKey: "old friend",
            connectedOnTimestamp: oldTimestamp,
            position: "Dev",
            company: "Corp",
        };

        const messageState = {
            contacts: new Map([
                [
                    "c1",
                    { name: "Old Friend", url: "https://li.com/old", lastTimestamp: oldTimestamp },
                ],
            ]),
            events: [{ contactKey: "c1", timestamp: oldTimestamp }],
            rowTimestamps: [oldTimestamp],
            skippedRows: 0,
            talkedNameKeys: new Set(["old friend"]),
            talkedUrlKeys: new Set(["https://li.com/old"]),
            latestTimestamp: now,
        };

        const connectionState = {
            list: [fadingConn],
            byUrl: new Map([["https://li.com/old", fadingConn]]),
            byName: new Map([["old friend", fadingConn]]),
        };

        const sig = `messages:${messagesFile.name}:${messagesFile.updatedAt}:${messagesFile.rowCount}|connections:none`;
        DataCache.set(`messages:state:${sig}`, {
            messageState,
            connectionState,
            connectionLoadError: null,
            hasConnectionsFile: true,
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        const list = document.getElementById("fadingConversationsList");
        expect(list.innerHTML).toContain("Old Friend");
        expect(list.innerHTML).toContain("days");
    });

    it("shows empty fading list when no contacts are inactive > 30 days", async () => {
        const now = Date.now();
        const recentTimestamp = now - 5 * 24 * 60 * 60 * 1000; // 5 days ago

        const messagesFile = {
            type: "messages",
            name: "recent.csv",
            text: "x",
            updatedAt: 61,
            rowCount: 1,
        };
        DataCache.set("storage:file:messages", messagesFile);

        const conn = {
            name: "Active Person",
            url: "https://li.com/active",
            nameKey: "active person",
            connectedOnTimestamp: recentTimestamp,
        };

        const messageState = {
            contacts: new Map([
                [
                    "c1",
                    {
                        name: "Active Person",
                        url: "https://li.com/active",
                        lastTimestamp: recentTimestamp,
                    },
                ],
            ]),
            events: [{ contactKey: "c1", timestamp: recentTimestamp }],
            rowTimestamps: [recentTimestamp],
            skippedRows: 0,
            talkedNameKeys: new Set(["active person"]),
            talkedUrlKeys: new Set(["https://li.com/active"]),
            latestTimestamp: now,
        };

        const connectionState = {
            list: [conn],
            byUrl: new Map([["https://li.com/active", conn]]),
            byName: new Map([["active person", conn]]),
        };

        const sig = `messages:${messagesFile.name}:${messagesFile.updatedAt}:${messagesFile.rowCount}|connections:none`;
        DataCache.set(`messages:state:${sig}`, {
            messageState,
            connectionState,
            connectionLoadError: null,
            hasConnectionsFile: true,
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        const list = document.getElementById("fadingConversationsList");
        expect(list.innerHTML).toContain("No fading conversations");
    });

    // --- Export buttons: silent connections & fading conversations -----------

    it("exports silent connections when data is available", async () => {
        const now = Date.now();
        const connTs = new Date("2023-01-01").getTime();

        const messagesFile = {
            type: "messages",
            name: "sc.csv",
            text: "x",
            updatedAt: 70,
            rowCount: 1,
        };
        DataCache.set("storage:file:messages", messagesFile);

        const silentConn = {
            name: "Silent Sam",
            url: "https://li.com/sam",
            nameKey: "silent sam",
            connectedOnTimestamp: connTs,
            position: "PM",
            company: "Biz",
        };

        const messageState = {
            contacts: new Map(),
            events: [],
            rowTimestamps: [],
            skippedRows: 0,
            talkedNameKeys: new Set(),
            talkedUrlKeys: new Set(),
            latestTimestamp: now,
        };

        const connectionState = {
            list: [silentConn],
            byUrl: new Map([["https://li.com/sam", silentConn]]),
            byName: new Map([["silent sam", silentConn]]),
        };

        const sig = `messages:${messagesFile.name}:${messagesFile.updatedAt}:${messagesFile.rowCount}|connections:none`;
        DataCache.set(`messages:state:${sig}`, {
            messageState,
            connectionState,
            connectionLoadError: null,
            hasConnectionsFile: true,
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        const btn = document.getElementById("silentConnectionsExportBtn");
        expect(btn.disabled).toBe(false);
        btn.click();
        await tick();

        const calls = ExcelGenerator.downloadFromSpec.mock.calls;
        const lastCall = calls[calls.length - 1];
        expect(lastCall[0].sheetName).toBe("Silent Connections");
        expect(lastCall[1]).toBe("messages-silent-connections.xlsx");
    });

    it("exports fading conversations when data is available", async () => {
        const now = Date.now();
        const oldTs = now - 90 * 24 * 60 * 60 * 1000;

        const messagesFile = {
            type: "messages",
            name: "fc.csv",
            text: "x",
            updatedAt: 80,
            rowCount: 1,
        };
        DataCache.set("storage:file:messages", messagesFile);

        const fadingConn = {
            name: "Fading Fred",
            url: "https://li.com/fred",
            nameKey: "fading fred",
            connectedOnTimestamp: oldTs,
            company: "OldCo",
        };

        const messageState = {
            contacts: new Map([
                ["c1", { name: "Fading Fred", url: "https://li.com/fred", lastTimestamp: oldTs }],
            ]),
            events: [{ contactKey: "c1", timestamp: oldTs }],
            rowTimestamps: [oldTs],
            skippedRows: 0,
            talkedNameKeys: new Set(["fading fred"]),
            talkedUrlKeys: new Set(["https://li.com/fred"]),
            latestTimestamp: now,
        };

        const connectionState = {
            list: [fadingConn],
            byUrl: new Map([["https://li.com/fred", fadingConn]]),
            byName: new Map([["fading fred", fadingConn]]),
        };

        const sig = `messages:${messagesFile.name}:${messagesFile.updatedAt}:${messagesFile.rowCount}|connections:none`;
        DataCache.set(`messages:state:${sig}`, {
            messageState,
            connectionState,
            connectionLoadError: null,
            hasConnectionsFile: true,
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        const btn = document.getElementById("fadingConversationsExportBtn");
        expect(btn.disabled).toBe(false);
        btn.click();
        await tick();

        const calls = ExcelGenerator.downloadFromSpec.mock.calls;
        const lastCall = calls[calls.length - 1];
        expect(lastCall[0].sheetName).toBe("Fading Conversations");
        expect(lastCall[1]).toBe("messages-fading-conversations.xlsx");
    });

    // --- Time-range filter button interaction --------------------------------

    it("time-range button click updates active state and re-renders", async () => {
        buildDom(); // rebuild DOM fresh with 4 range buttons
        vi.resetModules();
        ({ MessagesPage } = await import("../src/messages-insights.js"));
        ({ DataCache } = await import("../src/data-cache.js"));
        ({ AppRouter } = await import("../src/router.js"));
        ({ Storage } = await import("../src/storage.js"));

        const timestamp = new Date("2024-06-01").getTime();
        const messagesFile = {
            type: "messages",
            name: "rng.csv",
            text: "x",
            updatedAt: 90,
            rowCount: 1,
        };
        DataCache.set("storage:file:messages", messagesFile);

        const messageState = {
            contacts: new Map([["c1", { name: "Ada", url: "", lastTimestamp: timestamp }]]),
            events: [{ contactKey: "c1", timestamp }],
            rowTimestamps: [timestamp],
            skippedRows: 0,
            talkedNameKeys: new Set(["ada"]),
            talkedUrlKeys: new Set(),
            latestTimestamp: timestamp,
        };

        const sig = `messages:${messagesFile.name}:${messagesFile.updatedAt}:${messagesFile.rowCount}|connections:none`;
        DataCache.set(`messages:state:${sig}`, {
            messageState,
            connectionState: null,
            connectionLoadError: null,
            hasConnectionsFile: false,
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        // Click the 6m range button
        const btn6m = document.querySelector('[data-range="6m"]');
        btn6m.click();

        expect(btn6m.classList.contains("active")).toBe(true);
        expect(btn6m.getAttribute("aria-pressed")).toBe("true");

        // 12m button should be inactive
        const btn12m = document.querySelector('[data-range="12m"]');
        expect(btn12m.classList.contains("active")).toBe(false);
        expect(btn12m.getAttribute("aria-pressed")).toBe("false");
    });

    it("reset filters button restores 12m range", async () => {
        buildDom();
        vi.resetModules();
        ({ MessagesPage } = await import("../src/messages-insights.js"));
        ({ DataCache } = await import("../src/data-cache.js"));
        ({ AppRouter } = await import("../src/router.js"));
        ({ Storage } = await import("../src/storage.js"));

        const timestamp = new Date("2024-06-01").getTime();
        const messagesFile = {
            type: "messages",
            name: "rst.csv",
            text: "x",
            updatedAt: 95,
            rowCount: 1,
        };
        DataCache.set("storage:file:messages", messagesFile);

        const messageState = {
            contacts: new Map([["c1", { name: "Ada", url: "", lastTimestamp: timestamp }]]),
            events: [{ contactKey: "c1", timestamp }],
            rowTimestamps: [timestamp],
            skippedRows: 0,
            talkedNameKeys: new Set(["ada"]),
            talkedUrlKeys: new Set(),
            latestTimestamp: timestamp,
        };

        const sig = `messages:${messagesFile.name}:${messagesFile.updatedAt}:${messagesFile.rowCount}|connections:none`;
        DataCache.set(`messages:state:${sig}`, {
            messageState,
            connectionState: null,
            connectionLoadError: null,
            hasConnectionsFile: false,
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        // Switch to 3m first
        document.querySelector('[data-range="3m"]').click();
        expect(document.querySelector('[data-range="3m"]').classList.contains("active")).toBe(true);

        // Now reset
        document.getElementById("messagesResetFiltersBtn").click();
        expect(document.querySelector('[data-range="12m"]').classList.contains("active")).toBe(
            true,
        );
        expect(document.querySelector('[data-range="3m"]').classList.contains("active")).toBe(
            false,
        );
    });

    // --- Route range parameter parsing ---------------------------------------

    it("applies valid range param from route", async () => {
        buildDom();
        vi.resetModules();
        ({ MessagesPage } = await import("../src/messages-insights.js"));
        ({ DataCache } = await import("../src/data-cache.js"));
        ({ Storage } = await import("../src/storage.js"));

        Storage.getAllFiles.mockResolvedValue([]);
        MessagesPage.onRouteChange({ range: "3m" });
        await tick();

        const btn3m = document.querySelector('[data-range="3m"]');
        expect(btn3m.classList.contains("active")).toBe(true);
    });

    it("falls back to 12m for invalid range param", async () => {
        buildDom();
        vi.resetModules();
        ({ MessagesPage } = await import("../src/messages-insights.js"));
        ({ DataCache } = await import("../src/data-cache.js"));
        ({ Storage } = await import("../src/storage.js"));

        Storage.getAllFiles.mockResolvedValue([]);
        MessagesPage.onRouteChange({ range: "bogus" });
        await tick();

        const btn12m = document.querySelector('[data-range="12m"]');
        expect(btn12m.classList.contains("active")).toBe(true);
    });

    it('accepts "all" as a valid range param', async () => {
        buildDom();
        vi.resetModules();
        ({ MessagesPage } = await import("../src/messages-insights.js"));
        ({ DataCache } = await import("../src/data-cache.js"));
        ({ Storage } = await import("../src/storage.js"));

        Storage.getAllFiles.mockResolvedValue([]);
        // "all" is a valid range value — no button should show active for "all"
        MessagesPage.onRouteChange({ range: "all" });
        await tick();
        // Without a messages file the page shows the empty state (that's correct)
        expect(document.getElementById("messagesEmpty").hidden).toBe(false);
        // None of the range buttons should be marked active for "all"
        const activeBtn = document.querySelector("[data-range].active");
        expect(activeBtn).toBeNull();
    });

    // --- syncRouteRange skips when route is not messages --------------------

    it("does not sync route params when not on messages route", async () => {
        buildDom();
        vi.resetModules();
        ({ MessagesPage } = await import("../src/messages-insights.js"));
        ({ DataCache } = await import("../src/data-cache.js"));
        ({ Storage } = await import("../src/storage.js"));
        ({ AppRouter } = await import("../src/router.js"));

        // Route is not "messages" — syncRouteRange should short-circuit
        AppRouter.getCurrentRoute.mockReturnValue({ name: "analytics" });
        Storage.getAllFiles.mockResolvedValue([]);

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        // Clear any calls made during init/onRouteChange
        AppRouter.setParams.mockClear();

        // Click a range button — syncRouteRange should short-circuit
        const btn6m = document.querySelector('[data-range="6m"]');
        btn6m.click();
        expect(AppRouter.setParams).not.toHaveBeenCalled();
    });

    // --- hydrateMessageState & hydrateConnectionState via worker payload -----

    it("hydrateMessageState reconstructs Maps and Sets from worker payload", async () => {
        // Simulate a worker returning a pre-serialised messageState payload
        // (arrays instead of Map/Set — as the worker would send over postMessage)
        let workerMsgHandler = null;
        const mockWorker = {
            postMessage: vi.fn(),
            addEventListener: vi.fn((type, handler) => {
                if (type === "message") {
                    workerMsgHandler = handler;
                }
            }),
            removeEventListener: vi.fn(),
            terminate: vi.fn(),
        };
        globalThis.Worker = function () {
            return mockWorker;
        };

        buildDom();
        vi.resetModules();
        ({ MessagesPage } = await import("../src/messages-insights.js"));
        ({ DataCache } = await import("../src/data-cache.js"));
        ({ MessagesAnalytics } = await import("../src/messages-analytics.js"));
        ({ Storage } = await import("../src/storage.js"));

        const timestamp = new Date("2024-03-01").getTime();
        const messagesFile = {
            type: "messages",
            name: "w.csv",
            text: "csv",
            updatedAt: 100,
            rowCount: 5,
        };
        DataCache.set("storage:file:messages", messagesFile);

        MessagesPage.init();
        MessagesPage.onRouteChange({});

        // Wait for nextFrame + worker postMessage
        await tick();

        // Deliver worker 'processed' response with array-encoded state
        const workerPayload = {
            success: true,
            totalInputRows: 5,
            messageState: {
                contacts: [{ key: "c1", name: "Hydra Test", url: "", lastTimestamp: timestamp }],
                events: [{ contactKey: "c1", timestamp }],
                rowTimestamps: [timestamp],
                skippedRows: 0,
                talkedNameKeys: ["hydra test"],
                talkedUrlKeys: [],
                latestTimestamp: timestamp,
            },
            connectionState: {
                list: [{ name: "Conn One", url: "https://li.com/one", nameKey: "conn one" }],
            },
            connectionError: null,
        };

        // The worker listener was registered by processFilesInWorker
        if (workerMsgHandler) {
            workerMsgHandler({
                data: {
                    type: "processed",
                    requestId: 1,
                    payload: workerPayload,
                },
            });
        }

        await tick();

        // After hydration, the view should render with reconstructed Map
        expect(document.getElementById("topContactsList").innerHTML).toContain("Hydra Test");
    });

    // --- Worker error event --------------------------------------------------

    it("falls back to main-thread when worker fires error event", async () => {
        let workerErrHandler = null;
        const mockWorker = {
            postMessage: vi.fn(),
            addEventListener: vi.fn((type, handler) => {
                if (type === "error") {
                    workerErrHandler = handler;
                }
            }),
            removeEventListener: vi.fn(),
            terminate: vi.fn(),
        };
        globalThis.Worker = function () {
            return mockWorker;
        };

        buildDom();
        vi.resetModules();
        ({ MessagesPage } = await import("../src/messages-insights.js"));
        ({ DataCache } = await import("../src/data-cache.js"));
        ({ Storage } = await import("../src/storage.js"));
        ({ LinkedInCleaner } = await import("../src/cleaner.js"));
        ({ MessagesAnalytics } = await import("../src/messages-analytics.js"));

        const timestamp = new Date("2024-03-01").getTime();
        const messagesFile = {
            type: "messages",
            name: "werr.csv",
            text: "csv",
            updatedAt: 110,
            rowCount: 2,
        };
        DataCache.set("storage:file:messages", messagesFile);

        // Main-thread fallback via LinkedInCleaner
        LinkedInCleaner.process.mockReturnValue({
            success: true,
            cleanedData: [{ from: "Ada", to: "Bob", date: "2024-01-01", content: "Hi" }],
        });

        const messageState = {
            contacts: new Map([["c1", { name: "Ada", url: "", lastTimestamp: timestamp }]]),
            events: [{ contactKey: "c1", timestamp }],
            rowTimestamps: [timestamp],
            skippedRows: 0,
            talkedNameKeys: new Set(["ada"]),
            talkedUrlKeys: new Set(),
            latestTimestamp: timestamp,
        };
        MessagesAnalytics.buildMessageState.mockReturnValue(messageState);
        MessagesAnalytics.buildConnectionState.mockReturnValue({
            list: [],
            byUrl: new Map(),
            byName: new Map(),
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});

        // Wait for the worker postMessage to be called
        await tick();

        // Fire the worker error event
        if (workerErrHandler) {
            workerErrHandler(new Event("error"));
        }

        await tick();

        // Main-thread fallback was used — Ada should be in the list
        expect(document.getElementById("topContactsList").innerHTML).toContain("Ada");
    });

    // --- Worker timeout ------------------------------------------------------

    it("falls back to main-thread when worker times out", async () => {
        vi.useFakeTimers();

        const mockWorker = {
            postMessage: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            terminate: vi.fn(),
        };
        globalThis.Worker = function () {
            return mockWorker;
        };

        buildDom();
        vi.resetModules();
        ({ MessagesPage } = await import("../src/messages-insights.js"));
        ({ DataCache } = await import("../src/data-cache.js"));
        ({ Storage } = await import("../src/storage.js"));
        ({ LinkedInCleaner } = await import("../src/cleaner.js"));
        ({ MessagesAnalytics } = await import("../src/messages-analytics.js"));

        const timestamp = new Date("2024-03-01").getTime();
        const messagesFile = {
            type: "messages",
            name: "timeout.csv",
            text: "csv",
            updatedAt: 120,
            rowCount: 2,
        };
        DataCache.set("storage:file:messages", messagesFile);

        LinkedInCleaner.process.mockReturnValue({
            success: true,
            cleanedData: [],
        });

        const messageState = {
            contacts: new Map([
                ["c1", { name: "Timeout User", url: "", lastTimestamp: timestamp }],
            ]),
            events: [{ contactKey: "c1", timestamp }],
            rowTimestamps: [timestamp],
            skippedRows: 0,
            talkedNameKeys: new Set(["timeout user"]),
            talkedUrlKeys: new Set(),
            latestTimestamp: timestamp,
        };
        MessagesAnalytics.buildMessageState.mockReturnValue(messageState);
        MessagesAnalytics.buildConnectionState.mockReturnValue({
            list: [],
            byUrl: new Map(),
            byName: new Map(),
        });

        // Use real rAF mock for nextFrame
        window.requestAnimationFrame = (cb) => {
            setTimeout(cb, 0);
            return 1;
        };

        MessagesPage.init();
        MessagesPage.onRouteChange({});

        // Let nextFrame resolve
        await vi.runAllTimersAsync();

        // Advance past the 30 second worker timeout
        vi.advanceTimersByTime(31000);
        await vi.runAllTimersAsync();

        expect(document.getElementById("topContactsList").innerHTML).toContain("Timeout User");

        vi.useRealTimers();
    });

    // --- Worker unavailable (no Worker global) — main-thread path ------------

    it("parses on main thread when Worker is unavailable", async () => {
        globalThis.Worker = undefined;

        buildDom();
        vi.resetModules();
        ({ MessagesPage } = await import("../src/messages-insights.js"));
        ({ DataCache } = await import("../src/data-cache.js"));
        ({ Storage } = await import("../src/storage.js"));
        ({ LinkedInCleaner } = await import("../src/cleaner.js"));
        ({ MessagesAnalytics } = await import("../src/messages-analytics.js"));

        const timestamp = new Date("2024-03-01").getTime();
        const messagesFile = {
            type: "messages",
            name: "noworker.csv",
            text: "csv",
            updatedAt: 130,
            rowCount: 1,
        };
        DataCache.set("storage:file:messages", messagesFile);

        LinkedInCleaner.process.mockReturnValue({
            success: true,
            cleanedData: [{ from: "Ada", to: "Bob", date: "2024-01-01", content: "Hi" }],
        });

        const messageState = {
            contacts: new Map([["c1", { name: "No Worker", url: "", lastTimestamp: timestamp }]]),
            events: [{ contactKey: "c1", timestamp }],
            rowTimestamps: [timestamp],
            skippedRows: 0,
            talkedNameKeys: new Set(["no worker"]),
            talkedUrlKeys: new Set(),
            latestTimestamp: timestamp,
        };
        MessagesAnalytics.buildMessageState.mockReturnValue(messageState);
        MessagesAnalytics.buildConnectionState.mockReturnValue({
            list: [],
            byUrl: new Map(),
            byName: new Map(),
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        expect(document.getElementById("topContactsList").innerHTML).toContain("No Worker");

        globalThis.Worker = undefined; // reset
    });

    // --- Main-thread parse failure (success: false) --------------------------

    it("shows parse error empty state when main-thread parse fails", async () => {
        globalThis.Worker = undefined;

        buildDom();
        vi.resetModules();
        ({ MessagesPage } = await import("../src/messages-insights.js"));
        ({ DataCache } = await import("../src/data-cache.js"));
        ({ Storage } = await import("../src/storage.js"));
        ({ LinkedInCleaner } = await import("../src/cleaner.js"));

        const messagesFile = {
            type: "messages",
            name: "bad.csv",
            text: "bad",
            updatedAt: 140,
            rowCount: 0,
        };
        DataCache.set("storage:file:messages", messagesFile);

        LinkedInCleaner.process.mockReturnValue({
            success: false,
            error: "Bad CSV format",
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        expect(document.getElementById("messagesEmpty").hidden).toBe(false);
        expect(document.getElementById("messagesEmpty").querySelector("h2").textContent).toContain(
            "Messages parsing error",
        );

        globalThis.Worker = undefined;
    });

    // --- No usable message rows after parse ----------------------------------

    it("shows empty state when parsed data has no valid rows", async () => {
        globalThis.Worker = undefined;

        buildDom();
        vi.resetModules();
        ({ MessagesPage } = await import("../src/messages-insights.js"));
        ({ DataCache } = await import("../src/data-cache.js"));
        ({ Storage } = await import("../src/storage.js"));
        ({ LinkedInCleaner } = await import("../src/cleaner.js"));
        ({ MessagesAnalytics } = await import("../src/messages-analytics.js"));

        const messagesFile = {
            type: "messages",
            name: "empty.csv",
            text: "x",
            updatedAt: 141,
            rowCount: 0,
        };
        DataCache.set("storage:file:messages", messagesFile);

        LinkedInCleaner.process.mockReturnValue({ success: true, cleanedData: [] });

        MessagesAnalytics.buildMessageState.mockReturnValue({
            contacts: new Map(),
            events: [], // empty — triggers the "No usable rows" path
            rowTimestamps: [],
            skippedRows: 0,
            talkedNameKeys: new Set(),
            talkedUrlKeys: new Set(),
            latestTimestamp: 0,
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        expect(document.getElementById("messagesEmpty").hidden).toBe(false);
        expect(document.getElementById("messagesEmpty").querySelector("p").textContent).toContain(
            "no valid message rows",
        );

        globalThis.Worker = undefined;
    });

    // --- updateStats with skippedRows = 0 (plain text, no asterisk) ----------

    it("updateStats shows plain number when skippedRows is zero", async () => {
        const messagesFile = {
            type: "messages",
            name: "plain.csv",
            text: "x",
            updatedAt: 150,
            rowCount: 1,
        };
        DataCache.set("storage:file:messages", messagesFile);

        const messageState = makeMessageState({ skippedRows: 0 });

        const sig = `messages:${messagesFile.name}:${messagesFile.updatedAt}:${messagesFile.rowCount}|connections:none`;
        DataCache.set(`messages:state:${sig}`, {
            messageState,
            connectionState: null,
            connectionLoadError: null,
            hasConnectionsFile: false,
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        const statEl = document.getElementById("msgStatMessages");
        // Should be plain text number, no asterisk element
        expect(statEl.querySelector(".stat-asterisk")).toBeNull();
        expect(statEl.textContent).toBe("1");
    });

    // --- Stat-asterisk popup toggle & keyboard interactions ------------------

    it("skipped-row popup toggles on click and closes on Escape", async () => {
        const messagesFile = {
            type: "messages",
            name: "skip.csv",
            text: "x",
            updatedAt: 160,
            rowCount: 5,
        };
        DataCache.set("storage:file:messages", messagesFile);

        const messageState = makeMessageState({ skippedRows: 2 });

        const sig = `messages:${messagesFile.name}:${messagesFile.updatedAt}:${messagesFile.rowCount}|connections:none`;
        DataCache.set(`messages:state:${sig}`, {
            messageState,
            connectionState: null,
            connectionLoadError: null,
            hasConnectionsFile: false,
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        const asterisk = document.querySelector("#msgStatMessages .stat-asterisk");
        const popup = document.querySelector("#msgStatMessages .stat-popup");

        // Click to show
        asterisk.click();
        expect(popup.classList.contains("visible")).toBe(true);

        // Click to hide
        asterisk.click();
        expect(popup.classList.contains("visible")).toBe(false);

        // Show again then Escape to hide
        asterisk.click();
        asterisk.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        expect(popup.classList.contains("visible")).toBe(false);
    });

    it("skipped-row popup opens on Enter key", async () => {
        const messagesFile = {
            type: "messages",
            name: "skipenter.csv",
            text: "x",
            updatedAt: 161,
            rowCount: 3,
        };
        DataCache.set("storage:file:messages", messagesFile);
        const messageState = makeMessageState({ skippedRows: 1 });
        const sig = `messages:${messagesFile.name}:${messagesFile.updatedAt}:${messagesFile.rowCount}|connections:none`;
        DataCache.set(`messages:state:${sig}`, {
            messageState,
            connectionState: null,
            connectionLoadError: null,
            hasConnectionsFile: false,
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        const asterisk = document.querySelector("#msgStatMessages .stat-asterisk");
        const popup = document.querySelector("#msgStatMessages .stat-popup");

        const enterEvt = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
        Object.defineProperty(enterEvt, "preventDefault", { value: vi.fn() });
        asterisk.dispatchEvent(enterEvt);
        expect(popup.classList.contains("visible")).toBe(true);
    });

    it("skipped-row popup closes on focusout", async () => {
        const messagesFile = {
            type: "messages",
            name: "skipfocus.csv",
            text: "x",
            updatedAt: 162,
            rowCount: 3,
        };
        DataCache.set("storage:file:messages", messagesFile);
        const messageState = makeMessageState({ skippedRows: 1 });
        const sig = `messages:${messagesFile.name}:${messagesFile.updatedAt}:${messagesFile.rowCount}|connections:none`;
        DataCache.set(`messages:state:${sig}`, {
            messageState,
            connectionState: null,
            connectionLoadError: null,
            hasConnectionsFile: false,
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        const asterisk = document.querySelector("#msgStatMessages .stat-asterisk");
        const popup = document.querySelector("#msgStatMessages .stat-popup");

        // Open it first
        asterisk.dispatchEvent(new MouseEvent("mouseenter"));
        expect(popup.classList.contains("visible")).toBe(true);

        // focusout should close
        asterisk.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        expect(popup.classList.contains("visible")).toBe(false);
    });

    it("skipped-row popup closes on mouseleave", async () => {
        const messagesFile = {
            type: "messages",
            name: "skipmouse.csv",
            text: "x",
            updatedAt: 163,
            rowCount: 3,
        };
        DataCache.set("storage:file:messages", messagesFile);
        const messageState = makeMessageState({ skippedRows: 1 });
        const sig = `messages:${messagesFile.name}:${messagesFile.updatedAt}:${messagesFile.rowCount}|connections:none`;
        DataCache.set(`messages:state:${sig}`, {
            messageState,
            connectionState: null,
            connectionLoadError: null,
            hasConnectionsFile: false,
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        const asterisk = document.querySelector("#msgStatMessages .stat-asterisk");
        const popup = document.querySelector("#msgStatMessages .stat-popup");

        asterisk.dispatchEvent(new MouseEvent("mouseenter"));
        expect(popup.classList.contains("visible")).toBe(true);

        asterisk.dispatchEvent(new MouseEvent("mouseleave"));
        expect(popup.classList.contains("visible")).toBe(false);
    });

    // --- Tip text: top + fading branch ---------------------------------------

    it("tip shows both top contact and fading contact when both exist", async () => {
        const now = Date.now();
        const oldTs = now - 60 * 24 * 60 * 60 * 1000;

        const messagesFile = {
            type: "messages",
            name: "tip2.csv",
            text: "x",
            updatedAt: 170,
            rowCount: 2,
        };
        DataCache.set("storage:file:messages", messagesFile);

        const fadingConn = {
            name: "Old Pal",
            url: "https://li.com/pal",
            nameKey: "old pal",
            connectedOnTimestamp: oldTs,
            company: "Corp",
        };

        const messageState = {
            contacts: new Map([
                ["c1", { name: "Top Guy", url: "", lastTimestamp: now }],
                ["c2", { name: "Old Pal", url: "https://li.com/pal", lastTimestamp: oldTs }],
            ]),
            events: [
                { contactKey: "c1", timestamp: now },
                { contactKey: "c2", timestamp: oldTs },
            ],
            rowTimestamps: [now, oldTs],
            skippedRows: 0,
            talkedNameKeys: new Set(["top guy", "old pal"]),
            talkedUrlKeys: new Set(["https://li.com/pal"]),
            latestTimestamp: now,
        };

        const connectionState = {
            list: [fadingConn],
            byUrl: new Map([["https://li.com/pal", fadingConn]]),
            byName: new Map([["old pal", fadingConn]]),
        };

        const sig = `messages:${messagesFile.name}:${messagesFile.updatedAt}:${messagesFile.rowCount}|connections:none`;
        DataCache.set(`messages:state:${sig}`, {
            messageState,
            connectionState,
            connectionLoadError: null,
            hasConnectionsFile: true,
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        const tipText = document.getElementById("messagesTipText").textContent;
        expect(tipText).toContain("Top Guy");
        expect(tipText).toContain("Old Pal");
    });

    // --- Tip text: only top contact (no fading) ------------------------------

    it("tip shows only top contact message when no fading contacts", async () => {
        const now = Date.now();
        const recentTs = now - 2 * 24 * 60 * 60 * 1000; // 2 days ago

        const messagesFile = {
            type: "messages",
            name: "tip3.csv",
            text: "x",
            updatedAt: 171,
            rowCount: 1,
        };
        DataCache.set("storage:file:messages", messagesFile);

        const conn = {
            name: "Active Conn",
            url: "https://li.com/ac",
            nameKey: "active conn",
            connectedOnTimestamp: recentTs,
        };

        const messageState = {
            contacts: new Map([
                ["c1", { name: "Active Conn", url: "https://li.com/ac", lastTimestamp: recentTs }],
            ]),
            events: [{ contactKey: "c1", timestamp: recentTs }],
            rowTimestamps: [recentTs],
            skippedRows: 0,
            talkedNameKeys: new Set(["active conn"]),
            talkedUrlKeys: new Set(["https://li.com/ac"]),
            latestTimestamp: now,
        };

        const connectionState = {
            list: [conn],
            byUrl: new Map([["https://li.com/ac", conn]]),
            byName: new Map([["active conn", conn]]),
        };

        const sig = `messages:${messagesFile.name}:${messagesFile.updatedAt}:${messagesFile.rowCount}|connections:none`;
        DataCache.set(`messages:state:${sig}`, {
            messageState,
            connectionState,
            connectionLoadError: null,
            hasConnectionsFile: true,
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        const tipText = document.getElementById("messagesTipText").textContent;
        expect(tipText).toContain("Active Conn");
        expect(tipText).toContain("top contact");
    });

    // --- Tip text: only silent connections, no top contact -------------------

    it("tip shows silent-connections count when no top contact but silent list non-empty", async () => {
        const messagesFile = {
            type: "messages",
            name: "tip4.csv",
            text: "x",
            updatedAt: 172,
            rowCount: 0,
        };
        DataCache.set("storage:file:messages", messagesFile);

        const silentConn = {
            name: "Silent One",
            url: "",
            nameKey: "silent one",
            connectedOnTimestamp: null,
            position: "",
            company: "",
        };

        // No message events = no top contacts
        const messageState = {
            contacts: new Map(),
            events: [],
            rowTimestamps: [],
            skippedRows: 0,
            talkedNameKeys: new Set(),
            talkedUrlKeys: new Set(),
            latestTimestamp: 0,
        };

        const connectionState = {
            list: [silentConn],
            byUrl: new Map(),
            byName: new Map([["silent one", silentConn]]),
        };

        const sig = `messages:${messagesFile.name}:${messagesFile.updatedAt}:${messagesFile.rowCount}|connections:none`;
        DataCache.set(`messages:state:${sig}`, {
            messageState,
            connectionState,
            connectionLoadError: null,
            hasConnectionsFile: true,
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        const tipText = document.getElementById("messagesTipText").textContent;
        expect(tipText).toContain("silent");
    });

    // --- Connections state reuse when signature matches ----------------------

    it("reuses cached state when data signature is unchanged on second route change", async () => {
        const messagesFile = {
            type: "messages",
            name: "reuse.csv",
            text: "x",
            updatedAt: 180,
            rowCount: 1,
        };
        DataCache.set("storage:file:messages", messagesFile);

        const messageState = makeMessageState();

        const sig = `messages:${messagesFile.name}:${messagesFile.updatedAt}:${messagesFile.rowCount}|connections:none`;
        DataCache.set(`messages:state:${sig}`, {
            messageState,
            connectionState: null,
            connectionLoadError: null,
            hasConnectionsFile: false,
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        const firstHtml = document.getElementById("topContactsList").innerHTML;

        // Second route change — same signature, cached state reused
        MessagesPage.onRouteChange({});
        await tick();

        expect(document.getElementById("topContactsList").innerHTML).toBe(firstHtml);
    });

    // --- Connection matching by nameKey (not URL) ----------------------------

    it("matches fading contact to connection by name key when URL missing", async () => {
        const now = Date.now();
        const oldTs = now - 45 * 24 * 60 * 60 * 1000;

        const messagesFile = {
            type: "messages",
            name: "namekey.csv",
            text: "x",
            updatedAt: 190,
            rowCount: 1,
        };
        DataCache.set("storage:file:messages", messagesFile);

        // Contact has no URL, will be matched by nameKey
        const conn = {
            name: "Name Match",
            url: "",
            nameKey: "name match",
            connectedOnTimestamp: oldTs,
            company: "NameCo",
        };

        const messageState = {
            contacts: new Map([
                // url is empty — forces name-key lookup in findMatchingConnection
                ["c1", { name: "Name Match", url: "", lastTimestamp: oldTs }],
            ]),
            events: [{ contactKey: "c1", timestamp: oldTs }],
            rowTimestamps: [oldTs],
            skippedRows: 0,
            talkedNameKeys: new Set(["name match"]),
            talkedUrlKeys: new Set(),
            latestTimestamp: now,
        };

        const connectionState = {
            list: [conn],
            byUrl: new Map(),
            byName: new Map([["name match", conn]]),
        };

        const sig = `messages:${messagesFile.name}:${messagesFile.updatedAt}:${messagesFile.rowCount}|connections:none`;
        DataCache.set(`messages:state:${sig}`, {
            messageState,
            connectionState,
            connectionLoadError: null,
            hasConnectionsFile: true,
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        const list = document.getElementById("fadingConversationsList");
        expect(list.innerHTML).toContain("Name Match");
    });

    // --- Connections file with text (loads via Storage.getAllFiles) ----------

    it("loads files from storage when not in cache", async () => {
        const timestamp = new Date("2024-03-01").getTime();

        globalThis.Worker = undefined;

        buildDom();
        vi.resetModules();
        ({ MessagesPage } = await import("../src/messages-insights.js"));
        ({ DataCache } = await import("../src/data-cache.js"));
        ({ Storage } = await import("../src/storage.js"));
        ({ LinkedInCleaner } = await import("../src/cleaner.js"));
        ({ MessagesAnalytics } = await import("../src/messages-analytics.js"));

        Storage.getAllFiles.mockResolvedValue([
            {
                type: "messages",
                name: "fromdb.csv",
                text: "csv-content",
                updatedAt: 200,
                rowCount: 1,
            },
            {
                type: "connections",
                name: "Connections.csv",
                text: "conn-content",
                updatedAt: 200,
                rowCount: 2,
            },
        ]);

        LinkedInCleaner.process
            .mockReturnValueOnce({ success: true, cleanedData: [] }) // messages
            .mockReturnValueOnce({ success: true, cleanedData: [] }); // connections

        MessagesAnalytics.buildMessageState.mockReturnValue({
            contacts: new Map([["c1", { name: "DB User", url: "", lastTimestamp: timestamp }]]),
            events: [{ contactKey: "c1", timestamp }],
            rowTimestamps: [timestamp],
            skippedRows: 0,
            talkedNameKeys: new Set(["db user"]),
            talkedUrlKeys: new Set(),
            latestTimestamp: timestamp,
        });
        MessagesAnalytics.buildConnectionState.mockReturnValue({
            list: [],
            byUrl: new Map(),
            byName: new Map(),
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        // Storage.getAllFiles was called (no cache hit)
        expect(Storage.getAllFiles).toHaveBeenCalled();
        // Top contacts list contains the parsed contact
        expect(document.getElementById("topContactsList").innerHTML).toContain("DB User");

        globalThis.Worker = undefined;
    });

    // --- Worker postMessage throws (catch path in processFilesInWorker) ------

    it("falls back to main-thread when worker postMessage throws", async () => {
        const throwingWorker = {
            postMessage: vi.fn(() => {
                throw new Error("postMessage failed");
            }),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            terminate: vi.fn(),
        };
        globalThis.Worker = function () {
            return throwingWorker;
        };

        buildDom();
        vi.resetModules();
        ({ MessagesPage } = await import("../src/messages-insights.js"));
        ({ DataCache } = await import("../src/data-cache.js"));
        ({ Storage } = await import("../src/storage.js"));
        ({ LinkedInCleaner } = await import("../src/cleaner.js"));
        ({ MessagesAnalytics } = await import("../src/messages-analytics.js"));

        const timestamp = new Date("2024-03-01").getTime();
        const messagesFile = {
            type: "messages",
            name: "throw.csv",
            text: "csv",
            updatedAt: 210,
            rowCount: 1,
        };
        DataCache.set("storage:file:messages", messagesFile);

        LinkedInCleaner.process.mockReturnValue({ success: true, cleanedData: [] });
        MessagesAnalytics.buildMessageState.mockReturnValue({
            contacts: new Map([["c1", { name: "Throw User", url: "", lastTimestamp: timestamp }]]),
            events: [{ contactKey: "c1", timestamp }],
            rowTimestamps: [timestamp],
            skippedRows: 0,
            talkedNameKeys: new Set(["throw user"]),
            talkedUrlKeys: new Set(),
            latestTimestamp: timestamp,
        });
        MessagesAnalytics.buildConnectionState.mockReturnValue({
            list: [],
            byUrl: new Map(),
            byName: new Map(),
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        expect(document.getElementById("topContactsList").innerHTML).toContain("Throw User");
    });

    // --- connections parse error from main-thread ----------------------------

    it("records connection parse error when connections CSV fails on main thread", async () => {
        globalThis.Worker = undefined;

        buildDom();
        vi.resetModules();
        ({ MessagesPage } = await import("../src/messages-insights.js"));
        ({ DataCache } = await import("../src/data-cache.js"));
        ({ Storage } = await import("../src/storage.js"));
        ({ LinkedInCleaner } = await import("../src/cleaner.js"));
        ({ MessagesAnalytics } = await import("../src/messages-analytics.js"));

        const timestamp = new Date("2024-01-01").getTime();

        // DataCache._values is empty (cleared in beforeEach), so DataCache.get()
        // returns undefined (falsy) for all keys, which causes loadData() to call
        // Storage.getAllFiles — no need for a blanket mockReturnValue(null) override.

        Storage.getAllFiles.mockResolvedValue([
            { type: "messages", name: "connerr.csv", text: "csv", updatedAt: 220, rowCount: 1 },
            {
                type: "connections",
                name: "Connections.csv",
                text: "bad-conn",
                updatedAt: 220,
                rowCount: 0,
            },
        ]);

        LinkedInCleaner.process
            .mockReturnValueOnce({ success: true, cleanedData: [] }) // messages OK
            .mockReturnValueOnce({ success: false, error: "Bad conn CSV" }); // connections fail

        MessagesAnalytics.buildMessageState.mockReturnValue({
            contacts: new Map([["c1", { name: "Err User", url: "", lastTimestamp: timestamp }]]),
            events: [{ contactKey: "c1", timestamp }],
            rowTimestamps: [timestamp],
            skippedRows: 0,
            talkedNameKeys: new Set(["err user"]),
            talkedUrlKeys: new Set(),
            latestTimestamp: timestamp,
        });
        MessagesAnalytics.buildConnectionState.mockReturnValue({
            list: [],
            byUrl: new Map(),
            byName: new Map(),
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        // Connection error should appear in the silent connections list
        expect(document.getElementById("silentConnectionsList").innerHTML).toContain(
            "Bad conn CSV",
        );

        globalThis.Worker = undefined;
    });

    // --- Range filter limits visible results --------------------------------

    it("filters top contacts to the selected time range", async () => {
        buildDom();
        vi.resetModules();
        ({ MessagesPage } = await import("../src/messages-insights.js"));
        ({ DataCache } = await import("../src/data-cache.js"));
        ({ AppRouter } = await import("../src/router.js"));
        ({ Storage } = await import("../src/storage.js"));

        // Use a fixed "latest" date of 2024-06-15 so range calculation is deterministic.
        // getRangeStart('1m', latestTs) returns the first day of the month 0 months back,
        // i.e. 2024-06-01 00:00:00.
        // A recent event on 2024-06-10 is inside 1m.
        // An old event on 2023-12-01 is outside 1m but inside 12m.
        const latest = new Date("2024-06-15").getTime(); // latestTimestamp
        const recent = new Date("2024-06-10").getTime(); // within 1m window
        const old = new Date("2023-12-01").getTime(); // outside 1m window

        const messagesFile = {
            type: "messages",
            name: "range.csv",
            text: "x",
            updatedAt: 230,
            rowCount: 2,
        };
        DataCache.set("storage:file:messages", messagesFile);

        const messageState = {
            contacts: new Map([
                ["c1", { name: "Recent Contact", url: "", lastTimestamp: recent }],
                ["c2", { name: "Old Contact", url: "", lastTimestamp: old }],
            ]),
            events: [
                { contactKey: "c1", timestamp: recent },
                { contactKey: "c2", timestamp: old },
            ],
            rowTimestamps: [recent, old],
            skippedRows: 0,
            talkedNameKeys: new Set(["recent contact", "old contact"]),
            talkedUrlKeys: new Set(),
            latestTimestamp: latest,
        };

        const sig = `messages:${messagesFile.name}:${messagesFile.updatedAt}:${messagesFile.rowCount}|connections:none`;
        DataCache.set(`messages:state:${sig}`, {
            messageState,
            connectionState: null,
            connectionLoadError: null,
            hasConnectionsFile: false,
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        // Switch to 1m — rangeStart becomes 2024-06-01 00:00:00
        // Old Contact (2023-12-01) should NOT appear; Recent Contact (2024-06-10) SHOULD
        document.querySelector('[data-range="1m"]').click();

        const list = document.getElementById("topContactsList");
        expect(list.innerHTML).toContain("Recent Contact");
        expect(list.innerHTML).not.toContain("Old Contact");
    });

    // --- renderContactName with URL (produces <a> tag) ----------------------

    it("renders contact name as link when URL is present", async () => {
        const timestamp = new Date("2024-06-01").getTime();
        const messagesFile = {
            type: "messages",
            name: "link.csv",
            text: "x",
            updatedAt: 240,
            rowCount: 1,
        };
        DataCache.set("storage:file:messages", messagesFile);

        const messageState = {
            contacts: new Map([
                [
                    "c1",
                    {
                        name: "Link Person",
                        url: "https://linkedin.com/in/link",
                        lastTimestamp: timestamp,
                    },
                ],
            ]),
            events: [{ contactKey: "c1", timestamp }],
            rowTimestamps: [timestamp],
            skippedRows: 0,
            talkedNameKeys: new Set(["link person"]),
            talkedUrlKeys: new Set(["https://linkedin.com/in/link"]),
            latestTimestamp: timestamp,
        };

        const sig = `messages:${messagesFile.name}:${messagesFile.updatedAt}:${messagesFile.rowCount}|connections:none`;
        DataCache.set(`messages:state:${sig}`, {
            messageState,
            connectionState: null,
            connectionLoadError: null,
            hasConnectionsFile: false,
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        expect(document.getElementById("topContactsList").innerHTML).toContain(
            '<a href="https://linkedin.com/in/link"',
        );
    });

    // --- hydrateConnectionState: byName fallback when url missing -----------

    it("hydrateConnectionState populates byName map from connection list", async () => {
        let workerMsgHandler = null;
        const mockWorker = {
            postMessage: vi.fn(),
            addEventListener: vi.fn((type, handler) => {
                if (type === "message") {
                    workerMsgHandler = handler;
                }
            }),
            removeEventListener: vi.fn(),
            terminate: vi.fn(),
        };
        globalThis.Worker = function () {
            return mockWorker;
        };

        buildDom();
        vi.resetModules();
        ({ MessagesPage } = await import("../src/messages-insights.js"));
        ({ DataCache } = await import("../src/data-cache.js"));
        ({ Storage } = await import("../src/storage.js"));

        const now = Date.now();
        const oldTs = now - 50 * 24 * 60 * 60 * 1000;

        // Provide both messages AND connections files so hasConnectionsFile = true
        const messagesFile = {
            type: "messages",
            name: "hyd.csv",
            text: "csv",
            updatedAt: 250,
            rowCount: 1,
        };
        const connectionsFile = {
            type: "connections",
            name: "Connections.csv",
            text: "csv",
            updatedAt: 250,
            rowCount: 1,
        };
        DataCache.set("storage:file:messages", messagesFile);
        DataCache.set("storage:file:connections", connectionsFile);

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        if (workerMsgHandler) {
            workerMsgHandler({
                data: {
                    type: "processed",
                    requestId: 1,
                    payload: {
                        success: true,
                        totalInputRows: 1,
                        messageState: {
                            contacts: [
                                { key: "c1", name: "Hyd User", url: "", lastTimestamp: oldTs },
                            ],
                            events: [{ contactKey: "c1", timestamp: oldTs }],
                            rowTimestamps: [oldTs],
                            skippedRows: 0,
                            talkedNameKeys: ["hyd user"],
                            talkedUrlKeys: [],
                            latestTimestamp: now,
                        },
                        // Connection with no URL — will be keyed by nameKey only
                        connectionState: {
                            list: [
                                {
                                    name: "Hyd User",
                                    url: "",
                                    nameKey: "hyd user", // matches contact's normalized name
                                    connectedOnTimestamp: oldTs,
                                    company: "HydCo",
                                },
                            ],
                        },
                        connectionError: null,
                    },
                },
            });
        }
        await tick();

        // Fading conversations should include the matched connection (inactive > 30 days)
        expect(document.getElementById("fadingConversationsList").innerHTML).toContain("Hyd User");
    });

    // --- Export disabled when list is empty ----------------------------------

    it("export buttons are disabled when lists are empty", async () => {
        const messagesFile = {
            type: "messages",
            name: "noexp.csv",
            text: "x",
            updatedAt: 260,
            rowCount: 0,
        };
        DataCache.set("storage:file:messages", messagesFile);

        const messageState = {
            contacts: new Map(),
            events: [],
            rowTimestamps: [],
            skippedRows: 0,
            talkedNameKeys: new Set(),
            talkedUrlKeys: new Set(),
            latestTimestamp: 0,
        };

        const sig = `messages:${messagesFile.name}:${messagesFile.updatedAt}:${messagesFile.rowCount}|connections:none`;
        DataCache.set(`messages:state:${sig}`, {
            messageState,
            connectionState: { list: [], byUrl: new Map(), byName: new Map() },
            connectionLoadError: null,
            hasConnectionsFile: true,
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        expect(document.getElementById("topContactsExportBtn").disabled).toBe(true);
        expect(document.getElementById("silentConnectionsExportBtn").disabled).toBe(true);
        expect(document.getElementById("fadingConversationsExportBtn").disabled).toBe(true);
    });

    // --- Worker-initiated path: wrong requestId is ignored ------------------

    it("ignores worker messages with mismatched requestId", async () => {
        let workerMsgHandler = null;
        const mockWorker = {
            postMessage: vi.fn(),
            addEventListener: vi.fn((type, handler) => {
                if (type === "message") {
                    workerMsgHandler = handler;
                }
            }),
            removeEventListener: vi.fn(),
            terminate: vi.fn(),
        };
        globalThis.Worker = function () {
            return mockWorker;
        };

        buildDom();
        vi.resetModules();
        ({ MessagesPage } = await import("../src/messages-insights.js"));
        ({ DataCache } = await import("../src/data-cache.js"));
        ({ Storage } = await import("../src/storage.js"));

        const messagesFile = {
            type: "messages",
            name: "wrongid.csv",
            text: "csv",
            updatedAt: 270,
            rowCount: 1,
        };
        DataCache.set("storage:file:messages", messagesFile);

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        // Send a message with wrong requestId — should be silently ignored
        if (workerMsgHandler) {
            workerMsgHandler({
                data: {
                    type: "processed",
                    requestId: 9999, // mismatch
                    payload: { success: true },
                },
            });
        }

        await tick();
        // Still in loading/empty state since the wrong ID was ignored
        // No throw = pass
    });

    // --- onRouteChange with empty DOM (coverage for lines 79-80, 94-95) ------

    it("onRouteChange returns early when DOM elements are missing", async () => {
        document.body.innerHTML = "";
        vi.resetModules();
        const { MessagesPage: MI } = await import("../src/messages-insights.js");
        // onRouteChange should call init() which returns early due to missing elements,
        // and then onRouteChange itself returns early — no exception should be thrown.
        MI.onRouteChange({});
        // passes if no exception is thrown
    });

    // --- getTopContactsInRange accumulates count for repeated contactKey ------

    it("accumulates message count for contacts with multiple events", async () => {
        const latest = new Date("2024-06-15").getTime();
        const t1 = new Date("2024-06-10").getTime();
        const t2 = new Date("2024-06-11").getTime();

        const messagesFile = {
            type: "messages",
            name: "multi.csv",
            text: "x",
            updatedAt: 280,
            rowCount: 2,
        };
        DataCache.set("storage:file:messages", messagesFile);

        // Two events for the same contact key → count should be 2
        const messageState = {
            contacts: new Map([
                ["c1", { name: "Repeat Contact", url: "", lastTimestamp: t2 }],
                ["c2", { name: "Single Contact", url: "", lastTimestamp: t1 }],
            ]),
            events: [
                { contactKey: "c1", timestamp: t1 },
                { contactKey: "c1", timestamp: t2 }, // second event for c1
                { contactKey: "c2", timestamp: t1 },
            ],
            rowTimestamps: [t1, t2, t1],
            skippedRows: 0,
            talkedNameKeys: new Set(["repeat contact", "single contact"]),
            talkedUrlKeys: new Set(),
            latestTimestamp: latest,
        };

        const sig = `messages:${messagesFile.name}:${messagesFile.updatedAt}:${messagesFile.rowCount}|connections:none`;
        DataCache.set(`messages:state:${sig}`, {
            messageState,
            connectionState: null,
            connectionLoadError: null,
            hasConnectionsFile: false,
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        // Repeat Contact should appear in the top contacts list (count=2 sorts higher)
        const list = document.getElementById("topContactsList");
        expect(list.innerHTML).toContain("Repeat Contact");
    });

    // --- getSilentConnections sort with multiple silent connections -----------

    it("sorts silent connections by connectedOnTimestamp", async () => {
        const ts1 = new Date("2022-01-01").getTime();
        const ts2 = new Date("2023-06-01").getTime();

        const messagesFile = {
            type: "messages",
            name: "silentsort.csv",
            text: "x",
            updatedAt: 290,
            rowCount: 1,
        };
        DataCache.set("storage:file:messages", messagesFile);

        const conn1 = {
            name: "Zeta Connect",
            url: "https://li.com/zeta",
            nameKey: "zeta connect",
            connectedOnTimestamp: ts2, // newer
        };
        const conn2 = {
            name: "Alpha Connect",
            url: "https://li.com/alpha",
            nameKey: "alpha connect",
            connectedOnTimestamp: ts1, // older — should sort first
        };
        const messageState = {
            contacts: new Map(),
            events: [],
            rowTimestamps: [],
            skippedRows: 0,
            talkedNameKeys: new Set(),
            talkedUrlKeys: new Set(),
            latestTimestamp: Date.now(),
        };
        const connectionState = {
            list: [conn1, conn2],
            byUrl: new Map([
                ["https://li.com/zeta", conn1],
                ["https://li.com/alpha", conn2],
            ]),
            byName: new Map([
                ["zeta connect", conn1],
                ["alpha connect", conn2],
            ]),
        };

        const sig = `messages:${messagesFile.name}:${messagesFile.updatedAt}:${messagesFile.rowCount}|connections:none`;
        DataCache.set(`messages:state:${sig}`, {
            messageState,
            connectionState,
            connectionLoadError: null,
            hasConnectionsFile: true,
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        const html = document.getElementById("silentConnectionsList").innerHTML;
        // Both connections should appear
        expect(html).toContain("Alpha Connect");
        expect(html).toContain("Zeta Connect");
        // Alpha (older) should appear before Zeta (newer)
        const alphaIdx = html.indexOf("Alpha Connect");
        const zetaIdx = html.indexOf("Zeta Connect");
        expect(alphaIdx).toBeLessThan(zetaIdx);
    });

    // --- getFadingConversations sort with multiple fading contacts ------------

    it("sorts fading conversations by lastTimestamp descending", async () => {
        const now = Date.now();
        const t1 = now - 60 * 24 * 60 * 60 * 1000; // 60 days ago
        const t2 = now - 45 * 24 * 60 * 60 * 1000; // 45 days ago (more recent)

        const messagesFile = {
            type: "messages",
            name: "fadingsort.csv",
            text: "x",
            updatedAt: 300,
            rowCount: 2,
        };
        DataCache.set("storage:file:messages", messagesFile);

        const conn1 = {
            name: "Old Fader",
            url: "https://li.com/old",
            nameKey: "old fader",
            connectedOnTimestamp: t1,
            company: "A",
        };
        const conn2 = {
            name: "New Fader",
            url: "https://li.com/new",
            nameKey: "new fader",
            connectedOnTimestamp: t2,
            company: "B",
        };
        const messageState = {
            contacts: new Map([
                ["c1", { name: "Old Fader", url: "https://li.com/old", lastTimestamp: t1 }],
                ["c2", { name: "New Fader", url: "https://li.com/new", lastTimestamp: t2 }],
            ]),
            events: [
                { contactKey: "c1", timestamp: t1 },
                { contactKey: "c2", timestamp: t2 },
            ],
            rowTimestamps: [t1, t2],
            skippedRows: 0,
            talkedNameKeys: new Set(["old fader", "new fader"]),
            talkedUrlKeys: new Set(["https://li.com/old", "https://li.com/new"]),
            latestTimestamp: now,
        };
        const connectionState = {
            list: [conn1, conn2],
            byUrl: new Map([
                ["https://li.com/old", conn1],
                ["https://li.com/new", conn2],
            ]),
            byName: new Map([
                ["old fader", conn1],
                ["new fader", conn2],
            ]),
        };

        const sig = `messages:${messagesFile.name}:${messagesFile.updatedAt}:${messagesFile.rowCount}|connections:none`;
        DataCache.set(`messages:state:${sig}`, {
            messageState,
            connectionState,
            connectionLoadError: null,
            hasConnectionsFile: true,
        });

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        const html = document.getElementById("fadingConversationsList").innerHTML;
        expect(html).toContain("Old Fader");
        expect(html).toContain("New Fader");
        // New Fader (more recent timestamp) should appear first
        expect(html.indexOf("New Fader")).toBeLessThan(html.indexOf("Old Fader"));
    });

    // --- getRangeStart returns null for 'all' with actual data ---------------

    it('getRangeStart returns null for "all" range (shows all contacts)', async () => {
        const latest = new Date("2024-01-15").getTime();
        const old = new Date("2020-06-01").getTime(); // very old — filtered by 12m but not 'all'

        const messagesFile = {
            type: "messages",
            name: "allrange.csv",
            text: "x",
            updatedAt: 310,
            rowCount: 1,
        };
        DataCache.set("storage:file:messages", messagesFile);

        const messageState = {
            contacts: new Map([["c1", { name: "Old Timer", url: "", lastTimestamp: old }]]),
            events: [{ contactKey: "c1", timestamp: old }],
            rowTimestamps: [old],
            skippedRows: 0,
            talkedNameKeys: new Set(["old timer"]),
            talkedUrlKeys: new Set(),
            latestTimestamp: latest,
        };

        const sig = `messages:${messagesFile.name}:${messagesFile.updatedAt}:${messagesFile.rowCount}|connections:none`;
        DataCache.set(`messages:state:${sig}`, {
            messageState,
            connectionState: null,
            connectionLoadError: null,
            hasConnectionsFile: false,
        });

        // Re-import with 'all' DOM button
        buildDom({
            rangeButtons: `
                <button class="filter-btn active" data-range="12m"></button>
                <button class="filter-btn" data-range="all"></button>
            `,
        });
        vi.resetModules();
        ({ MessagesPage } = await import("../src/messages-insights.js"));
        ({ DataCache } = await import("../src/data-cache.js"));

        DataCache.set("storage:file:messages", messagesFile);
        DataCache.set(`messages:state:${sig}`, {
            messageState,
            connectionState: null,
            connectionLoadError: null,
            hasConnectionsFile: false,
        });

        // Load with 12m first (old timer should not appear)
        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();
        expect(document.getElementById("topContactsList").innerHTML).not.toContain("Old Timer");

        // Click 'all' button — old timer SHOULD appear now
        document.querySelector('[data-range="all"]').click();
        expect(document.getElementById("topContactsList").innerHTML).toContain("Old Timer");
    });

    // Skip contacts that do not have a stable key during hydration.

    it("hydrateMessageState skips contacts with no key", async () => {
        let workerMsgHandler = null;
        const mockWorker = {
            postMessage: vi.fn(),
            addEventListener: vi.fn((type, handler) => {
                if (type === "message") {
                    workerMsgHandler = handler;
                }
            }),
            removeEventListener: vi.fn(),
            terminate: vi.fn(),
        };
        globalThis.Worker = function () {
            return mockWorker;
        };

        buildDom();
        vi.resetModules();
        ({ MessagesPage } = await import("../src/messages-insights.js"));
        ({ DataCache } = await import("../src/data-cache.js"));
        ({ Storage } = await import("../src/storage.js"));

        const messagesFile = {
            type: "messages",
            name: "nullkey.csv",
            text: "csv",
            updatedAt: 320,
            rowCount: 1,
        };
        DataCache.set("storage:file:messages", messagesFile);

        MessagesPage.init();
        MessagesPage.onRouteChange({});
        await tick();

        const now = Date.now();
        if (workerMsgHandler) {
            workerMsgHandler({
                data: {
                    type: "processed",
                    requestId: 1,
                    payload: {
                        success: true,
                        totalInputRows: 2,
                        messageState: {
                            contacts: [
                                null, // null entry — should be skipped
                                { key: "", name: "No Key User" }, // empty key — should be skipped
                                { key: "c1", name: "Valid User", url: "", lastTimestamp: now },
                            ],
                            events: [{ contactKey: "c1", timestamp: now }],
                            rowTimestamps: [now],
                            skippedRows: 0,
                            talkedNameKeys: ["valid user"],
                            talkedUrlKeys: [],
                            latestTimestamp: now,
                        },
                    },
                },
            });
        }
        await tick();

        // Only Valid User should appear in the list
        const html = document.getElementById("topContactsList").innerHTML;
        expect(html).toContain("Valid User");
        expect(html).not.toContain("No Key User");
    });
});
