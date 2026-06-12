// SPDX-License-Identifier: MIT
/**
 * First-class-ish arrays — the `array::get` / `array::set` / `array::len`
 * accessor surface over `$[…]` literals, `Array[T]` params/returns, and
 * iterate-`@loop` over an Array subject (ADR 0016 retarget).
 *
 * The accessors are always available (no `@use` — a `$[…]` literal needs
 * none, so its accessors must not either): the typechecker retargets the
 * qualified names at the std.wat/prelude `arr_*` helpers, picking the f32
 * family for `Array[Float]`.  Arrays are length-prefixed linear-memory
 * pointers on every current target, so parity is asserted across host
 * (wasm-mvp) and wasm-gc.
 */

import { test, expect, describe } from 'bun:test'
import { resolve } from 'node:path'
import parse from '../parser'
import { buildStrataRegistry, elaborate } from '../elaborator/index'
import { typecheck } from '../types/index'
import { compileToWasm } from '../codegen'
import { resolveUses } from '../modules/useResolver'

interface Exports { [name: string]: any; memory: WebAssembly.Memory }

const ENTRY_PATH = resolve(__dirname, '../../entry.si')

async function compileRun(src: string, target: 'host' | 'wasm-gc'): Promise<Exports> {
    const { source: resolved } = resolveUses(src, ENTRY_PATH, { target })
    const ast = parse(resolved) as any
    const registry = buildStrataRegistry(ast)
    const { program: elab, errors: elabErrs } = elaborate(ast, registry)
    if (elabErrs.length) throw new Error(`elab: ${elabErrs.map(e => e.message).join('; ')}`)
    const tc = typecheck(elab, registry, undefined, target)
    if (tc.errors.length) throw new Error(`typecheck [${target}]: ${tc.errors.map((e: any) => e.message ?? e.kind).join('; ')}`)
    const bin = compileToWasm(tc.program, registry, tc.functions, undefined, { target })
    const mod = await WebAssembly.instantiate(bin, { env: { print: () => {}, read: () => 0 } })
    return mod.instance.exports as unknown as Exports
}

/** Compile + run on BOTH targets; assert both return `expected`. */
async function assertParity(src: string, fn: string, expected: number): Promise<void> {
    expect((await compileRun(src, 'host'))[fn]()).toBe(expected)
    expect((await compileRun(src, 'wasm-gc'))[fn]()).toBe(expected)
}

/** Parse + elaborate + typecheck only; return the typecheck error messages joined. */
function typecheckErrors(src: string): string {
    const { source: resolved } = resolveUses(src, ENTRY_PATH, { target: 'host' })
    const ast = parse(resolved) as any
    const registry = buildStrataRegistry(ast)
    const { program: elab } = elaborate(ast, registry)
    const tc = typecheck(elab, registry, undefined, 'host')
    return tc.errors.map((e: any) => e.message ?? e.kind).join(' | ')
}

// ─────────────────────────────────────────────────────────────────────────
// array::len / array::get / array::set on Int arrays
// ─────────────────────────────────────────────────────────────────────────

describe('array accessors: Int elements', () => {
    test('array::len reads the length prefix', async () => {
        await assertParity(`
            \\\\ run Int
            @fn run := {
                xs := $[10, 20, 30];
                array::len(xs)
            };
            @export run;`, 'run', 3)
    })

    test('array::get reads the Nth element', async () => {
        await assertParity(`
            \\\\ run Int
            @fn run := {
                xs := $[10, 20, 30];
                array::get(xs, 0) + array::get(xs, 2)
            };
            @export run;`, 'run', 40)
    })

    test('array::set writes through (round trip)', async () => {
        await assertParity(`
            \\\\ run Int
            @fn run := {
                xs := $[1, 2, 3];
                array::set(xs, 1, 42);
                array::get(xs, 1)
            };
            @export run;`, 'run', 42)
    })

    test('empty array literal has length 0', async () => {
        await assertParity(`
            \\\\ run Int
            @fn run := {
                xs := $[];
                array::len(xs)
            };
            @export run;`, 'run', 0)
    })
})

// ─────────────────────────────────────────────────────────────────────────
// Array[Float] — element type drives accessor dispatch (f32 family)
// ─────────────────────────────────────────────────────────────────────────

describe('array accessors: Float elements', () => {
    test('array::get on Array[Float] returns Float', async () => {
        await assertParity(`
            \\\\ run Float
            @fn run := {
                xs := $[1.5, 2.5];
                array::get(xs, 0) + array::get(xs, 1)
            };
            @export run;`, 'run', 4)
    })

    test('array::set on Array[Float] takes a Float value', async () => {
        await assertParity(`
            \\\\ run Float
            @fn run := {
                xs := $[1.5, 2.5];
                array::set(xs, 0, 7.25);
                array::get(xs, 0)
            };
            @export run;`, 'run', 7.25)
    })
})

// ─────────────────────────────────────────────────────────────────────────
// Array[T] params and returns (annotated signatures)
// ─────────────────────────────────────────────────────────────────────────

describe('Array[T] params and returns', () => {
    test('Array[Int] as an annotated parameter', async () => {
        await assertParity(`
            \\\\ sum_arr (Array[Int]) -> Int
            @fn sum_arr xs := {
                @mut total := 0;
                @loop(v, xs, {
                    total = total + v
                });
                total
            };
            \\\\ run Int
            @fn run := sum_arr($[5, 6, 7]);
            @export run;`, 'run', 18)
    })

    test('Array[Int] as an annotated return type', async () => {
        await assertParity(`
            \\\\ make Array[Int]
            @fn make := $[7, 8, 9];
            \\\\ run Int
            @fn run := array::get(make(), 2);
            @export run;`, 'run', 9)
    })
})

// ─────────────────────────────────────────────────────────────────────────
// Iterate-@loop over an Array subject (ADR 0016 retarget)
// ─────────────────────────────────────────────────────────────────────────

describe('@loop over Array[T]', () => {
    test('arity-1 binder iterates elements (Int)', async () => {
        await assertParity(`
            \\\\ run Int
            @fn run := {
                @mut total := 0;
                @loop(v, $[2, 4, 6], {
                    total = total + v
                });
                total
            };
            @export run;`, 'run', 12)
    })

    test('arity-2 binds position then element', async () => {
        await assertParity(`
            \\\\ run Int
            @fn run := {
                @mut acc := 0;
                @loop(i, v, $[3, 5, 7], {
                    acc = acc + (i * v)
                });
                acc
            };
            @export run;`, 'run', 19)   // 0*3 + 1*5 + 2*7
    })

    test('Array[Float] subject types the binder as Float', async () => {
        await assertParity(`
            \\\\ run Float
            @fn run := {
                @mut total := 0.0;
                @loop(v, $[1.5, 2.25], {
                    total = total + v
                });
                total
            };
            @export run;`, 'run', 3.75)
    })
})

// ─────────────────────────────────────────────────────────────────────────
// Rejections
// ─────────────────────────────────────────────────────────────────────────

describe('array rejections', () => {
    test('8-byte elements are rejected (4-byte slot layout in v1.0)', () => {
        const errs = typecheckErrors(`
            \\\\ run Int
            @fn run := {
                xs := $[@i64(1), @i64(2)];
                array::len(xs)
            };
            @export run;`)
        expect(errs).toContain('4-byte elements')
    })
})
