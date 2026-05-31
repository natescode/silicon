// SPDX-License-Identifier: MIT
/**
 * @fn[T] generic functions — end-to-end and edge cases.
 *
 * Complements hm-lite.test.ts (typecheck-only) by exercising the full
 * pipeline (lower + emit + instantiate) and the cases hm-lite.test.ts
 * doesn't cover: generic-calling-generic chains, T-shared-across-params
 * constraints, nested generic types, and stdlib helpers.
 *
 * The nested-generic case used to fail because each `checkPolymorphicCall`
 * allocated its own FreshGen, causing nested calls to recycle the same
 * `?T1` name. Fixed by moving the FreshGen onto Ctx so all polymorphic-call
 * sites share one counter. See ADR 0001.
 */

import { test, expect, describe } from 'bun:test'
import { buildStrataRegistry } from '../elaborator/strataLoader'
import elaborate from '../elaborator/elaborator'
import typecheck from '../types/typechecker'
import { lowerProgram } from '../ir/lower'
import { emitModule } from '../ir/emit'
import parse from '../parser'
import addToAstSemantics from '../ast/toAst'
import siliconGrammar from '../grammar/SiliconGrammar'
import { watToWasm } from '../codegen/toWasm'
import { loadStdWat } from '../codegen'

function check(src: string): { errors: string[] } {
    const prog = addToAstSemantics(siliconGrammar)(parse(src)).toAst() as any
    const registry = buildStrataRegistry(prog)
    const elab = elaborate(prog, registry)
    const { errors } = typecheck(elab.program, registry)
    return { errors: errors.map(e => `${e.kind}: ${e.message}`) }
}

function compileToWat(src: string): { wat: string; errors: string[] } {
    const prog = addToAstSemantics(siliconGrammar)(parse(src)).toAst() as any
    const registry = buildStrataRegistry(prog)
    const elab = elaborate(prog, registry)
    const { program: typedProg, functions, errors } = typecheck(elab.program, registry)
    const mod = lowerProgram(typedProg, registry, functions)
    const wat = emitModule(mod, loadStdWat())
    return { wat, errors: errors.map(e => `${e.kind}: ${e.message}`) }
}

function ok(src: string): void {
    const { errors } = check(src)
    if (errors.length > 0) throw new Error(`expected no errors, got:\n  ${errors.join('\n  ')}`)
}

function errs(src: string, ...substrings: string[]): void {
    const { errors } = check(src)
    if (errors.length === 0) throw new Error('expected errors, got none')
    for (const s of substrings) {
        if (!errors.some(e => e.includes(s))) {
            throw new Error(`expected an error containing "${s}", got:\n  ${errors.join('\n  ')}`)
        }
    }
}

describe('Gap 1: generic-calling-generic chain', () => {
    test('one generic fn calls another generic fn, T flows', () => {
        ok(`\\\\ id[T] (T)
@fn id x := x;
            \\\\ double_id[T] (T)
            @fn double_id x := (&id x);
            \\\\ use () -> Int
            @fn use  := (&double_id 42);`)
    })

    test('three-deep chain', () => {
        ok(`\\\\ id[T] (T)
@fn id x := x;
            \\\\ wrap[T] (T)
            @fn wrap x := (&id x);
            \\\\ ww[T] (T)
            @fn ww x := (&wrap x);
            \\\\ use () -> Int
            @fn use  := (&ww 42);`)
    })
})

describe('Gap 2: same T constraint across params', () => {
    test('@fn pair[T] a:T, b:T := a; — both args must share T', () => {
        ok(`\\\\ pair[T] (T, T)
@fn pair a, b := a;
            \\\\ use () -> Int
            @fn use  := (&pair 1, 2);`)
    })

    test('passing Int and Float for the same T should fail', () => {
        errs(`\\\\ pair[T] (T, T)
@fn pair a, b := a;
              \\\\ bad () -> Int
              @fn bad  := (&pair 1, 1.5);`,
            'pair')
    })
})

