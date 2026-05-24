/**
 * Unit tests for the HM-lite unification core.
 *
 * Covers: unify, applySubst, composeSubst, occursIn, instantiate, fresh vars.
 * These are pure data-structure operations — no compiler context needed.
 */

import { test, expect, describe } from 'bun:test'
import {
    unify, applySubst, composeSubst, occursIn, instantiate,
    makeFreshGen, emptySubst, UnifyError,
} from './unify'
import type { Subst } from './unify'
import {
    TypeInt, TypeFloat, TypeBool, TypeString,
    SumOf, ArrayOf, FunctionOf, schemeOf,
    type SiliconType,
} from './types'

const Tvar = (name: string): SiliconType => ({ kind: 'Variable', name })

// ---------------------------------------------------------------------------
// applySubst
// ---------------------------------------------------------------------------

describe('applySubst', () => {
    test('identity substitution returns the type unchanged', () => {
        expect(applySubst(TypeInt, emptySubst())).toEqual(TypeInt)
        expect(applySubst(Tvar('T'), emptySubst())).toEqual(Tvar('T'))
    })

    test('replaces a bound Variable with its target', () => {
        const s: Subst = new Map([['T', TypeInt]])
        expect(applySubst(Tvar('T'), s)).toEqual(TypeInt)
    })

    test('leaves unbound Variables unchanged', () => {
        const s: Subst = new Map([['T', TypeInt]])
        expect(applySubst(Tvar('U'), s)).toEqual(Tvar('U'))
    })

    test('resolves chains: T → U → Int', () => {
        const s: Subst = new Map([['T', Tvar('U')], ['U', TypeInt]])
        expect(applySubst(Tvar('T'), s)).toEqual(TypeInt)
    })

    test('identity binding T ↦ T does not infinite-loop', () => {
        // Regression: an early version of applySubst recursed on the looked-up
        // binding without checking whether it was the same variable, so
        // `subst = { T → Variable('T') }` would loop forever.  Legitimate
        // case: a parametric variant scheme whose tvar matches the
        // discriminant's typeArg variable produces this exact substitution
        // (built by resolveVariantFieldTypes when both share name 'T').
        const s: Subst = new Map([['T', Tvar('T')]])
        expect(applySubst(Tvar('T'), s)).toEqual(Tvar('T'))
    })

    test('identity binding nested in a compound type also terminates', () => {
        const s: Subst = new Map([['T', Tvar('T')]])
        const nested = SumOf('Option', ['Some', 'None'], [Tvar('T')])
        expect(applySubst(nested, s)).toEqual(nested)
    })

    test('descends into Array element', () => {
        const s: Subst = new Map([['T', TypeFloat]])
        expect(applySubst(ArrayOf(Tvar('T')), s)).toEqual(ArrayOf(TypeFloat))
    })

    test('descends into Function params + result', () => {
        const s: Subst = new Map([['T', TypeInt]])
        const fn = FunctionOf([Tvar('T'), TypeBool], Tvar('T'))
        expect(applySubst(fn, s)).toEqual(FunctionOf([TypeInt, TypeBool], TypeInt))
    })

    test('descends into Sum typeArgs', () => {
        const s: Subst = new Map([['T', TypeInt]])
        const opt = SumOf('Option', ['Some', 'None'], [Tvar('T')])
        const result = applySubst(opt, s)
        expect(result).toEqual(SumOf('Option', ['Some', 'None'], [TypeInt]))
    })

    test('leaves non-parametric Sums alone', () => {
        const s: Subst = new Map([['T', TypeInt]])
        const color = SumOf('Color', ['Red', 'Green'])
        expect(applySubst(color, s)).toEqual(color)
    })
})

// ---------------------------------------------------------------------------
// composeSubst
// ---------------------------------------------------------------------------

