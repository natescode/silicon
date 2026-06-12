// SPDX-License-Identifier: MIT
/**
 * F1 — native host-handle-carrying sum types under `--target=wasm-gc`.
 *
 * A `JSValue`/`JSString` is an externref; externref can't live in linear
 * memory, which is why the `js::pin` interim threads a handle through a
 * `Result[Int, …]` as an `i32` id.  Under wasm-gc a sum is a GC struct and a
 * struct field CAN be an externref, so a parametric sum instantiated with a
 * host-handle type-arg carries the handle natively — no pin.
 *
 * These tests RUN the emitted modules in Bun (not just validate): they pass a
 * real host object in, store it in the sum, read it back through `@match`, and
 * assert reference identity — proving the handle survives the round-trip in a
 * native externref field.  The flat-union specialized struct layout makes even
 * the heterogeneous `Result[JSValue, String]` (Ok: externref, Err: i32) work.
 */

import { test, expect, describe } from 'bun:test'
import { buildStrataRegistry } from '../elaborator/strataLoader'
import elaborate from '../elaborator/elaborator'
import typecheck from '../types/typechecker'
import { compileToWasm } from '../codegen'
import parse from '../parser'
import addToAstSemantics from '../ast/toAst'
import siliconGrammar from '../grammar/SiliconGrammar'

function compile(src: string, target: 'host' | 'wasm-gc') {
    const prog = addToAstSemantics(siliconGrammar)(parse(src)).toAst() as any
    const registry = buildStrataRegistry(prog)
    const tc = typecheck(elaborate(prog, registry).program, registry, undefined, target)
    if (tc.errors.length) return { errors: tc.errors.map((e: any) => e.message), binary: null as Uint8Array | null }
    try {
        const binary = compileToWasm(tc.program, registry, tc.functions, undefined, { target })
        return { errors: [] as string[], binary }
    } catch (e: any) {
        return { errors: [String(e.message ?? e)], binary: null as Uint8Array | null }
    }
}

async function run(src: string): Promise<Record<string, Function>> {
    const { errors, binary } = compile(src, 'wasm-gc')
    if (errors.length) throw new Error(errors.join('\n'))
    const { instance } = await WebAssembly.instantiate(binary!, { env: { print: () => {}, read: () => 0 } } as any)
    return instance.exports as any
}

const OPTION = `@type Option[T] := $Some value T | $None;\n`
const RESULT = `@type Result[T,E] := $Ok value T | $Err error E;\n`

describe('F1 — Option[JSValue] (single host-handle slot)', () => {
    test('constructs Some(handle), tests the tag, and extracts the handle by identity', async () => {
        const ex = await run(OPTION +
            `\\\\ wrap (JSValue) -> Option[JSValue]\n@fn wrap h := Some(h);\n` +
            `\\\\ none_ () -> Option[JSValue]\n@fn none_ := None();\n` +
            `\\\\ is_some (Option[JSValue]) -> Int\n@fn is_some o := @match(o, $Some v, { 1 }, $None, { 0 });\n` +
            `\\\\ get_or (Option[JSValue], JSValue) -> JSValue\n@fn get_or o, dflt := @match(o, $Some v, { v }, $None, { dflt });\n` +
            `@export wrap;\n@export none_;\n@export is_some;\n@export get_or;`)

        const obj = { kind: 'host-object', n: 42 }
        const some = ex.wrap(obj)
        const none = ex.none_()
        expect(ex.is_some(some)).toBe(1)
        expect(ex.is_some(none)).toBe(0)
        // The handle round-trips through the native externref field by identity.
        expect(ex.get_or(some, null)).toBe(obj)
        // None yields the supplied default handle.
        const fallback = { fallback: true }
        expect(ex.get_or(none, fallback)).toBe(fallback)
    })

    test('a null host handle round-trips', async () => {
        const ex = await run(OPTION +
            `\\\\ wrap (JSValue) -> Option[JSValue]\n@fn wrap h := Some(h);\n` +
            `\\\\ get_or (Option[JSValue], JSValue) -> JSValue\n@fn get_or o, dflt := @match(o, $Some v, { v }, $None, { dflt });\n` +
            `@export wrap;\n@export get_or;`)
        expect(ex.get_or(ex.wrap(null), { d: 1 })).toBe(null)
    })
})

