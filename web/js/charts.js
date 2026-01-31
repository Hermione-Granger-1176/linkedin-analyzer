/* LinkedIn Analyzer - Hand-drawn Charts */

const SketchCharts = (() => {
    'use strict';

    const registry = new Map();

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

    function resizeCanvas(canvas) {
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) {
            return null;
        }
        const ratio = window.devicePixelRatio || 1;
        canvas.width = rect.width * ratio;
        canvas.height = rect.height * ratio;
        const ctx = canvas.getContext('2d');
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        return { ctx, width: rect.width, height: rect.height };
    }

    function hexToRgb(hex) {
        const cleaned = hex.replace('#', '').trim();
        if (cleaned.length !== 6) return { r: 90, g: 150, b: 213 };
        const r = parseInt(cleaned.slice(0, 2), 16);
        const g = parseInt(cleaned.slice(2, 4), 16);
        const b = parseInt(cleaned.slice(4, 6), 16);
        return { r, g, b };
    }

    function register(canvas, items) {
        registry.set(canvas, items);
    }

    function clear(canvas, ctx, width, height) {
        ctx.clearRect(0, 0, width, height);
        registry.delete(canvas);
    }

    function getItemAt(canvas, x, y) {
        const items = registry.get(canvas);
        if (!items) return null;
        for (let i = 0; i < items.length; i += 1) {
            const item = items[i];
            if (item.hitTest && item.hitTest(x, y)) {
                return item;
            }
            if (typeof item.x === 'number') {
                if (x >= item.x && x <= item.x + item.width && y >= item.y && y <= item.y + item.height) {
                    return item;
                }
            }
        }
        return null;
    }

    function drawTimeline(canvas, data, progress = 1) {
        const size = resizeCanvas(canvas);
        if (!size) return;
        const { ctx, width, height } = size;
        const colors = getColors();
        clear(canvas, ctx, width, height);
        if (!data || !data.length) return;

        const padding = { top: 24, right: 10, bottom: 42, left: 36 };
        const chartWidth = width - padding.left - padding.right;
        const chartHeight = height - padding.top - padding.bottom;
        const maxValue = Math.max(...data.map(point => point.value), 1);
        const slotWidth = chartWidth / data.length;
        const barWidth = Math.max(8, slotWidth * 0.55);
        const rc = rough.canvas(canvas);

        ctx.strokeStyle = colors.border;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(padding.left, padding.top + chartHeight + 2);
        ctx.lineTo(padding.left + chartWidth, padding.top + chartHeight + 2);
        ctx.stroke();

        ctx.font = '12px Patrick Hand, sans-serif';
        ctx.fillStyle = colors.textSecondary;

        const items = [];

        data.forEach((point, index) => {
            const value = point.value;
            const barHeight = (value / maxValue) * chartHeight * progress;
            const x = padding.left + index * slotWidth + (slotWidth - barWidth) / 2;
            const y = padding.top + (chartHeight - barHeight);
            const fillHeight = Math.max(2, barHeight);

            ctx.fillStyle = colors.blue;
            ctx.globalAlpha = 0.6;
            ctx.fillRect(x, y, barWidth, fillHeight);
            ctx.globalAlpha = 1;

            rc.rectangle(x, y, barWidth, fillHeight, {
                stroke: colors.blue,
                strokeWidth: 1.2,
                roughness: 1.4
            });

            const label = point.label.split(' ');
            const labelText = label[0];
            ctx.save();
            ctx.translate(x + barWidth / 2, padding.top + chartHeight + 18);
            ctx.rotate(-0.35);
            ctx.textAlign = 'center';
            ctx.fillText(labelText, 0, 0);
            ctx.restore();

            items.push({
                type: 'month',
                key: point.key,
                label: point.label,
                value,
                x,
                y,
                width: barWidth,
                height: fillHeight,
                tooltip: `${point.label}: ${value}`
            });
        });

        register(canvas, items);
    }

    function drawTopics(canvas, data, progress = 1) {
        const size = resizeCanvas(canvas);
        if (!size) return;
        const { ctx, width, height } = size;
        const colors = getColors();
        clear(canvas, ctx, width, height);
        if (!data || !data.length) return;

        const padding = { top: 10, right: 10, bottom: 10, left: 80 };
        const chartWidth = width - padding.left - padding.right;
        const chartHeight = height - padding.top - padding.bottom;
        const maxValue = Math.max(...data.map(point => point.count), 1);
        const barHeight = Math.min(24, chartHeight / data.length - 6);
        const rc = rough.canvas(canvas);

        ctx.font = '13px Patrick Hand, sans-serif';
        ctx.fillStyle = colors.textSecondary;

        const items = [];

        data.forEach((point, index) => {
            const y = padding.top + index * (barHeight + 10);
            const barWidth = (point.count / maxValue) * chartWidth * progress;
            const x = padding.left;

            ctx.fillStyle = colors.purple;
            ctx.globalAlpha = 0.6;
            ctx.fillRect(x, y, barWidth, barHeight);
            ctx.globalAlpha = 1;

            rc.rectangle(x, y, barWidth, barHeight, {
                stroke: colors.purple,
                strokeWidth: 1.2,
                roughness: 1.3
            });

            ctx.fillStyle = colors.text;
            ctx.textAlign = 'right';
            ctx.fillText(point.topic, padding.left - 8, y + barHeight - 6);

            items.push({
                type: 'topic',
                key: point.topic,
                label: point.topic,
                value: point.count,
                x,
                y,
                width: barWidth,
                height: barHeight,
                tooltip: `${point.topic}: ${point.count}`
            });
        });

        register(canvas, items);
    }

    function drawHeatmap(canvas, grid) {
        const size = resizeCanvas(canvas);
        if (!size) return;
        const { ctx, width, height } = size;
        const colors = getColors();
        clear(canvas, ctx, width, height);
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

        for (let day = 0; day < 7; day += 1) {
            const label = AnalyticsEngine.DAY_LABELS[day];
            ctx.fillText(label, 6, padding.top + day * cellHeight + cellHeight * 0.7);
        }

        for (let hour = 0; hour < 24; hour += 3) {
            const label = String(hour).padStart(2, '0');
            ctx.fillText(label, padding.left + hour * cellWidth + 2, height - 6);
        }

        const items = [];

        for (let day = 0; day < 7; day += 1) {
            for (let hour = 0; hour < 24; hour += 1) {
                const value = grid[day][hour];
                const intensity = Math.max(0.08, value / maxValue);
                const x = padding.left + hour * cellWidth;
                const y = padding.top + day * cellHeight;
                ctx.fillStyle = `rgba(${baseColor.r}, ${baseColor.g}, ${baseColor.b}, ${intensity})`;
                ctx.fillRect(x, y, cellWidth, cellHeight);

                items.push({
                    type: 'heatmap',
                    day,
                    hour,
                    x,
                    y,
                    width: cellWidth,
                    height: cellHeight,
                    tooltip: `${AnalyticsEngine.DAY_LABELS[day]} ${String(hour).padStart(2, '0')}:00 - ${value}`
                });
            }
        }

        ctx.strokeStyle = colors.border;
        ctx.lineWidth = 0.6;
        for (let hour = 0; hour <= 24; hour += 1) {
            const x = padding.left + hour * cellWidth;
            ctx.beginPath();
            ctx.moveTo(x, padding.top);
            ctx.lineTo(x, padding.top + chartHeight);
            ctx.stroke();
        }
        for (let day = 0; day <= 7; day += 1) {
            const y = padding.top + day * cellHeight;
            ctx.beginPath();
            ctx.moveTo(padding.left, y);
            ctx.lineTo(padding.left + chartWidth, y);
            ctx.stroke();
        }

        if (typeof rough !== 'undefined') {
            const rc = rough.canvas(canvas);
            rc.rectangle(padding.left, padding.top, chartWidth, chartHeight, {
                stroke: colors.border,
                strokeWidth: 1.2,
                roughness: 1.4
            });
        }

        register(canvas, items);
    }

    function drawDonut(canvas, mix, progress = 1) {
        const size = resizeCanvas(canvas);
        if (!size) return;
        const { ctx, width, height } = size;
        const colors = getColors();
        clear(canvas, ctx, width, height);
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
        const rc = rough.canvas(canvas);

        const items = [];

        values.forEach(item => {
            if (item.value === 0) return;
            const angle = (item.value / total) * Math.PI * 2 * progress;
            const segmentStart = startAngle;
            const segmentEnd = startAngle + angle;

            ctx.beginPath();
            ctx.moveTo(centerX, centerY);
            ctx.fillStyle = item.color;
            ctx.globalAlpha = 0.6;
            ctx.arc(centerX, centerY, radius, segmentStart, segmentEnd);
            ctx.closePath();
            ctx.fill();
            ctx.globalAlpha = 1;

            rc.arc(centerX, centerY, radius * 2, radius * 2, segmentStart, segmentEnd, {
                stroke: item.color,
                strokeWidth: 1.4,
                roughness: 1.1
            });

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
                    const normalizedStart = segmentStart < -Math.PI / 2 ? segmentStart + Math.PI * 2 : segmentStart;
                    const normalizedEnd = segmentEnd < -Math.PI / 2 ? segmentEnd + Math.PI * 2 : segmentEnd;
                    return anglePoint >= normalizedStart && anglePoint <= normalizedEnd;
                }
            });

            startAngle = segmentEnd;
        });

        ctx.globalCompositeOperation = 'destination-out';
        ctx.beginPath();
        ctx.arc(centerX, centerY, innerRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';

        rc.circle(centerX, centerY, radius * 2, {
            stroke: colors.border,
            strokeWidth: 1.2,
            roughness: 1.5
        });

        register(canvas, items);
    }

    function animateDraw(drawFn, duration = 600) {
        let start = null;
        function step(timestamp) {
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

    return {
        drawTimeline,
        drawTopics,
        drawHeatmap,
        drawDonut,
        animateDraw,
        getItemAt
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = SketchCharts;
}
