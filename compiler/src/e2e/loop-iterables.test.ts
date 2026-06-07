// SPDX-License-Identifier: MIT
/**
 * ADR 0016 — `@loop` over iterables.
 *
 * Exercises the v1 surface end-to-end (source → wasm → run): the 0-operand
 * infinite sugar, `a..b` half-open ranges with arity-1/-2 binds, i32-element
 * indexed `Vec` iteration with arity-2/-3 binds, the `_` discard binder, and the
 * `IterStep[T,R]` convention.  Range / infinite / discard forms are asserted for
 * parity across both backends (they touch no Vec); the indexed-Vec forms run on
 * the host (wasm-mvp) target only, like `src/stdlib/vec.test.ts`, because
 * cross-target Vec source parity needs `:Vec[Int]` annotations vec.si doesn't
 * carry yet (see cross-target.test.ts header).
 *
 * Also asserts the elaboration-time rejections: arity ≥ 4 operands and a `..`
 * range used outside an iterate `@loop`.
 */

import { test, expect, describe } from 'bun:test'
import { resolve } from 'node:path'
import parse from '../parser'
import { buildStrataRegistry, elaborate } from '../elaborator/index'
import { typecheck } from '../types/index'
import { compileToWasm } from '../codegen'
import { resolveUses } from '../modules/useResolver'

interface Exports { [name: string]: any; memory: WebAssembly.Memory }

const ENTRY_PATH = resolve(__dirname, '../../entry.si')

async function compileRun(src: string, target: 'host' | 'wasm-gc'): Promise<Exports> {
    const { source: resolved } = resolveUses(src, ENTRY_PATH, { target })
    const ast = parse(resolved) as any
    const registry = buildStrataRegistry(ast)
    const { program: elab, errors: elabErrs } = elaborate(ast, registry)
    if (elabErrs.length) throw new Error(`elab: ${elabErrs.map(e => e.message).join('; ')}`)
    const tc = typecheck(elab, registry, undefined, target)
    if (tc.errors.length) throw new Error(`typecheck [${target}]: ${tc.errors.map((e: any) => e.message ?? e.kind).join('; ')}`)
    const bin = compileToWasm(tc.program, registry, tc.functions, undefined, { target })
    const mod = await WebAssembly.instantiate(bin, { env: { print: () => {}, read: () => 0 } })
    return mod.instance.exports as unknown as Exports
}

/** Compile + run on the host target; assert the exported fn returns `expected`. */
async function assertHost(src: string, fn: string, expected: number): Promise<void> {
    const exports = await compileRun(src, 'host')
    expect(exports[fn]()).toBe(expected)
}

/** Compile + run on BOTH targets; assert both return `expected`. */
async function assertParity(src: string, fn: string, expected: number): Promise<void> {
    expect((await compileRun(src, 'host'))[fn]()).toBe(expected)
    expect((await compileRun(src, 'wasm-gc'))[fn]()).toBe(expected)
}

/** Parse + elaborate only; return the elaboration error messages joined. */
function elabErrors(src: string): string {
    const ast = parse(src) as any
    const registry = buildStrataRegistry(ast)
    return elaborate(ast, registry).errors.map(e => e.message).join(' | ')
}

// ─────────────────────────────────────────────────────────────────────────
// Range forms — half-open `a..b`, parity across both backends
// ─────────────────────────────────────────────────────────────────────────

describe('ADR 0016: range @loop', () => {
    test('arity-1 binder sums 0..n (half-open)', async () => {
        await assertParity(`
            \\\\ run Int
            @fn run := {
                @mut total := 0;
                @loop(v, 0 .. 5, {
                    total = total + v
                });
                total
            };
            @export run;`, 'run', 10)   // 0+1+2+3+4
    })

    test('arity-2 binds position then element (diverge once a≠0)', async () => {
        await assertParity(`
            \\\\ run Int
            @fn run := {
                @mut acc := 0;
                @loop(i, v, 2 .. 5, {
                    acc = acc + (i * v)
                });
                acc
            };
            @export run;`, 'run', 11)   // i=0,1,2 ; v=2,3,4 → 0*2+1*3+2*4
    })

    test('empty range a..a runs zero times', async () => {
        await assertParity(`
            \\\\ run Int
            @fn run := {
                @mut r := 99;
                @loop(v, 3 .. 3, {
                    r = v
                });
                r
            };
            @export run;`, 'run', 99)
    })

    test('inverted range 5..3 runs zero times (not reversed)', async () => {
        await assertParity(`
            \\\\ run Int
            @fn run := {
                @mut r := 99;
                @loop(v, 5 .. 3, {
                    r = v
                });
                r
            };
            @export run;`, 'run', 99)
    })

    test('`_` discard binder iterates without binding the element', async () => {
        await assertParity(`
            \\\\ run Int
            @fn run := {
                @mut hits := 0;
                @loop(_, 0 .. 7, {
                    hits = hits + 1
                });
                hits
            };
            @export run;`, 'run', 7)
    })

    test('nested ranges multiply iteration counts', async () => {
        await assertParity(`
            \\\\ run Int
            @fn run := {
                @mut s := 0;
                @loop(a, 0 .. 3, {
                    @loop(b, 0 .. 4, {
                        s = s + 1
                    })
                });
                s
            };
            @export run;`, 'run', 12)   // 3 * 4
    })

    test('the high bound is snapshotted once at entry', async () => {
        await assertParity(`
            \\\\ run Int
            @fn run := {
                @mut hi := 3;
                @mut count := 0;
                @loop(v, 0 .. hi, {
                    hi = 99;
                    count = count + 1
                });
                count
            };
            @export run;`, 'run', 3)   // mutating hi mid-loop does not extend the iteration count
    })
})

