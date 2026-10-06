// @vitest-environment node

import { readFileSync } from "node:fs";

import braces from "braces";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
);
const lock = JSON.parse(
    readFileSync(new URL("../../../package-lock.json", import.meta.url), "utf8"),
);
const forkArchive =
    "https://codeload.github.com/FSDevelop/braces/tar.gz/28d440b5dd449dbf1fe6f3506cf94ecca4d02660";

function nestedPattern(depth, open = "{", close = "}") {
    return `${open.repeat(depth)}a${close.repeat(depth)}`;
}

function nestedAst(depth, root = true) {
    let node = { type: "text", value: "a" };
    for (let index = 0; index < depth; index += 1) {
        node = { type: "paren", nodes: [node] };
    }
    return root ? { type: "root", nodes: [node] } : node;
}

describe("braces security override", () => {
    it("pins every locked copy to the reviewed archive with integrity verification", () => {
        expect(manifest.devDependencies.braces).toBe(forkArchive);
        expect(manifest.overrides.braces).toBe("$braces");
        const copies = Object.entries(lock.packages).filter(([name]) =>
            name.endsWith("node_modules/braces"),
        );
        expect(copies.length).toBeGreaterThan(0);
        for (const [, entry] of copies) {
            expect(entry.resolved).toBe(forkArchive);
            expect(entry.integrity).toMatch(/^sha512-/u);
            expect(entry.dev).toBe(true);
        }
    });

    it.each(["parse", "compile", "expand", "stringify"])(
        "%s accepts depth 100 and rejects excessive brace and parenthesis nesting",
        (method) => {
            for (const [open, close] of [
                ["{", "}"],
                ["(", ")"],
            ]) {
                expect(() => braces[method](nestedPattern(100, open, close))).not.toThrow();
                for (const depth of [101, 4000]) {
                    expect(() => braces[method](nestedPattern(depth, open, close))).toThrow(
                        /exceeds max depth/u,
                    );
                }
            }
        },
    );

    it("counts mixed and unclosed nesting before recursive processing", () => {
        expect(() => braces.parse(nestedPattern(50, "{(", ")}"))).not.toThrow();
        expect(() => braces.parse(nestedPattern(51, "{(", ")}"))).toThrow(/exceeds max depth/u);
        expect(() => braces.parse("{".repeat(101))).toThrow(/exceeds max depth/u);
        expect(() => braces.parse("(".repeat(101))).toThrow(/exceeds max depth/u);
    });

    it("enforces fractional limits and a hard cap even with permissive options", () => {
        expect(() => braces.parse(nestedPattern(2), { maxDepth: 2.5 })).not.toThrow();
        expect(() => braces.parse(nestedPattern(3), { maxDepth: 2.5 })).toThrow(
            /exceeds max depth/u,
        );
        for (const maxDepth of [1000, Infinity, NaN, false]) {
            expect(() => braces.compile(nestedPattern(101), { maxDepth })).toThrow(
                /exceeds max depth/u,
            );
        }
    });

    it.each(["compile", "expand", "stringify"])(
        "%s guards caller-supplied ASTs and child cycles",
        (method) => {
            for (const root of [true, false]) {
                expect(() => braces[method](nestedAst(100, root))).not.toThrow();
                expect(() => braces[method](nestedAst(101, root))).toThrow(/exceeds max depth/u);
            }
            const cycle = { type: "root", nodes: [] };
            cycle.nodes.push(cycle);
            expect(() => braces[method](cycle)).toThrow(/exceeds max depth/u);
        },
    );

    it("rejects a cyclic parent chain during expansion", () => {
        const node = { type: "paren", nodes: [{ type: "text", value: "a" }] };
        node.parent = node;
        expect(() => braces.expand(node)).toThrow(/parent chain contains a cycle/u);
    });

    it("preserves ordinary alternatives, ranges, escapes, and stringification", () => {
        expect(braces.expand("web/{src,tests}/**/*.{js,mjs}")).toEqual([
            "web/src/**/*.js",
            "web/src/**/*.mjs",
            "web/tests/**/*.js",
            "web/tests/**/*.mjs",
        ]);
        expect(braces.expand("a{b,c,/{x,y}}/e")).toEqual(["ab/e", "ac/e", "a/x/e", "a/y/e"]);
        expect(braces.expand("{01..03}")).toEqual(["01", "02", "03"]);
        expect(braces.expand(String.raw`\{a,b\}`)).toEqual(["{a,b}"]);
        expect(braces.stringify("{1..8}", { escapeInvalid: true })).toBe("{1..8}");
    });
});
