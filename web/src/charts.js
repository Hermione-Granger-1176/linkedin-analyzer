/* LinkedIn Analyzer - Hand-drawn Charts (Optimized) */

import rough from 'roughjs/bundled/rough.esm.js';

export const SketchCharts = (() => {
    'use strict';

    const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const WEEKLY_TIME_RANGES = new Set(['1m', '3m']);

    const registry = new Map();
    const drawRegistry = new Map();
    let animationId = 0;
    let exportDpr = 0;

    const EXPORT_DPR = 3;

    /**
     * Read CSS custom properties and return a color palette object.
     * @returns {{text: string, textSecondary: string, border: string, blue: string, yellow: string, green: string, purple: string, red: string}}
     */
    function getColors() {
        const styles = getComputedStyle(document.documentElement);
        return {
            text: styles.getPropertyValue('--text-primary').trim(),
            textSecondary: styles.getPropertyValue('--text-secondary').trim(),
            border: styles.getPropertyValue('--border-color').trim(),
            blue: styles.getPropertyValue('--accent-blue').trim(),
            yellow: styles.getPropertyValue('--accent-yellow').trim(),
            green: styles.getPropertyValue('--accent-green').trim(),
            purple: styles.getPropertyValue('--accent-purple').trim(),
            red: styles.getPropertyValue('--accent-red').trim()
        };
    }

    /**
     * Resize canvas to match its CSS dimensions at device pixel ratio.
     * @param {HTMLCanvasElement} canvas - The canvas element to resize.
     * @param {number} [dprOverride] - Optional DPR override for high-res export.
     * @returns {{ctx: CanvasRenderingContext2D, width: number, height: number}|null}
     */
    function resizeCanvas(canvas, dprOverride) {
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        const ratio = exportDpr || dprOverride || window.devicePixelRatio || 1;
        canvas.width = rect.width * ratio;
        canvas.height = rect.height * ratio;
        const ctx = canvas.getContext('2d');
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        return { ctx, width: rect.width, height: rect.height };
    }

    /**
     * Convert hex color string to RGB object.
     * @param {string} hex - The hex color string (e.g. '#5a9bd5').
     * @returns {{r: number, g: number, b: number}}
     */
    function hexToRgb(hex) {
        const cleaned = hex.replace('#', '').trim();
        if (cleaned.length !== 6) return { r: 90, g: 150, b: 213 };
        return {
            r: parseInt(cleaned.slice(0, 2), 16),
            g: parseInt(cleaned.slice(2, 4), 16),
            b: parseInt(cleaned.slice(4, 6), 16)
        };
    }

    /**
     * Register hit-test items for a canvas in the global registry.
     * @param {HTMLCanvasElement} canvas - The canvas element to register items for.
     * @param {Array<Object>} items - The hit-test items to register.
     */
    function register(canvas, items) {
        registry.set(canvas, items);
    }

    /**
     * Clear canvas and remove its hit-test registry.
     * @param {HTMLCanvasElement} canvas - The canvas element.
     * @param {CanvasRenderingContext2D} ctx - The 2D rendering context.
     * @param {number} width - The canvas CSS width.
     * @param {number} height - The canvas CSS height.
     */
    function clear(canvas, ctx, width, height) {
        registry.delete(canvas);
        drawRegistry.delete(canvas);
        ctx.clearRect(0, 0, width, height);
    }

    /**
     * Get the hit-test item at the given coordinates on a canvas.
     * @param {HTMLCanvasElement} canvas - The canvas element to query.
     * @param {number} x - The x coordinate.
     * @param {number} y - The y coordinate.
     * @returns {Object|null} The matching item, or null if none found.
     */
    function getItemAt(canvas, x, y) {
        const items = registry.get(canvas);
        if (!items) return null;
        for (const item of items) {
            if (item.hitTest && item.hitTest(x, y)) return item;
            if (typeof item.x === 'number') {
                if (x >= item.x && x <= item.x + item.width && y >= item.y && y <= item.y + item.height) {
                    return item;
                }
            }
        }
        return null;
    }

    /**
     * Draw a sketchy rectangle border (cheaper than RoughJS for many items).
     * @param {CanvasRenderingContext2D} ctx - The 2D rendering context.
     * @param {number} x - The x coordinate of the rectangle.
     * @param {number} y - The y coordinate of the rectangle.
     * @param {number} w - The width of the rectangle.
     * @param {number} h - The height of the rectangle.
     * @param {string} color - The stroke color.
     */
    function sketchyRect(ctx, x, y, w, h, color) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        // Add slight wobble for hand-drawn effect
        const jitter = () => (Math.random() - 0.5) * 1.5;
        ctx.moveTo(x + jitter(), y + jitter());
        ctx.lineTo(x + w + jitter(), y + jitter());
        ctx.lineTo(x + w + jitter(), y + h + jitter());
        ctx.lineTo(x + jitter(), y + h + jitter());
        ctx.closePath();
        ctx.stroke();
    }

    /**
     * Draw the timeline line/area chart with labels.
     * @param {HTMLCanvasElement} canvas - The canvas element to draw on.
     * @param {Array<Object>} data - Timeline points array.
     * @param {string} timeRange - Filter key (e.g. '1m', '3m', '12m', 'all').
     * @param {number} [progress=1] - Animation progress from 0 to 1.
     * @param {number} [maxOverride=0] - Optional max Y value override.
     */
    function drawTimeline(canvas, data, timeRange, progress = 1, maxOverride = 0) {
        const size = resizeCanvas(canvas);
        if (!size) return;
        const { ctx, width, height } = size;
        const colors = getColors();
        clear(canvas, ctx, width, height);
        drawRegistry.set(canvas, () => drawTimeline(canvas, data, timeRange, 1, maxOverride));
        if (!data || !data.length) return;

        const padding = { top: 22, right: 12, bottom: 42, left: 40 };
        const chartWidth = width - padding.left - padding.right;
        const chartHeight = height - padding.top - padding.bottom;
        const maxValue = Math.max(maxOverride || 0, ...data.map(p => p.value), 1);
        const sliceWidth = chartWidth / data.length;
        const baseY = padding.top + chartHeight;

        const points = data.map((point, index) => {
            const value = point.value;
            const x = padding.left + sliceWidth * index + sliceWidth / 2;
            const y = baseY - (value / maxValue) * chartHeight;
            return { point, x, y, index };
        });

        let visiblePoints = points;
        if (progress < 1 && points.length > 1) {
            const capped = Math.max(0, Math.min(progress, 1));
            const visibleCount = Math.max(1, Math.floor(capped * (points.length - 1)) + 1);
            visiblePoints = points.slice(0, visibleCount);
        }

        // Axis line
        ctx.strokeStyle = colors.border;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(padding.left, baseY + 2);
        ctx.lineTo(padding.left + chartWidth, baseY + 2);
        ctx.stroke();

        // Area fill
        ctx.fillStyle = colors.blue;
        ctx.globalAlpha = 0.16;
        if (visiblePoints.length) {
            ctx.beginPath();
            ctx.moveTo(visiblePoints[0].x, baseY);
            visiblePoints.forEach(({ x, y }) => ctx.lineTo(x, y));
            ctx.lineTo(visiblePoints[visiblePoints.length - 1].x, baseY);
            ctx.closePath();
            ctx.fill();
        }
        ctx.globalAlpha = 1;

        // Primary line
        ctx.strokeStyle = colors.blue;
        ctx.lineWidth = 2.1;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        if (visiblePoints.length) {
            ctx.beginPath();
            ctx.moveTo(visiblePoints[0].x, visiblePoints[0].y);
            for (let i = 1; i < visiblePoints.length; i++) {
                ctx.lineTo(visiblePoints[i].x, visiblePoints[i].y);
            }
            ctx.stroke();
        }

        // Secondary jitter line for sketch feel
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = 1.2;
        if (visiblePoints.length) {
            ctx.beginPath();
            visiblePoints.forEach(({ x, y }, index) => {
                const jitter = (Math.random() - 0.5) * 1.4;
                const px = x + jitter;
                const py = y + jitter;
                if (index === 0) {
                    ctx.moveTo(px, py);
                } else {
                    ctx.lineTo(px, py);
                }
            });
            ctx.stroke();
        }
        ctx.globalAlpha = 1;

        // Points
        ctx.fillStyle = colors.blue;
        visiblePoints.forEach(({ x, y }) => {
            ctx.beginPath();
            ctx.arc(x, y, 3.2, 0, Math.PI * 2);
            ctx.fill();
        });

        // Value labels
        const showAllValues = data.length <= 24;
        const valueEvery = showAllValues ? 1 : Math.ceil(data.length / 10);
        ctx.font = '11px Patrick Hand, sans-serif';
        ctx.fillStyle = colors.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        visiblePoints.forEach(({ point, x, y, index }) => {
            if (!showAllValues && index % valueEvery !== 0 && index !== points.length - 1) return;
            const labelY = Math.max(padding.top + 10, y - 6);
            ctx.fillText(String(point.value), x, labelY);
        });

        // Labels
        ctx.font = '12px Patrick Hand, sans-serif';
        ctx.fillStyle = colors.textSecondary;
        const isWeekly = WEEKLY_TIME_RANGES.has(timeRange);
        if (timeRange === 'all' && data.length > 18) {
            let lastYear = null;
            points.forEach(({ point, x }, index) => {
                const [year, month] = point.key.split('-').map(Number);
                if (!year || !month) return;
                const isStart = index === 0;
                const isJan = month === 1;
                const isLast = index === points.length - 1;
                if (!isStart && !isJan && !isLast) return;
                if (year === lastYear && !isLast) return;
                lastYear = year;
                ctx.save();
                ctx.translate(x, baseY + 20);
                ctx.rotate(-0.18);
                ctx.textAlign = 'center';
                ctx.fillText(String(year), 0, 0);
                ctx.restore();
            });
        } else {
            const labelEvery = data.length <= 10 ? 1 : Math.ceil(data.length / 8);
            points.forEach(({ point, x }, index) => {
                if (index % labelEvery !== 0 && index !== points.length - 1) return;
                const labelText = isWeekly ? point.label : point.label.split(' ')[0];
                ctx.save();
                ctx.translate(x, baseY + 18);
                ctx.rotate(-0.35);
                ctx.textAlign = 'center';
                ctx.fillText(labelText, 0, 0);
                ctx.restore();
            });
        }

        const items = points.map(({ point, x }) => ({
            type: isWeekly ? 'week' : 'month',
            key: point.key,
            monthKey: point.monthKey || point.key,
            label: point.label,
            value: point.value,
            x: x - sliceWidth / 2,
            y: padding.top,
            width: sliceWidth,
            height: chartHeight,
            tooltip: `${point.label}: ${point.value}`
        }));

        register(canvas, items);
    }

    /**
     * Draw horizontal bar chart of topic counts.
     * @param {HTMLCanvasElement} canvas - The canvas element to draw on.
     * @param {Array<Object>} data - Array of topic objects with topic and count properties.
     * @param {number} [progress=1] - Animation progress from 0 to 1.
     */
    function drawTopics(canvas, data, progress = 1) {
        const size = resizeCanvas(canvas);
        if (!size) return;
        const { ctx, width, height } = size;
        const colors = getColors();
        clear(canvas, ctx, width, height);
        drawRegistry.set(canvas, () => drawTopics(canvas, data, 1));
        if (!data || !data.length) return;

        ctx.font = '13px Patrick Hand, sans-serif';
        const maxLabelWidth = Math.max(
            ...data.map(p => ctx.measureText(p.topic).width),
            60
        );
        const leftPad = Math.min(Math.ceil(maxLabelWidth) + 16, Math.floor(width * 0.4));
        const padding = { top: 10, right: 10, bottom: 10, left: leftPad };
        const chartWidth = width - padding.left - padding.right;
        const chartHeight = height - padding.top - padding.bottom;
        const maxValue = Math.max(...data.map(p => p.count), 1);
        const barHeight = Math.min(24, chartHeight / data.length - 6);
        const items = [];

        // Batch fill
        ctx.fillStyle = colors.purple;
        ctx.globalAlpha = 0.6;

        const barData = data.map((point, index) => {
            const y = padding.top + index * (barHeight + 10);
            const bw = (point.count / maxValue) * chartWidth * progress;
            ctx.fillRect(padding.left, y, bw, barHeight);
            return { point, y, bw };
        });

        ctx.globalAlpha = 1;

        // Borders and labels
        barData.forEach(({ point, y, bw }) => {
            sketchyRect(ctx, padding.left, y, bw, barHeight, colors.purple);

            ctx.fillStyle = colors.text;
            ctx.textAlign = 'right';
            let label = point.topic;
            const maxLabelSpace = padding.left - 12;
            while (label.length > 1 && ctx.measureText(label).width > maxLabelSpace) {
                label = label.slice(0, -1);
            }
            if (label !== point.topic) label += '\u2026';
            ctx.fillText(label, padding.left - 8, y + barHeight - 6);

            items.push({
                type: 'topic',
                key: point.topic,
                label: point.topic,
                value: point.count,
                x: padding.left,
                y,
                width: bw,
                height: barHeight,
                tooltip: `${point.topic}: ${point.count}`
            });
        });

        register(canvas, items);
    }

    /**
     * Draw 7x24 activity heatmap grid.
     * @param {HTMLCanvasElement} canvas - The canvas element to draw on.
     * @param {Array<Array<number>>} grid - 7x24 grid of activity counts (days x hours).
     */
    function drawHeatmap(canvas, grid) {
        const size = resizeCanvas(canvas);
        if (!size) return;
        const { ctx, width, height } = size;
        const colors = getColors();
        clear(canvas, ctx, width, height);
        drawRegistry.set(canvas, () => drawHeatmap(canvas, grid));
        if (!grid || !grid.length) return;

        const padding = { top: 20, right: 20, bottom: 26, left: 44 };
        const chartWidth = width - padding.left - padding.right;
        const chartHeight = height - padding.top - padding.bottom;
        const cellWidth = chartWidth / 24;
        const cellHeight = chartHeight / 7;
        const flat = grid.flat();
        const maxValue = Math.max(...flat, 1);
        const baseColor = hexToRgb(colors.blue);

        ctx.font = '11px Patrick Hand, sans-serif';
        ctx.fillStyle = colors.textSecondary;

        // Day labels
        for (let day = 0; day < 7; day++) {
            ctx.fillText(DAY_LABELS[day], 6, padding.top + day * cellHeight + cellHeight * 0.7);
        }

        // Hour labels
        for (let hour = 0; hour < 24; hour += 3) {
            ctx.fillText(String(hour).padStart(2, '0'), padding.left + hour * cellWidth + 2, height - 6);
        }

        const items = [];

        // Draw cells (no RoughJS - just fills)
        for (let day = 0; day < 7; day++) {
            for (let hour = 0; hour < 24; hour++) {
                const value = grid[day][hour];
                const intensity = Math.max(0.08, value / maxValue);
                const x = padding.left + hour * cellWidth;
                const y = padding.top + day * cellHeight;
                ctx.fillStyle = `rgba(${baseColor.r}, ${baseColor.g}, ${baseColor.b}, ${intensity})`;
                ctx.fillRect(x, y, cellWidth, cellHeight);

                items.push({
                    type: 'heatmap',
                    day, hour, x, y,
                    width: cellWidth,
                    height: cellHeight,
                    tooltip: `${DAY_LABELS[day]} ${String(hour).padStart(2, '0')}:00 - ${value}`
                });
            }
        }

        // Grid lines
        ctx.strokeStyle = colors.border;
        ctx.lineWidth = 0.6;
        for (let hour = 0; hour <= 24; hour++) {
            const x = padding.left + hour * cellWidth;
            ctx.beginPath();
            ctx.moveTo(x, padding.top);
            ctx.lineTo(x, padding.top + chartHeight);
            ctx.stroke();
        }
        for (let day = 0; day <= 7; day++) {
            const y = padding.top + day * cellHeight;
            ctx.beginPath();
            ctx.moveTo(padding.left, y);
            ctx.lineTo(padding.left + chartWidth, y);
            ctx.stroke();
        }

        // Single sketchy border (only 1 RoughJS call for entire heatmap)
        if (rough) {
            const rc = rough.canvas(canvas);
            rc.rectangle(padding.left, padding.top, chartWidth, chartHeight, {
                stroke: colors.border,
                strokeWidth: 1.2,
                roughness: 1.4
            });
        }

        register(canvas, items);
    }

    /**
     * Draw donut chart of content type mix.
     * @param {HTMLCanvasElement} canvas - The canvas element to draw on.
     * @param {Object} mix - Content type mix with textOnly, links, and media counts.
     * @param {number} [progress=1] - Animation progress from 0 to 1.
     */
    function drawDonut(canvas, mix, progress = 1) {
        const size = resizeCanvas(canvas);
        if (!size) return;
        const { ctx, width, height } = size;
        const colors = getColors();
        clear(canvas, ctx, width, height);
        drawRegistry.set(canvas, () => drawDonut(canvas, mix, 1));
        if (!mix) return;

        const values = [
            { label: 'Text', value: mix.textOnly, color: colors.green },
            { label: 'Links', value: mix.links, color: colors.blue },
            { label: 'Media', value: mix.media, color: colors.yellow }
        ];
        const total = values.reduce((sum, item) => sum + item.value, 0);
        if (total === 0) {
            ctx.font = '14px Patrick Hand, sans-serif';
            ctx.fillStyle = colors.textSecondary;
            ctx.fillText('No share data yet', 20, height / 2);
            return;
        }

        const centerX = width / 2;
        const centerY = height / 2;
        const radius = Math.min(width, height) * 0.32;
        const innerRadius = radius * 0.55;
        let startAngle = -Math.PI / 2;

        const items = [];

        // Draw segments with simple canvas (no RoughJS per segment)
        values.forEach(item => {
            if (item.value === 0) return;
            const angle = (item.value / total) * Math.PI * 2 * progress;
            const segmentStart = startAngle;
            const segmentEnd = startAngle + angle;

            // Fill
            ctx.beginPath();
            ctx.moveTo(centerX, centerY);
            ctx.fillStyle = item.color;
            ctx.globalAlpha = 0.6;
            ctx.arc(centerX, centerY, radius, segmentStart, segmentEnd);
            ctx.closePath();
            ctx.fill();
            ctx.globalAlpha = 1;

            // Simple stroke border
            ctx.strokeStyle = item.color;
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.arc(centerX, centerY, radius, segmentStart, segmentEnd);
            ctx.stroke();

            items.push({
                type: 'mix',
                label: item.label,
                value: item.value,
                tooltip: `${item.label}: ${item.value}`,
                hitTest: (x, y) => {
                    const dx = x - centerX;
                    const dy = y - centerY;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist < innerRadius || dist > radius) return false;
                    let anglePoint = Math.atan2(dy, dx);
                    if (anglePoint < -Math.PI / 2) anglePoint += Math.PI * 2;
                    const ns = segmentStart < -Math.PI / 2 ? segmentStart + Math.PI * 2 : segmentStart;
                    const ne = segmentEnd < -Math.PI / 2 ? segmentEnd + Math.PI * 2 : segmentEnd;
                    return anglePoint >= ns && anglePoint <= ne;
                }
            });

            startAngle = segmentEnd;
        });

        // Cut out center
        ctx.globalCompositeOperation = 'destination-out';
        ctx.beginPath();
        ctx.arc(centerX, centerY, innerRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';

        // Single RoughJS call for outer circle
        if (rough) {
            const rc = rough.canvas(canvas);
            rc.circle(centerX, centerY, radius * 2, {
                stroke: colors.border,
                strokeWidth: 1.2,
                roughness: 1.5
            });
        }

        register(canvas, items);
    }

    /**
     * Cancel any in-progress chart animations.
     */
    function cancelAnimations() {
        animationId++;
    }

    /**
     * Animate a draw function over the given duration.
     * @param {function(number): void} drawFn - Draw function called with progress (0-1).
     * @param {number} [duration=600] - Animation duration in milliseconds.
     */
    function animateDraw(drawFn, duration = 600) {
        const myId = ++animationId;
        let start = null;

        function step(timestamp) {
            if (myId !== animationId) return; // Cancelled
            if (!start) start = timestamp;
            const elapsed = timestamp - start;
            const progress = Math.min(elapsed / duration, 1);
            drawFn(progress);
            if (progress < 1) {
                requestAnimationFrame(step);
            }
        }
        requestAnimationFrame(step);
    }

    /**
     * Export a chart canvas as a high-resolution PNG file download.
     * Redraws the chart at EXPORT_DPR, exports, then restores normal DPR.
     * @param {HTMLCanvasElement} canvas - The canvas to export.
     * @param {string} [filename='chart.png'] - Download file name.
     */
    function exportPng(canvas, filename) {
        if (!canvas) return;
        const redraw = drawRegistry.get(canvas);
        if (!redraw) return;

        // Render at high DPR, copy pixels to a temp canvas, restore immediately
        cancelAnimations();
        exportDpr = EXPORT_DPR;
        redraw();
        exportDpr = 0;

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = canvas.width;
        tempCanvas.height = canvas.height;
        tempCanvas.getContext('2d').drawImage(canvas, 0, 0);

        // Restore on-screen canvas synchronously — no async gap
        redraw();

        // Export from the detached temp canvas (immune to further redraws)
        tempCanvas.toBlob(blob => {
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename || 'chart.png';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        }, 'image/png');
    }

    return {
        drawTimeline,
        drawTopics,
        drawHeatmap,
        drawDonut,
        animateDraw,
        cancelAnimations,
        getItemAt,
        exportPng
    };
})();
