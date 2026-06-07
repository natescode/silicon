// SPDX-License-Identifier: MIT
/**
 * Phase 5a-6 — stdlib HashMap[i32, i32] runtime tests.
 *
 * Compiles a Silicon program that bundles src/stdlib/hashmap.si and
 * exercises the open-addressing hash table end-to-end through
 * instantiated wasm.
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

const hashmapSrc = readFileSync(join(__dirname, 'hashmap.si'), 'utf-8')

interface Exports {
    memory: WebAssembly.Memory
    [name: string]: any
}

async function compileAndRun(testFns: Record<string, string>): Promise<Exports> {
    const userFns = Object.entries(testFns)
        .map(([name, body]) => `@fn ${name} := ${body};`)
        .join('\n')
    const userExports = Object.keys(testFns)
        .map(name => `@export ${name};`)
        .join('\n')
    const source = `${hashmapSrc}\n${userFns}\n${userExports}`

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

describe('Phase 5a-6: HashMap[i32→i32] runtime', () => {
    test('hashmap_new returns a header with len=0 and requested capacity', async () => {
        const ex = await compileAndRun({
            test_len:      `{ @mut h := hashmap_new(8); hashmap_len(h) }`,
            test_capacity: `{ @mut h := hashmap_new(8); hashmap_capacity(h) }`,
        })
        expect(ex.test_len()).toBe(0)
        expect(ex.test_capacity()).toBe(8)
    })

    test('set + get round-trip on a single key', async () => {
        const ex = await compileAndRun({
            test_get: `{
                @mut h := hashmap_new(8);
                hashmap_set_i32_i32(h, 42, 100);
                hashmap_get_i32_i32(h, 42)
            }`,
            test_len_after_set: `{
                @mut h := hashmap_new(8);
                hashmap_set_i32_i32(h, 42, 100);
                hashmap_len(h)
            }`,
        })
        expect(ex.test_get()).toBe(100)
        expect(ex.test_len_after_set()).toBe(1)
    })

    test('has returns 1 for present key, 0 for absent', async () => {
        const ex = await compileAndRun({
            test_has_present: `{
                @mut h := hashmap_new(8);
                hashmap_set_i32_i32(h, 42, 100);
                hashmap_has_i32(h, 42)
            }`,
            test_has_absent: `{
                @mut h := hashmap_new(8);
                hashmap_set_i32_i32(h, 42, 100);
                hashmap_has_i32(h, 99)
            }`,
        })
        expect(ex.test_has_present()).toBe(1)
        expect(ex.test_has_absent()).toBe(0)
    })

    test('multiple keys round-trip without collisions', async () => {
        const ex = await compileAndRun({
            test_multi: `{
                @mut h := hashmap_new(8);
                hashmap_set_i32_i32(h, 1, 10);
                hashmap_set_i32_i32(h, 2, 20);
                hashmap_set_i32_i32(h, 3, 30);
                hashmap_get_i32_i32(h, 1) + hashmap_get_i32_i32(h, 2) + hashmap_get_i32_i32(h, 3)
            }`,
            test_multi_len: `{
                @mut h := hashmap_new(8);
                hashmap_set_i32_i32(h, 1, 10);
                hashmap_set_i32_i32(h, 2, 20);
                hashmap_set_i32_i32(h, 3, 30);
                hashmap_len(h)
            }`,
        })
        expect(ex.test_multi()).toBe(60)
        expect(ex.test_multi_len()).toBe(3)
    })

    test('updating an existing key keeps len unchanged', async () => {
        const ex = await compileAndRun({
            test_update_val: `{
                @mut h := hashmap_new(8);
                hashmap_set_i32_i32(h, 42, 100);
                hashmap_set_i32_i32(h, 42, 200);
                hashmap_get_i32_i32(h, 42)
            }`,
            test_update_len: `{
                @mut h := hashmap_new(8);
                hashmap_set_i32_i32(h, 42, 100);
                hashmap_set_i32_i32(h, 42, 200);
                hashmap_len(h)
            }`,
        })
        expect(ex.test_update_val()).toBe(200)
        expect(ex.test_update_len()).toBe(1)
    })

    test('remove marks key as tombstone, has returns 0, len decrements', async () => {
        const ex = await compileAndRun({
            test_remove_returns_1: `{
                @mut h := hashmap_new(8);
                hashmap_set_i32_i32(h, 42, 100);
                hashmap_remove_i32(h, 42)
            }`,
            test_remove_has: `{
                @mut h := hashmap_new(8);
                hashmap_set_i32_i32(h, 42, 100);
                hashmap_remove_i32(h, 42);
                hashmap_has_i32(h, 42)
            }`,
            test_remove_len: `{
                @mut h := hashmap_new(8);
                hashmap_set_i32_i32(h, 42, 100);
                hashmap_remove_i32(h, 42);
                hashmap_len(h)
            }`,
            test_remove_absent: `{
                @mut h := hashmap_new(8);
                hashmap_set_i32_i32(h, 42, 100);
                hashmap_remove_i32(h, 99)
            }`,
        })
        expect(ex.test_remove_returns_1()).toBe(1)
        expect(ex.test_remove_has()).toBe(0)
        expect(ex.test_remove_len()).toBe(0)
        expect(ex.test_remove_absent()).toBe(0)
    })

    test('insert-then-remove-then-insert reuses tombstone slot', async () => {
        const ex = await compileAndRun({
            test_reuse: `{
                @mut h := hashmap_new(8);
                hashmap_set_i32_i32(h, 42, 100);
                hashmap_remove_i32(h, 42);
                hashmap_set_i32_i32(h, 42, 200);
                hashmap_get_i32_i32(h, 42)
            }`,
            test_reuse_len: `{
                @mut h := hashmap_new(8);
                hashmap_set_i32_i32(h, 42, 100);
                hashmap_remove_i32(h, 42);
                hashmap_set_i32_i32(h, 42, 200);
                hashmap_len(h)
            }`,
        })
        expect(ex.test_reuse()).toBe(200)
        expect(ex.test_reuse_len()).toBe(1)
    })

    test('resize triggers at 75% load and preserves all entries', async () => {
        // Initial capacity 4 → resize triggers when occupancy reaches 3
        // (since 3*4 >= 4*3 → 12 >= 12).  Push 6 entries to force at
        // least two resizes (4 → 8 → 16).  All values should survive.
        const ex = await compileAndRun({
            test_resize_sum: `{
                @mut h := hashmap_new(4);
                hashmap_set_i32_i32(h, 1, 100);
                hashmap_set_i32_i32(h, 2, 200);
                hashmap_set_i32_i32(h, 3, 300);
                hashmap_set_i32_i32(h, 4, 400);
                hashmap_set_i32_i32(h, 5, 500);
                hashmap_set_i32_i32(h, 6, 600);
                hashmap_get_i32_i32(h, 1) + hashmap_get_i32_i32(h, 2) + hashmap_get_i32_i32(h, 3) + hashmap_get_i32_i32(h, 4) + hashmap_get_i32_i32(h, 5) + hashmap_get_i32_i32(h, 6)
            }`,
            test_resize_len: `{
                @mut h := hashmap_new(4);
                hashmap_set_i32_i32(h, 1, 100);
                hashmap_set_i32_i32(h, 2, 200);
                hashmap_set_i32_i32(h, 3, 300);
                hashmap_set_i32_i32(h, 4, 400);
                hashmap_set_i32_i32(h, 5, 500);
                hashmap_set_i32_i32(h, 6, 600);
                hashmap_len(h)
            }`,
            test_resize_cap: `{
                @mut h := hashmap_new(4);
                hashmap_set_i32_i32(h, 1, 100);
                hashmap_set_i32_i32(h, 2, 200);
                hashmap_set_i32_i32(h, 3, 300);
                hashmap_set_i32_i32(h, 4, 400);
                hashmap_set_i32_i32(h, 5, 500);
                hashmap_set_i32_i32(h, 6, 600);
                hashmap_capacity(h)
            }`,
        })
        expect(ex.test_resize_sum()).toBe(2100)  // 100+200+300+400+500+600
        expect(ex.test_resize_len()).toBe(6)
        expect(ex.test_resize_cap()).toBeGreaterThan(4)
    })

    test('header pointer is stable across resize', async () => {
        const ex = await compileAndRun({
            test_stable: `{
                @mut h := hashmap_new(4);
                @mut before := h;
                hashmap_set_i32_i32(h, 1, 100);
                hashmap_set_i32_i32(h, 2, 200);
                hashmap_set_i32_i32(h, 3, 300);
                hashmap_set_i32_i32(h, 4, 400);
                hashmap_set_i32_i32(h, 5, 500);
                h - before
            }`,
        })
        expect(ex.test_stable()).toBe(0)
    })
})
