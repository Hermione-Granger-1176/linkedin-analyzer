import { describe, expect, it, vi } from 'vitest';

import {
    createCanvas,
    createMockCanvasContext,
    mockMatchMedia,
    mockResizeObserver,
    resetDom,
    setupDom
} from '../helpers/dom.js';

describe('dom helpers', () => {
    it('setupDom and resetDom manage document state', () => {
        setupDom('<div id="example"></div>');
        document.documentElement.setAttribute('data-theme', 'dark');
        expect(document.getElementById('example')).toBeTruthy();
        resetDom();
        expect(document.body.innerHTML).toBe('');
        expect(document.documentElement.getAttribute('data-theme')).toBe(null);
    });

    it('mockMatchMedia dispatches change events', () => {
        const listener = vi.fn();
        const mql = mockMatchMedia(true);
        window.matchMedia().addEventListener('change', listener);
        mql.dispatch(false);
        expect(listener).toHaveBeenCalledWith({ matches: false });
    });

    it('createMockCanvasContext returns a stubbed context', () => {
        const ctx = createMockCanvasContext();
        expect(typeof ctx.beginPath).toBe('function');
        expect(ctx.measureText('abc').width).toBeGreaterThan(0);
    });

    it('createCanvas returns a canvas with size and context', () => {
        const { canvas, ctx } = createCanvas({ width: 120, height: 80 });
        expect(canvas.getBoundingClientRect().width).toBe(120);
        expect(canvas.getContext('2d')).toBe(ctx);
    });

    it('mockResizeObserver triggers callbacks', () => {
        const callback = vi.fn();
        const controller = mockResizeObserver();
        const observer = new window.ResizeObserver(callback);
        observer.observe(document.body);
        controller.trigger();
        expect(callback).toHaveBeenCalled();
    });
});
