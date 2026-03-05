import { describe, expect, it } from 'vitest';

import {
    parseAnalyticsWorkerMessage,
    parseAnalyticsWorkerRequest,
    parseConnectionsWorkerMessage,
    parseConnectionsWorkerRequest,
    parseMessagesWorkerMessage,
    parseMessagesWorkerRequest,
    parseStoredUploadFile
} from '../src/worker-contracts.js';

describe('worker contracts', () => {
    it('parses analytics addFile request payload', () => {
        const parsed = parseAnalyticsWorkerRequest({
            type: 'addFile',
            payload: {
                csvText: 'Date,ShareLink\n2025-01-01,https://example.com',
                fileName: 'Shares.csv',
                jobId: 'job-1',
                totalSize: 120
            }
        });

        expect(parsed.valid).toBe(true);
        expect(parsed.value.type).toBe('addFile');
        expect(parsed.value.payload.fileName).toBe('Shares.csv');
    });

    it('rejects analytics addFile request without csvText', () => {
        const parsed = parseAnalyticsWorkerRequest({
            type: 'addFile',
            payload: { fileName: 'Shares.csv' }
        });

        expect(parsed.valid).toBe(false);
        expect(parsed.error).toContain('csvText');
    });

    it('rejects unknown analytics request type', () => {
        const parsed = parseAnalyticsWorkerRequest({ type: 'unknown' });
        expect(parsed.valid).toBe(false);
    });

    it('normalizes analytics restore/init/view/clear requests', () => {
        const restore = parseAnalyticsWorkerRequest({
            type: 'restoreFiles',
            payload: { sharesCsv: 99, commentsCsv: 'comments' }
        });
        const initBase = parseAnalyticsWorkerRequest({ type: 'initBase', payload: { fromCache: true } });
        const view = parseAnalyticsWorkerRequest({
            type: 'view',
            requestId: -1,
            filters: { month: '2026-01' }
        });
        const clear = parseAnalyticsWorkerRequest({ type: 'clear' });

        expect(restore.valid).toBe(true);
        expect(restore.value.payload.sharesCsv).toBe('');
        expect(restore.value.payload.commentsCsv).toBe('comments');

        expect(initBase.valid).toBe(true);
        expect(initBase.value.payload).toEqual({ fromCache: true });

        expect(view.valid).toBe(true);
        expect(view.value.requestId).toBe(0);
        expect(view.value.filters).toEqual({ month: '2026-01' });

        expect(clear.valid).toBe(true);
        expect(clear.value).toEqual({ type: 'clear' });
    });

    it('rejects invalid analytics request envelopes and oversize payloads', () => {
        const invalidEnvelope = parseAnalyticsWorkerRequest(null);
        const invalidRestore = parseAnalyticsWorkerRequest({ type: 'restoreFiles', payload: null });
        const invalidAddFilePayload = parseAnalyticsWorkerRequest({ type: 'addFile', payload: null });
        const missingFileName = parseAnalyticsWorkerRequest({
            type: 'addFile',
            payload: { csvText: 'Date,ShareLink\n2025-01-01,https://example.com' }
        });
        const oversizeCsv = parseAnalyticsWorkerRequest({
            type: 'addFile',
            payload: {
                csvText: 'a'.repeat(30 * 1024 * 1024 + 2),
                fileName: 'Shares.csv'
            }
        });
        const longJobId = parseAnalyticsWorkerRequest({
            type: 'addFile',
            payload: {
                csvText: 'Date,ShareLink\n2025-01-01,https://example.com',
                fileName: 'Shares.csv',
                jobId: 'x'.repeat(200)
            }
        });

        expect(invalidEnvelope.valid).toBe(false);
        expect(invalidRestore.valid).toBe(false);
        expect(invalidAddFilePayload.valid).toBe(false);
        expect(missingFileName.valid).toBe(false);
        expect(oversizeCsv.valid).toBe(false);
        expect(longJobId.valid).toBe(true);
        expect(longJobId.value.payload.jobId.length).toBe(128);
    });

    it('normalizes analytics progress payload in worker response', () => {
        const parsed = parseAnalyticsWorkerMessage({
            type: 'progress',
            payload: {
                jobId: 'job-2',
                fileName: 'Shares.csv',
                percent: 4
            }
        });

        expect(parsed.valid).toBe(true);
        expect(parsed.value.payload.percent).toBe(1);
    });

    it('normalizes analytics fileProcessed payload', () => {
        const parsed = parseAnalyticsWorkerMessage({
            type: 'fileProcessed',
            payload: {
                fileType: 'shares',
                fileName: 'Shares.csv',
                rowCount: 5,
                analyticsBase: { months: { '2025-01': {} } }
            }
        });

        expect(parsed.valid).toBe(true);
        expect(parsed.value.payload.fileType).toBe('shares');
        expect(parsed.value.payload.rowCount).toBe(5);
    });

    it('normalizes analytics error payload fallback message', () => {
        const parsed = parseAnalyticsWorkerMessage({
            type: 'error',
            payload: {}
        });

        expect(parsed.valid).toBe(true);
        expect(parsed.value.payload.message).toBe('Worker error.');
    });

    it('normalizes analytics message envelope variants', () => {
        const restored = parseAnalyticsWorkerMessage({
            type: 'restored',
            payload: { hasData: true, source: 'cache' },
            requestId: 'abc'
        });
        const init = parseAnalyticsWorkerMessage({ type: 'init', payload: { hasData: 1 } });
        const view = parseAnalyticsWorkerMessage({ type: 'view', payload: null, requestId: -10 });
        const progress = parseAnalyticsWorkerMessage({ type: 'progress', payload: null });
        const fileProcessed = parseAnalyticsWorkerMessage({
            type: 'fileProcessed',
            payload: {
                fileType: 'not-real',
                fileName: 45,
                jobId: '',
                rowCount: -5,
                analyticsBase: [],
                hasData: 'yes',
                error: ''
            }
        });
        const error = parseAnalyticsWorkerMessage({
            type: 'error',
            requestId: -1,
            payload: { message: 99, fileName: 123, jobId: '' }
        });
        const cleared = parseAnalyticsWorkerMessage({ type: 'cleared' });

        expect(restored.valid).toBe(true);
        expect(restored.value.requestId).toBe('abc');
        expect(restored.value.payload).toEqual({ hasData: true, source: 'cache' });

        expect(init.valid).toBe(true);
        expect(init.value.payload.hasData).toBe(true);

        expect(view.valid).toBe(true);
        expect(view.value.requestId).toBe(0);
        expect(view.value.payload).toEqual({});

        expect(progress.valid).toBe(true);
        expect(progress.value.payload.fileName).toBe('');
        expect(progress.value.payload.jobId).toBeNull();

        expect(fileProcessed.valid).toBe(true);
        expect(fileProcessed.value.payload.fileType).toBeNull();
        expect(fileProcessed.value.payload.fileName).toBe('');
        expect(fileProcessed.value.payload.jobId).toBeNull();
        expect(fileProcessed.value.payload.rowCount).toBe(0);
        expect(fileProcessed.value.payload.analyticsBase).toBeNull();
        expect(fileProcessed.value.payload.error).toBeNull();

        expect(error.valid).toBe(true);
        expect(error.value.requestId).toBe(0);
        expect(error.value.payload.message).toBe('Worker error.');
        expect(error.value.payload.fileName).toBe('');
        expect(error.value.payload.jobId).toBeNull();

        expect(cleared.valid).toBe(true);
        expect(cleared.value.payload).toEqual({});
    });

    it('rejects invalid and unknown analytics worker messages', () => {
        const invalidEnvelope = parseAnalyticsWorkerMessage('bad');
        const unknownType = parseAnalyticsWorkerMessage({ type: 'something-else' });

        expect(invalidEnvelope.valid).toBe(false);
        expect(unknownType.valid).toBe(false);
    });

    it('normalizes non-object payloads for analytics request/response envelopes', () => {
        const initBase = parseAnalyticsWorkerRequest({ type: 'initBase', payload: 'bad' });
        const view = parseAnalyticsWorkerRequest({ type: 'view', filters: null });
        const fileProcessed = parseAnalyticsWorkerMessage({ type: 'fileProcessed', payload: null });
        const workerError = parseAnalyticsWorkerMessage({ type: 'error', payload: null });

        expect(initBase.valid).toBe(true);
        expect(initBase.value.payload).toBeNull();

        expect(view.valid).toBe(true);
        expect(view.value.filters).toEqual({});

        expect(fileProcessed.valid).toBe(true);
        expect(fileProcessed.value.payload.fileType).toBeNull();

        expect(workerError.valid).toBe(true);
        expect(workerError.value.payload.message).toBe('Worker error.');
    });

    it('parses connections worker process request', () => {
        const parsed = parseConnectionsWorkerRequest({
            type: 'process',
            requestId: 8,
            payload: {
                connectionsCsv: 'First Name,Last Name,Connected On\nAda,Lovelace,2025-01-01'
            }
        });

        expect(parsed.valid).toBe(true);
        expect(parsed.value.requestId).toBe(8);
    });

    it('rejects connections worker process request without csv', () => {
        const parsed = parseConnectionsWorkerRequest({
            type: 'process',
            payload: {}
        });

        expect(parsed.valid).toBe(false);
    });

    it('parses connections worker processed response', () => {
        const parsed = parseConnectionsWorkerMessage({
            type: 'processed',
            requestId: 2,
            payload: {
                success: true,
                rows: [{ 'Connected On': '2025-01-01' }],
                analytics: { stats: { total: 1 } }
            }
        });

        expect(parsed.valid).toBe(true);
        expect(parsed.value.payload.success).toBe(true);
        expect(parsed.value.payload.rows).toHaveLength(1);
    });

    it('normalizes connections worker message fallbacks', () => {
        const processed = parseConnectionsWorkerMessage({
            type: 'processed',
            requestId: -1,
            payload: { success: 0, rows: null, analytics: [], error: '' }
        });
        const error = parseConnectionsWorkerMessage({
            type: 'error',
            payload: { message: null }
        });
        const processedFromInvalidPayload = parseConnectionsWorkerMessage({ type: 'processed', payload: null });

        expect(processed.valid).toBe(true);
        expect(processed.value.requestId).toBe(0);
        expect(processed.value.payload.success).toBe(false);
        expect(processed.value.payload.rows).toEqual([]);
        expect(processed.value.payload.analytics).toBeNull();
        expect(processed.value.payload.error).toBeNull();

        expect(error.valid).toBe(true);
        expect(error.value.payload.message).toBe('Worker error.');

        expect(processedFromInvalidPayload.valid).toBe(true);
        expect(processedFromInvalidPayload.value.payload.rows).toEqual([]);
    });

    it('normalizes non-object payload for connections worker error', () => {
        const parsed = parseConnectionsWorkerMessage({ type: 'error', payload: null });

        expect(parsed.valid).toBe(true);
        expect(parsed.value.payload.message).toBe('Worker error.');
    });

    it('rejects invalid and unknown connections worker messages', () => {
        const invalidEnvelope = parseConnectionsWorkerMessage(null);
        const unknownType = parseConnectionsWorkerMessage({ type: 'done' });

        expect(invalidEnvelope.valid).toBe(false);
        expect(unknownType.valid).toBe(false);
    });

    it('rejects invalid connections worker request envelopes and oversize payloads', () => {
        const invalidType = parseConnectionsWorkerRequest({ type: 'nope' });
        const missingPayloadDefaults = parseConnectionsWorkerRequest({ type: 'process', payload: null });
        const oversize = parseConnectionsWorkerRequest({
            type: 'process',
            payload: { connectionsCsv: 'a'.repeat(30 * 1024 * 1024 + 2) }
        });

        expect(invalidType.valid).toBe(false);
        expect(missingPayloadDefaults.valid).toBe(false);
        expect(oversize.valid).toBe(false);
    });

    it('parses messages worker process request and response', () => {
        const request = parseMessagesWorkerRequest({
            type: 'process',
            requestId: 4,
            payload: {
                messagesCsv: 'FROM,TO,DATE,CONTENT\nA,B,2025-01-01,Hello',
                connectionsCsv: ''
            }
        });
        const response = parseMessagesWorkerMessage({
            type: 'processed',
            requestId: 4,
            payload: { success: true }
        });

        expect(request.valid).toBe(true);
        expect(response.valid).toBe(true);
        expect(response.value.requestId).toBe(4);
    });

    it('normalizes message worker request and response fallbacks', () => {
        const request = parseMessagesWorkerRequest({
            type: 'process',
            requestId: -5,
            payload: { messagesCsv: 'a,b\n1,2', connectionsCsv: 99 }
        });
        const response = parseMessagesWorkerMessage({ type: 'processed', requestId: -4, payload: null });

        expect(request.valid).toBe(true);
        expect(request.value.requestId).toBe(0);
        expect(request.value.payload.connectionsCsv).toBe('');

        expect(response.valid).toBe(true);
        expect(response.value.requestId).toBe(0);
        expect(response.value.payload).toBeNull();
    });

    it('rejects invalid message worker envelopes and oversize csv', () => {
        const invalidRequest = parseMessagesWorkerRequest({ type: 'done' });
        const missingPayload = parseMessagesWorkerRequest({ type: 'process', payload: null });
        const oversizeRequest = parseMessagesWorkerRequest({
            type: 'process',
            payload: { messagesCsv: 'a'.repeat(30 * 1024 * 1024 + 2) }
        });
        const invalidResponse = parseMessagesWorkerMessage({ type: 'error' });

        expect(invalidRequest.valid).toBe(false);
        expect(missingPayload.valid).toBe(false);
        expect(oversizeRequest.valid).toBe(false);
        expect(invalidResponse.valid).toBe(false);
    });

    it('validates stored upload file payload shape', () => {
        const validFile = parseStoredUploadFile({
            type: 'shares',
            name: 'Shares.csv',
            text: 'Date,ShareLink\n2025-01-01,https://example.com',
            rowCount: 2,
            updatedAt: 12345
        });
        const invalidFile = parseStoredUploadFile({
            type: 'unknown',
            name: 'bad.csv',
            text: ''
        });

        expect(validFile.valid).toBe(true);
        expect(validFile.value.type).toBe('shares');
        expect(invalidFile.valid).toBe(false);
    });

    it('normalizes stored upload fields to safe defaults', () => {
        const parsed = parseStoredUploadFile({
            type: 'comments',
            name: 10,
            text: null,
            rowCount: Number.POSITIVE_INFINITY,
            updatedAt: -99
        });

        expect(parsed.valid).toBe(true);
        expect(parsed.value.name).toBe('');
        expect(parsed.value.text).toBe('');
        expect(parsed.value.rowCount).toBe(0);
        expect(parsed.value.updatedAt).toBe(0);
    });

    it('rejects invalid stored upload payload envelope', () => {
        const parsed = parseStoredUploadFile(null);
        expect(parsed.valid).toBe(false);
    });
});
