// SPDX-License-Identifier: MIT
/**
 * Phase 5d-3 — function-type as a first-class SiliconType (surface side).
 *
 * Proves the `$fn` sigil annotation parses, flows through the typechecker,
 * and produces a `Function`-kind SiliconType with the right param and
 * result types.
 *
 * Tests inspect the typechecker's recorded FunctionSig for a function
 * whose own *parameter* is typed `:$fn _:R _:T1, _:T2`.  This shape works
 * today because callback parameters don't require constructing a Function
 * value — that's deferred to 5d-1/5d-2 (function-reference table +
 * call_indirect codegen).  Once those land, return-type-annotated function
 * values become assignable too.
 */

import { test, expect, describe } from 'bun:test'
import parse from '../parser'
import addToAstSemantics from '../ast/toAst'
import siliconGrammar from '../grammar/SiliconGrammar'
import { buildStrataRegistry } from '../elaborator/strataLoader'
import elaborate from '../elaborator/elaborator'
import typecheck from './typechecker'
import { FunctionOf, TypeInt, TypeFloat, TypeBool, typeEquals } from './types'

function check(src: string) {
    const prog = addToAstSemantics(siliconGrammar)(parse(src)).toAst() as any
    const registry = buildStrataRegistry(prog)
    const elab = elaborate(prog, registry)
    return typecheck(elab.program, registry)
}

describe('Phase 5d-3: $fn surface annotation resolves to a Function SiliconType', () => {
    test('parameter `:$fn _:Int` (nullary callback) → Function([], Int)', () => {
        const { errors, functions } = check(`@fn run cb:$fn _:Int := 0;`)
        expect(errors.length).toBe(0)
        const sig = functions.get('run')
        expect(sig).toBeDefined()
        expect(sig!.params.length).toBe(1)
        expect(typeEquals(sig!.params[0], FunctionOf([], TypeInt))).toBe(true)
    })

    test('parameter `:$fn _:Bool _:Int` (unary callback) → Function([Int], Bool)', () => {
        const { errors, functions } = check(`@fn run cb:$fn _:Bool _:Int := 0;`)
        expect(errors.length).toBe(0)
        const sig = functions.get('run')
        expect(typeEquals(sig!.params[0], FunctionOf([TypeInt], TypeBool))).toBe(true)
    })

    test('parameter `:$fn _:Int _:Int, _:Float, _:Bool` (3-ary callback)', () => {
        const { errors, functions } = check(`@fn run cb:$fn _:Int _:Int, _:Float, _:Bool := 0;`)
        expect(errors.length).toBe(0)
        const sig = functions.get('run')
        expect(typeEquals(sig!.params[0], FunctionOf([TypeInt, TypeFloat, TypeBool], TypeInt))).toBe(true)
    })

    test('Function types are nominally distinct by params and result', () => {
        // Two callback annotations differing only in one slot must remain
        // distinct under typeEquals — this is the core invariant for
        // later call_indirect typing (5d-2).
        const { functions } = check(`
            @fn a cb:$fn _:Int _:Int := 0;
            @fn b cb:$fn _:Int _:Float := 0;
        `)
        const ra = (functions.get('a') as any).params[0]
        const rb = (functions.get('b') as any).params[0]
        expect(typeEquals(ra, rb)).toBe(false)
    })
})

// ---------------------------------------------------------------------------
// Known 1.0 limitation: when an outer function takes MORE THAN ONE
// `$fn`-typed parameter, the outer commas get eaten by the inner
// `sigilFnParams` rule.  E.g.:
//
//   @fn run a:$fn _:Int _:Int, b:$fn _:Bool _:Float := 0;
//
// parses with a single param `a` whose sigilFnParams swallows
// `_:Int, b:$fn _:Bool _:Float`.  Disambiguating requires either a
// terminator in the $fn grammar production (a closing sigil) or
// parenthesised type forms — both are 1.x grammar revisions.  Today's
// workaround: declare each callback in its own dedicated function.
// ---------------------------------------------------------------------------
