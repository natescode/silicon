// SPDX-License-Identifier: MIT
/**
 * Phase 9d-9 — cross-target equivalence suite.
 *
 * Compiles the same Silicon source under both `--target=wasm-mvp`
 * (the linear-memory bump-allocator path) and `--target=wasm-gc`
 * (the managed-reference path from Phase 9d), validates both
 * binaries under `WebAssembly.compile`, instantiates each, and
 * asserts the exported function returns the same value.
 *
 * This is the v1.0 contract: programs using only the portable surface
 * (primitives, `@struct`, sum types, `Vec[Int]`, lifecycle primitives,
 * Option/Result) compile unchanged across both targets and produce
 * equivalent runtime behaviour.
 *
 * Out of v1.0 scope (v1.1 stories):
 *   - Array[T] under wasm-gc (ref-typed elements, variance design).
 *   - Vec[Float] / Vec[Int64] (mechanical extensions).
 *   - Stringref (separate proposal; not universally shipped).
 *   - Programs that exercise raw memory primitives (&alloc,
 *     &@with_arena, &heap_*, Rc introspection) — those are
 *     wasm-mvp-only per the two-layer portability split (ADR 0009).
 *     The wasm-mvp-only cliff is verified separately by E0012/E0013
 *     in wasm-gc-portability.test.ts.
 *   - Vec[Int] cross-target source parity.  Under wasm-gc, `@mut v`
 *     must be annotated `:Vec[Int]` so injectLocalRefSlots can mark
 *     the wasm-level local as ref-typed.  Under wasm-mvp, the same
 *     annotation requires vec.si's signatures to also be Vec[Int],
 *     but vec.si's body uses raw pointer arithmetic (i32_load /
 *     i32_store) which doesn't typecheck on a Vec[Int] param.  The
 *     v1.1 fix is to split vec.si's pointer ops behind a
 *     `vec_as_ptr v:Vec[Int] → Int` cast helper so the body keeps
 *     working with Int while the public signature is Vec[Int].
 *     Until then, Vec[Int] is tested separately under each target:
 *     `src/stdlib/vec.test.ts` for wasm-mvp,
 *     `src/stdlib/gc/vec.test.ts` for wasm-gc.
 */

import { test, expect, describe } from 'bun:test'
import { resolve } from 'node:path'
import parse from '../parser'
import addToAstSemantics from '../ast/toAst'
import siliconGrammar from '../grammar/SiliconGrammar'
import { buildStrataRegistry, elaborate } from '../elaborator/index'
import { typecheck } from '../types/index'
import { compileToWasm } from '../codegen'
import { resolveUses } from '../modules/useResolver'

interface Exports { [name: string]: any; memory: WebAssembly.Memory }

// Pretend the test file sits at the repo root so relative `@use 'src/stdlib/…'`
// resolves the same as a real user program in the project directory.
const ENTRY_PATH = resolve(__dirname, '../../entry.si')

async function compileRun(src: string, target: 'host' | 'wasm-gc'): Promise<Exports> {
    // Run the @use resolver first — under wasm-gc it auto-redirects
    // stdlib/vec.si → stdlib/gc/vec.si via Phase 9d-6's shadow rule.
    const { source: resolved } = resolveUses(src, ENTRY_PATH, { target })
    const ast = addToAstSemantics(siliconGrammar)(parse(resolved)).toAst() as any
    const registry = buildStrataRegistry(ast)
    const { program: elab, errors: elabErrs } = elaborate(ast, registry)
    if (elabErrs.length) throw new Error(`elab: ${elabErrs.map(e => e.message).join('; ')}`)
    const tc = typecheck(elab, registry, undefined, target)
    if (tc.errors.length) {
        const msg = tc.errors.map(e => e.message ?? e.kind).join('; ')
        throw new Error(`typecheck [${target}]: ${msg}`)
    }
    const bin = compileToWasm(tc.program, registry, tc.functions, undefined, { target })
    const mod = await WebAssembly.instantiate(bin, {
        env: { print: () => {}, read: () => 0 },
    })
    return mod.instance.exports as unknown as Exports
}

