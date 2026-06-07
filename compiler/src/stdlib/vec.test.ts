// SPDX-License-Identifier: MIT
/**
 * Phase 5a-4 — stdlib Vec[T] runtime tests.
 *
 * Compiles a Silicon program that @use's src/stdlib/vec.si, instantiates
 * the WASM module, and exercises vec_new / vec_push_i32 / vec_get_i32 /
 * vec_set_i32 / vec_pop_i32 / vec_len / vec_capacity end-to-end —
 * including the grow path that triggers a realloc when capacity is
 * exhausted.
 */

import { test, expect, describe } from 'bun:test'
import { join } from 'path'
import { readFileSync } from 'fs'
import { compileToWasm } from '../codegen/index'
import siliconGrammar from '../grammar/SiliconGrammar'
import parse from '../parser'
import { addToAstSemantics } from '../ast/index'
import { buildStrataRegistry, elaborate } from '../elaborator/index'
import { typecheck } from '../types/index'
import type { Program } from '../ast/astNodes'

const vecSrc = readFileSync(join(__dirname, 'vec.si'), 'utf-8')

interface Exports {
    memory: WebAssembly.Memory
    [name: string]: any
}

/** Compile a Silicon source string + the vec.si stdlib, instantiate
 *  the resulting WASM, and return the exports.  User-defined @fns
 *  named `test_*` are auto-exported by appending `@export name;` lines. */
async function compileAndRun(testFns: Record<string, string>): Promise<Exports> {
    const userFns = Object.entries(testFns)
        .map(([name, body]) => `@fn ${name} := ${body};`)
        .join('\n')
    const userExports = Object.keys(testFns)
        .map(name => `@export ${name};`)
        .join('\n')
    const source = `${vecSrc}\n${userFns}\n${userExports}`

    const match = parse(source)
    const ast = addToAstSemantics(siliconGrammar)(match).toAst() as Program
    const registry = buildStrataRegistry(ast)
    const { program: elaborated } = elaborate(ast, registry)
    const { program: typed, functions } = typecheck(elaborated, registry)
    const bin = compileToWasm(typed, registry, functions)
    const mod = await WebAssembly.instantiate(bin, {
        env: { print: () => {}, read: () => 0 },
    })
    return mod.instance.exports as unknown as Exports
}

describe('Phase 5a-4: Vec[i32] runtime', () => {
    test('vec_new returns a header with len=0 and the requested capacity', async () => {
        const ex = await compileAndRun({
            test_len:      `{ @mut v := vec_new(4); vec_len(v) }`,
            test_capacity: `{ @mut v := vec_new(4); vec_capacity(v) }`,
        })
        expect(ex.test_len()).toBe(0)
        expect(ex.test_capacity()).toBe(4)
    })

    test('vec_push_i32 + vec_get_i32 round-trip below capacity', async () => {
        const ex = await compileAndRun({
            test_push_get: `{
                @mut v := vec_new(4);
                vec_push_i32(v, 10);
                vec_push_i32(v, 20);
                vec_push_i32(v, 30);
                vec_get_i32(v, 0) + vec_get_i32(v, 1) + vec_get_i32(v, 2)
            }`,
            test_len_after_3: `{
                @mut v := vec_new(4);
                vec_push_i32(v, 10);
                vec_push_i32(v, 20);
                vec_push_i32(v, 30);
                vec_len(v)
            }`,
        })
        expect(ex.test_push_get()).toBe(60)
        expect(ex.test_len_after_3()).toBe(3)
    })

    test('vec_push_i32 grows the backing buffer when capacity is reached', async () => {
        // Initial capacity 2; push 5 elements to force 2 grow cycles
        // (2 → 4 → 8).  Contents should be preserved across both
        // reallocs.
        const ex = await compileAndRun({
            test_grow_sum: `{
                @mut v := vec_new(2);
                vec_push_i32(v, 1);
                vec_push_i32(v, 2);
                vec_push_i32(v, 3);
                vec_push_i32(v, 4);
                vec_push_i32(v, 5);
                vec_get_i32(v, 0) + vec_get_i32(v, 1) + vec_get_i32(v, 2) + vec_get_i32(v, 3) + vec_get_i32(v, 4)
            }`,
            test_grow_cap: `{
                @mut v := vec_new(2);
                vec_push_i32(v, 1);
                vec_push_i32(v, 2);
                vec_push_i32(v, 3);
                vec_push_i32(v, 4);
                vec_push_i32(v, 5);
                vec_capacity(v)
            }`,
            test_grow_len: `{
                @mut v := vec_new(2);
                vec_push_i32(v, 1);
                vec_push_i32(v, 2);
                vec_push_i32(v, 3);
                vec_push_i32(v, 4);
                vec_push_i32(v, 5);
                vec_len(v)
            }`,
        })
        expect(ex.test_grow_sum()).toBe(15)
        expect(ex.test_grow_cap()).toBe(8)  // 2 → 4 → 8
        expect(ex.test_grow_len()).toBe(5)
    })

    test('vec_set_i32 mutates in place', async () => {
        const ex = await compileAndRun({
            test_set: `{
                @mut v := vec_new(4);
                vec_push_i32(v, 10);
                vec_push_i32(v, 20);
                vec_set_i32(v, 0, 99);
                vec_get_i32(v, 0) + vec_get_i32(v, 1)
            }`,
        })
        expect(ex.test_set()).toBe(119)  // 99 + 20
    })

    test('vec_pop_i32 returns the last element and decrements len', async () => {
        const ex = await compileAndRun({
            test_pop_val: `{
                @mut v := vec_new(4);
                vec_push_i32(v, 10);
                vec_push_i32(v, 20);
                vec_push_i32(v, 30);
                vec_pop_i32(v)
            }`,
            test_pop_len: `{
                @mut v := vec_new(4);
                vec_push_i32(v, 10);
                vec_push_i32(v, 20);
                vec_push_i32(v, 30);
                vec_pop_i32(v);
                vec_len(v)
            }`,
            test_pop_twice: `{
                @mut v := vec_new(4);
                vec_push_i32(v, 10);
                vec_push_i32(v, 20);
                vec_push_i32(v, 30);
                @mut a := vec_pop_i32(v);
                @mut b := vec_pop_i32(v);
                a + b
            }`,
        })
        expect(ex.test_pop_val()).toBe(30)
        expect(ex.test_pop_len()).toBe(2)
        expect(ex.test_pop_twice()).toBe(50)
    })

    test('header pointer is stable across grow (caller does not rebind)', async () => {
        // Push enough elements to trigger grow, then verify the Vec
        // value `v` (header pointer) is unchanged.
        const ex = await compileAndRun({
            test_stable_header: `{
                @mut v := vec_new(2);
                @mut before := v;
                vec_push_i32(v, 1);
                vec_push_i32(v, 2);
                vec_push_i32(v, 3);
                vec_push_i32(v, 4);
                vec_push_i32(v, 5);
                v - before
            }`,
        })
        expect(ex.test_stable_header()).toBe(0)
    })
})