describe('composeSubst', () => {
    test('composes T↦U with U↦Int → T↦Int, U↦Int', () => {
        const s1: Subst = new Map([['T', Tvar('U')]])
        const s2: Subst = new Map([['U', TypeInt]])
        const composed = composeSubst(s2, s1)
        // Applying the composed subst to T should resolve all the way.
        expect(applySubst(Tvar('T'), composed)).toEqual(TypeInt)
        expect(applySubst(Tvar('U'), composed)).toEqual(TypeInt)
    })

    test('empty ∘ s = s', () => {
        const s: Subst = new Map([['T', TypeInt]])
        const composed = composeSubst(emptySubst(), s)
        expect(applySubst(Tvar('T'), composed)).toEqual(TypeInt)
    })

    test('s ∘ empty = s', () => {
        const s: Subst = new Map([['T', TypeInt]])
        const composed = composeSubst(s, emptySubst())
        expect(applySubst(Tvar('T'), composed)).toEqual(TypeInt)
    })
})

// ---------------------------------------------------------------------------
// occursIn
// ---------------------------------------------------------------------------

describe('occursIn', () => {
    test('true for the variable itself', () => {
        expect(occursIn('T', Tvar('T'))).toBe(true)
    })

    test('false for a different variable', () => {
        expect(occursIn('T', Tvar('U'))).toBe(false)
    })

    test('false for a primitive', () => {
        expect(occursIn('T', TypeInt)).toBe(false)
    })

    test('true if nested in an Array', () => {
        expect(occursIn('T', ArrayOf(Tvar('T')))).toBe(true)
    })

    test('true if nested in Function params or result', () => {
        expect(occursIn('T', FunctionOf([Tvar('T')], TypeInt))).toBe(true)
        expect(occursIn('T', FunctionOf([TypeInt], Tvar('T')))).toBe(true)
    })

    test('true if nested in Sum typeArgs', () => {
        expect(occursIn('T', SumOf('Option', ['Some'], [Tvar('T')]))).toBe(true)
    })
})

// ---------------------------------------------------------------------------
// unify
// ---------------------------------------------------------------------------

describe('unify', () => {
    test('two equal primitives unify with empty subst', () => {
        expect(unify(TypeInt, TypeInt).size).toBe(0)
    })

    test('two different primitives fail', () => {
        expect(() => unify(TypeInt, TypeFloat)).toThrow(UnifyError)
    })

    test('Variable unifies with primitive (binds)', () => {
        const s = unify(Tvar('T'), TypeInt)
        expect(s.get('T')).toEqual(TypeInt)
    })

    test('order-symmetric: primitive with Variable also binds', () => {
        const s = unify(TypeInt, Tvar('T'))
        expect(s.get('T')).toEqual(TypeInt)
    })

    test('two variables unify (binds one to the other)', () => {
        const s = unify(Tvar('T'), Tvar('U'))
        // One of them ends up pointing at the other.
        expect(applySubst(Tvar('T'), s)).toEqual(applySubst(Tvar('U'), s))
    })

    test('occurs check rejects T = Array[T]', () => {
        expect(() => unify(Tvar('T'), ArrayOf(Tvar('T')))).toThrow(/occurs check/)
    })

    test('Functions unify pointwise', () => {
        const f1 = FunctionOf([Tvar('T'), TypeBool], Tvar('T'))
        const f2 = FunctionOf([TypeInt, Tvar('U')], TypeInt)
        const s = unify(f1, f2)
        expect(s.get('T')).toEqual(TypeInt)
        expect(s.get('U')).toEqual(TypeBool)
    })

    test('Functions with different arity fail', () => {
        const f1 = FunctionOf([TypeInt], TypeInt)
        const f2 = FunctionOf([TypeInt, TypeInt], TypeInt)
        expect(() => unify(f1, f2)).toThrow(/arity mismatch/)
    })

    test('parametric Sums unify when name + typeArgs unify', () => {
        const opt1 = SumOf('Option', ['Some', 'None'], [Tvar('T')])
        const opt2 = SumOf('Option', ['Some', 'None'], [TypeInt])
        const s = unify(opt1, opt2)
        expect(s.get('T')).toEqual(TypeInt)
    })

    test('parametric Sums with same name but different concrete args FAIL', () => {
        const optInt   = SumOf('Option', ['Some', 'None'], [TypeInt])
        const optFloat = SumOf('Option', ['Some', 'None'], [TypeFloat])
        expect(() => unify(optInt, optFloat)).toThrow()
    })

    test('different Sum names FAIL even with matching args', () => {
        const aT = SumOf('A', [], [TypeInt])
        const bT = SumOf('B', [], [TypeInt])
        expect(() => unify(aT, bT)).toThrow()
    })

    test('Unknown unifies with anything trivially', () => {
        expect(unify({ kind: 'Unknown' }, TypeInt).size).toBe(0)
        expect(unify(TypeInt, { kind: 'Unknown' }).size).toBe(0)
    })

    test('nested generic: List[Option[T]] vs List[Option[Int]] binds T=Int', () => {
        const listOptT = ArrayOf(SumOf('Option', [], [Tvar('T')]))
        const listOptI = ArrayOf(SumOf('Option', [], [TypeInt]))
        const s = unify(listOptT, listOptI)
        expect(s.get('T')).toEqual(TypeInt)
    })
})

