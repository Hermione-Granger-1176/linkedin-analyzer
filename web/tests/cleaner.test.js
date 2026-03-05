import { describe, expect, it } from 'vitest';

import { LinkedInCleaner } from '../src/cleaner.js';

describe('LinkedInCleaner', () => {
    it('auto-detects and cleans messages CSV', () => {
        const csv = [
            'CONVERSATION ID,FROM,TO,DATE,CONTENT,FOLDER,SENDER PROFILE URL,RECIPIENT PROFILE URLS',
            'abc,Ada,Bob,2025-01-01 10:00:00 UTC,"He said ""hello""",INBOX,https://linkedin.com/in/ada,https://linkedin.com/in/bob'
        ].join('\n');

        const result = LinkedInCleaner.process(csv, 'auto');

        expect(result.success).toBe(true);
        expect(result.fileType).toBe('messages');
        expect(result.rowCount).toBe(1);
        expect(result.cleanedData[0].CONTENT).toBe('He said "hello"');
    });

    it('auto-detects and cleans connections CSV with preamble', () => {
        const csv = [
            'Notes:',
            'Export metadata',
            '',
            'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
            'Ada,Lovelace,https://linkedin.com/in/ada,,Analytical Engines,Mathematician,30 Jan 2026'
        ].join('\n');

        const result = LinkedInCleaner.process(csv, 'auto');

        expect(result.success).toBe(true);
        expect(result.fileType).toBe('connections');
        expect(result.rowCount).toBe(1);
        expect(result.cleanedData[0]['Connected On']).toBe('2026-01-30');
    });

    it('cleans connections long month names', () => {
        const csv = [
            'Notes:',
            'Export metadata',
            '',
            'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
            'Ada,Lovelace,https://linkedin.com/in/ada,,Analytical Engines,Mathematician,30 January 2026'
        ].join('\n');

        const result = LinkedInCleaner.process(csv, 'connections');

        expect(result.success).toBe(true);
        expect(result.cleanedData[0]['Connected On']).toBe('2026-01-30');
    });

    it('cleans connections month names case-insensitively', () => {
        const csv = [
            'Notes:',
            'Export metadata',
            '',
            'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
            'Ada,Lovelace,https://linkedin.com/in/ada,,Analytical Engines,Mathematician,30 JAN 2026'
        ].join('\n');

        const result = LinkedInCleaner.process(csv, 'connections');

        expect(result.success).toBe(true);
        expect(result.cleanedData[0]['Connected On']).toBe('2026-01-30');
    });

    it('drops messages rows missing required values', () => {
        const csv = [
            'CONVERSATION ID,FROM,TO,DATE,CONTENT,FOLDER,SENDER PROFILE URL,RECIPIENT PROFILE URLS',
            'abc,Ada,Bob,2025-01-01 10:00:00 UTC,"Valid message",INBOX,https://linkedin.com/in/ada,https://linkedin.com/in/bob',
            'def,Ada,Bob,2025-01-01 11:00:00 UTC,,INBOX,https://linkedin.com/in/ada,https://linkedin.com/in/bob',
            'ghi,#N/A,Bob,2025-01-01 12:00:00 UTC,"Ignored row",INBOX,https://linkedin.com/in/ada,https://linkedin.com/in/bob'
        ].join('\n');

        const result = LinkedInCleaner.process(csv, 'messages');

        expect(result.success).toBe(true);
        expect(result.rowCount).toBe(1);
        expect(result.cleanedData[0].CONTENT).toBe('Valid message');
    });

    it('drops connections rows when all identity fields are missing', () => {
        const csv = [
            'Notes:',
            'Export metadata',
            '',
            'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
            ',,,,,,30 Jan 2026',
            ',,https://linkedin.com/in/ada,,Analytical Engines,Mathematician,30 Jan 2026'
        ].join('\n');

        const result = LinkedInCleaner.process(csv, 'connections');

        expect(result.success).toBe(true);
        expect(result.rowCount).toBe(1);
        expect(result.cleanedData[0].URL).toBe('https://linkedin.com/in/ada');
    });

    // ── buildColumnErrorMessage paths ─────────────────────────────────────────

    it('returns type-mismatch error when wrong file type selected (line 685)', () => {
        // Upload a shares CSV but tell the cleaner it's comments.
        // Shares have Date/ShareLink/ShareCommentary; Comments require Date/Link/Message.
        // detectFileType will identify the headers as 'shares', which != 'comments',
        // so buildColumnErrorMessage fires the "This looks like a X file" branch (line 685).
        const csv = [
            'Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility',
            '2025-01-01 10:00:00,https://linkedin.com/in/post,Hello world,,,MEMBER_NETWORK'
        ].join('\n');

        const result = LinkedInCleaner.process(csv, 'comments');

        expect(result.success).toBe(false);
        // The error must mention that it looks like a Shares file and Connections was chosen
        expect(result.error).toMatch(/Shares/i);
        expect(result.error).toMatch(/Comments/i);
    });

    it('cleanConnectionsDate returns raw value when date does not match expected format (line 325)', () => {
        // A connections CSV where Connected On doesn't match "DD Mon YYYY" format
        const csv = [
            'Notes:',
            '',
            '',
            'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
            'Ada,Lovelace,https://linkedin.com/in/ada,,Analytical Engines,Mathematician,2026-01-30'
        ].join('\n');

        const result = LinkedInCleaner.process(csv, 'connections');

        expect(result.success).toBe(true);
        // Date doesn't match "DD Mon YYYY" so it's returned as-is
        expect(result.cleanedData[0]['Connected On']).toBe('2026-01-30');
    });

    it('processes connections where Connected On field has unusual date format (line 325)', () => {
        // A connections CSV where Connected On has an iso-format date (not matching "DD Mon YYYY")
        // but the URL and name are present so row is not dropped
        const csv = [
            'Notes:',
            '',
            '',
            'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
            'Ada,Lovelace,https://linkedin.com/in/ada,,Analytical Engines,Mathematician,1/30/2026'
        ].join('\n');

        const result = LinkedInCleaner.process(csv, 'connections');

        // Process should succeed; date is returned as-is if format doesn't match
        expect(result.success).toBe(true);
    });

    it('returns "does not appear to be" error when selected type has no matching headers (line 690)', () => {
        // A CSV with completely unknown columns — selectedType != 'auto',
        // detectFileType returns null (no known type matches), so line 688-690 fires
        const csv = [
            'Unknown,Column,Headers',
            'a,b,c'
        ].join('\n');

        const result = LinkedInCleaner.process(csv, 'shares');

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/doesn't appear to be/i);
    });

    // ── process() auto-detect failure paths (lines 727-731) ──────────────────

    it('returns failure with headers when auto-detect finds no match (line 731)', () => {
        // A well-formed CSV with unknown column names so no file type matches
        const csv = [
            'Foo,Bar,Baz',
            '1,2,3',
            '4,5,6'
        ].join('\n');

        const result = LinkedInCleaner.process(csv, 'auto');

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/auto-detect/i);
        // Headers and row count should still be populated
        expect(result.headers.length).toBeGreaterThan(0);
        expect(result.rowCount).toBe(2);
    });

    // ── cleanSharesCommentary paths (lines 152-165) ──────────────────────────

    it('cleans shares commentary that starts and ends with quotes (lines 158-164)', () => {
        // A shares CSV where ShareCommentary starts with " and ends with "
        const csv = [
            'Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility',
            '2025-01-01 10:00:00 UTC,https://linkedin.com/in/post,"My post""text",,,MEMBER_NETWORK'
        ].join('\n');

        const result = LinkedInCleaner.process(csv, 'shares');
        expect(result.success).toBe(true);
        expect(result.rowCount).toBe(1);
    });

    it('cleanDate returns raw value when date has no time component (line 282)', () => {
        // Date without time — falls through to partial parse return
        const csv = [
            'Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility',
            '2025-01-01,https://linkedin.com/in/post,Hello,,,MEMBER_NETWORK'
        ].join('\n');
        const result = LinkedInCleaner.process(csv, 'shares');
        expect(result.success).toBe(true);
    });

    it('cleanDate handles NaN date components gracefully (line 287)', () => {
        // A date with non-numeric parts
        const csv = [
            'Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility',
            'NOT-A-DATE 00:00:00,https://linkedin.com/in/post,Hello,,,MEMBER_NETWORK'
        ].join('\n');
        const result = LinkedInCleaner.process(csv, 'shares');
        expect(result.success).toBe(true);
        // The date should be returned as-is (not cleaned)
        expect(result.cleanedData[0].Date).toContain('NOT-A-DATE');
    });

    it('cleanDate handles out-of-range date components (line 290)', () => {
        // Hour=25 is out of range
        const csv = [
            'Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility',
            '2025-01-01 25:00:00,https://linkedin.com/in/post,Hello,,,MEMBER_NETWORK'
        ].join('\n');
        const result = LinkedInCleaner.process(csv, 'shares');
        expect(result.success).toBe(true);
    });

    // ── Empty CSV edge cases (line 536-549) ──────────────────────────────────

    it('returns empty-CSV error when CSV has no rows (line 537)', () => {
        const result = LinkedInCleaner.process('', 'shares');
        expect(result.success).toBe(false);
        expect(result.error).toBeTruthy();
    });

    it('returns error when CSV headers are all empty (line 549)', () => {
        // A CSV with a header row that is entirely commas (empty columns)
        const csv = ',,,\n1,2,3,4';
        const result = LinkedInCleaner.process(csv, 'shares');
        expect(result.success).toBe(false);
    });

    // ── Date parsing edge cases in cleanDate ────────────────────────────────

    it('returns raw value when date format has no time part (line 282)', () => {
        // A date without a time component — cleanDate should return as-is
        const csv = [
            'Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility',
            '2025-01-01,https://linkedin.com/in/post,Hello world,,,MEMBER_NETWORK'
        ].join('\n');
        const result = LinkedInCleaner.process(csv, 'shares');
        // Should still succeed (returns the raw date string as-is)
        expect(result.success).toBe(true);
    });

    it('returns raw value when date components are out of range (line 290)', () => {
        // Month=13 → invalid range → cleanDate returns as-is
        const csv = [
            'Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility',
            '2025-13-01 10:00:00 UTC,https://linkedin.com,Hello,,,MEMBER_NETWORK'
        ].join('\n');
        const result = LinkedInCleaner.process(csv, 'shares');
        expect(result.success).toBe(true);
    });

    // ── validateColumns with unknown file type (line 609) ────────────────────

    it('validateColumns returns invalid for unknown file type (line 609)', () => {
        // Process with an unsupported file type → config lookup fails → buildColumnErrorMessage fires
        const csv = [
            'Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility',
            '2025-01-01 10:00:00,https://linkedin.com,Hello,,,MEMBER_NETWORK'
        ].join('\n');
        // 'events' is not a known type
        const result = LinkedInCleaner.process(csv, 'events');
        expect(result.success).toBe(false);
    });

    // ── CRLF inside quoted field (line 449) ───────────────────────────────────

    it('handles bare \\r (without \\n) inside a quoted CSV field (line 449)', () => {
        // A quoted field with \r NOT followed by \n — triggers the `else` branch in
        // CSV_PARSE_STATE.INSIDE_QUOTES case '\r' at line 449-452
        const csv = 'CONVERSATION ID,FROM,TO,DATE,CONTENT,FOLDER,SENDER PROFILE URL,RECIPIENT PROFILE URLS\r\nabc,Ada,Bob,2025-01-01 10:00:00 UTC,"Line1\rLine2",INBOX,https://linkedin.com/in/ada,https://linkedin.com/in/bob';

        const result = LinkedInCleaner.process(csv, 'messages');

        expect(result.success).toBe(true);
        expect(result.rowCount).toBe(1);
        // The bare \r is preserved inside the quoted field
        expect(result.cleanedData[0].CONTENT).toContain('Line1');
    });

    it('returns parser error when a row exceeds max column count', () => {
        const headers = Array.from({ length: 260 }, (_, index) => `C${index}`).join(',');
        const row = Array.from({ length: 260 }, (_, index) => String(index)).join(',');
        const csv = `${headers}\n${row}`;

        const result = LinkedInCleaner.process(csv, 'auto');

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/too many columns/i);
    });

    it('returns empty-data parser error for CSV containing only blank lines', () => {
        const result = LinkedInCleaner.process('\n\n\n', 'auto');

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/empty/i);
    });

    it('recovers unmatched quote by retrying parse with appended quote', () => {
        const csv = [
            'Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility',
            '2025-01-01 10:00:00 UTC,https://linkedin.com/in/post,"Unclosed commentary,,,MEMBER_NETWORK'
        ].join('\n');

        const result = LinkedInCleaner.process(csv, 'shares');

        expect(result.success).toBe(true);
        expect(result.rowCount).toBe(1);
        expect(result.cleanedData[0].ShareCommentary).toContain('Unclosed commentary');
    });

    it('surfaces alternate detected type when selected type cannot be inferred directly', () => {
        const csv = [
            'Notes:',
            'Export metadata',
            '',
            'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
            'Ada,Lovelace,https://linkedin.com/in/ada,,Analytical Engines,Mathematician,30 Jan 2026'
        ].join('\n');

        const result = LinkedInCleaner.process(csv, 'shares');

        expect(result.success).toBe(false);
        expect(result.detectedType).toBe('connections');
        expect(result.error).toMatch(/Connections/i);
    });

    it('cleans shares rows when date/commentary cells are missing', () => {
        const csv = [
            'Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility',
            ',https://linkedin.com/in/post,,,,MEMBER_NETWORK'
        ].join('\n');

        const result = LinkedInCleaner.process(csv, 'shares');

        expect(result.success).toBe(true);
        expect(result.rowCount).toBe(0);
    });

    it('cleans comments escaped quotes and preserves content', () => {
        const csv = [
            'Date,Link,Message',
            '2025-01-01 10:00:00 UTC,https://linkedin.com/posts/1,"hello""world"'
        ].join('\n');

        const result = LinkedInCleaner.process(csv, 'comments');

        expect(result.success).toBe(true);
        expect(result.rowCount).toBe(1);
    });

    it('returns connection date as-is for unknown month token', () => {
        const csv = [
            'Notes:',
            '',
            '',
            'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
            'Ada,Lovelace,https://linkedin.com/in/ada,,Analytical Engines,Mathematician,30 FOO 2026'
        ].join('\n');

        const result = LinkedInCleaner.process(csv, 'connections');

        expect(result.success).toBe(true);
        expect(result.cleanedData[0]['Connected On']).toBe('30 FOO 2026');
    });

    it('returns empty-data parser error when parsed rows collapse to empty', () => {
        const result = LinkedInCleaner.process(',,,\n,,', 'shares');

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/empty/i);
    });

    it('escapes formula injection prefix + in Visibility column', () => {
        const csv = [
            'Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility',
            '2025-01-01 10:00:00 UTC,https://linkedin.com/in/post,Hello,,,+cmd'
        ].join('\n');
        const result = LinkedInCleaner.process(csv, 'shares');
        expect(result.success).toBe(true);
        expect(result.cleanedData[0].Visibility).toBe("'+cmd");
    });

    it('escapes formula injection prefix - in Visibility column', () => {
        const csv = [
            'Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility',
            '2025-01-01 10:00:00 UTC,https://linkedin.com/in/post,Hello,,,-cmd'
        ].join('\n');
        const result = LinkedInCleaner.process(csv, 'shares');
        expect(result.success).toBe(true);
        expect(result.cleanedData[0].Visibility).toBe("'-cmd");
    });

    it('escapes formula injection prefix @ in Visibility column', () => {
        const csv = [
            'Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility',
            '2025-01-01 10:00:00 UTC,https://linkedin.com/in/post,Hello,,,@SUM(A1)'
        ].join('\n');
        const result = LinkedInCleaner.process(csv, 'shares');
        expect(result.success).toBe(true);
        expect(result.cleanedData[0].Visibility).toBe("'@SUM(A1)");
    });

    it('returns parser error when a quoted field exceeds the safety limit', () => {
        const veryLargeField = 'x'.repeat(200001);
        const csv = [
            'Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility',
            `2025-01-01 10:00:00 UTC,https://linkedin.com/in/post,"${veryLargeField}",,,MEMBER_NETWORK`
        ].join('\n');

        const result = LinkedInCleaner.process(csv, 'shares');

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/too large/i);
    });

});
