import { describe, expect, it } from "vitest";

import {
    aggregateField,
    buildConnectionsView,
    buildGrowthTimeline,
    computeStats,
    filterRowsByRange,
    findTopValue,
    formatNetworkAge,
    monthKeyToLabel,
    normalizeConnectionRows,
    parseConnectedOnTimestamp,
    parseConnectionDate,
    toMonthKey
} from "../../../src/features/connections/view.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Build a normalized row a fixed number of days in the past.
 * @param {number} days - Age of the connection in days
 * @param {string} company - Company name
 * @param {string} position - Position title
 * @returns {{connectedOn: number, company: string, position: string}}
 */
function rowDaysAgo(days, company, position) {
    return { connectedOn: Date.now() - days * DAY_MS, company, position };
}

const TIMELINE = [{ key: "2024-01", label: "Jan 2024", value: 2 }];

describe("normalizeConnectionRows", () => {
    it("maps title-case keys and trims company and position", () => {
        const rows = normalizeConnectionRows([
            { "Connected On": "2024-06-15", Company: "  Acme  ", Position: "  Engineer  " }
        ]);

        expect(rows).toEqual([
            {
                connectedOn: new Date(2024, 5, 15).getTime(),
                company: "Acme",
                position: "Engineer"
            }
        ]);
    });

    it("uses 0 for unparseable or missing Connected On values", () => {
        const rows = normalizeConnectionRows([
            { "Connected On": "not-a-date", Company: "Acme", Position: "Engineer" },
            { Company: "Engines", Position: "Mathematician" }
        ]);

        expect(rows[0].connectedOn).toBe(0);
        expect(rows[1].connectedOn).toBe(0);
    });

    it("falls back to empty strings for missing company and position", () => {
        expect(normalizeConnectionRows([{ "Connected On": "2024-06-15" }])).toEqual([
            { connectedOn: new Date(2024, 5, 15).getTime(), company: "", position: "" }
        ]);
    });

    it("returns an empty array for empty rows", () => {
        expect(normalizeConnectionRows([])).toEqual([]);
    });
});

describe("connections view helpers", () => {
    it("parseConnectedOnTimestamp returns epoch milliseconds or 0", () => {
        expect(parseConnectedOnTimestamp("2024-06-15")).toBe(new Date(2024, 5, 15).getTime());
        expect(parseConnectedOnTimestamp("not-a-date")).toBe(0);
    });

    it("filterRowsByRange keeps the array itself for the all-time range", () => {
        const rows = [rowDaysAgo(400, "Acme", "Engineer")];
        expect(filterRowsByRange(rows, "all")).toBe(rows);
        expect(filterRowsByRange(rows, "6m")).toEqual([]);
    });

    it("filterRowsByRange cuts each range at the number of days it names", () => {
        // Probed on both sides of every cutoff. Unpinned, "6m" could be changed
        // from 182 days to 100 and every test in this file would still pass,
        // while the Connections screen quietly showed a third less history.
        const days = { "1m": 30, "3m": 91, "6m": 182, "12m": 365 };

        for (const [range, span] of Object.entries(days)) {
            expect(filterRowsByRange([rowDaysAgo(span - 1, "Acme", "Engineer")], range)).toHaveLength(1);
            expect(filterRowsByRange([rowDaysAgo(span + 1, "Acme", "Engineer")], range)).toHaveLength(0);
        }
    });

    it("aggregateField sorts by count and caps the list at ten entries", () => {
        const rows = Array.from({ length: 12 }, (_, index) =>
            rowDaysAgo(1, `Company ${index}`, "Engineer")
        ).concat(rowDaysAgo(1, "Company 11", "Engineer"));

        const companies = aggregateField(rows, "company");

        expect(companies.length).toBe(10);
        expect(companies[0]).toEqual({ topic: "Company 11", count: 2 });
    });

    it("findTopValue keeps whichever value reached the top count first", () => {
        // The comparison is strictly greater, so a later value never displaces
        // one already on the same count. Relaxing it to >= would silently change
        // whose name the "Top company" tile carries for anyone with a tie.
        const rows = [
            { company: "Globex" },
            { company: "Globex" },
            { company: "Initech" },
            { company: "Initech" },
        ];

        expect(findTopValue(rows, "company")).toBe("Globex");
    });

    it("findTopValue returns a dash without rows", () => {
        expect(findTopValue([], "company")).toBe("-");
    });

    it("formatNetworkAge switches from months to years at a year", () => {
        expect(formatNetworkAge(0)).toBe("-");
        expect(formatNetworkAge(11)).toBe("11 mo");
        expect(formatNetworkAge(12)).toBe("1.0 yr");
        expect(formatNetworkAge(30)).toBe("2.5 yr");
    });
});

