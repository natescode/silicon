// SPDX-License-Identifier: MIT
/**
 * Phase 5a-5 + 5d-4 — Vec.map proof.
 *
 * The capstone test for Workstream B: a Silicon-side stdlib helper
 * (`vec_map_i32_i32`) accepts a first-class function value (an i32
 * obtained via `&@fnref name`), iterates over the source Vec,
 * dispatches to the callback via `&@call_indirect cb, x`, and pushes
 * the results into a new Vec.  Confirms the entire chain works
 * end-to-end:
 *
 *   funcref table populated → @fnref returns slot index → @call_indirect
 *   dispatches through the WASM funcref table → callback returns → Vec
 *   collects results.
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

async function compileAndRun(testFns: Record<string, string>, extra = ''): Promise<Exports> {
    const userFns = Object.entries(testFns)
        .map(([name, body]) => `@fn ${name}:Int := ${body};`)
        .join('\n')
    const userExports = Object.keys(testFns)
        .map(name => `@export ${name};`)
        .join('\n')
    const source = `${vecSrc}\n${extra}\n${userFns}\n${userExports}`

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

describe('Phase 5a-5 + 5d-4: Vec.map proof', () => {
    test('vec_map_i32_i32 applies the callback to each element', async () => {
        const ex = await compileAndRun({
            test_double_sum: `{
                @local v:Int := &vec_new 4;
                &vec_push_i32 v, 1;
                &vec_push_i32 v, 2;
                &vec_push_i32 v, 3;
                @local doubled:Int := &vec_map_i32_i32 v, (&@fnref double);
                (&vec_get_i32 doubled, 0) + (&vec_get_i32 doubled, 1) + (&vec_get_i32 doubled, 2)
            }`,
        }, `@fn double:Int x:Int := x * 2;`)
        expect(ex.test_double_sum()).toBe(12)  // 2 + 4 + 6
    })

    test('vec_map_i32_i32 preserves length', async () => {
        const ex = await compileAndRun({
            test_len: `{
                @local v:Int := &vec_new 4;
                &vec_push_i32 v, 10;
                &vec_push_i32 v, 20;
                &vec_push_i32 v, 30;
                @local out:Int := &vec_map_i32_i32 v, (&@fnref identity);
                &vec_len out
            }`,
        }, `@fn identity:Int x:Int := x;`)
        expect(ex.test_len()).toBe(3)
    })

    test('vec_map_i32_i32 returns a new Vec (source unchanged)', async () => {
        const ex = await compileAndRun({
            test_source_unchanged: `{
                @local v:Int := &vec_new 4;
                &vec_push_i32 v, 5;
                &vec_push_i32 v, 6;
                &vec_map_i32_i32 v, (&@fnref add_one);
                (&vec_get_i32 v, 0) + (&vec_get_i32 v, 1)
            }`,
        }, `@fn add_one:Int x:Int := x + 1;`)
        expect(ex.test_source_unchanged()).toBe(11)  // 5 + 6 — not 6 + 7
    })

    test('different callbacks can be passed to map without recompiling', async () => {
        // Same Vec, two different mappings.  Proves the funcref dispatch
        // is data-driven (the table index), not codegen-fixed.
        const ex = await compileAndRun({
            test_two_maps: `{
                @local v:Int := &vec_new 4;
                &vec_push_i32 v, 10;
                &vec_push_i32 v, 20;
                @local doubled:Int := &vec_map_i32_i32 v, (&@fnref double);
                @local incremented:Int := &vec_map_i32_i32 v, (&@fnref add_one);
                (&vec_get_i32 doubled, 0) + (&vec_get_i32 doubled, 1)
                + (&vec_get_i32 incremented, 0) + (&vec_get_i32 incremented, 1)
            }`,
        }, `@fn double:Int x:Int := x * 2;
            @fn add_one:Int x:Int := x + 1;`)
        // 20 + 40 + 11 + 21 = 92
        expect(ex.test_two_maps()).toBe(92)
    })

    test('vec_map_i32_i32 of an empty Vec returns an empty Vec', async () => {
        const ex = await compileAndRun({
            test_empty: `{
                @local v:Int := &vec_new 4;
                @local mapped:Int := &vec_map_i32_i32 v, (&@fnref add_one);
                &vec_len mapped
            }`,
        }, `@fn add_one:Int x:Int := x + 1;`)
        expect(ex.test_empty()).toBe(0)
    })
})
