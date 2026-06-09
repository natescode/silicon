// SPDX-License-Identifier: MIT
/**
 * ADR 0019 C1 — non-escaping closures with by-value capture, end-to-end.
 *
 * A `@closure(body_fn, …caps)` builds a closure over a named top-level @fn whose
 * leading params are the captures; `@call_closure(clo, …args)` invokes it.  The
 * desugar (closureDesugar.ts) rewrites both into the shipped `@fnref` /
 * `@call_indirect` (C0) + `vec_*` machinery with zero new IR, synthesizing an
 * env-unpack wrapper @fn per site.  These tests compile real Silicon programs
 * and run the generated WASM, asserting captured state flows correctly —
 * including the combinator case (a closure passed to a higher-order function),
 * which is the gap ADR 0016 named (`map`/`filter`/`fold` "wait on closures").
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

const vecSrc = readFileSync(join(__dirname, '..', 'stdlib', 'vec.si'), 'utf-8')

async function compileRun(programSrc: string): Promise<any> {
    const source = `${vecSrc}\n${programSrc}`
    const ast = addToAstSemantics(siliconGrammar)(parse(source)).toAst() as Program
    const registry = buildStrataRegistry(ast)
    const { program: elaborated, errors } = elaborate(ast, registry)
    expect(errors ?? []).toEqual([])
    const { program: typed, functions } = typecheck(elaborated, registry)
    const bin = compileToWasm(typed, registry, functions)
    const mod = await WebAssembly.instantiate(bin, { env: { print: () => {}, read: () => 0 } })
    return mod.instance.exports as any
}

describe('ADR 0019 C1 — closures with by-value capture', () => {
    test('a closure captures a value and adds it (the make_adder case)', async () => {
        const ex = await compileRun(`\\\\ add2 (Int, Int) -> Int
@fn add2 captured, x := { captured + x };
\\\\ run (Int) -> Int
@fn run n := {
    adder := @closure(add2, n);
    @call_closure(adder, 5)
};
@export run;`)
        expect(ex.run(10)).toBe(15)
        expect(ex.run(100)).toBe(105)
        expect(ex.run(-3)).toBe(2)
    })

    test('a closure captures two values (linear y = a*x + b)', async () => {
        const ex = await compileRun(`\\\\ lin (Int, Int, Int) -> Int
@fn lin a, b, x := { (a * x) + b };
\\\\ run (Int) -> Int
@fn run x := {
    f := @closure(lin, 2, 3);
    @call_closure(f, x)
};
@export run;`)
        expect(ex.run(5)).toBe(13)   // 2*5 + 3
        expect(ex.run(0)).toBe(3)
    })

    test('an empty-capture closure degenerates to a plain function value', async () => {
        const ex = await compileRun(`\\\\ dbl (Int) -> Int
@fn dbl x := { x * 2 };
\\\\ run (Int) -> Int
@fn run x := {
    f := @closure(dbl);
    @call_closure(f, x)
};
@export run;`)
        expect(ex.run(7)).toBe(14)
        expect(ex.run(21)).toBe(42)
    })

    test('two distinct closures over the same body coexist (independent envs)', async () => {
        const ex = await compileRun(`\\\\ mul (Int, Int) -> Int
@fn mul factor, x := { factor * x };
\\\\ run (Int) -> Int
@fn run x := {
    times3 := @closure(mul, 3);
    times10 := @closure(mul, 10);
    @call_closure(times3, x) + @call_closure(times10, x)
};
@export run;`)
        expect(ex.run(2)).toBe(26)   // 3*2 + 10*2 = 6 + 20
        expect(ex.run(5)).toBe(65)   // 15 + 50
    })

    test('a closure passed to a combinator applies captured state per element (ADR 0016 gap)', async () => {
        // vec_map_closure is a higher-order function taking a CLOSURE (not a bare
        // funcref): it invokes it via @call_closure, so the callback can close
        // over a surrounding value (a scale factor) — exactly the accumulator/
        // combinator case ADR 0016 declined for lack of closures.
        const ex = await compileRun(`\\\\ scale (Int, Int) -> Int
@fn scale factor, x := { factor * x };
\\\\ vec_map_closure (Int, Int) -> Int
@fn vec_map_closure v, clo := {
    len := vec_len(v);
    result := vec_new(len);
    @mut i := 0;
    @loop(i < len, {
        result_i := @call_closure(clo, vec_get_i32(v, i));
        vec_push_i32(result, result_i);
        i = i + 1;
    });
    result
};
\\\\ run (Int) -> Int
@fn run factor := {
    v := vec_new(3);
    vec_push_i32(v, 1);
    vec_push_i32(v, 2);
    vec_push_i32(v, 3);
    scaler := @closure(scale, factor);
    out := vec_map_closure(v, scaler);
    vec_get_i32(out, 0) + vec_get_i32(out, 1) + vec_get_i32(out, 2)
};
@export run;`)
        expect(ex.run(10)).toBe(60)   // (1+2+3) * 10
        expect(ex.run(2)).toBe(12)    // (1+2+3) * 2
    })
})

describe('ADR 0019 C2 — escape/host-reachability gate', () => {
    // The classifier runs in closureDesugar before the rewrite; its errors
    // surface as elaboration diagnostics.  No vec.si needed here.
    function elabErrors(src: string): string[] {
        const ast = addToAstSemantics(siliconGrammar)(parse(src)).toAst() as Program
        const registry = buildStrataRegistry(ast)
        const { errors } = elaborate(ast, registry)
        return (errors ?? []).map((e: any) => e.message)
    }

    test('a @closure literal crossing an @extern boundary is rejected (host-callable escape)', () => {
        const errs = elabErrors(`\\\\ @extern register_cb (Int) -> Void;
\\\\ h (Int, Int) -> Int
@fn h c, x := { c + x };
\\\\ run (Int) -> Void
@fn run n := { register_cb(@closure(h, n)) };`)
        expect(errs.some(m => m.includes('host-callable escaping closure') && m.includes('--target=wasm-gc'))).toBe(true)
    })

    test('a closure-bound local crossing @extern is also rejected (conservative over-approximation)', () => {
        const errs = elabErrors(`\\\\ @extern register_cb (Int) -> Void;
\\\\ h (Int, Int) -> Int
@fn h c, x := { c + x };
\\\\ run (Int) -> Void
@fn run n := { cb := @closure(h, n); register_cb(cb) };`)
        expect(errs.some(m => m.includes('host-callable escaping closure'))).toBe(true)
    })

    test('a closure passed to a Silicon-side higher-order function is allowed (no host escape)', () => {
        const errs = elabErrors(`\\\\ apply (Int, Int) -> Int
@fn apply clo, x := { @call_closure(clo, x) };
\\\\ h (Int, Int) -> Int
@fn h c, x := { c + x };
\\\\ run (Int) -> Int
@fn run n := { apply(@closure(h, n), 5) };`)
        expect(errs.filter(m => m.includes('host-callable escaping closure'))).toEqual([])
    })

    test('a plain @fnref (no captures) may cross @extern unchanged', () => {
        const errs = elabErrors(`\\\\ @extern register_cb (Int) -> Void;
\\\\ h (Int) -> Int
@fn h x := { x };
\\\\ run () -> Void
@fn run := { register_cb(@fnref(h)) };`)
        expect(errs.filter(m => m.includes('host-callable escaping closure'))).toEqual([])
    })
})