describe('Gap 3: end-to-end compile (typecheck → lower → emit)', () => {
    test('@fn id[T] x:T := x lowers and emits WAT with the right monotypes per call', () => {
        const { wat, errors } = compileToWat(`\\\\ id[T] (T)
@fn id x := x;
            \\\\ use_i () -> Int
            @fn use_i  := (&id 42);
            \\\\ use_f () -> Float
            @fn use_f  := (&id 3.14);`)
        expect(errors).toEqual([])
        // We expect $id to appear at least once and the two calls to compile.
        expect(wat).toContain('$use_i')
        expect(wat).toContain('$use_f')
        expect(wat).toMatch(/\$use_i[\s\S]*call \$id/)
        expect(wat).toMatch(/\$use_f[\s\S]*call \$id/)
    })

    test('generic stdlib unwrap_or call compiles to runnable WASM', async () => {
        const { wat, errors } = compileToWat(`
            @type Option[T] := $Some value T | $None;
            \\\\ unwrap_or[T] (Option[T], T)
            @fn unwrap_or opt, dflt := {
                &@match opt, $Some v => v, $None => dflt
            };
            \\\\ pick () -> Int
            @fn pick  := (&unwrap_or (&Some 42), 0);
            \\\\ miss () -> Int
            @fn miss  := (&unwrap_or (&None), 7);
            @export pick;
            @export miss;
        `)
        expect(errors).toEqual([])
        const wasm = await watToWasm(wat)
        const imports = {
            env: { print: () => {}, read: () => 0 },
        }
        const { instance } = await WebAssembly.instantiate(wasm, imports as any)
        const pick = (instance.exports as any).pick as () => number
        const miss = (instance.exports as any).miss as () => number
        expect(pick()).toBe(42)
        expect(miss()).toBe(7)
    })
})

describe('Gap 4: nested generic types', () => {
    test('Option[Option[Int]] — generic over a generic type', () => {
        ok(`@type Option[T] := $Some value T | $None;
            \\\\ nested () -> Option[Option[Int]]
            @fn nested  := (&Some (&Some 42));`)
    })

    test('4a: nested with concrete dflt (no &None) — should work', () => {
        // Dflt is &Some 0 which has type Option[Int]; T is unambiguously Option[Int].
        ok(`@type Option[T] := $Some value T | $None;
            \\\\ unwrap_or[T] (Option[T], T)
            @fn unwrap_or opt, dflt := {
                &@match opt, $Some v => v, $None => dflt
            };
            \\\\ nested () -> Option[Int]
            @fn nested  := {
                &unwrap_or (&Some (&Some 42)), (&Some 0)
            };`)
    })

    test('4b: nested with &None dflt — the failing case', () => {
        ok(`@type Option[T] := $Some value T | $None;
            \\\\ unwrap_or[T] (Option[T], T)
            @fn unwrap_or opt, dflt := {
                &@match opt, $Some v => v, $None => dflt
            };
            \\\\ nested () -> Option[Int]
            @fn nested  := {
                &unwrap_or (&Some (&Some 42)), (&None)
            };`)
    })
})

describe('Gap 5: generic used inside non-generic context', () => {
    test('non-generic fn calls generic fn with concrete arg', () => {
        ok(`\\\\ id[T] (T)
@fn id x := x;
            \\\\ use_in_arith () -> Int
            @fn use_in_arith  := { (&id 5) + 3 };`)
    })

    test('generic constructor used in non-generic position', () => {
        ok(`@type Option[T] := $Some value T | $None;
            \\\\ maybe_int () -> Int
            @fn maybe_int  := {
                @local x := (&Some 7);
                &@match x, $Some v => v, $None => 0
            };`)
    })
})

describe('Gap 6: generic fn body contains generic call to another fn', () => {
    test('higher: unwrap with explicit inner call', () => {
        ok(`@type Option[T] := $Some value T | $None;
            \\\\ unwrap_or[T] (Option[T], T)
            @fn unwrap_or opt, dflt := {
                &@match opt, $Some v => v, $None => dflt
            };
            # second generic fn that itself calls unwrap_or with its own T
            \\\\ unwrap_double[T] (Option[T], T)
            @fn unwrap_double opt, dflt := {
                &unwrap_or opt, dflt
            };
            \\\\ use () -> Int
            @fn use  := (&unwrap_double (&Some 99), 0);`)
    })
})

describe('stdlib helpers: option_is_some / option_is_none / result_is_err', () => {
    const OPTION = `@type Option[T] := $Some value T | $None;
        \\\\ option_is_some[T] (Option[T])
        @fn option_is_some opt := {
            &@match opt, $Some _v => @true, $None => @false
        };
        \\\\ option_is_none[T] (Option[T])
        @fn option_is_none opt := {
            &@match opt, $Some _v => @false, $None => @true
        };`
    const RESULT = `@type Result[T, E] := $Ok value T | $Err error E;
        \\\\ result_is_err[T, E] (Result[T, E])
        @fn result_is_err r := {
            &@match r, $Ok _v => @false, $Err _e => @true
        };`

    test('option_is_some/some Int → true', () => {
        ok(`${OPTION}
            @fn check := (&option_is_some (&Some 7));`)
    })

    test('option_is_some/none with annotation', () => {
        ok(`${OPTION}
            @fn check := {
                @local x := (&None);
                &option_is_some x
            };`)
    })

    test('option_is_none over Float', () => {
        ok(`${OPTION}
            @fn check := (&option_is_none (&Some 1.5));`)
    })

    test('result_is_err on Ok and Err of distinct types', () => {
        ok(`${RESULT}
            @fn a := (&result_is_err (&Ok 42));
            @fn b := (&result_is_err (&Err 'oops'));`)
    })
})
