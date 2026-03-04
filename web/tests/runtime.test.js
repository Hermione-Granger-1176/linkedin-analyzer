import { describe, expect, it } from 'vitest';

import { initRuntime } from '../src/runtime.js';

describe('runtime', () => {
    it('creates error banner on error', () => {
        initRuntime();
        window.dispatchEvent(new ErrorEvent('error', { error: new Error('boom') }));
        const banner = document.getElementById('globalErrorBanner');
        expect(banner).toBeTruthy();
        expect(banner.hidden).toBe(false);
    });

    it('handles promise rejection', () => {
        initRuntime();
        const event = new Event('unhandledrejection');
        Object.defineProperty(event, 'reason', { value: new Error('rejected') });
        window.dispatchEvent(event);
        const banner = document.getElementById('globalErrorBanner');
        expect(banner).toBeTruthy();
    });
});
