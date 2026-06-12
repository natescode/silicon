// SPDX-License-Identifier: MIT
/**
 * @i64 / @u64 casts + numeric digit separators.
 *
 * Two related features land together:
 *
 *   - `@i64(expr)` / `@u64(expr)` — Int → Int64 / UInt64 casts, the human-
 *     readable spelling of the WASI-era `@toInt64` / `@toU64` keywords.  A
 *     *literal* argument is constant-folded straight to a 64-bit `i64.const`,
 *     so values above the 32-bit range survive (the original `@toInt64(N)`
 *     bug round-tripped N through `i32.const` first and truncated it).  A
 *     *non-literal* argument takes the ordinary sign/zero-extend path.
 *
 *   - `_` digit separators in integer and float literals (`5_000_000`,
 *     `123_456.789_012`, `0xFF_FF`) — stripped when computing the value.
 *
 * Range over-/under-flow past the 64-bit window is rejected at typecheck
 * with E0018 (IntLiteralOutOfRange).
 */

import { test, expect, describe } from 'bun:test'
import { compileToWasm, compileToWat } from '../codegen/index'
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

function typeErrors(src: string) {
    const match = parse(src)
    const ast = addToAstSemantics(siliconGrammar)(match).toAst() as Program
    const registry = buildStrataRegistry(ast)
    const { program: elaborated } = elaborate(ast, registry)
    return typecheck(elaborated, registry).errors
}

describe('@i64 / @u64 casts', () => {
    test('@i64 of a small literal round-trips as a BigInt result', async () => {
        const ex = await compileAndRun(`
            \\\\ make Int64
            @fn make := @i64(42);
            @export make;`)
        expect(ex.make()).toBe(42n)
    })

    test('@i64 of a literal above the 32-bit range is exact (original bug fixed)', async () => {
        // 5_000_000_000 > 2^31; the old @toInt64 truncated through i32.const.
        const ex = await compileAndRun(`
            \\\\ make Int64
            @fn make := @i64(5000000000);
            @export make;`)
        expect(ex.make()).toBe(5000000000n)
    })

    test('@i64 of max Int64 (above 2^53) is exact', async () => {
        const ex = await compileAndRun(`
            \\\\ make Int64
            @fn make := @i64(9223372036854775807);
            @export make;`)
        expect(ex.make()).toBe(9223372036854775807n)
    })

    test('@toInt64 of a large literal is now exact (the reported bug)', async () => {
        const ex = await compileAndRun(`
            \\\\ make Int64
            @fn make := @toInt64(5000000000);
            @export make;`)
        expect(ex.make()).toBe(5000000000n)
    })

    test('@u64 of max UInt64 lowers to the all-ones i64 pattern (-1n)', async () => {
        const ex = await compileAndRun(`
            \\\\ make u64
            @fn make := @u64(18446744073709551615);
            @export make;`)
        // wasm i64 is two's-complement; max u64 is the all-ones bit pattern.
        expect(ex.make()).toBe(-1n)
    })

    test('@i64 of a literal folds to i64.const (no extend instruction)', () => {
        const wat = compileWat(`\\\\ make Int64
@fn make := @i64(42);`)
        expect(wat).toContain('i64.const 42')
        expect(wat).not.toContain('i64.extend_i32_s')
    })

    test('@i64 of a non-literal Int sign-extends', async () => {
        const ex = await compileAndRun(`
            \\\\ widen (Int) -> Int64
            @fn widen x := @i64(x);
            @export widen;`)
        expect(ex.widen(42)).toBe(42n)
        expect(ex.widen(-7)).toBe(-7n)
    })
})

describe('@i64 / @u64 range validation (E0018)', () => {
    test('@i64 above 2^63-1 is rejected', () => {
        const errs = typeErrors(`\\\\ make Int64
@fn make := @i64(9223372036854775808);`)
        expect(errs.some(e => e.kind === 'IntLiteralOutOfRange')).toBe(true)
    })

    test('@u64 above 2^64-1 is rejected', () => {
        const errs = typeErrors(`\\\\ make u64
@fn make := @u64(99999999999999999999999);`)
        expect(errs.some(e => e.kind === 'IntLiteralOutOfRange')).toBe(true)
    })

    test('@u64 of max UInt64 is in range (boundary)', () => {
        const errs = typeErrors(`\\\\ make u64
@fn make := @u64(18446744073709551615);`)
        expect(errs.some(e => e.kind === 'IntLiteralOutOfRange')).toBe(false)
    })
})

describe('numeric digit separators', () => {
    test('integer separators evaluate to the correct value', async () => {
        const ex = await compileAndRun(`
            \\\\ make Int64
            @fn make := @i64(5_000_000);
            @export make;`)
        expect(ex.make()).toBe(5000000n)
    })

    test('separators in a large literal stay exact', async () => {
        const ex = await compileAndRun(`
            \\\\ make Int64
            @fn make := @i64(9_223_372_036_854_775_807);
            @export make;`)
        expect(ex.make()).toBe(9223372036854775807n)
    })

    test('float separators evaluate to the correct value', async () => {
        const ex = await compileAndRun(`
            \\\\ make Float
            @fn make := 123_456.789_012;
            @export make;`)
        // f32 rounding — assert proximity rather than exact equality.
        expect(ex.make()).toBeCloseTo(123456.789, 1)
    })

    test('hex literal with separators is correct', async () => {
        const ex = await compileAndRun(`
            \\\\ make Int
            @fn make := 0xFF_FF;
            @export make;`)
        expect(ex.make()).toBe(65535)
    })
})
