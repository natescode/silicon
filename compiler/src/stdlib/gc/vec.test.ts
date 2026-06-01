// SPDX-License-Identifier: MIT
/**
 * Phase 9d-8 — Vec[Int] under --target=wasm-gc end-to-end test suite.
 *
 * Mirrors `src/stdlib/vec.test.ts` (the mvp suite).  Programs use the
 * same `&vec_new`, `&vec_push_i32`, `&vec_get_i32`, `&vec_len`,
 * `&vec_capacity`, `&vec_pop_i32` call surface; the only thing that
 * changes is `--target=wasm-gc`.  Under that flag the resolver
 * redirects to the stub `src/stdlib/gc/vec.si`; the compiler injects
 * the gc Vec functions via `src/codegen/gc-vec.ts`; the typechecker
 * registers the signatures using the new `Vec[Int]` surface type.
 *
 * Each test compiles a small program, validates it under
 * `WebAssembly.compile`, instantiates it, and asserts the exported
 * function returns the expected value.
 */

import { test, expect, describe } from 'bun:test'
import parse from '../../parser'
import addToAstSemantics from '../../ast/toAst'
import siliconGrammar from '../../grammar/SiliconGrammar'
import { buildStrataRegistry, elaborate } from '../../elaborator/index'
import { typecheck } from '../../types/index'
import { compileToWasm } from '../../codegen'

interface Exports { [name: string]: any; memory: WebAssembly.Memory }

async function compileGcRun(src: string): Promise<Exports> {
    const ast = addToAstSemantics(siliconGrammar)(parse(src)).toAst() as any
    const registry = buildStrataRegistry(ast)
    const { program: elab } = elaborate(ast, registry)
    const tc = typecheck(elab, registry, undefined, 'wasm-gc')
    if (tc.errors.length) {
        const msg = tc.errors.map(e => e.message ?? e.kind).join('; ')
        throw new Error(`typecheck: ${msg}`)
    }
    const bin = compileToWasm(tc.program, registry, tc.functions, undefined, { target: 'wasm-gc' })
    const mod = await WebAssembly.instantiate(bin, {
        env: { print: () => {}, read: () => 0 },
    })
    return mod.instance.exports as unknown as Exports
}

describe('Phase 9d-8: Vec[Int] under wasm-gc — core API', () => {

    test('vec_new + vec_len: fresh vec has length 0', async () => {
        const ex = await compileGcRun(`
            \\\\ test () -> Int
            @fn test  := { @local v := &@as Vec[Int], &vec_new 4; &vec_len v };
            @export test;
        `)
        expect(ex.test()).toBe(0)
    })

    test('vec_new + vec_capacity: initial capacity matches request', async () => {
        const ex = await compileGcRun(`
            \\\\ test () -> Int
            @fn test  := { @local v := &@as Vec[Int], &vec_new 8; &vec_capacity v };
            @export test;
        `)
        expect(ex.test()).toBe(8)
    })

    test('vec_push_i32 then vec_len: length goes up by one', async () => {
        const ex = await compileGcRun(`
            \\\\ test () -> Int
            @fn test  := {
                @local v := &@as Vec[Int], &vec_new 4;
                &vec_push_i32 v, 42;
                &vec_len v
            };
            @export test;
        `)
        expect(ex.test()).toBe(1)
    })

    test('vec_get_i32 returns the stored value', async () => {
        const ex = await compileGcRun(`
            \\\\ test () -> Int
            @fn test  := {
                @local v := &@as Vec[Int], &vec_new 4;
                &vec_push_i32 v, 100;
                &vec_push_i32 v, 200;
                &vec_push_i32 v, 300;
                &vec_get_i32 v, 1
            };
            @export test;
        `)
        expect(ex.test()).toBe(200)
    })

    test('vec_set_i32 overwrites the element', async () => {
        const ex = await compileGcRun(`
            \\\\ test () -> Int
            @fn test  := {
                @local v := &@as Vec[Int], &vec_new 4;
                &vec_push_i32 v, 10;
                &vec_push_i32 v, 20;
                &vec_set_i32 v, 0, 99;
                &vec_get_i32 v, 0
            };
            @export test;
        `)
        expect(ex.test()).toBe(99)
    })

    test('vec_pop_i32 returns the last element and shrinks len', async () => {
        const ex = await compileGcRun(`
            \\\\ pop_value () -> Int
            @fn pop_value  := {
                @local v := &@as Vec[Int], &vec_new 4;
                &vec_push_i32 v, 7;
                &vec_push_i32 v, 13;
                &vec_pop_i32 v
            };
            \\\\ len_after_pop () -> Int
            @fn len_after_pop  := {
                @local v := &@as Vec[Int], &vec_new 4;
                &vec_push_i32 v, 7;
                &vec_push_i32 v, 13;
                &vec_pop_i32 v;
                &vec_len v
            };
            @export pop_value;
            @export len_after_pop;
        `)
        expect(ex.pop_value()).toBe(13)
        expect(ex.len_after_pop()).toBe(1)
    })
})

