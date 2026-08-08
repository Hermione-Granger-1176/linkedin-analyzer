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
// Twelve companies and twelve positions, spread over seven years, so both bar
// charts fill and the connections dashboard is taller than a single page.
const CONNECTIONS_WIDE_CSV = path.join(__dirname, "fixtures", "ConnectionsWide.csv");

// Every body in MessagesThreads.csv starts with a character the spreadsheet
// cleaner quote-prefixes, which is right for a workbook and wrong here.
const EXPORTED_BODIES = [
    "+1, that works for me",
    "=totally fine by me",
    "@Bob could you take a look",
    "-2 days later is fine",
];

/**
 * Wait for the export trigger to actually be available, then return it.
 *
 * The button is never natively disabled - it stays in the tab order and carries
 * its own reason for being unavailable - so `toBeEnabled()` passes on it
 * immediately and would race the asynchronous availability check, leaving the
 * click to land on a button that refuses it. `aria-disabled` is the real state.
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

// Contents are the next test's job: it blocks the fonts so the text is readable
// as literals. This one covers the round trip, the file name, and the dialog and
// focus behaviour around it.
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

    // Axe over the open dialog, matching the scan the other specs run.
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
    // A floor the embedded font subsets alone would clear, so it says the file
    // is real rather than that it has content: that is the next test's claim.
    expect(bytes.byteLength).toBeGreaterThan(5000);

    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
});

test("the opted-in PDF really contains the message text", async ({ page }, testInfo) => {
    // The document is drawn with embedded TrueType subsets, whose text is written
    // as glyph ids. Blocking the font files takes the documented Helvetica
    // fallback instead, where the text is readable in the content stream, so the
    // assertions below are about the bodies rather than the byte count.
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
    // The spreadsheet path would have written "'+1, that works for me".
    expect(text).not.toContain("'+1");
    expect(text).not.toContain("'=");
    expect(text).not.toContain("'@");
    // Two conversations, each with a message in both directions, so the account
    // owner is unambiguous and the chips say so.
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

    // The document reads its colors off a detached .theme-light probe, so the
    // warm light palette has to resolve even while the page is dark.
    const probed = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.className = "theme-light";
        document.body.appendChild(probe);
        const styles = getComputedStyle(probe);
        const read = (token) => styles.getPropertyValue(token).trim();
        const values = {
            bgPrimary: read("--bg-primary"),
            textPrimary: read("--text-primary"),
            accentBlue: read("--accent-blue"),
            accentYellowBg: read("--accent-yellow-bg"),
        };
        probe.remove();
        return values;
    });

    // The build minifies the token values, so these are compared as colors
    // rather than as the exact text in variables.css.
    expect(probed.bgPrimary.toLowerCase()).toMatch(
        /^(#fffdf7|rgba?\(255,\s?253,\s?247(,\s?1)?\))$/,
    );
    expect(probed.textPrimary.toLowerCase()).toMatch(/^(#1c1917|rgba?\(28,\s?25,\s?23(,\s?1)?\))$/);
    expect(probed.accentBlue.toLowerCase()).toMatch(
        /^(#4285f4|rgba?\(66,\s?133,\s?244(,\s?1)?\))$/,
    );
    // The tinted tokens keep their alpha, in whichever form the minifier picks.
    expect(probed.accentYellowBg.toLowerCase()).toMatch(
        /^(#fbbc0526|rgba\(251,\s?188,\s?5,\s?\.?0?\.?15\))$/,
    );

    // Opted in with no messages export uploaded: the section is simply omitted
    // and the export still succeeds.
    await trigger.click();
    await page.locator("#pdfExportIncludeMessages").check();
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#pdfExportConfirmBtn").click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toContain("linkedin-insights-");
});

test("the PDF carries a dashboard page per screen", async ({ page }, testInfo) => {
    // Helvetica again, for the same reason the thread spec blocks the fonts:
    // the headings have to be readable in the content stream to be asserted on.
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
    // The connections dashboard covers the whole network, not the screen's
    // twelve-month default. This fixture's connections all predate that window,
    // so these two charts are exactly what the default would have lost.
    expect(text).toContain("Top companies");
    expect(text).toContain("Top positions");
    expect(text).toContain("Messages in range");
    // Opted in, so the lists that name people are drawn.
    expect(text).toContain("Top contacts");

    // A dashboard opens a page of its own, so the footer counts past the three
    // of them plus the insights page.
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
    // The stat tile keeps its count; the list that would name people is absent,
    // and so is every name it would have carried.
    expect(text).not.toContain("Top contacts");
    expect(text).not.toContain("Silent connections");
    expect(text).not.toContain("Ada Lovelace");
    expect(text).not.toContain("Bob Smith");
});

test("message contents name their contacts even with the names box unticked", async ({
    page,
}, testInfo) => {
    // The two opt-ins are not one promise about names. A transcript is headed by
    // the person it is with, so ticking message contents puts that contact in
    // the file whatever the names box says; the dialog and the docs say so, and
    // this is what holds them to it.
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

    // The transcript, and therefore its correspondent, is in.
    expect(text).toContain("Recent conversations");
    expect(text).toContain("Ada Lovelace");
    // The dashboard lists that name people are still out.
    expect(text).not.toContain("Top contacts");
    expect(text).not.toContain("Silent connections");
});

test("a dashboard that outgrows its page carries a continuation heading", async ({
    page,
}, testInfo) => {
    // The wide fixture exists for this: twelve companies and twelve positions
    // fill both bar charts, which the small Connections.csv cannot do, and a
    // connections dashboard with full charts is taller than one page. Sized to
    // fit exactly one page the charts had two millimetres of slack and every
    // plot was as short as the page demanded, so a dashboard is allowed to run
    // on instead. The page it runs onto has to say what it is.
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
    // The heading travels with its chart rather than being left behind on the
    // page before it, which is what the running head would otherwise be
    // labelling.
    expect(text).toContain("Top positions");
});

test("captions name the months the data covers, not a relative range", async ({
    page,
}, testInfo) => {
    // A relative label is true on a screen and false in a stored document: the
    // window is anchored on the newest thing in the file, so "Last 12 months"
    // printed beside today's date describes a year that may be long past.
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
    // Two halves of one claim. The export marks what its font cannot draw
    // rather than dropping it silently, and the site, which has the browser's
    // own font fallback, still shows the same data whole: this is a rendering
    // limit of one surface, not damage to the file.
    //
    // The fonts are blocked as they are in the specs above, so the text is
    // readable in the content stream. That puts the document on the Helvetica
    // path, whose drawable set is WinAnsi rather than the faces' own cmap, and
    // both sets are exercised directly in drawable-text and fonts unit tests.
    // What matters here is the same either way: Latin-1 survives, everything
    // outside the set is marked, and neither is true of the site.
    await page.route("**/fonts/*.ttf", (route) => route.abort());

    await uploadFiles(page, [SHARES_CSV, CONNECTIONS_WIDE_CSV]);
    await waitForLoadedStatus(page, "sharesStatus");
    await waitForLoadedStatus(page, "connectionsStatus");

    // Navigated through the hub card rather than by URL: a fresh load of
    // `#connections` starts the screen before the upload it is meant to be
    // showing has been restored, and the stat reads its placeholder.
    await page.locator('#screen-home a.hub-card[data-route="connections"]').click();
    await expect(page).toHaveURL(/#connections/);
    // All time, which is the range the exported dashboard draws and the only
    // one this fixture has rows in: the screen opens on its twelve-month
    // default, which every dated row here predates.
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
    // Latin-1 is inside the faces' coverage, so an accented name is untouched.
    // Without this the assertion above would also pass for a build that
    // replaced every non-ASCII character it saw.
    expect(text).toContain("Café Zürich");
});
