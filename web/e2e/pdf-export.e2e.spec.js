const fs = require("fs");
const path = require("path");

const AxeBuilder = require("@axe-core/playwright").default;
const { expect, test } = require("@playwright/test");

const { extractPdfText } = require("./helpers/pdf-text.js");
const { uploadFiles, waitForLoadedStatus } = require("./helpers/upload.js");

const SHARES_CSV = path.join(__dirname, "fixtures", "Shares.csv");
const COMMENTS_CSV = path.join(__dirname, "fixtures", "Comments.csv");
const CONNECTIONS_CSV = path.join(__dirname, "fixtures", "Connections.csv");
const MESSAGES_CSV = path.join(__dirname, "fixtures", "Messages.csv");
const MESSAGE_THREADS_CSV = path.join(__dirname, "fixtures", "MessagesThreads.csv");
// Twelve companies and twelve positions over seven years. Both bar charts fill,
// and the connections dashboard runs past one page.
const CONNECTIONS_WIDE_CSV = path.join(__dirname, "fixtures", "ConnectionsWide.csv");

// Each body in MessagesThreads.csv starts with a character the spreadsheet
// cleaner quote-prefixes. The PDF keeps the text as written.
const EXPORTED_BODIES = [
    "+1, that works for me",
    "=totally fine by me",
    "@Bob could you take a look",
    "-2 days later is fine",
];

/**
 * Wait for the export trigger to actually be available, then return it.
 *
 * Waits for `aria-disabled` to be "false". The trigger is never natively disabled,
 * so `toBeEnabled()` cannot tell when it is ready.
 * @param {import('@playwright/test').Page} page - Playwright page instance
 * @returns {Promise<import('@playwright/test').Locator>} The ready trigger
 */
async function waitForExportTrigger(page) {
    const trigger = page.locator("#pdfExportBtn");
    await expect(trigger).toHaveAttribute("aria-disabled", "false", { timeout: 20000 });
    return trigger;
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        /** @type {Window & { __LINKEDIN_ANALYZER_DISABLE_TUTORIALS__?: boolean }} */
        const globalWindow = window;
        globalWindow.__LINKEDIN_ANALYZER_DISABLE_TUTORIALS__ = true;
    });
});

// Checks the download, file name, dialog, and focus. The next test checks the document text.
test("save as PDF downloads a valid PDF and restores focus", async ({ page }, testInfo) => {
    await uploadFiles(page, [SHARES_CSV, COMMENTS_CSV, MESSAGES_CSV]);
    await waitForLoadedStatus(page, "sharesStatus");
    await waitForLoadedStatus(page, "commentsStatus");
    await waitForLoadedStatus(page, "messagesStatus");

    const trigger = await waitForExportTrigger(page);
    await trigger.click();

    const dialog = page.locator("#pdfExportDialog");
    await expect(dialog).toBeVisible();

    const includeMessages = page.locator("#pdfExportIncludeMessages");
    await expect(includeMessages).not.toBeChecked();

    // Runs axe over the open dialog.
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const critical = results.violations.filter(
        (violation) => violation.impact === "critical" || violation.impact === "serious",
    );
    expect(critical).toEqual([]);

    await includeMessages.check();

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#pdfExportConfirmBtn").click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/^linkedin-insights-\d{4}-\d{2}-\d{2}\.pdf$/);

    const outputPath = testInfo.outputPath("linkedin-insights.pdf");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    await download.saveAs(outputPath);

    const bytes = fs.readFileSync(outputPath);
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("%PDF");
    // Size floor: the file is more than a header. The next test checks the content.
    expect(bytes.byteLength).toBeGreaterThan(5000);

    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
});

