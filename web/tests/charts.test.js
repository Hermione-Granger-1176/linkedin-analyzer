import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SketchCharts } from '../src/charts.js';

import { createCanvas, createMockCanvasContext } from './helpers/dom.js';

describe('SketchCharts', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        document.documentElement.style.setProperty('--text-primary', '#111');
        document.documentElement.style.setProperty('--text-secondary', '#444');
        document.documentElement.style.setProperty('--border-color', '#ccc');
        document.documentElement.style.setProperty('--accent-blue', '#2d6cdf');
        document.documentElement.style.setProperty('--accent-yellow', '#f2c94c');
        document.documentElement.style.setProperty('--accent-green', '#27ae60');
        document.documentElement.style.setProperty('--accent-purple', '#9b59b6');
        document.documentElement.style.setProperty('--accent-red', '#eb5757');
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => createMockCanvasContext());
        vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
            callback(new Blob(['chart'], { type: 'image/png' }));
        });
    });

    it('drawTimeline registers hit items', () => {
        const { canvas } = createCanvas({ width: 400, height: 200 });
        const data = [
            { key: '2025-01', label: 'Jan 2025', value: 2 },
            { key: '2025-02', label: 'Feb 2025', value: 5 }
        ];

        SketchCharts.drawTimeline(canvas, data, '12m', 1, 0);
        const item = SketchCharts.getItemAt(canvas, 60, 120);
        expect(item).toBeTruthy();
        expect(item.tooltip).toContain('Jan');
    });

    it('drawTopics trims labels and registers items', () => {
        const { canvas } = createCanvas({ width: 300, height: 200 });
        const data = [
            { topic: 'Very long topic label', count: 5 },
            { topic: 'Short', count: 2 }
        ];

        SketchCharts.drawTopics(canvas, data, 1);
        const item = SketchCharts.getItemAt(canvas, 200, 24);
        expect(item).toBeTruthy();
        expect(item.type).toBe('topic');
    });

    it('drawHeatmap registers grid items', () => {
        const { canvas } = createCanvas({ width: 360, height: 220 });
        const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
        grid[1][2] = 3;

        SketchCharts.drawHeatmap(canvas, grid);
        const item = SketchCharts.getItemAt(canvas, 70, 30);
        expect(item).toBeTruthy();
        expect(item.type).toBe('heatmap');
    });

    it('drawDonut registers mix segments and hit tests', () => {
        const { canvas } = createCanvas({ width: 260, height: 200 });
        const mix = { textOnly: 3, links: 1, media: 1 };

        SketchCharts.drawDonut(canvas, mix, 1);
        const item = SketchCharts.getItemAt(canvas, 170, 100);
        expect(item).toBeTruthy();
        expect(item.type).toBe('mix');
    });

    it('animateDraw cancels when requested', () => {
        let rafCount = 0;
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
            rafCount += 1;
            if (rafCount > 5) {
                return rafCount;
            }
            callback(rafCount * 80);
            return rafCount;
        });
        const drawFn = vi.fn();
        SketchCharts.animateDraw(drawFn, 200);
        SketchCharts.cancelAnimations();
        expect(drawFn).toHaveBeenCalled();
    });

    it('exportPng triggers download', () => {
        const { canvas } = createCanvas({ width: 320, height: 160 });
        const data = [
            { key: '2025-01', label: 'Jan 2025', value: 3 }
        ];
        SketchCharts.drawTimeline(canvas, data, '12m', 1, 0);

        const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:chart');
        const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

        SketchCharts.exportPng(canvas, 'chart.png');

        expect(createUrl).toHaveBeenCalled();
        expect(clickSpy).toHaveBeenCalled();
        expect(revokeUrl).toHaveBeenCalled();
    });
});
