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
});
