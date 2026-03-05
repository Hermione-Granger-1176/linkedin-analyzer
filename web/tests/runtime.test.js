import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SketchCharts } from '../src/charts.js';
import { initRuntime } from '../src/runtime.js';

vi.mock('../src/sentry.js', () => ({ captureError: vi.fn() }));
vi.mock('../src/charts.js', () => ({ SketchCharts: { exportPng: vi.fn() } }));

describe('runtime', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    it('creates error banner on error', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        initRuntime();
        window.dispatchEvent(new ErrorEvent('error', { error: new Error('boom') }));
        const banner = document.getElementById('globalErrorBanner');
        expect(banner).toBeTruthy();
        expect(banner.hidden).toBe(false);
    });

    it('handles promise rejection', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        initRuntime();
        const event = new Event('unhandledrejection');
        Object.defineProperty(event, 'reason', { value: new Error('rejected') });
        window.dispatchEvent(event);
        const banner = document.getElementById('globalErrorBanner');
        expect(banner).toBeTruthy();
    });

    it('dismisses banner on button click', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        initRuntime();
        window.dispatchEvent(new ErrorEvent('error', { error: new Error('boom') }));
        const banner = document.getElementById('globalErrorBanner');
        const dismiss = banner.querySelectorAll('button')[1];
        dismiss.click();
        expect(banner.hidden).toBe(true);
    });

    it('ignores export click when canvas missing', () => {
        document.body.innerHTML = '<button class="chart-export-btn" data-export-canvas="missing"></button>';
        initRuntime();
        document.querySelector('.chart-export-btn')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(SketchCharts.exportPng).not.toHaveBeenCalled();
    });

    it('ignores export click when canvasId is empty (line 112)', () => {
        // A button with an empty data-export-canvas attribute — canvasId is '' (falsy),
        // so the early return on line 111-113 fires before looking up the canvas.
        document.body.innerHTML = '<button class="chart-export-btn" data-export-canvas=""></button>';
        initRuntime();
        document.querySelector('.chart-export-btn')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(SketchCharts.exportPng).not.toHaveBeenCalled();
    });

    it('calls exportPng when a valid export button with a canvas is clicked', () => {
        const canvas = document.createElement('canvas');
        canvas.id = 'myCanvas';
        document.body.appendChild(canvas);

        const btn = document.createElement('button');
        btn.className = 'chart-export-btn';
        btn.dataset.exportCanvas = 'myCanvas';
        btn.dataset.exportName = 'my-chart.png';
        document.body.appendChild(btn);

        initRuntime();
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(SketchCharts.exportPng).toHaveBeenCalledWith(canvas, 'my-chart.png');
    });

    it('handleError shows banner even when event has no error property (lines 81-82)', () => {
        initRuntime();
        // Dispatch an ErrorEvent without an .error property — event.error is null
        // → line 81's ternary takes the false branch (error = event), line 82 still true
        const event = new Event('error');
        window.dispatchEvent(event);
        const banner = document.getElementById('globalErrorBanner');
        expect(banner).toBeTruthy();
        expect(banner.hidden).toBe(false);
    });

    it('handleError shows banner even when event itself is falsy-like (line 82 false branch)', () => {
        initRuntime();
        // Dispatch ErrorEvent with error=null → error is null → line 82 if(error) is false
        window.dispatchEvent(new ErrorEvent('error', { error: null }));
        const banner = document.getElementById('globalErrorBanner');
        expect(banner).toBeTruthy();
        expect(banner.hidden).toBe(false);
    });

    it('handleRejection shows banner even with no reason (lines 94-98 false branch)', () => {
        initRuntime();
        // An unhandledrejection event with no .reason property → line 94 if is false
        const event = new Event('unhandledrejection');
        window.dispatchEvent(event);
        const banner = document.getElementById('globalErrorBanner');
        expect(banner).toBeTruthy();
        expect(banner.hidden).toBe(false);
    });

    it('createBanner uses documentElement when body is null (line 53-54)', () => {
        const originalBody = document.body;
        Object.defineProperty(document, 'body', { value: null, configurable: true });
        initRuntime();
        // Trigger error to call createBanner
        window.dispatchEvent(new ErrorEvent('error', { error: new Error('no-body') }));
        // Restore body
        Object.defineProperty(document, 'body', { value: originalBody, configurable: true });
        const banner = document.getElementById('globalErrorBanner');
        expect(banner).toBeTruthy();
    });

    it('uses default filename when data-export-name is absent (line 115)', () => {
        const canvas = document.createElement('canvas');
        canvas.id = 'defaultCanvas';
        document.body.appendChild(canvas);

        const btn = document.createElement('button');
        btn.className = 'chart-export-btn';
        btn.dataset.exportCanvas = 'defaultCanvas';
        // intentionally no data-export-name attribute
        document.body.appendChild(btn);

        initRuntime();
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(SketchCharts.exportPng).toHaveBeenCalledWith(canvas, 'chart.png');
    });
});
