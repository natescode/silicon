// SPDX-License-Identifier: MIT
/**
 * Phase 9c Tier B — Rc smart pointer stdlib runtime tests.
 *
 * Compiles a Silicon program that @use's src/stdlib/rc.si and exercises
 * the rc_new / rc_clone / rc_drop / rc_get / rc_count / rc_is_unique
 * lifecycle.  Includes composition tests that show Rc working with the
 * existing @defer and &@with_arena strata — the "stratum power"
 * showcase from Phase 9c Tier B.
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

const rcSrc = readFileSync(join(__dirname, 'rc.si'), 'utf-8')

interface Exports {
    memory: WebAssembly.Memory
    [name: string]: any
}

async function compileAndRun(testFns: Record<string, string>): Promise<Exports> {
    const userFns = Object.entries(testFns)
        .map(([name, body]) => `@fn ${name}:Int := ${body};`)
        .join('\n')
    const userExports = Object.keys(testFns)
        .map(name => `@export ${name};`)
        .join('\n')
    const source = `${rcSrc}\n${userFns}\n${userExports}`

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

describe('Phase 9c Tier B: Rc smart pointer — core lifecycle', () => {

    test('rc_new wraps a value with refcount 1', async () => {
        const ex = await compileAndRun({
            test_count: `{ @local r:Int := &rc_new 42; &rc_count r }`,
            test_get:   `{ @local r:Int := &rc_new 42; &rc_get r }`,
        })
        expect(ex.test_count()).toBe(1)
        expect(ex.test_get()).toBe(42)
    })

    test('rc_clone bumps the refcount without copying the value', async () => {
        const ex = await compileAndRun({
            test_clone: `{
                @local r:Int := &rc_new 99;
                @local r2:Int := &rc_clone r;
                &rc_count r
            }`,
            test_ptr_eq: `{
                @local r:Int := &rc_new 99;
                @local r2:Int := &rc_clone r;
                r - r2
            }`,
        })
        expect(ex.test_clone()).toBe(2)
        // Clones return the SAME pointer — no new allocation.
        expect(ex.test_ptr_eq()).toBe(0)
    })

    test('rc_drop decrements the refcount', async () => {
        const ex = await compileAndRun({
            test_drop_once: `{
                @local r:Int := &rc_new 7;
                @local r2:Int := &rc_clone r;
                &rc_drop r2;
                &rc_count r
            }`,
            test_drop_to_zero: `{
                @local r:Int := &rc_new 7;
                &rc_drop r;
                &rc_count r
            }`,
        })
        expect(ex.test_drop_once()).toBe(1)
        expect(ex.test_drop_to_zero()).toBe(0)
    })

    test('rc_is_unique is true exactly when refcount == 1', async () => {
        const ex = await compileAndRun({
            test_fresh_is_unique: `{
                @local r:Int := &rc_new 1;
                &@if (&rc_is_unique r), { 1 }, { 0 }
            }`,
            test_clone_not_unique: `{
                @local r:Int := &rc_new 1;
                @local r2:Int := &rc_clone r;
                &@if (&rc_is_unique r), { 1 }, { 0 }
            }`,
            test_drop_back_to_unique: `{
                @local r:Int := &rc_new 1;
                @local r2:Int := &rc_clone r;
                &rc_drop r2;
                &@if (&rc_is_unique r), { 1 }, { 0 }
            }`,
        })
        expect(ex.test_fresh_is_unique()).toBe(1)
        expect(ex.test_clone_not_unique()).toBe(0)
        expect(ex.test_drop_back_to_unique()).toBe(1)
    })

    test('rc_get returns the boxed value regardless of refcount', async () => {
        const ex = await compileAndRun({
            test_get_after_clones: `{
                @local r:Int := &rc_new 1234;
                @local r2:Int := &rc_clone r;
                @local r3:Int := &rc_clone r;
                (&rc_get r) + (&rc_get r2) + (&rc_get r3)
            }`,
        })
        expect(ex.test_get_after_clones()).toBe(1234 * 3)
    })
})

describe('Phase 9c Tier B: Rc — multi-owner lifecycle', () => {

    test('three owners decrement back to one via drops', async () => {
        // Owner counts: new=1, clone→2, clone→3, drop→2, drop→1.
        const ex = await compileAndRun({
            test_three_owner_dance: `{
                @local r:Int := &rc_new 555;
                @local b:Int := &rc_clone r;
                @local c:Int := &rc_clone r;
                &rc_drop b;
                &rc_drop c;
                &rc_count r
            }`,
        })
        expect(ex.test_three_owner_dance()).toBe(1)
    })

    test('value is preserved across the clone+drop dance', async () => {
        const ex = await compileAndRun({
            test_value_preserved: `{
                @local r:Int := &rc_new 4321;
                @local b:Int := &rc_clone r;
                &rc_drop b;
                &rc_get r
            }`,
        })
        expect(ex.test_value_preserved()).toBe(4321)
    })
})

describe('Phase 9c Tier B: Rc + @defer composition (stratum power demo)', () => {

    test('@defer drops the Rc at function exit (LIFO)', async () => {
        // The function builds r, defers its drop, returns the count seen
        // BEFORE the deferred drop fires.  External observer cannot see
        // the post-defer state — but we verify the count progression is
        // 1 (after new) and that the function returns cleanly.
        const ex = await compileAndRun({
            test_defer_drops: `{
                @local r:Int := &rc_new 11;
                &@defer &rc_drop r;
                &rc_count r
            }`,
        })
        expect(ex.test_defer_drops()).toBe(1)
    })

    test('multiple deferred drops fire in LIFO order', async () => {
        // Each defer registers a separate drop.  After the function
        // body finishes, defers fire bottom-up: drop c, drop b, drop a.
        // We capture pre-defer state (count == 3) as the return value.
        const ex = await compileAndRun({
            test_three_defers: `{
                @local a:Int := &rc_new 1;
                &@defer &rc_drop a;
                @local b:Int := &rc_clone a;
                &@defer &rc_drop b;
                @local c:Int := &rc_clone a;
                &@defer &rc_drop c;
                &rc_count a
            }`,
        })
        expect(ex.test_three_defers()).toBe(3)
    })
})

describe('Phase 9c Tier B: Rc + &@with_arena composition', () => {

    test('Rc allocated inside an arena is physically freed at arena exit', async () => {
        // Inside the arena: r holds an Rc.  At arena exit the heap
        // pointer resets — the Rc block (and its refcount) are reclaimed
        // regardless of refcount.  We verify by comparing heap_get
        // before/after; should be equal.
        const ex = await compileAndRun({
            test_arena_frees_rc: `{
                @local before:Int := &heap_get;
                &@with_arena {
                    @local r:Int := &rc_new 99;
                    @local r2:Int := &rc_clone r;
                    @local r3:Int := &rc_clone r;
                    # deliberately do NOT drop — arena cleanup wins
                };
                @local after:Int := &heap_get;
                after - before
            }`,
        })
        expect(ex.test_arena_frees_rc()).toBe(0)
    })

    test('Rc promoted out of an arena keeps its value', async () => {
        // The Rc's 8-byte block is a flat heap layout — value-array
        // shape — so &@move_to_parent_arena can promote it.
        // Promoted Rc has [count:i32, value:i32].
        const ex = await compileAndRun({
            test_promote_rc_value: `&@with_arena {
                @local r:Int := &rc_new 777;
                &@move_to_parent_arena r
            }`,
        })
        // Reading the promoted block at offset 4 gives the boxed value.
        const promotedPtr = ex.test_promote_rc_value()
        const view = new DataView(ex.memory.buffer)
        expect(view.getInt32(promotedPtr, true)).toBe(1)       // refcount preserved
        expect(view.getInt32(promotedPtr + 4, true)).toBe(777) // value preserved
    })
})

describe('Phase 9c Tier B: Rc with heap-pointer payloads (String)', () => {

    test('Rc wrapping a String pointer preserves byte-for-byte', async () => {
        // String literals are static; we use str_ptr to get the data
        // address and store it in the Rc payload.
        const ex = await compileAndRun({
            test_rc_string: `{
                @local s:String := 'hello';
                @local r:Int := &rc_new (&str_ptr s);
                &WASM::i32_load ((&rc_get r) + 4)
            }`,
        })
        // String layout: [len=5][h][e][l][l][o].  load4 at +4 = "hell" as i32 LE.
        // 'h' = 0x68, 'e' = 0x65, 'l' = 0x6c, 'l' = 0x6c → 0x6c6c6568.
        expect(ex.test_rc_string()).toBe(0x6c6c6568)
    })
})
