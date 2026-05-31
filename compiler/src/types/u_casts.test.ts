// SPDX-License-Identifier: MIT
/**
 * Phase 5b-4 — @toU32 / @toU64 cast keywords.
 *
 * Proves the three cast paths introduced for the WASI bindings
 * migration:
 *
 *   - `&@toU32 expr` — Int → u32, pure type relabel (no WASM instruction).
 *   - `&@toU64 expr` (Int → u64) — zero-extends via i64.extend_i32_u.
 *   - `&@toU64 expr` (Int64 → u64) — pure type relabel (no instruction).
 *
 * Type-system tests verify the typechecker accepts the new annotations
 * + cast forms.  Runtime tests instantiate the compiled wasm and confirm
 * the cast values round-trip correctly through the unsigned-integer
 * codegen paths.
 */

import { test, expect, describe } from 'bun:test'
import { compileToWasm } from '../codegen/index'
import { compileToWat } from '../codegen/index'
import siliconGrammar from '../grammar/SiliconGrammar'
import parse from '../parser'
import { addToAstSemantics } from '../ast/index'
import { buildStrataRegistry, elaborate } from '../elaborator/index'
import { typecheck } from '../types/index'
import type { Program } from '../ast/astNodes'

async function compileAndRun(src: string): Promise<any> {
    const match = parse(src)
    const ast = addToAstSemantics(siliconGrammar)(match).toAst() as Program
    const registry = buildStrataRegistry(ast)
    const { program: elaborated } = elaborate(ast, registry)
    const { program: typed, functions } = typecheck(elaborated, registry)
    const bin = compileToWasm(typed, registry, functions)
    const mod = await WebAssembly.instantiate(bin, {
        env: { print: () => {}, read: () => 0 },
    })
    return mod.instance.exports
}

function compileWat(src: string): string {
    const match = parse(src)
    const ast = addToAstSemantics(siliconGrammar)(match).toAst() as Program
    const registry = buildStrataRegistry(ast)
    const { program: elaborated } = elaborate(ast, registry)
    const { program: typed, functions } = typecheck(elaborated, registry)
    return compileToWat(typed, registry, functions)
}

describe('Phase 5b-4: @toU32 / @toU64 cast keywords', () => {
    test('@toU32 lets a function declare :u32 return type with an Int body', async () => {
        const ex = await compileAndRun(`
            @fn make_u32:u32 := &@toU32 42;
            @export make_u32;
        `)
        // u32 lowers to i32 wasm — caller gets the raw value.
        expect(ex.make_u32()).toBe(42)
    })

    test('@toU64 from Int emits i64.extend_i32_u (zero-extend)', () => {
        const wat = compileWat(`@fn make:u64 := &@toU64 42;`)
        expect(wat).toContain('i64.extend_i32_u')
        // Function's WAT result type must match.
        expect(wat).toContain('(func $make (result i64)')
    })

    test('@toU64 from Int returns i64 value at runtime', async () => {
        const ex = await compileAndRun(`
            @fn make_u64:u64 := &@toU64 42;
            @export make_u64;
        `)
        // BigInt because the wasm return is i64.
        expect(ex.make_u64()).toBe(42n)
    })

    test('@toU64 from Int64 emits NO extension instruction (pure relabel)', () => {
        // Inner @toInt64 emits its own i64.extend_i32_s; outer @toU64:Int64
        // is a no-op.  Confirm we don't see a *second* extend instruction
        // wrapping the inner one.
        const wat = compileWat(`@fn make:u64 := &@toU64 (&@toInt64 42);`)
        const extendCount = (wat.match(/i64\.extend_i32_/g) || []).length
        expect(extendCount).toBe(1)
    })

    test('@toU64 from Int64 produces the right runtime value', async () => {
        const ex = await compileAndRun(`
            @fn make:u64 := &@toU64 (&@toInt64 99);
            @export make;
        `)
        expect(ex.make()).toBe(99n)
    })

    test('typechecker rejects @toU32 on a non-Int argument', () => {
        // `42.0` is a Float literal; @toU32 expects Int.
        const match = parse(`@fn bad:u32 := &@toU32 42.0;`)
        const ast = addToAstSemantics(siliconGrammar)(match).toAst() as Program
        const registry = buildStrataRegistry(ast)
        const { program: elaborated } = elaborate(ast, registry)
        const { errors } = typecheck(elaborated, registry)
        expect(errors.length).toBeGreaterThan(0)
    })

    // The path_open module-call test that originally lived here moved
    // to src/e2e/e2e.test.ts (Round 27 / path_open_i64) because that
    // harness loads the moduleRegistry needed to resolve the
    // `wasi_snapshot_preview1::` namespace.  The cast-keyword surface
    // is fully covered by the tests above.
})
