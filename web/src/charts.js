/* LinkedIn Analyzer - Hand-drawn Charts (Optimized) */

import rough from "roughjs/bundled/rough.esm.js";

import { DAY_LABELS } from "./analytics-constants.js";

export const SketchCharts = (() => {
    "use strict";

    const WEEKLY_TIME_RANGES = new Set(["1m", "3m"]);

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
            text: styles.getPropertyValue("--text-primary").trim(),
            textSecondary: styles.getPropertyValue("--text-secondary").trim(),
            border: styles.getPropertyValue("--border-color").trim(),
            blue: styles.getPropertyValue("--accent-blue").trim(),
            yellow: styles.getPropertyValue("--accent-yellow").trim(),
            green: styles.getPropertyValue("--accent-green").trim(),
            purple: styles.getPropertyValue("--accent-purple").trim(),
            red: styles.getPropertyValue("--accent-red").trim(),
        };
    }

    /**
     * Resize canvas to match its CSS dimensions at device pixel ratio.
     * @param {HTMLCanvasElement} canvas - The canvas element to resize.
     * @returns {{ctx: CanvasRenderingContext2D, width: number, height: number}|null}
     */
    function resizeCanvas(canvas) {
        const rect = canvas.getBoundingClientRect();
        /* v8 ignore next */
        if (!rect.width || !rect.height) {
            return null;
        }
        const ratio = exportDpr || window.devicePixelRatio || 1;
        // Round the CSS box first, then scale the backing store to whole device
        // pixels. A fractional backing store (rect.width is often sub-pixel) makes
        // the browser resample the canvas, which reads as blur on wide charts.
        const cssWidth = Math.round(rect.width);
        const cssHeight = Math.round(rect.height);
        canvas.width = Math.round(cssWidth * ratio);
        canvas.height = Math.round(cssHeight * ratio);
        const ctx = canvas.getContext("2d");
        /* v8 ignore next */
        if (!ctx) {
            return null;
        }
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        return { ctx, width: cssWidth, height: cssHeight };
    }

    /**
     * Toggle the empty-state class on a canvas wrapper so the card can shrink.
     * @param {HTMLCanvasElement} canvas - The canvas whose wrapper to toggle.
     * @param {boolean} isEmpty - Whether the chart has no data to show.
     */
    function setChartEmpty(canvas, isEmpty) {
        const wrap = canvas.parentElement;
        if (!wrap) {
            return;
        }
        wrap.classList.toggle("chart-canvas-wrap--empty", isEmpty);
    }

    /**
     * Draw a centered friendly message when a chart has no data.
     * @param {HTMLCanvasElement} canvas - The canvas element to draw on.
     * @param {string} message - The short message to show.
     */
    function drawEmptyState(canvas, message) {
        setChartEmpty(canvas, true);
        const size = resizeCanvas(canvas);
        /* v8 ignore next 3 */
        if (!size) {
            return;
        }
        const { ctx, width, height } = size;
        const colors = getColors();
        clear(canvas, ctx, width, height);
        ctx.font = "14px Patrick Hand, sans-serif";
        ctx.fillStyle = colors.textSecondary;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(message, width / 2, height / 2);
    }

    /**
     * Pick a "nice" chart maximum with headroom so sparse or flat data still
     * reads as a chart instead of a full-height block pinned to the top edge.
     * @param {number} value - The raw maximum data value.
     * @returns {number} A rounded maximum with a little headroom above the data.
     */
    function niceTimelineMax(value) {
        if (value <= 1) {
            return 2;
        }
        if (value <= 4) {
            return value + 1;
        }
        return Math.ceil(value * 1.12);
    }

    /**
     * Convert an rgb()/rgba() color string to an RGB object.
     * @param {string} color - The CSS color string (e.g. 'rgba(46, 66, 209, 1)').
     * @returns {{r: number, g: number, b: number}}
     */
    function colorToRgb(color) {
        const match = color.match(
            /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(?:\d*\.?\d+))?\s*\)/i,
        );
        /* v8 ignore next */
        if (!match) {
            return { r: 81, g: 147, b: 212 };
        }
        return {
            r: Number.parseInt(match[1], 10),
            g: Number.parseInt(match[2], 10),
            b: Number.parseInt(match[3], 10),
        };
    }

    /**
     * Register hit-test items for a canvas in the global registry.
     * @param {HTMLCanvasElement} canvas - The canvas element to register items for.
     * @param {Array<object>} items - The hit-test items to register.
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
     * @returns {object | null} The matching item, or null if none found.
     */
    function getItemAt(canvas, x, y) {
        const items = registry.get(canvas);
        if (!items) {
            return null;
        }
        for (const item of items) {
            if (item.hitTest && item.hitTest(x, y)) {
                return item;
            }
            if (
                typeof item.x === "number" &&
                x >= item.x &&
                x <= item.x + item.width &&
                y >= item.y &&
                y <= item.y + item.height
            ) {
                return item;
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
     * @param {Array<object>} data - Timeline points array.
     * @param {string} timeRange - Filter key (e.g. '1m', '3m', '12m', 'all').
     * @param {number} [progress=1] - Animation progress from 0 to 1.
     * @param {number} [maxOverride=0] - Optional max Y value override.
     * @param {string} [emptyMessage] - Message shown when there is no data.
     */
    function drawTimeline(
        canvas,
        data,
        timeRange,
        progress = 1,
        maxOverride = 0,
        emptyMessage = "No activity to show yet.",
    ) {
        if (!data || !data.length) {
            drawEmptyState(canvas, emptyMessage);
            return;
        }
        setChartEmpty(canvas, false);
        const size = resizeCanvas(canvas);
        /* v8 ignore next */
        if (!size) {
            return;
        }
        const { ctx, width, height } = size;
        const colors = getColors();
        clear(canvas, ctx, width, height);
        drawRegistry.set(canvas, () =>
            drawTimeline(canvas, data, timeRange, 1, maxOverride, emptyMessage),
        );

        const padding = { top: 28, right: 12, bottom: 42, left: 40 };
        const chartWidth = width - padding.left - padding.right;
        const chartHeight = height - padding.top - padding.bottom;
        const rawMax = Math.max(maxOverride || 0, ...data.map((p) => p.value), 1);
        const maxValue = niceTimelineMax(rawMax);
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

        // Y-axis ticks and gridlines so sparse/flat data still reads as a chart
        const tickStep = Math.max(1, Math.ceil(maxValue / 4));
        ctx.font = "10px Patrick Hand, sans-serif";
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        for (let tickValue = 0; tickValue <= maxValue; tickValue += tickStep) {
            const tickY = baseY - (tickValue / maxValue) * chartHeight;
            if (tickValue !== 0) {
                ctx.strokeStyle = colors.border;
                ctx.globalAlpha = 0.35;
                ctx.lineWidth = 0.6;
                ctx.beginPath();
                ctx.moveTo(padding.left, tickY);
                ctx.lineTo(padding.left + chartWidth, tickY);
                ctx.stroke();
                ctx.globalAlpha = 1;
            }
            ctx.fillStyle = colors.textSecondary;
            ctx.fillText(String(tickValue), padding.left - 6, tickY);
        }

        // Area fill
        ctx.fillStyle = colors.blue;
        ctx.globalAlpha = 0.16;
        /* v8 ignore next */
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
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        /* v8 ignore next */
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
        /* v8 ignore next */
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
        ctx.font = "11px Patrick Hand, sans-serif";
        ctx.fillStyle = colors.text;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        visiblePoints.forEach(({ point, x, y, index }) => {
            // Flat months emit a row of noisy repeated "0" labels; skip them.
            if (point.value === 0) {
                return;
            }
            if (!showAllValues && index % valueEvery !== 0 && index !== points.length - 1) {
                return;
            }
            // Keep the label above the point and clear of the top edge.
            const labelY = Math.max(14, y - 8);
            ctx.fillText(String(point.value), x, labelY);
        });

        // Labels
        ctx.font = "12px Patrick Hand, sans-serif";
        ctx.fillStyle = colors.textSecondary;
        const isWeekly = WEEKLY_TIME_RANGES.has(timeRange);
        if (timeRange === "all" && data.length > 18) {
            let lastYear = null;
            points.forEach(({ point, x }, index) => {
                const [year, month] = point.key.split("-").map(Number);
                /* v8 ignore next */
                if (!year || !month) {
                    return;
                }
                const isStart = index === 0;
                const isJan = month === 1;
                const isLast = index === points.length - 1;
                if (!isStart && !isJan && !isLast) {
                    return;
                }
                // Well-formed monthly keys contribute one label candidate per
                // year before the year changes, so a repeat never occurs; the
                // dedupe guard is defensive against duplicated month keys.
                /* v8 ignore next 3 */
                if (year === lastYear && !isLast) {
                    return;
                }
                lastYear = year;
                ctx.save();
                ctx.translate(x, baseY + 20);
                ctx.rotate(-0.18);
                ctx.textAlign = "center";
                ctx.fillText(String(year), 0, 0);
                ctx.restore();
            });
        } else {
            const labelEvery = data.length <= 10 ? 1 : Math.ceil(data.length / 8);
            const minLabelSpacing = 38;

            // Collect label candidates, then thin out any that would crowd their
            // neighbour so rotated labels (e.g. "Dec"/"Jan") no longer collide at
            // narrow widths. The last point wins over an adjacent regular label.
            const accepted = [];
            points.forEach((entry, index) => {
                const isLast = index === points.length - 1;
                if (index % labelEvery !== 0 && !isLast) {
                    return;
                }
                const prev = accepted[accepted.length - 1];
                if (prev && entry.x - prev.entry.x < minLabelSpacing) {
                    if (isLast) {
                        accepted.pop();
                        accepted.push({ entry, isLast });
                    }
                    return;
                }
                accepted.push({ entry, isLast });
            });

            accepted.forEach(({ entry }) => {
                const { point, x } = entry;
                const labelText = isWeekly ? point.label : point.label.split(" ")[0];
                ctx.save();
                ctx.translate(x, baseY + 18);
                ctx.rotate(-0.35);
                ctx.textAlign = "center";
                ctx.fillText(labelText, 0, 0);
                ctx.restore();
            });
        }

        const items = points.map(({ point, x }) => ({
            type: isWeekly ? "week" : "month",
            key: point.key,
            monthKey: point.monthKey || point.key,
            label: point.label,
            value: point.value,
            x: x - sliceWidth / 2,
            y: padding.top,
            width: sliceWidth,
            height: chartHeight,
            tooltip: `${point.label}: ${point.value}`,
        }));

        register(canvas, items);
    }

    /**
     * Draw horizontal bar chart of topic counts.
     * @param {HTMLCanvasElement} canvas - The canvas element to draw on.
     * @param {Array<object>} data - Array of topic objects with topic and count properties.
     * @param {number} [progress=1] - Animation progress from 0 to 1.
     * @param {string} [emptyMessage] - Message shown when there is no data.
     */
    function drawTopics(canvas, data, progress = 1, emptyMessage = "No data to show yet.") {
        if (!data || !data.length) {
            drawEmptyState(canvas, emptyMessage);
            return;
        }
        setChartEmpty(canvas, false);
        const size = resizeCanvas(canvas);
        /* v8 ignore next */
        if (!size) {
            return;
        }
        const { ctx, width, height } = size;
        const colors = getColors();
        clear(canvas, ctx, width, height);
        drawRegistry.set(canvas, () => drawTopics(canvas, data, 1, emptyMessage));

        ctx.font = "13px Patrick Hand, sans-serif";
        const maxLabelWidth = Math.max(...data.map((p) => ctx.measureText(p.topic).width), 60);
        const leftPad = Math.min(Math.ceil(maxLabelWidth) + 16, Math.floor(width * 0.4));
        const padding = { top: 10, right: 10, bottom: 10, left: leftPad };
        const chartWidth = width - padding.left - padding.right;
        const chartHeight = height - padding.top - padding.bottom;
        const maxValue = Math.max(...data.map((p) => p.count), 1);
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
            ctx.textAlign = "right";
            let label = point.topic;
            const maxLabelSpace = padding.left - 12;
            while (label.length > 1 && ctx.measureText(label).width > maxLabelSpace) {
                label = label.slice(0, -1);
            }
            if (label !== point.topic) {
                label += "\u2026";
            }
            ctx.fillText(label, padding.left - 8, y + barHeight - 6);

            items.push({
                type: "topic",
                key: point.topic,
                label: point.topic,
                value: point.count,
                x: padding.left,
                y,
                width: bw,
                height: barHeight,
                tooltip: `${point.topic}: ${point.count}`,
            });
        });

        register(canvas, items);
    }

    /**
     * Draw 7x24 activity heatmap grid.
     * @param {HTMLCanvasElement} canvas - The canvas element to draw on.
     * @param {Array<Array<number>>} grid - 7x24 grid of activity counts (days x hours).
     * @param {string} [emptyMessage] - Message shown when there is no data.
     */
    function drawHeatmap(canvas, grid, emptyMessage = "No activity to show yet.") {
        if (!grid || !grid.length) {
            drawEmptyState(canvas, emptyMessage);
            return;
        }
        setChartEmpty(canvas, false);
        const size = resizeCanvas(canvas);
        /* v8 ignore next */
        if (!size) {
            return;
        }
        const { ctx, width, height } = size;
        const colors = getColors();
        clear(canvas, ctx, width, height);
        drawRegistry.set(canvas, () => drawHeatmap(canvas, grid, emptyMessage));

        const padding = { top: 20, right: 20, bottom: 26, left: 44 };
        const chartWidth = width - padding.left - padding.right;
        const chartHeight = height - padding.top - padding.bottom;
        const cellWidth = chartWidth / 24;
        const cellHeight = chartHeight / 7;
        const flat = grid.flat();
        const maxValue = Math.max(...flat, 1);
        const baseColor = colorToRgb(colors.blue);

        ctx.font = "11px Patrick Hand, sans-serif";
        ctx.fillStyle = colors.textSecondary;

        // Day labels
        for (let day = 0; day < 7; day++) {
            ctx.fillText(DAY_LABELS[day], 6, padding.top + day * cellHeight + cellHeight * 0.7);
        }

        // Hour labels
        for (let hour = 0; hour < 24; hour += 3) {
            ctx.fillText(
                String(hour).padStart(2, "0"),
                padding.left + hour * cellWidth + 2,
                height - 6,
            );
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
                    type: "heatmap",
                    day,
                    hour,
                    x,
                    y,
                    width: cellWidth,
                    height: cellHeight,
                    tooltip: `${DAY_LABELS[day]} ${String(hour).padStart(2, "0")}:00 - ${value}`,
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
        /* v8 ignore next */
        if (rough) {
            const rc = rough.canvas(canvas);
            rc.rectangle(padding.left, padding.top, chartWidth, chartHeight, {
                stroke: colors.border,
                strokeWidth: 1.2,
                roughness: 1.4,
            });
        }

        register(canvas, items);
    }

    /**
     * Draw donut chart of content type mix.
     * @param {HTMLCanvasElement} canvas - The canvas element to draw on.
     * @param {object} mix - Content type mix with textOnly, links, and media counts.
     * @param {number} [progress=1] - Animation progress from 0 to 1.
     */
    function drawDonut(canvas, mix, progress = 1) {
        const size = resizeCanvas(canvas);
        /* v8 ignore next */
        if (!size) {
            return;
        }
        const { ctx, width, height } = size;
        const colors = getColors();
        clear(canvas, ctx, width, height);
        drawRegistry.set(canvas, () => drawDonut(canvas, mix, 1));
        if (!mix) {
            return;
        }

        const values = [
            { label: "Text", value: mix.textOnly, color: colors.green },
            { label: "Links", value: mix.links, color: colors.blue },
            { label: "Media", value: mix.media, color: colors.yellow },
        ];
        const total = values.reduce((sum, item) => sum + item.value, 0);
        if (total === 0) {
            ctx.font = "14px Patrick Hand, sans-serif";
            ctx.fillStyle = colors.textSecondary;
            ctx.fillText("No share data yet", 20, height / 2);
            return;
        }

        const centerX = width / 2;
        const centerY = height / 2;
        const radius = Math.min(width, height) * 0.32;
        const innerRadius = radius * 0.55;
        let startAngle = -Math.PI / 2;

        const items = [];

        // Draw segments with simple canvas (no RoughJS per segment)
        values.forEach((item) => {
            if (item.value === 0) {
                return;
            }
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
                type: "mix",
                label: item.label,
                value: item.value,
                tooltip: `${item.label}: ${item.value}`,
                hitTest: (x, y) => {
                    const dx = x - centerX;
                    const dy = y - centerY;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist < innerRadius || dist > radius) {
                        return false;
                    }
                    let anglePoint = Math.atan2(dy, dx);
                    if (anglePoint < -Math.PI / 2) {
                        anglePoint += Math.PI * 2;
                    }
                    // Segment angles accumulate upward from -PI/2, so they never
                    // fall below it; the wrap adjustment is defensive only.
                    /* v8 ignore next 3 */
                    const ns =
                        segmentStart < -Math.PI / 2 ? segmentStart + Math.PI * 2 : segmentStart;
                    const ne = segmentEnd < -Math.PI / 2 ? segmentEnd + Math.PI * 2 : segmentEnd;
                    return anglePoint >= ns && anglePoint <= ne;
                },
            });

            startAngle = segmentEnd;
        });

        // Cut out center
        ctx.globalCompositeOperation = "destination-out";
        ctx.beginPath();
        ctx.arc(centerX, centerY, innerRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = "source-over";

        // Single RoughJS call for outer circle
        /* v8 ignore next */
        if (rough) {
            const rc = rough.canvas(canvas);
            rc.circle(centerX, centerY, radius * 2, {
                stroke: colors.border,
                strokeWidth: 1.2,
                roughness: 1.5,
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
            /* v8 ignore next */
            if (myId !== animationId) {
                return;
            } // Cancelled
            /* v8 ignore next */
            if (!start) {
                start = timestamp;
            }
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
        /* v8 ignore next */
        if (!canvas) {
            return;
        }
        const redraw = drawRegistry.get(canvas);
        /* v8 ignore next */
        if (!redraw) {
            return;
        }

        // Render at high DPR, copy pixels to a temp canvas, restore immediately
        cancelAnimations();
        exportDpr = EXPORT_DPR;
        redraw();
        exportDpr = 0;

        const tempCanvas = document.createElement("canvas");
        tempCanvas.width = canvas.width;
        tempCanvas.height = canvas.height;
        const tempCtx = tempCanvas.getContext("2d");
        /* v8 ignore next */
        if (!tempCtx) {
            return;
        }
        tempCtx.drawImage(canvas, 0, 0);

        // Restore on-screen canvas synchronously, no async gap
        redraw();

        // Export from the detached temp canvas (immune to further redraws)
        tempCanvas.toBlob((blob) => {
            if (!blob) {
                return;
            }
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = filename || "chart.png";
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        }, "image/png");
    }

    return {
        drawTimeline,
        drawTopics,
        drawHeatmap,
        drawDonut,
        animateDraw,
        cancelAnimations,
        getItemAt,
        exportPng,
    };
})();
