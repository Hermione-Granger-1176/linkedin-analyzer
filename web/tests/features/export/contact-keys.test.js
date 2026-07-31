import { describe, expect, it } from "vitest";

import { LinkedInCleaner } from "../../../src/features/cleaning/cleaner.js";
import { collectContactKeys } from "../../../src/features/export/contact-keys.js";

const ADA_URL = "https://www.linkedin.com/in/ada";
const HEADER = "First Name,Last Name,URL,Email Address,Company,Position,Connected On";

/**
 * Build a stored connections export, preamble and all.
 * @param {string[]} rows - Data rows, header excluded
 * @returns {string} Connections CSV
 */
function connectionsCsv(rows) {
    return ["Notes:", "Export metadata", "", HEADER, ...rows].join("\n");
}

describe("collectContactKeys", () => {
    it("keys every connection by normalized name and profile URL", () => {
        const keys = collectContactKeys(
            connectionsCsv([
                `Ada,Lovelace,${ADA_URL},,Analytical Engines,Mathematician,01 Jan 2024`,
                "Grace,Hopper,,,Navy,Rear Admiral,02 Feb 2024",
            ]),
        );

        expect(keys).toEqual(["ada lovelace", ADA_URL, "grace hopper"]);
    });

    it("keeps a connection whose export recorded no connection date", () => {
        // The whole reason this parses rather than cleans. `requiredRowColumns`
        // drops a row with no "Connected On", which is right for the connections
        // dashboard and wrong here: somebody you are connected to is still not
        // you whether or not the export recorded when it happened.
        const csv = connectionsCsv([`Ada,Lovelace,${ADA_URL},,Analytical Engines,Mathematician,`]);

        expect(LinkedInCleaner.process(csv, "connections").cleanedData).toHaveLength(0);
        expect(collectContactKeys(csv)).toEqual(["ada lovelace", ADA_URL]);
    });

    it("keeps a row the cleaner would rewrite for a spreadsheet", () => {
        // The cleaner quote-prefixes a cell a spreadsheet would evaluate. A key
        // is looked up by exact value, so a rewritten one matches nobody.
        const csv = connectionsCsv([`=Ada,Lovelace,${ADA_URL},,Acme,Engineer,01 Jan 2024`]);

        expect(collectContactKeys(csv)).toContain("=ada lovelace");
    });

    it("returns nothing for an absent or unparseable file", () => {
        expect(collectContactKeys("")).toEqual([]);
        expect(collectContactKeys("not,a,connections,export")).toEqual([]);
    });

    it("skips a row that names nobody and never repeats a key", () => {
        const keys = collectContactKeys(
            connectionsCsv([
                ",,,,Acme,Engineer,01 Jan 2024",
                `Ada,Lovelace,${ADA_URL},,Acme,Engineer,01 Jan 2024`,
                `Ada,Lovelace,${ADA_URL},,Acme,Engineer,02 Jan 2024`,
            ]),
        );

        expect(keys).toEqual(["ada lovelace", ADA_URL]);
    });
});
