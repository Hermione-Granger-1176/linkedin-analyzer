import { describe, expect, it, vi } from 'vitest';

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

    it('processPayload handles non-string messagesCsv (line 12 false branch)', () => {
        // When messagesCsv is not a string, it defaults to '' which causes a parse failure
        const result = processPayload({ messagesCsv: null });
        expect(result.success).toBe(false);
    });

    it('processPayload handles non-string connectionsCsv (line 13 false branch)', () => {
        const result = processPayload({ messagesCsv: VALID_MESSAGES_CSV, connectionsCsv: 42 });
        // connectionsCsv coerces to '' which means no connections parsed, success=true
        expect(result.success).toBe(true);
        expect(result.connectionError).toBe(null);
    });

    // ── Worker message listener (lines 80-87) ─────────────────────────────────

    it('worker listener ignores non-process message types', () => {
        // self.addEventListener is registered at module load time; simulate via
        // dispatchEvent on globalThis which is aliased as self in jsdom.
        const postMessageSpy = vi.spyOn(globalThis, 'postMessage').mockImplementation(() => {});

        globalThis.dispatchEvent(
            Object.assign(new Event('message'), { data: { type: 'other', requestId: 'r1', payload: {} } })
        );

        expect(postMessageSpy).not.toHaveBeenCalled();
        postMessageSpy.mockRestore();
    });

    it('worker listener posts processed result for process message type', () => {
        const postMessageSpy = vi.spyOn(globalThis, 'postMessage').mockImplementation(() => {});

        globalThis.dispatchEvent(
            Object.assign(new Event('message'), {
                data: {
                    type: 'process',
                    requestId: 'req-42',
                    payload: { messagesCsv: VALID_MESSAGES_CSV }
                }
            })
        );

        expect(postMessageSpy).toHaveBeenCalledOnce();
        const [msg] = postMessageSpy.mock.calls[0];
        expect(msg.type).toBe('processed');
        expect(msg.requestId).toBe('req-42');
        expect(msg.payload.success).toBe(true);

        postMessageSpy.mockRestore();
    });

    it('worker listener forwards runtime error events as processed failure', () => {
        const postMessageSpy = vi.spyOn(globalThis, 'postMessage').mockImplementation(() => {});

        const event = new Event('error');
        Object.defineProperty(event, 'error', { value: new Error('messages-runtime') });
        globalThis.dispatchEvent(event);

        expect(postMessageSpy).toHaveBeenCalledOnce();
        const [message] = postMessageSpy.mock.calls[0];
        expect(message.type).toBe('processed');
        expect(message.payload.success).toBe(false);
        expect(message.payload.error).toContain('messages-runtime');

        postMessageSpy.mockRestore();
    });

    it('worker listener forwards unhandled rejections as processed failure', () => {
        const postMessageSpy = vi.spyOn(globalThis, 'postMessage').mockImplementation(() => {});

        const event = new Event('unhandledrejection');
        Object.defineProperty(event, 'reason', { value: new Error('messages-rejection') });
        globalThis.dispatchEvent(event);

        expect(postMessageSpy).toHaveBeenCalledOnce();
        const [message] = postMessageSpy.mock.calls[0];
        expect(message.type).toBe('processed');
        expect(message.payload.success).toBe(false);
        expect(message.payload.error).toContain('messages-rejection');

        postMessageSpy.mockRestore();
    });

    it('worker listener reports invalid process payloads', () => {
        const postMessageSpy = vi.spyOn(globalThis, 'postMessage').mockImplementation(() => {});

        globalThis.dispatchEvent(
            Object.assign(new Event('message'), {
                data: {
                    type: 'process',
                    requestId: 'req-invalid',
                    payload: {}
                }
            })
        );

        expect(postMessageSpy).toHaveBeenCalledOnce();
        const [message] = postMessageSpy.mock.calls[0];
        expect(message.type).toBe('processed');
        expect(message.payload.success).toBe(false);
        expect(message.payload.error).toContain('Missing messagesCsv payload');

        postMessageSpy.mockRestore();
    });

    it('worker error listener supports string-only error events', () => {
        const postMessageSpy = vi.spyOn(globalThis, 'postMessage').mockImplementation(() => {});

        const event = new Event('error');
        Object.defineProperty(event, 'message', { value: 'messages-string-error' });
        globalThis.dispatchEvent(event);

        expect(postMessageSpy).toHaveBeenCalledOnce();
        const [message] = postMessageSpy.mock.calls[0];
        expect(message.payload.success).toBe(false);
        expect(message.payload.error).toBe('messages-string-error');

        postMessageSpy.mockRestore();
    });

    it('worker rejection listener falls back to default runtime error message', () => {
        const postMessageSpy = vi.spyOn(globalThis, 'postMessage').mockImplementation(() => {});

        const event = new Event('unhandledrejection');
        Object.defineProperty(event, 'reason', { value: { kind: 'opaque' } });
        globalThis.dispatchEvent(event);

        expect(postMessageSpy).toHaveBeenCalledOnce();
        const [message] = postMessageSpy.mock.calls[0];
        expect(message.payload.success).toBe(false);
        expect(message.payload.error).toBe('Messages worker runtime failure.');

        postMessageSpy.mockRestore();
    });

    it('worker error listener falls back when event has no error payload', () => {
        const postMessageSpy = vi.spyOn(globalThis, 'postMessage').mockImplementation(() => {});

        globalThis.dispatchEvent(new Event('error'));

        expect(postMessageSpy).toHaveBeenCalledOnce();
        const [message] = postMessageSpy.mock.calls[0];
        expect(message.payload.success).toBe(false);
        expect(message.payload.error).toBe('Messages worker runtime failure.');

        postMessageSpy.mockRestore();
    });

    it('worker rejection listener falls back when reason is missing', () => {
        const postMessageSpy = vi.spyOn(globalThis, 'postMessage').mockImplementation(() => {});

        globalThis.dispatchEvent(new Event('unhandledrejection'));

        expect(postMessageSpy).toHaveBeenCalledOnce();
        const [message] = postMessageSpy.mock.calls[0];
        expect(message.payload.success).toBe(false);
        expect(message.payload.error).toBe('Messages worker runtime failure.');

        postMessageSpy.mockRestore();
    });
});