// ─────────────────────────────────────────────────────────────────────────
// Infinite (0-operand) form — desugars to the `&@loop 1, {…}` idiom
// ─────────────────────────────────────────────────────────────────────────

describe('ADR 0016: infinite @loop', () => {
    test('0-operand `@loop({ body })` loops until @break', async () => {
        await assertParity(`
            \\\\ run Int
            @fn run := {
                @mut c := 0;
                @loop({
                    @if(c >= 4, {
                        @break()
                    });
                    c = c + 1
                });
                c
            };
            @export run;`, 'run', 4)
    })

    test('one-operand `@loop(cond, { body })` while form is unchanged', async () => {
        await assertParity(`
            \\\\ run Int
            @fn run := {
                @mut sum := 0;
                @mut i := 1;
                @loop(i <= 10, {
                    sum = sum + i;
                    i = i + 1
                });
                sum
            };
            @export run;`, 'run', 55)
    })
})

// ─────────────────────────────────────────────────────────────────────────
// Indexed Vec form — i32 elements via vec_len / vec_get_i32 (host target)
// ─────────────────────────────────────────────────────────────────────────

describe('ADR 0016: indexed Vec @loop', () => {
    const VEC_PRELUDE = `
        @use 'vec';
        \\\\ build Int
        @fn build := {
            @mut v := vec_new(4);
            vec_push_i32(v, 10);
            vec_push_i32(v, 20);
            vec_push_i32(v, 30);
            v
        };`

    test('arity-2 binds the element', async () => {
        await assertHost(`${VEC_PRELUDE}
            \\\\ run () -> Int
            @fn run := {
                @mut v := build();
                @mut sum := 0;
                @loop(x, v, { sum = sum + x });
                sum
            };
            @export run;
        `, 'run', 60)
    })

    test('arity-3 binds position then element', async () => {
        await assertHost(`${VEC_PRELUDE}
            \\\\ run () -> Int
            @fn run := {
                @mut v := build();
                @mut w := 0;
                @loop(i, x, v, { w = w + (i * x) });
                w
            };
            @export run;
        `, 'run', 80)   // 0*10 + 1*20 + 2*30
    })

    test('iterating an empty Vec runs zero times', async () => {
        await assertHost(`
            @use 'vec';
            \\\\ run Int
            @fn run := {
                @mut v := vec_new(2);
                @mut hits := 0;
                @loop(x, v, {
                    hits = hits + 1
                });
                hits
            };
            @export run;`, 'run', 0)
    })
})

// ─────────────────────────────────────────────────────────────────────────
// IterStep[T,R] convention (hand-written external driver — host target)
// ─────────────────────────────────────────────────────────────────────────

describe('ADR 0016: IterStep convention', () => {
    test('a hand-written next -> IterStep loop sums elements', async () => {
        await assertHost(`
            @use 'iter';
            \\\\ count_next (Int, Int) -> IterStep[Int, Int]
            @fn count_next i, n := {
                @if(i < n, {
                    \\\\ _r IterStep[Int, Int]
                    @mut _r := Item(i);
                    _r
                }, {
                    \\\\ _r IterStep[Int, Int]
                    @mut _r := Done(0);
                    _r
                })
            };
            \\\\ run () -> Int
            @fn run := {
                @mut i := 0;
                @mut total := 0;
                @mut running := 1;
                @loop(running == 1, {
                    @mut s := count_next(i, 5);
                    @if(iter_is_done(s),
                        { running = 0 },
                        { total = total + iter_item_or(s, 0); i = i + 1 }
                    )
                });
                total
            };
            @export run;
        `, 'run', 10)   // 0+1+2+3+4
    })

    test('IterStep helpers select item vs done', async () => {
        await assertHost(`
            @use 'iter';
            \\\\ run () -> Int
            @fn run := {
                \\\\ a IterStep[Int, Int]
                @mut a := Item(42);
                \\\\ b IterStep[Int, Int]
                @mut b := Done(7);
                iter_item_or(a, 0) + iter_item_or(b, 100)
            };
            @export run;
        `, 'run', 142)   // 42 + 100
    })
})

// ─────────────────────────────────────────────────────────────────────────
// Rejections — arity and stray ranges (elaboration-time)
// ─────────────────────────────────────────────────────────────────────────

describe('ADR 0016: rejections', () => {
    test('≥4 operands before the body block is rejected', () => {
        const errs = elabErrors(`@fn run := { @loop(a, b, c, d, 0 .. 3, { a }); 0 };`)
        expect(errs).toContain('@loop takes at most 3 operands')
    })

    test('a `..` range outside an iterate @loop is rejected', () => {
        const errs = elabErrors(`@fn run := { @mut r := 0 .. 5; r };`)
        expect(errs).toContain('`..` range is only valid')
    })

    test('a non-name element binder is rejected', () => {
        const errs = elabErrors(`@fn run := { @loop(1 + 2, 0 .. 3, { 0 }); 0 };`)
        expect(errs).toContain('must be a bare name')
    })
})
