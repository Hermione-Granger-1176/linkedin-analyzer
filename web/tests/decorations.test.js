import { describe, expect, it, vi } from 'vitest';

import { initDecorations } from '../src/decorations.js';

import { createCanvas } from './helpers/dom.js';

vi.mock('roughjs/bundled/rough.esm.js', () => ({
    default: {
        canvas: vi.fn(() => ({ circle: vi.fn() }))
    }
}));

describe('initDecorations', () => {
    it('returns early when canvas is missing', async () => {
        document.body.innerHTML = '';
        initDecorations();
        const rough = await import('roughjs/bundled/rough.esm.js');
        expect(rough.default.canvas).not.toHaveBeenCalled();
    });

    it('draws rough circles on the canvas', async () => {
        const { canvas, ctx } = createCanvas({ width: 300, height: 200 });
        canvas.id = 'roughCanvas';
        canvas.getContext = vi.fn(() => ctx);
        document.body.appendChild(canvas);
        document.documentElement.setAttribute('data-theme', 'dark');

        initDecorations();
        const rough = await import('roughjs/bundled/rough.esm.js');
        const rc = rough.default.canvas.mock.results[0].value;
        expect(rough.default.canvas).toHaveBeenCalledWith(canvas);
        expect(rc.circle).toHaveBeenCalledTimes(3);
    });
});
