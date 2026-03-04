import { describe, expect, it } from 'vitest';

import { processPayload } from '../src/messages-worker.js';

const VALID_MESSAGES_CSV = [
    'CONVERSATION ID,FROM,TO,DATE,CONTENT,FOLDER,SENDER PROFILE URL,RECIPIENT PROFILE URLS',
    'abc,Ada,Bob,2025-01-01 10:00:00 UTC,"Hello there",INBOX,https://linkedin.com/in/ada,https://linkedin.com/in/bob'
].join('\n');

const VALID_CONNECTIONS_CSV = [
    'Notes:',
    'Export metadata',
    '',
    'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
    'Ada,Lovelace,https://linkedin.com/in/ada,,Engines,Mathematician,30 Jan 2024'
].join('\n');

describe('messages worker', () => {
    it('processPayload parses valid messages CSV', () => {
        const result = processPayload({ messagesCsv: VALID_MESSAGES_CSV });

        expect(result.success).toBe(true);
        expect(result.messagesData.length).toBe(0);
        expect(result.connectionError).toBe(null);
    });

    it('processPayload returns error for invalid messages CSV', () => {
        const result = processPayload({ messagesCsv: 'not,a,valid,csv' });

        expect(result.success).toBe(false);
        expect(result.error).toBeTruthy();
    });

    it('processPayload parses both messages and connections', () => {
        const result = processPayload({
            messagesCsv: VALID_MESSAGES_CSV,
            connectionsCsv: VALID_CONNECTIONS_CSV
        });

        expect(result.success).toBe(true);
        expect(result.connectionError).toBe(null);
    });

    it('processPayload handles connections failure gracefully', () => {
        const result = processPayload({
            messagesCsv: VALID_MESSAGES_CSV,
            connectionsCsv: 'bad,csv,data'
        });

        expect(result.success).toBe(true);
        expect(result.connectionError).toBeTruthy();
    });

    it('processPayload handles missing connectionsCsv', () => {
        const result = processPayload({ messagesCsv: VALID_MESSAGES_CSV });

        expect(result.success).toBe(true);
        expect(result.connectionError).toBe(null);
    });
});
