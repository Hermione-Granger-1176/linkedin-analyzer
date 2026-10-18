import { describe, expect, it, vi } from "vitest";

import { LinkedInCleaner } from "../../../src/features/cleaning/cleaner.js";
import {
    collectContactKeys,
    collectContactKeysFromSource,
} from "../../../src/features/export/contact-keys.js";
import { storedUpload } from "../../helpers/stored-upload.js";

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
        // The connections cleaner drops rows without Connected On. Contact-key
        // matching must still include those rows.
        const csv = connectionsCsv([`Ada,Lovelace,${ADA_URL},,Analytical Engines,Mathematician,`]);

        expect(LinkedInCleaner.process(csv, "connections").cleanedData).toHaveLength(0);
        expect(collectContactKeys(csv)).toEqual(["ada lovelace", ADA_URL]);
    });

    it("keeps a row the cleaner would rewrite for a spreadsheet", () => {
        // Match the raw name before the cleaner prefixes an apostrophe for spreadsheet export.
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

describe("collectContactKeysFromSource", () => {
    const rows = [`Ada,Lovelace,${ADA_URL},,Engines,Mathematician,`, "Bob,Smith,,,Acme,Engineer,"];

    it("streams a stored upload to the same keys as the text", async () => {
        const csv = connectionsCsv(rows);
        const parse = vi.spyOn(LinkedInCleaner, "parseCSV");

        expect(await collectContactKeysFromSource(storedUpload(csv))).toEqual(
            collectContactKeys(csv),
        );
        // Only the comparison above parses the text; the stream builds no rows.
        expect(parse).toHaveBeenCalledOnce();
        parse.mockRestore();
    });

    it("drops the first attempt's keys when the stream restarts as windows-1252", async () => {
        const csv = connectionsCsv(["Zo\u00eb,Smith,,,Acme,Engineer,"]);
        const bytes = Uint8Array.from(csv, (char) => char.charCodeAt(0));
        expect(await collectContactKeysFromSource(storedUpload(bytes))).toEqual(["zo\u00eb smith"]);
    });

    it("reads a stored upload whole when it does not stream as connections", async () => {
        expect(
            await collectContactKeysFromSource(storedUpload("not,a,connections,export")),
        ).toEqual([]);
    });

    it("collects from CSV text", async () => {
        expect(await collectContactKeysFromSource(connectionsCsv(rows))).toContain("bob smith");
    });
});
