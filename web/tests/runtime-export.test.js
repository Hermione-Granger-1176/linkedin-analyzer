import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SketchCharts } from '../src/charts.js';
import { initRuntime } from '../src/runtime.js';

vi.mock('../src/charts.js', () => ({
    SketchCharts: {
        exportPng: vi.fn()
    }
}));

describe('runtime export handler', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <button class="chart-export-btn" data-export-canvas="chartCanvas" data-export-name="report.png"></button>
            <canvas id="chartCanvas"></canvas>
        `;
        vi.restoreAllMocks();
    });

    it('exports chart on button click', () => {
        initRuntime();
        const button = document.querySelector('.chart-export-btn');
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(SketchCharts.exportPng).toHaveBeenCalledWith(
            document.getElementById('chartCanvas'),
            'report.png'
        );
    });
});
