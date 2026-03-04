import { vi } from 'vitest';

export function setupDom(html = '') {
    document.body.innerHTML = html;
}

export function resetDom() {
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('data-theme');
}

export function mockMatchMedia(initialMatches = false) {
    const listeners = new Set();
    const mql = {
        matches: initialMatches,
        media: '',
        addEventListener: (event, callback) => {
            if (event === 'change' && typeof callback === 'function') {
                listeners.add(callback);
            }
        },
        removeEventListener: (event, callback) => {
            if (event === 'change' && typeof callback === 'function') {
                listeners.delete(callback);
            }
        },
        dispatch: (nextMatches) => {
            mql.matches = nextMatches;
            listeners.forEach(callback => callback({ matches: nextMatches }));
        }
    };

    window.matchMedia = () => mql;
    return mql;
}

export function createMockCanvasContext(overrides = {}) {
    const ctx = {
        setTransform: vi.fn(),
        clearRect: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        bezierCurveTo: vi.fn(),
        quadraticCurveTo: vi.fn(),
        closePath: vi.fn(),
        stroke: vi.fn(),
        fill: vi.fn(),
        arc: vi.fn(),
        fillRect: vi.fn(),
        strokeRect: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        translate: vi.fn(),
        rotate: vi.fn(),
        drawImage: vi.fn(),
        measureText: vi.fn(text => ({ width: String(text).length * 6 })),
        fillText: vi.fn(),
        strokeText: vi.fn(),
        setLineDash: vi.fn(),
        getLineDash: vi.fn(() => []),
        lineWidth: 1,
        strokeStyle: '',
        fillStyle: '',
        font: '',
        globalAlpha: 1,
        textAlign: 'start',
        textBaseline: 'alphabetic',
        lineJoin: 'miter',
        lineCap: 'butt',
        globalCompositeOperation: 'source-over'
    };
    return Object.assign(ctx, overrides);
}

export function createCanvas({ width = 300, height = 150, ctxOverrides = {} } = {}) {
    const canvas = document.createElement('canvas');
    const ctx = createMockCanvasContext(ctxOverrides);
    canvas.getContext = vi.fn(() => ctx);
    canvas.getBoundingClientRect = () => ({
        width,
        height,
        left: 0,
        top: 0,
        right: width,
        bottom: height
    });
    canvas.toBlob = (callback) => callback(new Blob(['test'], { type: 'image/png' }));
    return { canvas, ctx };
}

export function mockResizeObserver() {
    const callbacks = [];
    class MockResizeObserver {
        constructor(callback) {
            this.callback = callback;
            callbacks.push(callback);
        }
        observe() {}
        disconnect() {}
    }
    window.ResizeObserver = MockResizeObserver;
    return {
        trigger() {
            callbacks.forEach(callback => callback());
        }
    };
}
