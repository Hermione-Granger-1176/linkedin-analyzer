import { describe, expect, it, vi } from "vitest";

import {
    JANK_FRAME_COUNT,
    JANK_WINDOW_MS,
    watchForJank,
} from "../../../src/platform/device/jank.js";

/** A PerformanceObserver stand-in whose entries the test pushes by hand. */
function fakeObserverClass(supportedEntryTypes) {
    const instances = [];
    class FakeObserver {
        static supportedEntryTypes = supportedEntryTypes;

        constructor(callback) {
            this.callback = callback;
            this.disconnect = vi.fn();
            this.observe = vi.fn();
            instances.push(this);
        }

        emit(startTimes) {
            this.callback({ getEntries: () => startTimes.map((startTime) => ({ startTime })) });
        }
    }
    return { FakeObserver, instances };
}

describe("watchForJank", () => {
    it("prefers long-animation-frame and fires once after repeated idle long frames", () => {
        const { FakeObserver, instances } = fakeObserverClass(["longtask", "long-animation-frame"]);
        const onJank = vi.fn();
        watchForJank({ Observer: FakeObserver, isBusy: () => false, onJank });
        const [observer] = instances;
        expect(observer.observe).toHaveBeenCalledWith({
            type: "long-animation-frame",
            buffered: false,
        });

        observer.emit([0, 100, 200, 300]);
        expect(onJank).not.toHaveBeenCalled();
        observer.emit([400, 500]);
        expect(onJank).toHaveBeenCalledTimes(1);
        expect(observer.disconnect).toHaveBeenCalled();

        observer.emit([600, 700, 800, 900, 1000]);
        expect(onJank).toHaveBeenCalledTimes(1);
    });

    it("forgets long frames older than the window", () => {
        const { FakeObserver, instances } = fakeObserverClass(["longtask"]);
        const onJank = vi.fn();
        watchForJank({ Observer: FakeObserver, isBusy: () => false, onJank });
        const spaced = Array.from(
            { length: JANK_FRAME_COUNT },
            (_, index) => index * (JANK_WINDOW_MS / 2 + 1),
        );
        instances[0].emit(spaced);
        expect(instances[0].observe).toHaveBeenCalledWith({ type: "longtask", buffered: false });
        expect(onJank).not.toHaveBeenCalled();
    });

    it("ignores long frames while the page is busy", () => {
        const { FakeObserver, instances } = fakeObserverClass(["longtask"]);
        const onJank = vi.fn();
        let busy = false;
        watchForJank({ Observer: FakeObserver, isBusy: () => busy, onJank });

        instances[0].emit([0, 10, 20, 30]);
        busy = true;
        instances[0].emit([40]);
        busy = false;
        instances[0].emit([50, 60, 70, 80]);
        expect(onJank).not.toHaveBeenCalled();
    });

    it("ignores long frames that span a busy mark reported after the work ended", () => {
        const { FakeObserver, instances } = fakeObserverClass(["longtask"]);
        const onJank = vi.fn();
        const marks = [];
        watchForJank({
            Observer: FakeObserver,
            isBusy: () => false,
            onJank,
            busyMarks: () => marks,
        });

        marks.push(0, 10, 20, 30, 40);
        instances[0].emit([0, 10, 20, 30, 40]);
        expect(onJank).not.toHaveBeenCalled();
        instances[0].callback({
            getEntries: () => [50, 60, 70, 80, 90].map((startTime) => ({ startTime, duration: 5 })),
        });
        expect(onJank).toHaveBeenCalledTimes(1);
    });

    it("does nothing without a supported observer and can be stopped", () => {
        const onJank = vi.fn();
        expect(() =>
            watchForJank({ Observer: undefined, isBusy: () => false, onJank })(),
        ).not.toThrow();
        const unsupported = fakeObserverClass(["paint"]);
        watchForJank({ Observer: unsupported.FakeObserver, isBusy: () => false, onJank })();
        expect(unsupported.instances).toHaveLength(0);
        const noList = fakeObserverClass(undefined);
        watchForJank({ Observer: noList.FakeObserver, isBusy: () => false, onJank });
        expect(noList.instances).toHaveLength(0);

        const { FakeObserver, instances } = fakeObserverClass(["longtask"]);
        const stop = watchForJank({ Observer: FakeObserver, isBusy: () => false, onJank });
        stop();
        expect(instances[0].disconnect).toHaveBeenCalled();
    });
});
