import { afterEach, describe, expect, it, vi } from "vitest";

import { startPerformanceSpan } from "../../../src/platform/observability/perf.js";

describe("startPerformanceSpan", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("marks the start now and the end and the measure when the span is closed", () => {
        const performanceStub = { mark: vi.fn(), measure: vi.fn() };
        vi.stubGlobal("performance", performanceStub);

        const end = startPerformanceSpan("page:load");

        expect(performanceStub.mark.mock.calls).toEqual([["page:load:start"]]);
        expect(performanceStub.measure).not.toHaveBeenCalled();

        end();

        expect(performanceStub.mark.mock.calls).toEqual([["page:load:start"], ["page:load:end"]]);
        expect(performanceStub.measure).toHaveBeenCalledWith(
            "page:load",
            "page:load:start",
            "page:load:end",
        );
    });

    it("does nothing where the Performance API is missing", () => {
        vi.stubGlobal("performance", undefined);

        const end = startPerformanceSpan("page:load");

        expect(() => end()).not.toThrow();
    });
});
