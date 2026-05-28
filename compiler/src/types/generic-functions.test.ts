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
        ok(`@fn id[T] x:T := x;
            @fn double_id[T] x:T := (&id x);
            @fn use:Int := (&double_id 42);`)
    })

    test('three-deep chain', () => {
        ok(`@fn id[T] x:T := x;
            @fn wrap[T] x:T := (&id x);
            @fn ww[T] x:T := (&wrap x);
            @fn use:Int := (&ww 42);`)
    })
})

describe('Gap 2: same T constraint across params', () => {
    test('@fn pair[T] a:T, b:T := a; — both args must share T', () => {
        ok(`@fn pair[T] a:T, b:T := a;
            @fn use:Int := (&pair 1, 2);`)
    })

    test('passing Int and Float for the same T should fail', () => {
        errs(`@fn pair[T] a:T, b:T := a;
              @fn bad:Int := (&pair 1, 1.5);`,
            'pair')
    })
})

describe('Gap 3: end-to-end compile (typecheck → lower → emit)', () => {
    test('@fn id[T] x:T := x lowers and emits WAT with the right monotypes per call', () => {
        const { wat, errors } = compileToWat(`@fn id[T] x:T := x;
            @fn use_i:Int := (&id 42);
            @fn use_f:Float := (&id 3.14);`)
        expect(errors).toEqual([])
        // We expect $id to appear at least once and the two calls to compile.
        expect(wat).toContain('$use_i')
        expect(wat).toContain('$use_f')
        expect(wat).toMatch(/\$use_i[\s\S]*call \$id/)
        expect(wat).toMatch(/\$use_f[\s\S]*call \$id/)
    })

    test('generic stdlib unwrap_or call compiles to runnable WASM', async () => {
        const { wat, errors } = compileToWat(`
            @type Option[T] := $Some value:T | $None;
            @fn unwrap_or[T] opt:Option[T], dflt:T := {
                &@match opt, $Some v => v, $None => dflt
            };
            @fn pick:Int := (&unwrap_or (&Some 42), 0);
            @fn miss:Int := (&unwrap_or (&None), 7);
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
        ok(`@type Option[T] := $Some value:T | $None;
            @fn nested:Option[Option[Int]] := (&Some (&Some 42));`)
    })

    test('4a: nested with concrete dflt (no &None) — should work', () => {
        // Dflt is &Some 0 which has type Option[Int]; T is unambiguously Option[Int].
        ok(`@type Option[T] := $Some value:T | $None;
            @fn unwrap_or[T] opt:Option[T], dflt:T := {
                &@match opt, $Some v => v, $None => dflt
            };
            @fn nested:Option[Int] := {
                &unwrap_or (&Some (&Some 42)), (&Some 0)
            };`)
    })

    test('4b: nested with &None dflt — the failing case', () => {
        ok(`@type Option[T] := $Some value:T | $None;
            @fn unwrap_or[T] opt:Option[T], dflt:T := {
                &@match opt, $Some v => v, $None => dflt
            };
            @fn nested:Option[Int] := {
                &unwrap_or (&Some (&Some 42)), (&None)
            };`)
    })
})

describe('Gap 5: generic used inside non-generic context', () => {
    test('non-generic fn calls generic fn with concrete arg', () => {
        ok(`@fn id[T] x:T := x;
            @fn use_in_arith:Int := { (&id 5) + 3 };`)
    })

    test('generic constructor used in non-generic position', () => {
        ok(`@type Option[T] := $Some value:T | $None;
            @fn maybe_int:Int := {
                @local x:Option[Int] := (&Some 7);
                &@match x, $Some v => v, $None => 0
            };`)
    })
})

describe('Gap 6: generic fn body contains generic call to another fn', () => {
    test('higher: unwrap with explicit inner call', () => {
        ok(`@type Option[T] := $Some value:T | $None;
            @fn unwrap_or[T] opt:Option[T], dflt:T := {
                &@match opt, $Some v => v, $None => dflt
            };
            # second generic fn that itself calls unwrap_or with its own T
            @fn unwrap_double[T] opt:Option[T], dflt:T := {
                &unwrap_or opt, dflt
            };
            @fn use:Int := (&unwrap_double (&Some 99), 0);`)
    })
})

describe('stdlib helpers: option_is_some / option_is_none / result_is_err', () => {
    const OPTION = `@type Option[T] := $Some value:T | $None;
        @fn option_is_some[T] opt:Option[T] := {
            &@match opt, $Some _v => @true, $None => @false
        };
        @fn option_is_none[T] opt:Option[T] := {
            &@match opt, $Some _v => @false, $None => @true
        };`
    const RESULT = `@type Result[T, E] := $Ok value:T | $Err error:E;
        @fn result_is_err[T, E] r:Result[T, E] := {
            &@match r, $Ok _v => @false, $Err _e => @true
        };`

    test('option_is_some/some Int → true', () => {
        ok(`${OPTION}
            @fn check:Bool := (&option_is_some (&Some 7));`)
    })

    test('option_is_some/none with annotation', () => {
        ok(`${OPTION}
            @fn check:Bool := {
                @local x:Option[Int] := (&None);
                &option_is_some x
            };`)
    })

    test('option_is_none over Float', () => {
        ok(`${OPTION}
            @fn check:Bool := (&option_is_none (&Some 1.5));`)
    })

    test('result_is_err on Ok and Err of distinct types', () => {
        ok(`${RESULT}
            @fn a:Bool := (&result_is_err (&Ok 42));
            @fn b:Bool := (&result_is_err (&Err 'oops'));`)
    })
})
