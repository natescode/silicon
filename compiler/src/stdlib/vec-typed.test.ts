// SPDX-License-Identifier: MIT
/**
 * M1 (ADR 0001 / ADR 0009 M-8) — Vec[Float] and Vec[Int64], monomorphic per
 * element type, run on BOTH targets from the SAME source:
 *   - linear-mem (`host`): vec.si `vec_*_f32` / `vec_*_i64` (f32/i64
 *     load/store, 8-byte stride for i64);
 *   - wasm-gc: per-element GC arrays `$Array_f32`/`$Array_i64` emitted by
 *     codegen/gc-vec.ts.
 *
 * The suffixed surface (`vec_new_f32`, `vec_len_i64`, …) is identical across
 * targets, so each program is compiled and run on both.
 */

import { test, expect, describe } from 'bun:test'
import parse from '../parser'
import addToAstSemantics from '../ast/toAst'
import siliconGrammar from '../grammar/SiliconGrammar'
import { buildStrataRegistry, elaborate } from '../elaborator/index'
import { typecheck } from '../types/index'
import { compileToWasm } from '../codegen'
import { resolveUses } from '../modules/useResolver'

async function runBoth(src: string): Promise<Record<'host' | 'wasm-gc', any>> {
    const out: any = {}
    for (const target of ['host', 'wasm-gc'] as const) {
        // The mvp/host path needs `@use 'vec'`; under wasm-gc the vec
        // functions are TS-injected, so `@use` is a harmless no-op there.
        const full = `@use 'vec';\n${src}`
        const { source } = resolveUses(full, '/virtual/m.si', { target } as any)
        const ast = addToAstSemantics(siliconGrammar)(parse(source)).toAst() as any
        const registry = buildStrataRegistry(ast)
        const { program: elab } = elaborate(ast, registry)
        const tc = typecheck(elab, registry, undefined, target as any)
        // The `\\ v Vec[T]` annotations must be CLEAN on both targets: under
        // wasm-gc against the TS-registered Vec[T] signatures, on the linear
        // host via the Vec≈Int representation rule (a Vec IS its header ptr).
        if (tc.errors.length) throw new Error(`typecheck [${target}]: ${tc.errors.map((e: any) => e.message ?? e.kind).join('; ')}`)
        const bin = compileToWasm(tc.program, registry, tc.functions, undefined, { target } as any)
        const mod = await WebAssembly.instantiate(bin, { env: { print: () => {}, read: () => 0 } } as any)
        out[target] = mod.instance.exports
    }
    return out
}

describe('M1: Vec[Float] (both targets)', () => {
    test('push / set / get round-trip with f32 elements', async () => {
        const ex = await runBoth(`
            \\\\ run_f () -> Float
            @fn run_f := {
                \\\\ v Vec[Float]
                @mut v := vec_new_f32(2);
                vec_push_f32(v, 1.5);
                vec_push_f32(v, 2.5);
                vec_push_f32(v, 3.5);
                vec_set_f32(v, 0, 9.5);
                (vec_get_f32(v, 0) + vec_get_f32(v, 2))
            };
            \\\\ len_f () -> Int
            @fn len_f := {
                \\\\ v Vec[Float]
                @mut v := vec_new_f32(2);
                vec_push_f32(v, 1.5);
                vec_push_f32(v, 2.5);
                vec_len_f32(v)
            };
            @export run_f;
            @export len_f;`)
        for (const t of ['host', 'wasm-gc'] as const) {
            expect(ex[t].run_f()).toBe(13)   // 9.5 + 3.5
            expect(ex[t].len_f()).toBe(2)
        }
    })

    test('grow path preserves earlier f32 elements (push past initial capacity)', async () => {
        const ex = await runBoth(`
            \\\\ first_after_grow () -> Float
            @fn first_after_grow := {
                \\\\ v Vec[Float]
                @mut v := vec_new_f32(1);
                vec_push_f32(v, 7.5);
                vec_push_f32(v, 8.5);
                vec_push_f32(v, 9.5);
                vec_get_f32(v, 0)
            };
            @export first_after_grow;`)
        for (const t of ['host', 'wasm-gc'] as const) expect(ex[t].first_after_grow()).toBe(7.5)
    })
})

describe('M1: Vec[Int64] (both targets)', () => {
    test('stores and reads back values > 2^32 (full 64-bit element)', async () => {
        const ex = await runBoth(`
            \\\\ run_l () -> Int64
            @fn run_l := {
                \\\\ v Vec[Int64]
                @mut v := vec_new_i64(2);
                big := (@toInt64(2000000000) + @toInt64(2000000000));
                vec_push_i64(v, big);
                vec_push_i64(v, @toInt64(7));
                vec_set_i64(v, 1, @toInt64(123));
                (vec_get_i64(v, 0) + vec_get_i64(v, 1))
            };
            \\\\ len_l () -> Int
            @fn len_l := {
                \\\\ v Vec[Int64]
                @mut v := vec_new_i64(2);
                vec_push_i64(v, @toInt64(1));
                vec_len_i64(v)
            };
            @export run_l;
            @export len_l;`)
        for (const t of ['host', 'wasm-gc'] as const) {
            expect(ex[t].run_l()).toBe(4000000123n)   // 4_000_000_000 + 123 (> 2^32)
            expect(ex[t].len_l()).toBe(1)
        }
    })
})
