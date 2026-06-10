// SPDX-License-Identifier: MIT
/**
 * ADR 0019 C1/C2 — closures under `--target=wasm-gc`, end-to-end.
 *
 * Under wasm-gc the closure env is a `(ref $Vec_i32)` (gc-vec.ts) rather than an
 * i32 linear pointer, so it is ENGINE-GC'd — no bump-heap retention.  Making this
 * work needed: the synthesized wrapper's env param typed `Vec[Int]` (a ref slot);
 * closure-holding locals annotated `Vec[Int]`; and the C0 funcref ABI extended so
 * `@call_indirect`'s type carries the `(ref $Vec_i32)` env param (it keyed on flat
 * valtypes before, so the call_indirect type didn't match the ref-typed wrapper).
 *
 * These compile real programs with `--target=wasm-gc` and run the WASM under Bun
 * (which has wasm-gc), asserting captured state flows through the GC'd env.
 */

import { test, expect, describe } from 'bun:test'
import { compileToWasm } from '../codegen/index'
import siliconGrammar from '../grammar/SiliconGrammar'
import parse from '../parser'
import { addToAstSemantics } from '../ast/index'
import { buildStrataRegistry, elaborate } from '../elaborator/index'
import { typecheck } from '../types/index'
import type { Program } from '../ast/astNodes'

/** Compile + run with --target=wasm-gc.  vec_* are compiler-generated under
 *  wasm-gc (gc-vec.ts), so unlike the linear harness no vec.si prepend is needed. */
async function compileRunGc(programSrc: string): Promise<any> {
    const ast = addToAstSemantics(siliconGrammar)(parse(programSrc)).toAst() as Program
    const registry = buildStrataRegistry(ast)
    const { program: elaborated, errors } = elaborate(ast, registry, [], 'wasm-gc')
    expect(errors ?? []).toEqual([])
    const { program: typed, functions } = typecheck(elaborated, registry, undefined, 'wasm-gc')
    const bin = compileToWasm(typed, registry, functions, undefined, { target: 'wasm-gc' })
    expect(await WebAssembly.validate(bin)).toBe(true)
    const mod = await WebAssembly.instantiate(bin, { env: { print: () => {}, read: () => 0 } })
    return mod.instance.exports as any
}

describe('ADR 0019 — closures run under --target=wasm-gc (engine-GC\'d env)', () => {
    test('a closure captures a value (make_adder) — env is a (ref $Vec_i32)', async () => {
        const ex = await compileRunGc(`\\\\ add2 (Int, Int) -> Int
@fn add2 captured, x := { captured + x };
\\\\ run (Int) -> Int
@fn run n := { adder := @closure(add2, n); @call_closure(adder, 5) };
@export run;`)
        expect(ex.run(10)).toBe(15)
        expect(ex.run(100)).toBe(105)
        expect(ex.run(-3)).toBe(2)
    })

    test('two captures (linear y = a*x + b)', async () => {
        const ex = await compileRunGc(`\\\\ lin (Int, Int, Int) -> Int
@fn lin a, b, x := { (a * x) + b };
\\\\ run (Int) -> Int
@fn run x := { f := @closure(lin, 2, 3); @call_closure(f, x) };
@export run;`)
        expect(ex.run(5)).toBe(13)   // 2*5 + 3
        expect(ex.run(0)).toBe(3)
    })

    test('two distinct closures over the same body coexist (independent GC\'d envs)', async () => {
        const ex = await compileRunGc(`\\\\ mul (Int, Int) -> Int
@fn mul factor, x := { factor * x };
\\\\ run (Int) -> Int
@fn run x := {
    times3 := @closure(mul, 3);
    times10 := @closure(mul, 10);
    @call_closure(times3, x) + @call_closure(times10, x)
};
@export run;`)
        expect(ex.run(2)).toBe(26)   // 3*2 + 10*2
        expect(ex.run(5)).toBe(65)   // 15 + 50
    })

    test('an empty-capture closure degenerates to a plain function value', async () => {
        const ex = await compileRunGc(`\\\\ dbl (Int) -> Int
@fn dbl x := { x * 2 };
\\\\ run (Int) -> Int
@fn run x := { f := @closure(dbl); @call_closure(f, x) };
@export run;`)
        expect(ex.run(7)).toBe(14)
        expect(ex.run(21)).toBe(42)
    })

    test('a closure passed to a higher-order Silicon fn applies captured state (ADR 0016 gap, on wasm-gc)', async () => {
        // A closure passed as a PARAMETER is typed `Vec[Int]` — its env-ref type
        // under wasm-gc (the linear path types it `Int`); the C0 ref-typed funcref
        // ABI then matches the call_indirect through it.
        const ex = await compileRunGc(`\\\\ scale (Int, Int) -> Int
@fn scale factor, x := { factor * x };
\\\\ apply_twice (Vec[Int], Int) -> Int
@fn apply_twice clo, x := { @call_closure(clo, x) + @call_closure(clo, x) };
\\\\ run (Int, Int) -> Int
@fn run factor, x := { s := @closure(scale, factor); apply_twice(s, x) };
@export run;`)
        expect(ex.run(3, 5)).toBe(30)   // (3*5) + (3*5)
        expect(ex.run(10, 2)).toBe(40)  // 20 + 20
    })

    test('C2 — an escaping host-callable closure crosses @extern as an engine-GC\'d ref (leak-free)', async () => {
        // `@export_callback` hands the closure to the host.  Under wasm-gc the
        // handle is the `(ref $Vec_i32)` env itself, crossing as a wasm-gc ref (the
        // host holds it as an opaque object; the engine collects it when dropped —
        // no bump-heap retention).  The host calls it back via the synthesized
        // exported `__closure_invoke_<k>` trampoline (clo param typed `Vec[Int]`).
        const src = `\\\\ @extern store_cb (Vec[Int]) -> Void;
\\\\ scale (Int, Int) -> Int
@fn scale factor, x := { factor * x };
\\\\ register (Int) -> Void
@fn register factor := { store_cb(@export_callback(@closure(scale, factor))) };
@export register;`
        const ast = addToAstSemantics(siliconGrammar)(parse(src)).toAst() as Program
        const registry = buildStrataRegistry(ast)
        const { program: elaborated } = elaborate(ast, registry, [], 'wasm-gc')
        const { program: typed, functions } = typecheck(elaborated, registry, undefined, 'wasm-gc')
        const bin = compileToWasm(typed, registry, functions, undefined, { target: 'wasm-gc' })
        expect(await WebAssembly.validate(bin)).toBe(true)

        let saved: any = null
        const m = await WebAssembly.instantiate(bin, { env: { print: () => {}, read: () => 0, store_cb: (h: any) => { saved = h } } })
        const ex = m.instance.exports as any
        ex.register(7)
        expect(typeof saved).toBe('object')          // an engine wasm-gc ref, NOT an i32 pointer
        expect(typeof ex.__closure_invoke_1).toBe('function')
        expect(ex.__closure_invoke_1(saved, 5)).toBe(35)   // scale(7, 5), called back from the host
        expect(ex.__closure_invoke_1(saved, 1)).toBe(7)    // env persists across calls
        ex.register(4)                                       // a fresh independent closure
        expect(ex.__closure_invoke_1(saved, 3)).toBe(12)   // scale(4, 3)
    })
})