// ---------------------------------------------------------------------------
// instantiate
// ---------------------------------------------------------------------------

describe('instantiate', () => {
    test('monomorphic scheme returns the type unchanged', () => {
        const s = schemeOf([], TypeInt)
        const fresh = makeFreshGen()
        expect(instantiate(s, fresh)).toEqual(TypeInt)
    })

    test('polymorphic scheme replaces bound vars with fresh ones', () => {
        const idScheme = schemeOf(['T'], FunctionOf([Tvar('T')], Tvar('T')))
        const fresh = makeFreshGen()
        const inst = instantiate(idScheme, fresh) as any
        expect(inst.kind).toBe('Function')
        // params[0] and result share the same fresh var.
        expect(inst.params[0]).toEqual(inst.result)
        // The fresh var is NOT 'T' anymore — it's been renamed.
        expect(inst.params[0].name).not.toBe('T')
        expect(inst.params[0].name).toMatch(/^\?T\d+/)
    })

    test('two instantiations of the same scheme get independent fresh vars', () => {
        const idScheme = schemeOf(['T'], FunctionOf([Tvar('T')], Tvar('T')))
        const fresh = makeFreshGen()
        const a = instantiate(idScheme, fresh) as any
        const b = instantiate(idScheme, fresh) as any
        // Different concrete fresh-var names.
        expect(a.params[0].name).not.toBe(b.params[0].name)
    })
})

// ---------------------------------------------------------------------------
// End-to-end: instantiate + unify
// ---------------------------------------------------------------------------

describe('instantiate + unify (the HM-lite call-site flow)', () => {
    test('calling id : ∀T. T→T with Int infers T = Int and result = Int', () => {
        const idScheme = schemeOf(['T'], FunctionOf([Tvar('T')], Tvar('T')))
        const fresh = makeFreshGen()
        const inst = instantiate(idScheme, fresh) as any   // (?T1) → ?T1
        // The call site has arg of type Int. Unify the param with Int.
        const s = unify(inst.params[0], TypeInt)
        // The result type, after subst, is Int.
        expect(applySubst(inst.result, s)).toEqual(TypeInt)
    })

    test('calling Some : ∀T. T→Option[T] with String gives Option[String]', () => {
        const someScheme = schemeOf(['T'],
            FunctionOf([Tvar('T')], SumOf('Option', ['Some', 'None'], [Tvar('T')])))
        const fresh = makeFreshGen()
        const inst = instantiate(someScheme, fresh) as any
        const s = unify(inst.params[0], TypeString)
        const resultType = applySubst(inst.result, s) as any
        expect(resultType.kind).toBe('Sum')
        expect(resultType.name).toBe('Option')
        expect(resultType.typeArgs).toEqual([TypeString])
    })

    test('calling pair : ∀A,B. (A,B)→Pair[A,B] with (Int, String) infers both', () => {
        const pairScheme = schemeOf(['A', 'B'],
            FunctionOf([Tvar('A'), Tvar('B')], SumOf('Pair', ['Pair'], [Tvar('A'), Tvar('B')])))
        const fresh = makeFreshGen()
        const inst = instantiate(pairScheme, fresh) as any
        let s = unify(inst.params[0], TypeInt)
        s = unify(inst.params[1], TypeString, s)
        const resultType = applySubst(inst.result, s) as any
        expect(resultType.typeArgs).toEqual([TypeInt, TypeString])
    })
})