test("the opted-in PDF really contains the message text", async ({ page }, testInfo) => {
    // Embedded TrueType subsets write text as glyph ids. Blocking the font files selects
    // the Helvetica fallback, where the text is readable in the content stream.
    await page.route("**/fonts/*.ttf", (route) => route.abort());

    await uploadFiles(page, [SHARES_CSV, MESSAGE_THREADS_CSV]);
    await waitForLoadedStatus(page, "sharesStatus");
    await waitForLoadedStatus(page, "messagesStatus");

    const trigger = await waitForExportTrigger(page);
    await trigger.click();
    await page.locator("#pdfExportIncludeMessages").check();

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#pdfExportConfirmBtn").click();
    const download = await downloadPromise;

    const outputPath = testInfo.outputPath("linkedin-insights-threads.pdf");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    await download.saveAs(outputPath);

    const text = extractPdfText(fs.readFileSync(outputPath));

    expect(text).toContain("Recent conversations");
    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("Bob Smith");
    for (const body of EXPORTED_BODIES) {
        expect(text).toContain(body);
    }
    // Spreadsheet quote prefixes must not appear.
    expect(text).not.toContain("'+1");
    expect(text).not.toContain("'=");
    expect(text).not.toContain("'@");
    // Two conversations, each with messages in both directions. The Sent and Received chips label them.
    expect(text).toContain("Sent");
    expect(text).toContain("Received");
    expect(text).not.toContain("Sam Self");
});