describe("buildConnectionsView", () => {
    it("keeps every row for the all-time range and aggregates by count", () => {
        const rows = [
            rowDaysAgo(10, "Acme", "Engineer"),
            rowDaysAgo(400, "Acme", "Engineer"),
            rowDaysAgo(500, "Engines", "Mathematician")
        ];

        const view = buildConnectionsView(rows, TIMELINE, { total: 3, networkAgeMonths: 18 }, "all");

        expect(view.timeline).toBe(TIMELINE);
        expect(view.companies).toEqual([
            { topic: "Acme", count: 2 },
            { topic: "Engines", count: 1 }
        ]);
        expect(view.positions).toEqual([
            { topic: "Engineer", count: 2 },
            { topic: "Mathematician", count: 1 }
        ]);
        expect(view.stats).toEqual({
            total: 3,
            recent: 3,
            topCompany: "Acme",
            networkAge: "1.5 yr"
        });
    });

    it("drops rows outside a bounded range", () => {
        const rows = [
            rowDaysAgo(10, "Acme", "Engineer"),
            rowDaysAgo(400, "Engines", "Mathematician")
        ];

        const view = buildConnectionsView(rows, TIMELINE, { total: 2, networkAgeMonths: 8 }, "12m");

        expect(view.companies).toEqual([{ topic: "Acme", count: 1 }]);
        expect(view.stats).toEqual({
            total: 2,
            recent: 1,
            topCompany: "Acme",
            networkAge: "8 mo"
        });
    });

    it("treats an unknown range key as unfiltered", () => {
        const rows = [rowDaysAgo(10, "Acme", "Engineer"), rowDaysAgo(400, "Acme", "Engineer")];

        const view = buildConnectionsView(rows, TIMELINE, { total: 2, networkAgeMonths: 0 }, "99y");

        expect(view.stats.recent).toBe(2);
        expect(view.stats.networkAge).toBe("-");
    });

    it("falls back to row count and a dash when worker stats are missing", () => {
        const rows = [rowDaysAgo(10, "Acme", "Engineer")];

        const view = buildConnectionsView(rows, TIMELINE, null, "all");

        expect(view.stats.total).toBe(1);
        expect(view.stats.networkAge).toBe("-");
    });

    it("skips blank company and position values", () => {
        const view = buildConnectionsView([rowDaysAgo(10, "", "")], TIMELINE, null, "all");

        expect(view.companies).toEqual([]);
        expect(view.positions).toEqual([]);
        expect(view.stats.topCompany).toBe("-");
    });

    it("returns empty aggregates for empty rows", () => {
        const view = buildConnectionsView([], TIMELINE, {}, "all");

        expect(view.companies).toEqual([]);
        expect(view.positions).toEqual([]);
        expect(view.stats).toEqual({
            total: 0,
            recent: 0,
            topCompany: "-",
            networkAge: "-"
        });
    });
});