describe('Phase 9d-8: Vec[Int] grow path (capacity exceeded)', () => {

    test('pushing past initial capacity triggers grow + values survive', async () => {
        const ex = await compileGcRun(`
            \\\\ test () -> Int
            @fn test  := {
                @local v := &@as Vec[Int], &vec_new 2;
                &vec_push_i32 v, 10;
                &vec_push_i32 v, 20;
                # capacity is 2 here — next push grows.
                &vec_push_i32 v, 30;
                &vec_push_i32 v, 40;
                &vec_get_i32 v, 0
            };
            @export test;
        `)
        expect(ex.test()).toBe(10)
    })

    test('grow from cap=0 expands to default size and preserves elements', async () => {
        const ex = await compileGcRun(`
            \\\\ len_test () -> Int
            @fn len_test  := {
                @local v := &@as Vec[Int], &vec_new 0;
                &vec_push_i32 v, 1;
                &vec_push_i32 v, 2;
                &vec_push_i32 v, 3;
                &vec_len v
            };
            \\\\ val_test () -> Int
            @fn val_test  := {
                @local v := &@as Vec[Int], &vec_new 0;
                &vec_push_i32 v, 1;
                &vec_push_i32 v, 2;
                &vec_push_i32 v, 3;
                &vec_get_i32 v, 2
            };
            @export len_test;
            @export val_test;
        `)
        expect(ex.len_test()).toBe(3)
        expect(ex.val_test()).toBe(3)
    })

    test('capacity reflects post-grow array size', async () => {
        const ex = await compileGcRun(`
            \\\\ test () -> Int
            @fn test  := {
                @local v := &@as Vec[Int], &vec_new 2;
                # Force a grow.
                &vec_push_i32 v, 1;
                &vec_push_i32 v, 2;
                &vec_push_i32 v, 3;
                &vec_capacity v
            };
            @export test;
        `)
        // cap doubled: 2 → 4.
        expect(ex.test()).toBe(4)
    })
})

describe('Phase 9d-8: Vec[Int] via function boundaries', () => {

    test('passing Vec[Int] across @fn boundaries works (refParams encoding)', async () => {
        // `consumer v:Vec[Int]` receives the vec as (ref $Vec_i32);
        // the typechecker treats v as Vec[Int] at the Sigil level;
        // injectRefSlots upgrades the param to ref-typed at binary emit.
        const ex = await compileGcRun(`
            \\\\ consumer (Vec[Int])
            @fn consumer v := &vec_get_i32 v, 0;
            \\\\ test () -> Int
            @fn test  := {
                @local v := &@as Vec[Int], &vec_new 2;
                &vec_push_i32 v, 777;
                &consumer v
            };
            @export test;
        `)
        expect(ex.test()).toBe(777)
    })

    test('returning Vec[Int] from a function works (refResult encoding)', async () => {
        const ex = await compileGcRun(`
            \\\\ make_pair () -> Vec[Int]
            @fn make_pair  := {
                @local v := &@as Vec[Int], &vec_new 2;
                &vec_push_i32 v, 11;
                &vec_push_i32 v, 22;
                v
            };
            \\\\ test () -> Int
            @fn test  := &vec_get_i32 (&make_pair), 1;
            @export test;
        `)
        expect(ex.test()).toBe(22)
    })
})
