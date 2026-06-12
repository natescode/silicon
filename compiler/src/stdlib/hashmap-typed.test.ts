// SPDX-License-Identifier: MIT
/**
 * M1 — typed HashMap (K, V) monomorph families, end-to-end through
 * instantiated wasm (host/linear-mem target, like hashmap.test.ts —
 * the HashMap substrate is linear-memory `alloc`, E0013 under wasm-gc):
 *
 *   (i32, f32)  — `hashmap_set_i32_f32` / `hashmap_get_i32_f32` on the
 *                 compact 12-byte slots (shares new/has/remove/resize/
 *                 cursor with the i32→i32 family);
 *   (i64, i64)  — the wide 24-byte-slot family with i64 probing,
 *                 resize, removal, and its own iteration cursor;
 *   (i32, i64)  — sign-extending wrappers over the wide family.
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
    // Like hashmap.test.ts, typecheck errors are not asserted: hashmap.si
    // carries two benign pre-existing diagnostics (Bool-vs-Int on the `has`
    // predicates, and the `^` tail of hashmap_hash typing as no-value) that
    // don't affect codegen.
    const { program: typed, functions } = typecheck(elaborated, registry)
    const bin = compileToWasm(typed, registry, functions)
    const mod = await WebAssembly.instantiate(bin, {
        env: { print: () => {}, read: () => 0 },
    })
    return mod.instance.exports as unknown as Exports
}

describe('M1: HashMap[i32 → f32] (compact family)', () => {
    test('set + get round-trip and overwrite', async () => {
        const ex = await compileAndRun({
            test_get: `{
                @mut h := hashmap_new(8);
                hashmap_set_i32_f32(h, 7, 1.5);
                hashmap_set_i32_f32(h, 9, 2.25);
                hashmap_get_i32_f32(h, 7) + hashmap_get_i32_f32(h, 9)
            }`,
            test_overwrite: `{
                @mut h := hashmap_new(8);
                hashmap_set_i32_f32(h, 7, 1.5);
                hashmap_set_i32_f32(h, 7, 9.75);
                hashmap_get_i32_f32(h, 7)
            }`,
            test_len: `{
                @mut h := hashmap_new(8);
                hashmap_set_i32_f32(h, 7, 1.5);
                hashmap_set_i32_f32(h, 7, 9.75);
                hashmap_set_i32_f32(h, 8, 0.5);
                hashmap_len(h)
            }`,
        })
        expect(ex.test_get()).toBe(3.75)        // 1.5 + 2.25
        expect(ex.test_overwrite()).toBe(9.75)
        expect(ex.test_len()).toBe(2)
    })

    test('f32 values survive resize (rehash copies raw bits)', async () => {
        const ex = await compileAndRun({
            // capacity 4 → resize triggers at occupancy 3; insert 6.
            test_resize: `{
                @mut h := hashmap_new(4);
                @mut k := 0;
                @loop(k < 6, {
                    hashmap_set_i32_f32(h, k, @toFloat(k) + 0.5);
                    k = k + 1;
                });
                hashmap_get_i32_f32(h, 0) + (hashmap_get_i32_f32(h, 5) + @toFloat(hashmap_capacity(h)))
            }`,
        })
        expect(ex.test_resize()).toBe(0.5 + 5.5 + 8)   // capacity grew 4 → 8
    })

    test('shared key machinery: has / remove work on an f32-valued map', async () => {
        const ex = await compileAndRun({
            test_has_remove: `{
                @mut h := hashmap_new(8);
                hashmap_set_i32_f32(h, 42, 3.5);
                had := hashmap_has_i32(h, 42);
                hashmap_remove_i32(h, 42);
                had + hashmap_has_i32(h, 42)
            }`,
        })
        expect(ex.test_has_remove()).toBe(1)   // 1 (before) + 0 (after)
    })

    test('compact cursor + iter_value_f32 sums the values', async () => {
        const ex = await compileAndRun({
            test_iter: `{
                @mut h := hashmap_new(8);
                hashmap_set_i32_f32(h, 1, 1.25);
                hashmap_set_i32_f32(h, 2, 2.25);
                hashmap_set_i32_f32(h, 3, 3.25);
                @mut sum := 0.0;
                @mut i := hashmap_iter_start(h);
                @loop(hashmap_iter_done(h, i) == 0, {
                    sum = sum + hashmap_iter_value_f32(h, i);
                    i = hashmap_iter_next(h, i);
                });
                sum
            }`,
        })
        expect(ex.test_iter()).toBe(6.75)
    })
})

describe('M1: HashMap[i64 → i64] (wide family)', () => {
    test('set + get round-trip with keys and values past 2^32', async () => {
        const ex = await compileAndRun({
            test_get: `{
                @mut h := hashmap_new_i64(8);
                hashmap_set_i64_i64(h, @i64(5000000007), @i64(6000000001));
                hashmap_set_i64_i64(h, @i64(11), @i64(22));
                hashmap_get_i64_i64(h, @i64(5000000007)) + hashmap_get_i64_i64(h, @i64(11))
            }`,
        })
        expect(ex.test_get()).toBe(6000000023n)
    })

    test('keys that differ only past bit 32 stay distinct (forced hash collision probes)', async () => {
        const ex = await compileAndRun({
            // hash_i64 folds hi ^ lo: key 7 → mix(7); key 2^32+6 → mix(6^1)=mix(7).
            // Same home slot, so the second insert must linear-probe, and both
            // entries must remain individually addressable.
            test_collide: `{
                @mut h := hashmap_new_i64(8);
                hashmap_set_i64_i64(h, @i64(7), @i64(100));
                hashmap_set_i64_i64(h, @i64(4294967302), @i64(200));
                first := hashmap_get_i64_i64(h, @i64(7));
                second := hashmap_get_i64_i64(h, @i64(4294967302));
                (first * @i64(1000)) + second
            }`,
            test_collide_len: `{
                @mut h := hashmap_new_i64(8);
                hashmap_set_i64_i64(h, @i64(7), @i64(100));
                hashmap_set_i64_i64(h, @i64(4294967302), @i64(200));
                hashmap_len(h)
            }`,
        })
        expect(ex.test_collide()).toBe(100200n)
        expect(ex.test_collide_len()).toBe(2)
    })

    test('wide slots survive resize', async () => {
        const ex = await compileAndRun({
            test_resize: `{
                @mut h := hashmap_new_i64(4);
                @mut k := 0;
                @loop(k < 6, {
                    hashmap_set_i64_i64(h, @i64(4000000000) + WASM::i64_extend_i32_s(k), @i64(7000000000) + WASM::i64_extend_i32_s(k));
                    k = k + 1;
                });
                hashmap_get_i64_i64(h, @i64(4000000005)) + WASM::i64_extend_i32_s(hashmap_capacity(h))
            }`,
        })
        expect(ex.test_resize()).toBe(7000000005n + 8n)
    })

    test('remove leaves a tombstone; entries past it stay reachable; reinsert works', async () => {
        const ex = await compileAndRun({
            // 7 and 2^32+6 share a home slot (see collision test); removing the
            // first must not orphan the second, and the key stays reinsertable.
            test_remove: `{
                @mut h := hashmap_new_i64(8);
                hashmap_set_i64_i64(h, @i64(7), @i64(100));
                hashmap_set_i64_i64(h, @i64(4294967302), @i64(200));
                hashmap_remove_i64(h, @i64(7));
                past := hashmap_get_i64_i64(h, @i64(4294967302));
                gone := WASM::i64_extend_i32_s(hashmap_has_i64(h, @i64(7)));
                hashmap_set_i64_i64(h, @i64(7), @i64(300));
                back := hashmap_get_i64_i64(h, @i64(7));
                ((past * @i64(1000)) + back) + (gone * @i64(1000000))
            }`,
        })
        expect(ex.test_remove()).toBe(200300n)   // past=200, back=300, gone=0
    })

    test('wide cursor iterates keys and values', async () => {
        const ex = await compileAndRun({
            test_iter: `{
                @mut h := hashmap_new_i64(8);
                hashmap_set_i64_i64(h, @i64(5000000001), @i64(1));
                hashmap_set_i64_i64(h, @i64(5000000002), @i64(2));
                hashmap_set_i64_i64(h, @i64(5000000003), @i64(3));
                @mut key_sum := @i64(0);
                @mut val_sum := @i64(0);
                @mut i := hashmap_iter_start_i64(h);
                @loop(hashmap_iter_done(h, i) == 0, {
                    key_sum = key_sum + hashmap_iter_key_i64(h, i);
                    val_sum = val_sum + hashmap_iter_value_i64(h, i);
                    i = hashmap_iter_next_i64(h, i);
                });
                key_sum + val_sum
            }`,
        })
        expect(ex.test_iter()).toBe(15000000006n + 6n)
    })
})

describe('M1: HashMap[i32 → i64] (wrappers over the wide family)', () => {
    test('set + get round-trip, value past 2^32', async () => {
        const ex = await compileAndRun({
            test_get: `{
                @mut h := hashmap_new_i64(8);
                hashmap_set_i32_i64(h, 7, @i64(9000000001));
                hashmap_get_i32_i64(h, 7)
            }`,
        })
        expect(ex.test_get()).toBe(9000000001n)
    })

    test('negative i32 keys sign-extend consistently across set/get/has/remove', async () => {
        const ex = await compileAndRun({
            test_negative: `{
                @mut h := hashmap_new_i64(8);
                hashmap_set_i32_i64(h, 0 - 5, @i64(55));
                v := hashmap_get_i32_i64(h, 0 - 5);
                had := hashmap_has_i32_i64(h, 0 - 5);
                hashmap_remove_i32_i64(h, 0 - 5);
                gone := hashmap_has_i32_i64(h, 0 - 5);
                v + WASM::i64_extend_i32_s((had * 100) + gone)
            }`,
        })
        expect(ex.test_negative()).toBe(155n)   // 55 + had*100, gone=0
    })
})