describe("connection date helpers", () => {
    it("parseConnectionDate returns Date for valid ISO string", () => {
        const date = parseConnectionDate("2024-06-15");
        expect(date).toBeInstanceOf(Date);
        expect(date.getFullYear()).toBe(2024);
        expect(date.getMonth()).toBe(5);
        expect(date.getDate()).toBe(15);
    });

    it("parseConnectionDate returns null for invalid input", () => {
        expect(parseConnectionDate(null)).toBe(null);
        expect(parseConnectionDate("")).toBe(null);
        expect(parseConnectionDate("not-a-date")).toBe(null);
        expect(parseConnectionDate("2024-13-01")).toBe(null);
        expect(parseConnectionDate("2024-00-15")).toBe(null);
        expect(parseConnectionDate("2024-06-32")).toBe(null);
        expect(parseConnectionDate("2024-04-31")).toBe(null);
        expect(parseConnectionDate("2023-02-29")).toBe(null);
        expect(parseConnectionDate("2024/06/15")).toBe(null);
        expect(parseConnectionDate(42)).toBe(null);
    });

    it("parseConnectionDate accepts leap day in a leap year", () => {
        expect(parseConnectionDate("2024-02-29")).toEqual(new Date(2024, 1, 29));
    });

    it("toMonthKey formats Date as YYYY-MM with zero-padding", () => {
        expect(toMonthKey(new Date(2024, 0, 1))).toBe("2024-01");
        expect(toMonthKey(new Date(2024, 11, 31))).toBe("2024-12");
        expect(toMonthKey(new Date(2025, 5, 15))).toBe("2025-06");
    });

    it("monthKeyToLabel converts YYYY-MM to readable label", () => {
        expect(monthKeyToLabel("2024-01")).toBe("Jan 2024");
        expect(monthKeyToLabel("2025-12")).toBe("Dec 2025");
        expect(monthKeyToLabel("2023-06")).toBe("Jun 2023");
    });
});

describe("buildGrowthTimeline", () => {
    it("buckets by month and fills the gaps between them", () => {
        const rows = [
            { "Connected On": "2024-01-10" },
            { "Connected On": "2024-01-20" },
            { "Connected On": "2024-03-05" }
        ];

        const timeline = buildGrowthTimeline(rows);

        expect(timeline.length).toBe(3);
        expect(timeline[0].key).toBe("2024-01");
        expect(timeline[0].value).toBe(2);
        expect(timeline[0].label).toBe("Jan 2024");
        expect(timeline[1].key).toBe("2024-02");
        expect(timeline[1].value).toBe(0);
        expect(timeline[2].key).toBe("2024-03");
        expect(timeline[2].value).toBe(1);
    });

    it("returns an empty timeline when no row carries a readable date", () => {
        expect(buildGrowthTimeline([])).toEqual([]);
        expect(buildGrowthTimeline([{ "Connected On": "" }])).toEqual([]);
        expect(buildGrowthTimeline([{ "Connected On": "invalid" }])).toEqual([]);
    });

    it("excludes impossible dates", () => {
        const timeline = buildGrowthTimeline([
            { "Connected On": "2024-02-29" },
            { "Connected On": "2023-02-29" },
            { "Connected On": "2024-04-31" }
        ]);

        expect(timeline).toEqual([{ key: "2024-02", label: "Feb 2024", value: 1 }]);
    });
});

describe("computeStats", () => {
    it("returns the total and a positive network age", () => {
        const rows = [
            { "Connected On": "2020-01-01" },
            { "Connected On": "2024-06-15" },
            { "Connected On": "2025-01-01" }
        ];

        const stats = computeStats(rows);

        expect(stats.total).toBe(3);
        expect(stats.networkAgeMonths).toBeGreaterThan(0);
    });

    it("handles empty rows", () => {
        const stats = computeStats([]);
        expect(stats.total).toBe(0);
        expect(stats.networkAgeMonths).toBe(0);
    });

    it("gives a single connection a positive network age", () => {
        const rows = [{ "Connected On": "2023-06-01" }];
        const stats = computeStats(rows);
        expect(stats.total).toBe(1);
        expect(stats.networkAgeMonths).toBeGreaterThan(0);
    });

    it("counts a row with an unreadable date but does not date the network by it", () => {
        // Rows with missing dates still contribute to total but not to earliestMs
        const rows = [
            { "Connected On": "" },
            { "Connected On": "bad" },
            { "Connected On": "2024-03-01" }
        ];
        const stats = computeStats(rows);
        // total counts ALL rows regardless of date validity
        expect(stats.total).toBe(3);
        expect(stats.networkAgeMonths).toBeGreaterThan(0);
    });

    it("reports no network age when no row carries a readable date", () => {
        const rows = [
            { "Connected On": "" },
            { "Connected On": "not-a-date" }
        ];
        const stats = computeStats(rows);
        expect(stats.total).toBe(2);
        expect(stats.networkAgeMonths).toBe(0);
    });

    // ── processConnections empty-rows path (lines 187-194) ───────────────────
});
