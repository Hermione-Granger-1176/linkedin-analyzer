import { describe, expect, it } from 'vitest';

import { MessagesAnalytics } from '../src/messages-analytics.js';

describe('MessagesAnalytics', () => {
    it('buildMessageState extracts contacts and events', () => {
        const rows = [
            {
                FROM: 'Ada Lovelace',
                TO: 'Bob Smith',
                DATE: '2025-01-01 10:00:00',
                CONTENT: 'Hello',
                'SENDER PROFILE URL': 'https://linkedin.com/in/ada',
                'RECIPIENT PROFILE URLS': 'https://linkedin.com/in/bob'
            },
            {
                FROM: 'Ada Lovelace',
                TO: 'LinkedIn Member',
                DATE: '2025-01-02 10:00:00',
                CONTENT: 'Hey',
                'SENDER PROFILE URL': 'https://linkedin.com/in/ada',
                'RECIPIENT PROFILE URLS': ''
            }
        ];

        const state = MessagesAnalytics.buildMessageState(rows);
        expect(state.contacts.size).toBe(1);
        expect(state.events.length).toBe(1);
        expect(state.skippedRows).toBe(1);
    });

    it('buildConnectionState normalizes names and urls', () => {
        const rows = [
            {
                'First Name': 'Ada',
                'Last Name': 'Lovelace',
                URL: 'https://linkedin.com/in/ada/',
                Company: 'Engines',
                Position: 'Mathematician',
                'Connected On': '2025-01-01'
            },
            {
                'First Name': '',
                'Last Name': '',
                URL: '',
                Company: '',
                Position: '',
                'Connected On': ''
            }
        ];

        const state = MessagesAnalytics.buildConnectionState(rows);
        expect(state.list.length).toBe(1);
        expect(state.byUrl.size).toBe(1);
        expect(state.byName.size).toBe(1);
    });

    it('normalizes URL lists and recipient names', () => {
        const urls = MessagesAnalytics.normalizeUrlList(
            'https://linkedin.com/in/ada, https://linkedin.com/in/ada , https://linkedin.com/in/bob/'
        );
        expect(urls).toEqual([
            'https://linkedin.com/in/ada',
            'https://linkedin.com/in/bob'
        ]);

        const names = MessagesAnalytics.parseRecipientNames('Ada, Bob, Cara', 3);
        expect(names).toEqual(['Ada', 'Bob', 'Cara']);
    });

    it('parses valid dates and handles invalid ones', () => {
        expect(MessagesAnalytics.parseDateTime('2025-01-01 10:30:00')).toBeInstanceOf(Date);
        expect(MessagesAnalytics.parseDateTime('bad')).toBe(null);
        expect(MessagesAnalytics.parseDateOnly('2025-01-01')).toBeInstanceOf(Date);
        expect(MessagesAnalytics.parseDateOnly('bad')).toBe(null);
    });
});
