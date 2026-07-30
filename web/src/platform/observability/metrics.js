export const WEB_VITAL_NAMES = new Set(["CLS", "FCP", "INP", "LCP", "TTFB"]);

export const PERFORMANCE_MEASURE_NAMES = new Set([
    "connections:idb-read",
    "connections:normalize",
    "connections:render",
    "connections:worker-parse",
    "messages:build-connections",
    "messages:build-state",
    "messages:idb-read",
    "messages:render",
    "messages:worker-parse",
]);

export const WIRE_METRIC_NAMES = new Set([
    ...Array.from(PERFORMANCE_MEASURE_NAMES, (name) => `perf:${name}`),
    ...Array.from(WEB_VITAL_NAMES, (name) => `web-vital:${name}`),
]);
