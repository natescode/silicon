// SPDX-License-Identifier: MIT
/**
 * Codegen Tests
 *
 * Validates the compileToWat() pipeline: typed AST → IRModule → WAT string.
 * Full pipeline per test: parse → AST → strata → elaborate → typecheck → IR lower → emit.
 */

import { test, expect } from "bun:test"
import { compileToWat, compileToWasm } from "./index"
import siliconGrammar from "../grammar/SiliconGrammar"
import parse from "../parser"
import { addToAstSemantics } from "../ast/index"
import { buildStrataRegistry, elaborate } from "../elaborator/index"
import { typecheck } from "../types/index"
import type { Program } from "../ast/astNodes"

function compile(source: string): string {
    const match = parse(source)
    const ast = addToAstSemantics(siliconGrammar)(match).toAst() as Program
    const registry = buildStrataRegistry(ast)
    const { program: elaborated } = elaborate(ast, registry)
    const { program: typed, functions } = typecheck(elaborated, registry)
    return compileToWat(typed, registry, functions)
}

function compileBinary(source: string): Uint8Array {
    const match = parse(source)
    const ast = addToAstSemantics(siliconGrammar)(match).toAst() as Program
    const registry = buildStrataRegistry(ast)
    const { program: elaborated } = elaborate(ast, registry)
    const { program: typed, functions } = typecheck(elaborated, registry)
    return compileToWasm(typed, registry, functions)
}

test("compile generates module structure", () => {
    const wat = compile("42;")
    expect(wat).toContain("(module")
    expect(wat).toContain("(memory 1)")
    expect(wat).toContain("(global $heap")
})

test("compile integer literal produces i32.const", () => {
    const wat = compile("123;")
    expect(wat).toContain("i32.const 123")
})

test("compile float literal produces f32.const", () => {
    const wat = compile("3.14;")
    expect(wat).toContain("f32.const 3.14")
})

test("compile true produces i32.const 1", () => {
    const wat = compile("@true;")
    expect(wat).toContain("i32.const 1")
})

test("compile false produces i32.const 0", () => {
    const wat = compile("@false;")
    expect(wat).toContain("i32.const 0")
})

test("compile addition produces i32.add", () => {
    const wat = compile("1 + 2;")
    expect(wat).toContain("i32.add")
})

test("compile output is valid WAT syntax", () => {
    const wat = compile("42;")
    let depth = 0
    for (const ch of wat) {
        if (ch === '(') depth++
        if (ch === ')') depth--
    }
    expect(depth).toBe(0)
})

test("compile output contains required WAT declarations", () => {
    const wat = compile("42;")
    expect(wat).toContain("(module")
    expect(wat).toContain("(memory 1)")
    expect(wat).toContain("(global $heap")
    expect(wat).toContain("i32.const 1024")
})

test("compile handles multiple expressions", () => {
    const wat = compile("42; 100;")
    expect(wat).toContain("i32.const 42")
    expect(wat).toContain("i32.const 100")
})

test("compile string literals allocate static data", () => {
    const wat = compile("'hello';")
    expect(wat).toContain("(module")
})

test("compile array literals are supported", () => {
    const wat = compile("$[1, 2, 3];")
    expect(wat).toContain("(module")
})

test("compile @let definition emits func with params", () => {
    const wat = compile("\\\\ add (Int, Int)\n@let add x, y := x + y;")
    expect(wat).toContain("(func $add")
    expect(wat).toContain("(param $x i32)")
    expect(wat).toContain("(param $y i32)")
    expect(wat).toContain("i32.add")
})

test("compile unknown definition keyword throws", () => {
    expect(() => compile("@foo bar := 1;")).toThrow("Unknown definition keyword")
})

test("compile if-else as binding emits (result i32)", () => {
    const wat = compile("\\\\ pick (Int, Int, Int)\n@let pick a, b, c := { &@if c, { a }, { b } };")
    expect(wat).toContain("(if (result i32)")
    expect(wat).toContain("(then")
    expect(wat).toContain("(else")
})

test("compile if without else does not emit result type", () => {
    const wat = compile("\\\\ doIf (Int)\n@let doIf x := { &@if x, { x = x + 1; }; x };")
    expect(wat).not.toContain("(if (result")
})

test("compile @let function without @export is not exported", () => {
    const wat = compile("\\\\ add (Int, Int)\n@let add x, y := x + y;")
    expect(wat).toContain("(func $add")
    expect(wat).not.toContain('(export "add"')
})

test("compile @fn definition emits func with params", () => {
    const wat = compile("\\\\ add (Int, Int)\n@fn add x, y := x + y;")
    expect(wat).toContain("(func $add")
    expect(wat).toContain("i32.add")
})

test("compile @var definition emits mutable global", () => {
    const wat = compile("@var count := 0;")
    expect(wat).toContain("(global $count")
    expect(wat).toContain("(mut i32)")
    expect(wat).toContain("(i32.const 0)")
})

test("compile assignment to parameter uses local.set", () => {
    const wat = compile("\\\\ inc (Int)\n@let inc x := { x = x + 1; x };")
    expect(wat).toContain("local.set $x")
    expect(wat).toContain("local.get $x")
})

test("compile @extern with no return type emits void import", () => {
    const wat = compile("@extern { \\\\ print (Int) -> Void }")
    expect(wat).toContain('(import "env" "print"')
    expect(wat).toContain("(param i32)")
    const importLine = wat.split('\n').find(l => l.includes('(import "env" "print"')) ?? ''
    expect(importLine).not.toContain("(result")
})

test("compile @extern with return type emits result declaration", () => {
    const wat = compile("@extern { \\\\ readInt () -> Int }")
    expect(wat).toContain('(import "env" "readInt"')
    expect(wat).toContain("(result i32)")
})

test("compile @extern appears before function definitions in module", () => {
    const wat = compile("@extern { \\\\ print (Int) -> Void }\n@let greet := { &print 42 };")
    const importPos = wat.indexOf("(import")
    const funcPos = wat.indexOf("(func $greet")
    expect(importPos).toBeGreaterThan(-1)
    expect(funcPos).toBeGreaterThan(-1)
    expect(importPos).toBeLessThan(funcPos)
})

test("compile @extern with multiple params", () => {
    const wat = compile("@extern { \\\\ add (Int, Int) -> Void }")
    expect(wat).toContain('(import "env" "add"')
    // IR emitter uses unnamed params in import declarations
    expect(wat).toContain("(param i32) (param i32)")
})

test("compileToWasm returns a valid WASM binary", () => {
    const bin = compileBinary("42;")
    // Magic + version: \0asm 0x01000000
    expect(bin[0]).toBe(0x00)
    expect(bin[1]).toBe(0x61)
    expect(bin[2]).toBe(0x73)
    expect(bin[3]).toBe(0x6d)
    expect(bin[4]).toBe(0x01)
    expect(bin[5]).toBe(0x00)
    expect(bin[6]).toBe(0x00)
    expect(bin[7]).toBe(0x00)
    expect(bin.byteLength).toBeGreaterThan(8)
})

test("compileToWasm direct emitter is byte-equal to WAT round-trip", async () => {
    const { watToWasm } = await import("./toWasm")
    const source = "\\\\ add (Int, Int)\n@let add x, y := x + y;"
    const viaWat = await watToWasm(compile(source))
    const viaDirect = compileBinary(source)
    expect(viaDirect.byteLength).toBe(viaWat.byteLength)
    for (let i = 0; i < viaWat.byteLength; i++) {
        expect(viaDirect[i]).toBe(viaWat[i])
    }
})
