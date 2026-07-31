import { describe, expect, it } from "vitest";

import {
    aggregateField,
    buildConnectionsView,
    filterRowsByRange,
    findTopValue,
    formatNetworkAge,
    normalizeConnectionRows,
    parseConnectedOnTimestamp
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