test("save as PDF works in dark mode and closes on Escape", async ({ page }) => {
    await uploadFiles(page, [SHARES_CSV, COMMENTS_CSV]);
    await waitForLoadedStatus(page, "sharesStatus");
    await waitForLoadedStatus(page, "commentsStatus");

    await page.locator("#themeToggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    const trigger = await waitForExportTrigger(page);
    await trigger.click();
    await expect(page.locator("#pdfExportDialog")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator("#pdfExportDialog")).toBeHidden();
    await expect(trigger).toBeFocused();

    // The document reads colors from a detached .theme-light probe, so the light palette resolves while the page is dark.
    const probed = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.className = "theme-light";
        document.body.appendChild(probe);
        const styles = getComputedStyle(probe);
        const read = (/** @type {string} */ token) => styles.getPropertyValue(token).trim();
        const values = {
            bgPrimary: read("--bg-primary"),
            textPrimary: read("--text-primary"),
            accentBlue: read("--accent-blue"),
            accentYellowBg: read("--accent-yellow-bg"),
        };
        probe.remove();
        return values;
    });

    // The build minifies token values, so these compare colors rather than the text in variables.css.
    expect(probed.bgPrimary.toLowerCase()).toMatch(
        /^(#fffdf7|rgba?\(255,\s?253,\s?247(,\s?1)?\))$/,
    );
    expect(probed.textPrimary.toLowerCase()).toMatch(/^(#1c1917|rgba?\(28,\s?25,\s?23(,\s?1)?\))$/);
    expect(probed.accentBlue.toLowerCase()).toMatch(
        /^(#4285f4|rgba?\(66,\s?133,\s?244(,\s?1)?\))$/,
    );
    // Tinted tokens keep their alpha, in whichever form the minifier emits.
    expect(probed.accentYellowBg.toLowerCase()).toMatch(
        /^(#fbbc0526|rgba\(251,\s?188,\s?5,\s?\.?0?\.?15\))$/,
    );

    // The opted-in section is omitted when no messages export is uploaded, and
    // the export still succeeds.
    await trigger.click();
    await page.locator("#pdfExportIncludeMessages").check();
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#pdfExportConfirmBtn").click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toContain("linkedin-insights-");
});

test("the PDF carries a dashboard page per screen", async ({ page }, testInfo) => {
    // Blocks the font files so the headings are readable in the content stream.
    await page.route("**/fonts/*.ttf", (route) => route.abort());

    await uploadFiles(page, [SHARES_CSV, COMMENTS_CSV, CONNECTIONS_CSV, MESSAGES_CSV]);
    await waitForLoadedStatus(page, "sharesStatus");
    await waitForLoadedStatus(page, "commentsStatus");
    await waitForLoadedStatus(page, "connectionsStatus");
    await waitForLoadedStatus(page, "messagesStatus");

    const trigger = await waitForExportTrigger(page);
    await trigger.click();
    await page.locator("#pdfExportIncludeNames").check();

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#pdfExportConfirmBtn").click();
    const download = await downloadPromise;

    const outputPath = testInfo.outputPath("linkedin-insights-dashboards.pdf");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    await download.saveAs(outputPath);
    const text = extractPdfText(fs.readFileSync(outputPath));

    // Each screen's own headings, so the page divides the way the site does.
    expect(text).toContain("Analytics");
    expect(text).toContain("Activity timeline");
    expect(text).toContain("Top topics");
    expect(text).toContain("When you are active");
    expect(text).toContain("Connection growth");
    expect(text).toContain("Network age");
    // The connections dashboard covers all time, not the screen's twelve-month default.
    // This fixture's connections all predate that window.
    expect(text).toContain("Top companies");
    expect(text).toContain("Top positions");
    expect(text).toContain("Messages in range");
    // Opted in, so the lists that name people are drawn.
    expect(text).toContain("Top contacts");

    // Each dashboard starts its own page, so the footer total is at least four.
    expect(text).toMatch(/Page 1 of ([4-9]|\d{2,})/);
});

test("the names opt-in gates the lists but not the counts", async ({ page }, testInfo) => {
    await page.route("**/fonts/*.ttf", (route) => route.abort());

    await uploadFiles(page, [SHARES_CSV, CONNECTIONS_CSV, MESSAGE_THREADS_CSV]);
    await waitForLoadedStatus(page, "sharesStatus");
    await waitForLoadedStatus(page, "connectionsStatus");
    await waitForLoadedStatus(page, "messagesStatus");

    const trigger = await waitForExportTrigger(page);
    await trigger.click();
    await expect(page.locator("#pdfExportIncludeNames")).not.toBeChecked();

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#pdfExportConfirmBtn").click();
    const download = await downloadPromise;

    const outputPath = testInfo.outputPath("linkedin-insights-no-names.pdf");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    await download.saveAs(outputPath);
    const text = extractPdfText(fs.readFileSync(outputPath));

    expect(text).toContain("Messages in range");
    expect(text).toContain("Fading conversations");
    // The stat tile keeps its count. Contact lists and their names are absent.
    expect(text).not.toContain("Top contacts");
    expect(text).not.toContain("Silent connections");
    expect(text).not.toContain("Ada Lovelace");
    expect(text).not.toContain("Bob Smith");
});

test("message contents name their contacts even with the names box unticked", async ({
    page,
}, testInfo) => {
    // Message transcripts include the correspondent's name as a heading. The
    // message-content option includes that name independently of the
    // dashboard-name option.
    await page.route("**/fonts/*.ttf", (route) => route.abort());

    await uploadFiles(page, [SHARES_CSV, CONNECTIONS_CSV, MESSAGE_THREADS_CSV]);
    await waitForLoadedStatus(page, "sharesStatus");
    await waitForLoadedStatus(page, "connectionsStatus");
    await waitForLoadedStatus(page, "messagesStatus");

    const trigger = await waitForExportTrigger(page);
    await trigger.click();
    await expect(page.locator("#pdfExportIncludeNames")).not.toBeChecked();
    await page.locator("#pdfExportIncludeMessages").check();

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#pdfExportConfirmBtn").click();
    const download = await downloadPromise;

    const outputPath = testInfo.outputPath("linkedin-insights-threads-no-names.pdf");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    await download.saveAs(outputPath);
    const text = extractPdfText(fs.readFileSync(outputPath));

    // The transcript includes the correspondent's name.
    expect(text).toContain("Recent conversations");
    expect(text).toContain("Ada Lovelace");
    // Dashboard contact lists remain absent.
    expect(text).not.toContain("Top contacts");
    expect(text).not.toContain("Silent connections");
});

test("a dashboard that outgrows its page carries a continuation heading", async ({
    page,
}, testInfo) => {
    // ConnectionsWide.csv fills both bar charts, and the connections dashboard runs onto
    // a second page. That page is labeled as a continuation.
    await page.route("**/fonts/*.ttf", (route) => route.abort());

    await uploadFiles(page, [SHARES_CSV, CONNECTIONS_WIDE_CSV]);
    await waitForLoadedStatus(page, "sharesStatus");
    await waitForLoadedStatus(page, "connectionsStatus");

    const trigger = await waitForExportTrigger(page);
    await trigger.click();

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#pdfExportConfirmBtn").click();
    const download = await downloadPromise;

    const outputPath = testInfo.outputPath("linkedin-insights-continued.pdf");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    await download.saveAs(outputPath);
    const text = extractPdfText(fs.readFileSync(outputPath));

    expect(text).toContain("Connections (continued)");
    // The heading moves with its chart onto the new page.
    expect(text).toContain("Top positions");
});

test("captions name the months the data covers, not a relative range", async ({
    page,
}, testInfo) => {
    // Captions state the covered months as dates. A relative label is anchored on the
    // newest row in the file, not on the document date, so it is not used.
    await page.route("**/fonts/*.ttf", (route) => route.abort());

    await uploadFiles(page, [SHARES_CSV, CONNECTIONS_WIDE_CSV]);
    await waitForLoadedStatus(page, "sharesStatus");
    await waitForLoadedStatus(page, "connectionsStatus");

    const trigger = await waitForExportTrigger(page);
    await trigger.click();

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#pdfExportConfirmBtn").click();
    const download = await downloadPromise;

    const outputPath = testInfo.outputPath("linkedin-insights-window.pdf");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    await download.saveAs(outputPath);
    const text = extractPdfText(fs.readFileSync(outputPath));

    expect(text).toMatch(/[A-Z][a-z]{2} \d{4} to [A-Z][a-z]{2} \d{4}/);
    expect(text).not.toContain("Last 12 months");
});

test("a name the fonts cannot draw is marked, and the site still shows it whole", async ({
    page,
}, testInfo) => {
    // The export marks characters its font cannot draw instead of dropping them. The site
    // shows the full name through the browser's font fallback.
    //
    // Fonts are blocked, so the document uses the Helvetica path, whose drawable set is
    // WinAnsi. Unit tests cover both sets. This test checks that Latin-1 survives and
    // characters outside the set are marked.
    await page.route("**/fonts/*.ttf", (route) => route.abort());

    await uploadFiles(page, [SHARES_CSV, CONNECTIONS_WIDE_CSV]);
    await waitForLoadedStatus(page, "sharesStatus");
    await waitForLoadedStatus(page, "connectionsStatus");

    // Navigates through the hub card, not the URL. A fresh load of `#connections`
    // shows the placeholder stat until the upload is restored.
    await page.locator('#screen-home a.hub-card[data-route="connections"]').click();
    await expect(page).toHaveURL(/#connections/);
    // Selects All time, the range the exported dashboard draws. The screen opens on its
    // twelve-month default, which every dated row in this fixture predates.
    await page.locator('#screen-connections .filter-btn[data-range="all"]').click();
    await expect(page.locator("#connStatTopCompany")).toHaveText("北京科技", {
        timeout: 20000,
    });

    const trigger = await waitForExportTrigger(page);
    await trigger.click();

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#pdfExportConfirmBtn").click();
    const download = await downloadPromise;

    const outputPath = testInfo.outputPath("linkedin-insights-undrawable.pdf");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    await download.saveAs(outputPath);
    const text = extractPdfText(fs.readFileSync(outputPath));

    expect(text).not.toContain("北京科技");
    expect(text).toContain("?");
    // Latin-1 characters pass through, so an accented name is untouched. Without this,
    // the check above would also pass if every non-ASCII character were replaced.
    expect(text).toContain("Café Zürich");
});
