import { describe, expect, it } from "vitest";

import { AVATAR_COLORS, getInitials, pickAvatarColor } from "../src/avatar.js";

describe("getInitials", () => {
    it("uses first and last token for multi-word names", () => {
        expect(getInitials("Ada Lovelace")).toBe("AL");
        expect(getInitials("Grace Brewster Hopper")).toBe("GH");
    });

    it("uses up to two letters for a single token", () => {
        expect(getInitials("Cher")).toBe("CH");
        expect(getInitials("A")).toBe("A");
    });

    it("collapses extra whitespace", () => {
        expect(getInitials("  Ada   Lovelace  ")).toBe("AL");
    });

    it("falls back to '?' for empty or missing names", () => {
        expect(getInitials("")).toBe("?");
        expect(getInitials("   ")).toBe("?");
        expect(getInitials(null)).toBe("?");
        expect(getInitials(undefined)).toBe("?");
    });
});

describe("pickAvatarColor", () => {
    it("always returns a known color class", () => {
        for (const name of ["Ada Lovelace", "Alan Turing", "x", ""]) {
            expect(AVATAR_COLORS).toContain(pickAvatarColor(name));
        }
    });

    it("is deterministic for the same name", () => {
        expect(pickAvatarColor("Ada Lovelace")).toBe(pickAvatarColor("Ada Lovelace"));
    });

    it("ignores surrounding whitespace", () => {
        expect(pickAvatarColor("  Ada Lovelace  ")).toBe(pickAvatarColor("Ada Lovelace"));
    });
});