describe('F1 — Result[JSValue, String] (heterogeneous: externref Ok, i32 Err)', () => {
    test('Ok carries the handle natively; Err carries a String; both via one flat-union struct', async () => {
        const ex = await run(RESULT +
            `\\\\ ok (JSValue) -> Result[JSValue, String]\n@fn ok h := Ok(h);\n` +
            `\\\\ err () -> Result[JSValue, String]\n@fn err := Err('boom');\n` +
            `\\\\ is_ok (Result[JSValue, String]) -> Int\n@fn is_ok r := @match(r, $Ok v, { 1 }, $Err e, { 0 });\n` +
            `\\\\ unwrap_or (Result[JSValue, String], JSValue) -> JSValue\n@fn unwrap_or r, dflt := @match(r, $Ok v, { v }, $Err e, { dflt });\n` +
            `@export ok;\n@export err;\n@export is_ok;\n@export unwrap_or;`)

        const resource = { resource: 'fd', id: 7 }
        const okv = ex.ok(resource)
        const errv = ex.err()
        expect(ex.is_ok(okv)).toBe(1)
        expect(ex.is_ok(errv)).toBe(0)
        // Ok's externref handle survives by identity.
        expect(ex.unwrap_or(okv, null)).toBe(resource)
        // Err is the i32-shaped (String) variant — unwrap_or falls back.
        const dflt = { default: true }
        expect(ex.unwrap_or(errv, dflt)).toBe(dflt)
    })

    test('the i32 Err payload reads back correctly (the i32 slot in the flat-union is intact)', async () => {
        // Result[JSValue, Int]: Ok is the externref slot, Err the i32 slot.
        // Reading the Err Int back proves the heterogeneous struct keeps its
        // i32 slot uncorrupted alongside the externref one.
        const ex = await run(RESULT +
            `\\\\ err (Int) -> Result[JSValue, Int]\n@fn err code := Err(code);\n` +
            `\\\\ ok (JSValue) -> Result[JSValue, Int]\n@fn ok h := Ok(h);\n` +
            `\\\\ err_code (Result[JSValue, Int]) -> Int\n` +
            `@fn err_code r := @match(r, $Ok v, { 0 - 1 }, $Err e, { e });\n` +
            `@export err;\n@export ok;\n@export err_code;`)
        expect(ex.err_code(ex.err(404))).toBe(404)
        // An Ok value returns the -1 sentinel (its i32 Err slot is the default 0,
        // but the match dispatches on the tag, not the slot — so we get -1).
        expect(ex.err_code(ex.ok({ any: 'obj' }))).toBe(-1)
    })
})

describe('F1 — linear-memory target rejection (fail-fast, not invalid wasm)', () => {
    test('a JSValue sum payload errors clearly on --target=host', () => {
        const { errors, binary } = compile(OPTION +
            `\\\\ wrap (JSValue) -> Option[JSValue]\n@fn wrap h := Some(h);\n@export wrap;`, 'host')
        expect(binary).toBeNull()
        expect(errors.join('\n')).toContain('host handle')
        expect(errors.join('\n')).toContain('wasm-gc')
    })
})

describe('F1 — existing all-i32 sums are unaffected', () => {
    test('Option[Int] still uses the shared base struct (no specialization)', async () => {
        const ex = await run(OPTION +
            `\\\\ wrap (Int) -> Option[Int]\n@fn wrap x := Some(x);\n` +
            `\\\\ get_or (Option[Int], Int) -> Int\n@fn get_or o, d := @match(o, $Some v, { v }, $None, { d });\n` +
            `@export wrap;\n@export get_or;`)
        expect(ex.get_or(ex.wrap(99), 0)).toBe(99)
    })
})
