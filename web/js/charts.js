/* LinkedIn Analyzer - Hand-drawn Charts (Optimized) */

const SketchCharts = (() => {
    'use strict';

    const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    const registry = new Map();
    let animationId = 0;

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
        if (!rect.width || !rect.height) return null;
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
        return {
            r: parseInt(cleaned.slice(0, 2), 16),
            g: parseInt(cleaned.slice(2, 4), 16),
            b: parseInt(cleaned.slice(4, 6), 16)
        };
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
     * Draw a sketchy rectangle border (cheaper than RoughJS for many items)
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

    function drawTimeline(canvas, data, timeRange, progress = 1) {
        const size = resizeCanvas(canvas);
        if (!size) return;
        const { ctx, width, height } = size;
        const colors = getColors();
        clear(canvas, ctx, width, height);
        if (!data || !data.length) return;

        // For "all time" with many months, group by year
        let displayData = data;
        let isYearGrouped = false;
        if (timeRange === 'all' && data.length > 24) {
            displayData = groupByYear(data);
            isYearGrouped = true;
        }

        const padding = { top: 24, right: 10, bottom: 42, left: 36 };
        const chartWidth = width - padding.left - padding.right;
        const chartHeight = height - padding.top - padding.bottom;
        const maxValue = Math.max(...displayData.map(p => p.value), 1);
        const slotWidth = chartWidth / displayData.length;
        const barWidth = Math.max(8, slotWidth * 0.55);

        // Draw axis line
        ctx.strokeStyle = colors.border;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(padding.left, padding.top + chartHeight + 2);
        ctx.lineTo(padding.left + chartWidth, padding.top + chartHeight + 2);
        ctx.stroke();

        ctx.font = '12px Patrick Hand, sans-serif';
        const items = [];

        // Draw all bars with simple fill first (batched)
        ctx.fillStyle = colors.blue;
        ctx.globalAlpha = 0.6;
        
        const barData = displayData.map((point, index) => {
            const barHeight = (point.value / maxValue) * chartHeight * progress;
            const x = padding.left + index * slotWidth + (slotWidth - barWidth) / 2;
            const y = padding.top + (chartHeight - barHeight);
            const fillHeight = Math.max(2, barHeight);
            ctx.fillRect(x, y, barWidth, fillHeight);
            return { point, x, y, fillHeight };
        });
        
        ctx.globalAlpha = 1;

        // Draw sketchy borders (simpler than RoughJS)
        barData.forEach(({ point, x, y, fillHeight }) => {
            sketchyRect(ctx, x, y, barWidth, fillHeight, colors.blue);

            // Labels - use year for grouped data, month abbreviation otherwise
            ctx.fillStyle = colors.textSecondary;
            const labelText = isYearGrouped ? point.label : point.label.split(' ')[0];
            ctx.save();
            ctx.translate(x + barWidth / 2, padding.top + chartHeight + 18);
            ctx.rotate(-0.35);
            ctx.textAlign = 'center';
            ctx.fillText(labelText, 0, 0);
            ctx.restore();

            items.push({
                type: isYearGrouped ? 'year' : 'month',
                key: point.key,
                label: point.label,
                value: point.value,
                x, y,
                width: barWidth,
                height: fillHeight,
                tooltip: `${point.label}: ${point.value}`,
                months: point.months || null  // For year groups, store contributing month keys
            });
        });

        register(canvas, items);
    }

    /**
     * Group monthly data by year for cleaner display of long timelines
     */
    function groupByYear(data) {
        const yearMap = new Map();
        data.forEach(point => {
            // point.key is "YYYY-MM"
            const year = point.key.split('-')[0];
            if (!yearMap.has(year)) {
                yearMap.set(year, { value: 0, months: [] });
            }
            const entry = yearMap.get(year);
            entry.value += point.value;
            entry.months.push(point.key);
        });
        return Array.from(yearMap.entries()).map(([year, entry]) => ({
            key: year,
            label: year,
            value: entry.value,
            months: entry.months
        }));
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
        const maxValue = Math.max(...data.map(p => p.count), 1);
        const barHeight = Math.min(24, chartHeight / data.length - 6);

        ctx.font = '13px Patrick Hand, sans-serif';
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
            ctx.fillText(point.topic, padding.left - 8, y + barHeight - 6);

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
        if (typeof rough !== 'undefined') {
            const rc = rough.canvas(canvas);
            rc.circle(centerX, centerY, radius * 2, {
                stroke: colors.border,
                strokeWidth: 1.2,
                roughness: 1.5
            });
        }

        register(canvas, items);
    }

    function cancelAnimations() {
        animationId++;
    }

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

    return {
        drawTimeline,
        drawTopics,
        drawHeatmap,
        drawDonut,
        animateDraw,
        cancelAnimations,
        getItemAt
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = SketchCharts;
}
