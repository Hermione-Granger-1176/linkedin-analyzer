import { describe, expect, it } from 'vitest';

import { hideChartTooltip, showChartTooltip } from '../src/ui/chart-tooltip.js';

import { setupDom } from './helpers/dom.js';

describe('chart tooltip helpers', () => {
    it('shows and positions tooltip near pointer', () => {
        setupDom('<div id="tooltip" hidden></div>');
        const tooltip = document.getElementById('tooltip');
        tooltip.getBoundingClientRect = () => ({ width: 80, height: 30 });

        showChartTooltip(tooltip, 40, 50, 'Point A');

        expect(tooltip.hidden).toBe(false);
        expect(tooltip.textContent).toBe('Point A');
        expect(tooltip.style.left).toBe('52px');
        expect(tooltip.style.top).toBe('62px');
    });

    it('flips tooltip when near viewport edge', () => {
        setupDom('<div id="tooltip" hidden></div>');
        const tooltip = document.getElementById('tooltip');
        tooltip.getBoundingClientRect = () => ({ width: 120, height: 40 });

        showChartTooltip(tooltip, window.innerWidth - 10, window.innerHeight - 10, 'Edge point');

        expect(tooltip.hidden).toBe(false);
        expect(Number.parseInt(tooltip.style.left, 10)).toBeLessThan(window.innerWidth - 10);
        expect(Number.parseInt(tooltip.style.top, 10)).toBeLessThan(window.innerHeight - 10);
    });

    it('hides tooltip safely', () => {
        setupDom('<div id="tooltip"></div>');
        const tooltip = document.getElementById('tooltip');

        hideChartTooltip(tooltip);
        expect(tooltip.hidden).toBe(true);

        hideChartTooltip(null);
        showChartTooltip(null, 0, 0, 'ignored');
    });
});