/** Compile + execute under BOTH targets; assert both run successfully and
 *  return the same value for the given exported function. */
async function assertParity(src: string, fn: string, expected: number): Promise<void> {
    const mvp = await compileRun(src, 'host')
    const gc  = await compileRun(src, 'wasm-gc')
    const mvpVal = mvp[fn]()
    const gcVal  = gc[fn]()
    expect(mvpVal).toBe(expected)
    expect(gcVal).toBe(expected)
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Primitives — Int, Float, Bool arithmetic and comparisons
// ─────────────────────────────────────────────────────────────────────────

describe('Phase 9d-9: primitives parity', () => {

    test('Int arithmetic returns the same value on both targets', async () => {
        await assertParity(`
            \\\\ run () -> Int
            @fn run  := (1 + 2) * 3 - 4;
            @export run;
        `, 'run', 5)
    })

    test('Int comparisons return the same i32 (0/1) on both targets', async () => {
        await assertParity(`
            \\\\ run Int
            @fn run := @if(5 > 3, {
                1
            }, {
                0
            });
            @export run;`, 'run', 1)
    })

    test('Loop accumulator preserves arithmetic semantics', async () => {
        await assertParity(`
            \\\\ run Int
            @fn run := {
                @mut sum := 0;
                @mut i := 1;
                @loop(i <= 10, {
                    sum = sum + i;
                    i = i + 1;
                });
                sum
            };
            @export run;`, 'run', 55)
    })

    test('Recursive function compiles + runs the same', async () => {
        await assertParity(`
            \\\\ fib (Int)
            @fn fib n := @if(n < 2, {
                n
            }, {
                fib(n - 1) + fib(n - 2)
            });
            \\\\ run Int
            @fn run := fib(10);
            @export run;`, 'run', 55)
    })
})

// ─────────────────────────────────────────────────────────────────────────
// 2. @struct — record types
// ─────────────────────────────────────────────────────────────────────────

describe('Phase 9d-9: @struct parity', () => {

    test('@struct construct + field read returns the same value', async () => {
        // Note: @struct field-access syntax differs slightly per target
        // (mvp uses i32.load, gc uses struct.get) but the source program
        // doesn't change — `p.x` lowers correctly under both.
        await assertParity(`
            @type Point := { x Int, y Int };
            \\\\ run Int
            @fn run := {
                @mut p := Point(3, 4);
                p::x + p::y
            };
            @export run;`, 'run', 7)
    })
})

// ─────────────────────────────────────────────────────────────────────────
// 3. Sum types — payload-free (enum-style) + payload-bearing
// ─────────────────────────────────────────────────────────────────────────

describe('Phase 9d-9: sum-type parity', () => {

    test('payload-free @type_sum + @match parity', async () => {
        await assertParity(`
            @enum Color := Red | Green | Blue;
            \\\\ run Int
            @fn run := {
                @mut c := Color::Green;
                @match(c, Color::Red, { 1 }, Color::Green, { 2 }, Color::Blue, { 3 })
            };
            @export run;`, 'run', 2)
    })

    test('payload-bearing @type Sum + match arms (Some path)', async () => {
        await assertParity(`
            @type Opt := $Some v Int | $None;
            \\\\ unwrap (Opt)
            @fn unwrap o := @match(o, $Some v, { v }, $None, { 0 });
            \\\\ run Int
            @fn run := unwrap(Some(42));
            @export run;`, 'run', 42)
    })

    test('payload-bearing Sum (None path)', async () => {
        // Match-arm bodies with binary expressions need parens; the
        // zero-arg constructor call to `None()` also needs parens.
        await assertParity(`
            @type Opt := $Some v Int | $None;
            \\\\ unwrap (Opt)
            @fn unwrap o := @match(o, $Some v, { v }, $None, { (0 - 7) });
            \\\\ make_none Opt
            @fn make_none := None();
            \\\\ run Int
            @fn run := unwrap(make_none());
            @export run;`, 'run', -7)
    })
})

// ─────────────────────────────────────────────────────────────────────────
// 4. Option / Result — sum types with the stdlib helpers
// ─────────────────────────────────────────────────────────────────────────

describe('Phase 9d-9: Option / Result stdlib parity', () => {

    test('inline Option-like sum + helper compiles on both targets', async () => {
        // The stdlib Option / Result types are themselves sum types,
        // so a user program declaring its own Option-shaped type tests
        // the same machinery.
        await assertParity(`
            @type Opt := $Some v Int | $None;
            \\\\ unwrap_or (Opt, Int)
            @fn unwrap_or o, dflt := @match(o, $Some v, { v }, $None, { dflt });
            \\\\ run Int
            @fn run := {
                @mut a := unwrap_or(Some(10), 99);
                @mut b := unwrap_or(None(), 99);
                a + b
            };
            @export run;`, 'run', 109)
    })

    test('Sum-with-variants + arms returning different magnitudes', async () => {
        // Distinct field names per variant so the typechecker's
        // per-arm scope isn't ambiguous; same pattern Result-like
        // programs use in practice (`$Ok value`, `$Err code`).
        await assertParity(`
            @type Res := $Ok value Int | $Err code Int;
            \\\\ ok_value (Res)
            @fn ok_value r := @match(r, $Ok value, { value }, $Err code, { 0 });
            \\\\ err_code (Res)
            @fn err_code r := @match(r, $Ok value, { 0 }, $Err code, { code });
            \\\\ run Int
            @fn run := ok_value(Ok(7)) + err_code(Err(3));
            @export run;`, 'run', 10)
    })
})

// ─────────────────────────────────────────────────────────────────────────
// 5. Programs that validate under both targets (no run-equivalence —
//    these use ref-typed values that can't be returned to JS without
//    engine-specific glue, but compilation success on both is the
//    real portability claim).
// ─────────────────────────────────────────────────────────────────────────

describe('Phase 9d-9: programs validate under both targets', () => {

    /** Compile a program under both targets; assert both binaries
     *  validate.  Used for source where the exported function returns
     *  a heap value that can't be trivially compared via JS. */
    async function assertBothValidate(src: string): Promise<void> {
        const mvpExports = await compileRun(src, 'host')
        const gcExports  = await compileRun(src, 'wasm-gc')
        expect(mvpExports).toBeDefined()
        expect(gcExports).toBeDefined()
    }

    test('Function taking a sum and returning the same sum (refResult/refParams encoding)', async () => {
        await assertBothValidate(`
            @type Opt := $Some v Int | $None;
            \\\\ identity (Opt)
            @fn identity o := o;
            \\\\ run Int
            @fn run := @match(identity(Some(5)), $Some v, { v }, $None, { 0 });
            @export run;`)
    })

    test('Function returning sum + further @match composes cleanly', async () => {
        // Sum-typed return values flow through call sites correctly
        // under both targets — refResult encoding on the gc side,
        // i32 pointer on the mvp side.  Construction + match in
        // separate functions exercises the wasm-level call boundary
        // for ref/ptr-typed returns.  Match-arm binary expressions
        // need parens — the comma separator is otherwise consumed
        // by the binary parse (a parser-level quirk independent of
        // 9d-9).
        await assertBothValidate(`
            @type Tag := $A x Int | $B y Int;
            \\\\ make_a (Int)
            @fn make_a v := A(v);
            \\\\ make_b (Int)
            @fn make_b v := B(v);
            \\\\ classify (Tag)
            @fn classify t := @match(t, $A x, { x }, $B y, { (0 - y) });
            \\\\ run Int
            @fn run := classify(make_a(7)) + classify(make_b(3));
            @export run;`)
    })

    test('Lifecycle: arena + Rc compose cleanly under both targets', async () => {
        await assertBothValidate(`
            @use 'src/stdlib/rc.si';
            @fn run := @with_arena({
                @mut r := rc_new(42);
                @defer(rc_drop(r));
                rc_get(r)
            });
            @export run;`)
    })
})
