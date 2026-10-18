import { describe, expect, it } from "vitest";

import {
    extractWorkerError,
    extractWorkerRejection,
    toErrorMessage,
} from "../../src/shared/worker-errors.js";

describe("toErrorMessage", () => {
    it.each([
        [new Error("boom"), "boom"],
        [new Error(""), "fallback"],
        ["text", "text"],
        ["", "fallback"],
        [42, "fallback"],
    ])("turns %j into %j", (error, expected) => {
        expect(toErrorMessage(error, "fallback")).toBe(expected);
    });
});

describe("extractWorkerError", () => {
    const error = new Error("boom");

    it.each([
        [null, undefined],
        ["text", undefined],
        [{ error }, error],
        [{ error: null, message: "text" }, "text"],
        [{ message: "" }, undefined],
    ])("reads %j", (event, expected) => {
        expect(extractWorkerError(event)).toBe(expected);
    });
});

describe("extractWorkerRejection", () => {
    it.each([
        [null, undefined],
        [{}, undefined],
        [{ reason: "why" }, "why"],
    ])("reads %j", (event, expected) => {
        expect(extractWorkerRejection(event)).toBe(expected);
    });
});
