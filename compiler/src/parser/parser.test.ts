// SPDX-License-Identifier: MIT
import { test, expect, describe } from "bun:test";
import { parse } from "./index";

// parse() now returns the AST Program directly (ohm removed) and throws on
// invalid input, so "parses" means "returns a Program without throwing".

test("parse is a function", () => {
    expect(typeof parse).toBe("function");
});

const VALID: Array<[string, string]> = [
    ["simple expression", "42;"],
    ["integer literal", "123;"],
    ["float literal", "3.14;"],
    ["string literal", "'hello world';"],
    ["empty string", "'';"],
    ["boolean true", "@true;"],
    ["boolean false", "@false;"],
    ["array literal", "$[1, 2, 3];"],
    ["empty array", "$[];"],
    ["object literal", "${a=1, b=2};"],
    ["empty object", "${};"],
    ["tuple literal", "$(1, 2, 3);"],
    ["binary addition", "1 + 2;"],
    ["binary multiplication", "3 * 4;"],
    ["complex expression", "1 + 2 * 3 - 4;"],
    ["assignment", "x = 42;"],
    ["assignment with expression", "y = 1 + 2;"],
    ["function call", "add(1, 2);"],
    ["function call no args", "print();"],
    ["block", "{ x = 1; y = 2; };"],
    ["empty block", "{};"],
    ["namespace", "a::b;"],
    ["nested namespace", "a::b::c;"],
    ["doc comment (consumed as comment → empty program)", "## This is a comment"],
    ["function definition", "@fn add x := 42;"],
    ["parenthesized expression", "(1 + 2) * 3;"],
];

describe("parse valid programs", () => {
    for (const [name, src] of VALID) {
        test(name, () => {
            const result = parse(src);
            expect(result).toBeDefined();
            expect(result.type).toBe("Program");
            expect(Array.isArray(result.elements)).toBe(true);
        });
    }
});

describe("parse rejects invalid input", () => {
    for (const src of ["@fn add a:Int := a;", "1 +", "$[1, 2", "{ x = 1"]) {
        test(JSON.stringify(src), () => {
            expect(() => parse(src)).toThrow();
        });
    }
});
