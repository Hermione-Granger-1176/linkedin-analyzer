/*
 * Watch for a page that janks while it is otherwise idle.
 *
 * Long frames during processing or a screen render are expected and say
 * nothing about decoration cost, so the caller's isBusy() check filters them
 * out. Repeated long frames while idle mean the running animation is too much
 * for this device, and the caller drops one effects tier for the session.
 */

// Long frames needed inside the window before the page counts as janking.
export const JANK_FRAME_COUNT = 5;
export const JANK_WINDOW_MS = 5000;

/**
 * Start watching. Uses long-animation-frame where supported and falls back to
 * longtask. Calls onJank at most once.
 * @param {object} options
 * @param {typeof PerformanceObserver|undefined} options.Observer - PerformanceObserver
 * @param {() => boolean} options.isBusy - True while processing or rendering is expected to block
 * @param {() => void} options.onJank - Called once when the page janks while idle
 * @param {() => Array<{start: number, end: number}>} [options.busySpans] -
 * performance.now() intervals during which the page was busy (end is Infinity
 * while it still is). Entries arrive after their frame, often once the busy
 * state is over, so a frame that overlaps any span is not counted.
 * @returns {() => void} Stops watching
 */
export function watchForJank({ Observer, isBusy, onJank, busySpans = () => [] }) {
    if (typeof Observer !== "function") {
        return () => {};
    }
    const supported = Array.isArray(Observer.supportedEntryTypes)
        ? Observer.supportedEntryTypes
        : [];
    const type = ["long-animation-frame", "longtask"].find((name) => supported.includes(name));
    if (!type) {
        return () => {};
    }

    /** @type {number[]} */
    let frames = [];
    let fired = false;
    const observer = new Observer((list) => {
        if (fired) {
            return;
        }
        for (const entry of list.getEntries()) {
            const end = entry.startTime + (entry.duration || 0);
            const overlapsBusy = busySpans().some(
                (span) => span.start <= end && span.end >= entry.startTime,
            );
            if (isBusy() || overlapsBusy) {
                frames = [];
                continue;
            }
            frames.push(entry.startTime);
            frames = frames.filter((start) => entry.startTime - start <= JANK_WINDOW_MS);
            if (frames.length >= JANK_FRAME_COUNT) {
                fired = true;
                observer.disconnect();
                onJank();
                return;
            }
        }
    });
    observer.observe({ type, buffered: false });
    return () => observer.disconnect();
}
