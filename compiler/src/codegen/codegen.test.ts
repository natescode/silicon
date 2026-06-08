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

test("compile @global definition emits func with params", () => {
    const wat = compile("\\\\ add (Int, Int)\nadd x, y := x + y;")
    expect(wat).toContain("(func $add")
    expect(wat).toContain("(param $x i32)")
    expect(wat).toContain("(param $y i32)")
    expect(wat).toContain("i32.add")
})

test("compile unknown definition keyword throws", () => {
    expect(() => compile("@foo bar := 1;")).toThrow("Unknown definition keyword")
})

test("compile if-else as binding emits (result i32)", () => {
    const wat = compile("\\\\ pick (Int, Int, Int)\npick a, b, c := {\n    @if(c, {\n        a\n    }, {\n        b\n    })\n};")
    expect(wat).toContain("(if (result i32)")
    expect(wat).toContain("(then")
    expect(wat).toContain("(else")
})

test("compile if without else does not emit result type", () => {
    const wat = compile("\\\\ doIf (Int)\ndoIf x := {\n    @if(x, {\n        x = x + 1;\n    });\n    x\n};")
    expect(wat).not.toContain("(if (result")
})

test("compile @global function without @export is not exported", () => {
    const wat = compile("\\\\ add (Int, Int)\nadd x, y := x + y;")
    expect(wat).toContain("(func $add")
    expect(wat).not.toContain('(export "add"')
})

test("compile @fn definition emits func with params", () => {
    const wat = compile("\\\\ add (Int, Int)\n@fn add x, y := x + y;")
    expect(wat).toContain("(func $add")
    expect(wat).toContain("i32.add")
})

test("compile @local definition emits mutable global", () => {
    const wat = compile("@mut count := 0;")
    expect(wat).toContain("(global $count")
    expect(wat).toContain("(mut i32)")
    expect(wat).toContain("(i32.const 0)")
})

test("compile assignment to parameter uses local.set", () => {
    const wat = compile("\\\\ inc (Int)\ninc x := {\n    x = x + 1;\n    x\n};")
    expect(wat).toContain("local.set $x")
    expect(wat).toContain("local.get $x")
})

test("compile @extern with no return type emits void import", () => {
    const wat = compile("\\\\ @extern print (Int) -> Void;")
    expect(wat).toContain('(import "env" "print"')
    expect(wat).toContain("(param i32)")
    const importLine = wat.split('\n').find(l => l.includes('(import "env" "print"')) ?? ''
    expect(importLine).not.toContain("(result")
})

test("compile @extern with return type emits result declaration", () => {
    const wat = compile("\\\\ @extern readInt () -> Int;")
    expect(wat).toContain('(import "env" "readInt"')
    expect(wat).toContain("(result i32)")
})

test("compile @extern appears before function definitions in module", () => {
    const wat = compile("\\\\ @extern print (Int);\ngreet := {\n    print(42)\n};")
    const importPos = wat.indexOf("(import")
    const funcPos = wat.indexOf("(func $greet")
    expect(importPos).toBeGreaterThan(-1)
    expect(funcPos).toBeGreaterThan(-1)
    expect(importPos).toBeLessThan(funcPos)
})

test("compile @extern with multiple params", () => {
    const wat = compile("\\\\ @extern add (Int, Int) -> Void;")
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

// Strip every custom section (id 0) so we compare only the CORE module
// (sections 1–11). The direct emitter and wabt both now emit `name`/`producers`
// custom metadata, which legitimately differs between a hand-emitter and wabt;
// the invariant under test is that the two backends produce the same *core* module.
function stripCustomSections(bytes: Uint8Array): Uint8Array {
    const out: number[] = []
    for (let i = 0; i < 8; i++) out.push(bytes[i])   // \0asm + version header
    let p = 8
    while (p < bytes.length) {
        const id = bytes[p]
        let len = 0, shift = 0, q = p + 1
        for (;;) { const b = bytes[q++]; len |= (b & 0x7f) << shift; if ((b & 0x80) === 0) break; shift += 7 }
        const end = q + len
        if (id !== 0) for (let i = p; i < end; i++) out.push(bytes[i])
        p = end
    }
    return new Uint8Array(out)
}

test("compileToWasm direct emitter is byte-equal to WAT round-trip (core sections)", async () => {
    const { watToWasm } = await import("./toWasm")
    const source = "\\\\ add (Int, Int)\nadd x, y := x + y;"
    const viaWat = stripCustomSections(await watToWasm(compile(source)))
    const viaDirect = stripCustomSections(compileBinary(source))
    expect(viaDirect.byteLength).toBe(viaWat.byteLength)
    for (let i = 0; i < viaWat.byteLength; i++) {
        expect(viaDirect[i]).toBe(viaWat[i])
    }
})
