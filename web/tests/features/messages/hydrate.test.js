import { describe, expect, it } from "vitest";

import { hydrateMessageState } from "../../../src/features/messages/hydrate.js";
import { compactEvents } from "../../helpers/message-events.js";

describe("hydrateMessageState", () => {
    it("keeps well-formed event and row timestamp columns", () => {
        const events = compactEvents([
            { contactKey: "a", timestamp: 100 },
            { contactKey: "b", timestamp: 200 },
        ]);
        const rowTimestamps = Float64Array.of(100, 200);

        const state = hydrateMessageState({ contacts: [], events, rowTimestamps });

        expect(state.events).toEqual(events);
        expect(state.events.timestamps).toBe(events.timestamps);
        expect(state.rowTimestamps).toBe(rowTimestamps);
    });

    it.each([
        ["missing", undefined],
        ["plain arrays", { contactKeys: ["a"], contactIds: [0], timestamps: [100] }],
        [
            "mismatched lengths",
            { contactKeys: ["a"], contactIds: Int32Array.of(0, 0), timestamps: Float64Array.of(1) },
        ],
        ["no contact keys", { contactIds: Int32Array.of(0), timestamps: Float64Array.of(1) }],
    ])("replaces %s event columns with empty ones", (label, events) => {
        const state = hydrateMessageState({ events, rowTimestamps: [100] });

        expect(state.events.contactKeys).toEqual([]);
        expect(state.events.contactIds).toEqual(new Int32Array(0));
        expect(state.events.timestamps).toEqual(new Float64Array(0));
        expect(state.rowTimestamps).toEqual(new Float64Array(0));
    });
});
