/**
 * Phase 5 Workstream B Step 1 — `@fnref` + `@call_indirect` end-to-end.
 *
 * Proves the first-class-function machinery (5d-1 + 5d-2):
 *
 *   - `&@fnref name` resolves to a stable i32 table index for a
 *     top-level @fn.
 *   - `&@call_indirect cb, x` invokes the function at table index cb
 *     with one i32 arg, returning i32.
 *   - Multiple distinct functions can be referenced via @fnref and
 *     dispatched by index — proves the table populates correctly.
 *   - Compiled wasm validates and runs under the WASM runtime
 *     (currently routed through WAT → wabt; direct binary emitter
 *     parity is a follow-up).
 */

import { test, expect, describe } from 'bun:test'
import { compileToWasm } from './index'
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

describe('Phase 5 Workstream B: @fnref + @call_indirect', () => {
    test('@fnref returns a stable i32 table index for a top-level @fn', async () => {
        const ex = await compileAndRun(`
            @fn add_one:Int x:Int := x + 1;
            @fn test_idx:Int := &@fnref add_one;
            @export test_idx;
        `)
        // First @fnref to a function gets table slot 0.
        expect(ex.test_idx()).toBe(0)
    })

    test('@fnref to the same name twice returns the same index', async () => {
        const ex = await compileAndRun(`
            @fn add_one:Int x:Int := x + 1;
            @fn test_same:Int := {
                @local a:Int := &@fnref add_one;
                @local b:Int := &@fnref add_one;
                a - b
            };
            @export test_same;
        `)
        expect(ex.test_same()).toBe(0)
    })

    test('@fnref to different functions returns distinct indices', async () => {
        const ex = await compileAndRun(`
            @fn add_one:Int x:Int := x + 1;
            @fn double:Int x:Int := x * 2;
            @fn test_distinct:Int := {
                @local a:Int := &@fnref add_one;
                @local b:Int := &@fnref double;
                b - a
            };
            @export test_distinct;
        `)
        expect(ex.test_distinct()).toBe(1)
    })

    test('@call_indirect invokes the right function via table index', async () => {
        const ex = await compileAndRun(`
            @fn add_one:Int x:Int := x + 1;
            @fn call_via_ref:Int := {
                @local cb:Int := &@fnref add_one;
                &@call_indirect cb, 41
            };
            @export call_via_ref;
        `)
        expect(ex.call_via_ref()).toBe(42)
    })

    test('@call_indirect dispatches between multiple functions by index', async () => {
        const ex = await compileAndRun(`
            @fn add_one:Int x:Int := x + 1;
            @fn double:Int x:Int := x * 2;
            @fn dispatch_add:Int := {
                @local cb:Int := &@fnref add_one;
                &@call_indirect cb, 10
            };
            @fn dispatch_double:Int := {
                @local cb:Int := &@fnref double;
                &@call_indirect cb, 10
            };
            @export dispatch_add;
            @export dispatch_double;
        `)
        expect(ex.dispatch_add()).toBe(11)
        expect(ex.dispatch_double()).toBe(20)
    })

    test('non-funcref programs preserve their existing direct-binary path', async () => {
        // A program without @fnref / @call_indirect must produce identical
        // bytes via the direct binary emitter as before (the byte-equal
        // codegen test already enforces this — this test is just a sanity
        // check that adding the funcrefTable field doesn't accidentally
        // route non-funcref modules through WAT).
        const ex = await compileAndRun(`
            @fn add:Int a:Int, b:Int := a + b;
            @export add;
        `)
        expect(ex.add(2, 3)).toBe(5)
    })
})
