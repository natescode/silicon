/**
 * Strata Loader Tests
 *
 * Tests for buildStrataRegistry in isolation from the elaboration walk.
 * Verifies that built-in strata are registered correctly and that
 * user-defined strata from the AST are picked up and merged in.
 */

import { test, expect } from 'bun:test'
import { buildStrataRegistry } from './strataLoader'
import { lookupTypedOperator, lookupTypedKeyword } from './registry'
import { ASTFactory } from '../ast/astNodes'
import { StrataType } from './strataenum'
import { TypeInt, TypeFloat, TypeBool } from '../types/types'
import parse from '../parser'
import addToAstSemantics from '../ast/toAst'
import siliconGrammar from '../grammar/SiliconGrammar'

// ---------------------------------------------------------------------------
// Built-in strata registration
// ---------------------------------------------------------------------------

test("buildStrataRegistry: returns an ElaboratorRegistry", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(registry).toBeDefined()
    expect(typeof registry.operators).toBe('object')
    expect(typeof registry.keywords).toBe('object')
    expect(typeof registry.defKinds).toBe('object')
})

test("buildStrataRegistry: registers arithmetic operators", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    for (const op of ['+', '-', '*', '/', '%']) {
        expect(registry.operators[op]).toBeDefined()
        expect(registry.operators[op].discriminant).toBe(op)
    }
})

test("buildStrataRegistry: registers comparison operators", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    for (const op of ['==', '!=', '<', '>', '<=', '>=']) {
        expect(registry.operators[op]).toBeDefined()
    }
})

test("buildStrataRegistry: registers bitwise operators", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    for (const op of ['|', '^', '<<', '>>']) {
        expect(registry.operators[op]).toBeDefined()
        expect(registry.operators[op].data?.intrinsic).toMatch(/^IR::i32_/)
    }
})

test("buildStrataRegistry: registers || as operator stratum", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(registry.operators['||']).toBeDefined()
})

test("buildStrataRegistry: registers @if as Control stratum", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const entry = registry.keywords['@if']
    expect(entry).toBeDefined()
    expect(entry.type).toBe(StrataType.Control)
    expect(entry.data?.intrinsic).toBe('IR::control_if')
})

test("buildStrataRegistry: registers @loop as Control stratum", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const entry = registry.keywords['@loop']
    expect(entry).toBeDefined()
    expect(entry.type).toBe(StrataType.Control)
    expect(entry.data?.intrinsic).toBe('IR::control_loop')
})

test("buildStrataRegistry: registers @break and @continue", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(registry.keywords['@break']?.data?.intrinsic).toBe('IR::control_break')
    expect(registry.keywords['@continue']?.data?.intrinsic).toBe('IR::control_continue')
})

test("buildStrataRegistry: registers @return", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(registry.keywords['@return']?.data?.intrinsic).toBe('IR::control_return')
})

test("buildStrataRegistry: registers @toInt and @toFloat cast strata", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(registry.keywords['@toInt']?.data?.intrinsic).toBe('IR::i32_trunc_f32_s')
    expect(registry.keywords['@toFloat']?.data?.intrinsic).toBe('IR::f32_convert_i32_s')
})

// ---------------------------------------------------------------------------
// Def-kinds registration
// ---------------------------------------------------------------------------

test("buildStrataRegistry: registers @let, @fn, @var def-kinds", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(registry.defKinds['@let']?.codegenKind).toBe('function')
    expect(registry.defKinds['@fn']?.codegenKind).toBe('function')
    expect(registry.defKinds['@var']?.codegenKind).toBe('global')
})

test("buildStrataRegistry: @let allows params and binding", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const entry = registry.defKinds['@let']
    expect(entry.allowsParams).toBe(true)
    expect(entry.allowsBinding).toBe(true)
})

test("buildStrataRegistry: @extern does not allow binding", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const entry = registry.defKinds['@extern']
    expect(entry).toBeDefined()
    expect(entry.allowsBinding).toBe(false)
})

// ---------------------------------------------------------------------------
// StrataData is typed — no raw body stored
// ---------------------------------------------------------------------------

test("buildStrataRegistry: StrataNode.data has intrinsic but no body property", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const plus = registry.operators['+']
    expect(plus.data?.intrinsic).toBe('IR::i32_add')
    // The raw body AST must not be stored — only derived data.
    expect((plus.data as any)?.body).toBeUndefined()
})

test("buildStrataRegistry: operator strata carry bodyTemplate as array of steps", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const plus = registry.operators['+']
    expect(plus.data?.bodyTemplate).toBeDefined()
    expect(Array.isArray(plus.data?.bodyTemplate)).toBe(true)
    // Single-step body: one entry with left/right arg refs.
    expect(plus.data?.bodyTemplate?.length).toBe(1)
    expect(plus.data?.bodyTemplate?.[0]?.argRefs).toEqual(['left', 'right'])
})

// ---------------------------------------------------------------------------
// User-defined strata from AST are picked up
// ---------------------------------------------------------------------------

test("buildStrataRegistry: user-defined @stratum_operator is registered", () => {
    const elab = ASTFactory.elaboration('operator', 'Custom', '@@', 'Node', undefined)
    const element = ASTFactory.element_elaboration(elab)
    const program = ASTFactory.program([element])
    const registry = buildStrataRegistry(program)
    expect(registry.operators['@@']).toBeDefined()
    expect(registry.operators['@@'].discriminant).toBe('@@')
})

test("buildStrataRegistry: user-defined @stratum_keyword is registered", () => {
    const elab = ASTFactory.elaboration('keyword', 'MyKw', '@mykw', 'Node', undefined)
    const element = ASTFactory.element_elaboration(elab)
    const program = ASTFactory.program([element])
    const registry = buildStrataRegistry(program)
    expect(registry.keywords['@mykw']).toBeDefined()
    expect(registry.keywords['@mykw'].discriminant).toBe('@mykw')
})

test("buildStrataRegistry: user strata override builtin on symbol clash", () => {
    // A user-defined '+' stratum should overwrite the builtin one.
    const elab = ASTFactory.elaboration('operator', 'CustomPlus', '+', 'Node', undefined)
    const element = ASTFactory.element_elaboration(elab)
    const program = ASTFactory.program([element])
    const registry = buildStrataRegistry(program)
    // The user's entry wins (no intrinsic since body was undefined).
    expect(registry.operators['+'].data?.intrinsic).toBeUndefined()
})

// ---------------------------------------------------------------------------
// Independence from elaborate()
// ---------------------------------------------------------------------------

test("buildStrataRegistry: result is independent from elaborate()", () => {
    // Two separate calls should produce equal but distinct registries.
    const r1 = buildStrataRegistry(ASTFactory.program([]))
    const r2 = buildStrataRegistry(ASTFactory.program([]))
    expect(Object.keys(r1.operators)).toEqual(Object.keys(r2.operators))
    expect(r1.operators).not.toBe(r2.operators)  // different objects
})

// ---------------------------------------------------------------------------
// Round 30: typeSignature populated at load time
// ---------------------------------------------------------------------------

test("buildStrataRegistry: '+' has typeSignature (Int, Int) -> Int", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const sig = registry.operators['+'].data?.typeSignature
    expect(sig).toBeDefined()
    expect(sig!.params).toEqual([TypeInt, TypeInt])
    expect(sig!.result).toEqual(TypeInt)
})

test("buildStrataRegistry: '*' has typeSignature (Int, Int) -> Int", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const sig = registry.operators['*'].data?.typeSignature
    expect(sig).toBeDefined()
    expect(sig!.params).toEqual([TypeInt, TypeInt])
    expect(sig!.result).toEqual(TypeInt)
})

test("buildStrataRegistry: '<' has typeSignature (Int, Int) -> Bool", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const sig = registry.operators['<'].data?.typeSignature
    expect(sig).toBeDefined()
    expect(sig!.params).toEqual([TypeInt, TypeInt])
    expect(sig!.result).toEqual(TypeBool)
})

test("buildStrataRegistry: '==' has typeSignature (Int, Int) -> Bool", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const sig = registry.operators['=='].data?.typeSignature
    expect(sig).toBeDefined()
    expect(sig!.result).toEqual(TypeBool)
})

test("buildStrataRegistry: @toFloat has typeSignature (Int) -> Float", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const sig = registry.keywords['@toFloat'].data?.typeSignature
    expect(sig).toBeDefined()
    expect(sig!.params).toEqual([TypeInt])
    expect(sig!.result).toEqual(TypeFloat)
})

test("buildStrataRegistry: @toInt has typeSignature (Float) -> Int", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const sig = registry.keywords['@toInt'].data?.typeSignature
    expect(sig).toBeDefined()
    expect(sig!.params).toEqual([TypeFloat])
    expect(sig!.result).toEqual(TypeInt)
})

test("buildStrataRegistry: control strata have no typeSignature (they are structural)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    // @if, @loop, @match are structural — no surface type sig derived from WASM name.
    expect(registry.keywords['@if'].data?.typeSignature).toBeUndefined()
    expect(registry.keywords['@loop'].data?.typeSignature).toBeUndefined()
})

test("buildStrataRegistry: user-defined strata with unknown intrinsic have undefined typeSignature", () => {
    const elab = ASTFactory.elaboration('operator', 'Custom', '@@', 'Node', undefined)
    const element = ASTFactory.element_elaboration(elab)
    const program = ASTFactory.program([element])
    const registry = buildStrataRegistry(program)
    // No body → no intrinsic → no typeSignature.
    expect(registry.operators['@@'].data?.typeSignature).toBeUndefined()
})

// ---------------------------------------------------------------------------
// Round 36: typed operator overloads via StrataType.Constraint
// ---------------------------------------------------------------------------

test("buildStrataRegistry: '+' primary is the Int (i32) variant", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(registry.operators['+']?.data?.intrinsic).toBe('IR::i32_add')
    expect(registry.operators['+']?.type).not.toBe(StrataType.Constraint)
})

test("buildStrataRegistry: '+' has a Float overload tagged as Constraint", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const floatOp = lookupTypedOperator(registry, '+', 'Float')
    expect(floatOp?.data?.intrinsic).toBe('IR::f32_add')
    expect(floatOp?.type).toBe(StrataType.Constraint)
})

test("buildStrataRegistry: '-' has a Float overload (f32.sub)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const floatOp = lookupTypedOperator(registry, '-', 'Float')
    expect(floatOp?.data?.intrinsic).toBe('IR::f32_sub')
})

test("buildStrataRegistry: '*' has a Float overload (f32.mul)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const floatOp = lookupTypedOperator(registry, '*', 'Float')
    expect(floatOp?.data?.intrinsic).toBe('IR::f32_mul')
})

test("buildStrataRegistry: '/' has a Float overload (f32.div)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const floatOp = lookupTypedOperator(registry, '/', 'Float')
    expect(floatOp?.data?.intrinsic).toBe('IR::f32_div')
})

test("buildStrataRegistry: '<' has a Float overload (f32.lt)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const floatOp = lookupTypedOperator(registry, '<', 'Float')
    expect(floatOp?.data?.intrinsic).toBe('IR::f32_lt')
})

test("buildStrataRegistry: '==' has a Float overload (f32.eq)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const floatOp = lookupTypedOperator(registry, '==', 'Float')
    expect(floatOp?.data?.intrinsic).toBe('IR::f32_eq')
})

test("buildStrataRegistry: bitwise '|' has no Float overload (no f32 counterpart)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    // Typed lookup falls back to Int primary for bitwise ops.
    const floatOp = lookupTypedOperator(registry, '|', 'Float')
    expect(floatOp?.data?.intrinsic).toBe('IR::i32_or')
})

test("buildStrataRegistry: lookupTypedOperator returns primary for unknown typeKind", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const result = lookupTypedOperator(registry, '+', 'Bool')
    expect(result?.data?.intrinsic).toBe('IR::i32_add')
})

test("buildStrataRegistry: user-defined typed overload is registered under compound key", () => {
    const src = `@stratum_operator MyPlus ('+', Node) = { &WASM::f32_add Node.left, Node.right; };`
    const match = parse(src)
    const prog = addToAstSemantics(siliconGrammar)(match).toAst() as any
    const registry = buildStrataRegistry(prog)
    const floatOp = lookupTypedOperator(registry, '+', 'Float')
    expect(floatOp?.data?.intrinsic).toBe('WASM::f32_add')
    // User's float variant overrides the builtin Float overload.
    expect(floatOp?.type).toBe(StrataType.Constraint)
})

// ---------------------------------------------------------------------------
// Round 34: multi-step strata bodies
// ---------------------------------------------------------------------------

test("buildStrataRegistry: multi-step strata body extracts all steps as an array", () => {
    // Drive through the full parse → registry path by parsing inline Silicon source.
    const src = `@stratum_operator Weird ('??', Node) = { &WASM::i32_add Node.left, Node.right; &WASM::i32_eqz; };`
    const match = parse(src)
    const prog = addToAstSemantics(siliconGrammar)(match).toAst() as any
    const registry = buildStrataRegistry(prog)
    const bt = registry.operators['??']?.data?.bodyTemplate
    expect(Array.isArray(bt)).toBe(true)
    expect(bt?.length).toBe(2)
    expect(bt?.[0]?.intrinsic).toBe('WASM::i32_add')
    expect(bt?.[0]?.argRefs).toEqual(['left', 'right'])
    expect(bt?.[1]?.intrinsic).toBe('WASM::i32_eqz')
    expect(bt?.[1]?.argRefs).toEqual([])
})

test("buildStrataRegistry: '>' has a Float overload (f32.gt)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const floatOp = lookupTypedOperator(registry, '>', 'Float')
    expect(floatOp?.data?.intrinsic).toBe('IR::f32_gt')
})

test("buildStrataRegistry: '<=' has a Float overload (f32.le)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const floatOp = lookupTypedOperator(registry, '<=', 'Float')
    expect(floatOp?.data?.intrinsic).toBe('IR::f32_le')
})

test("buildStrataRegistry: '>=' has a Float overload (f32.ge)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const floatOp = lookupTypedOperator(registry, '>=', 'Float')
    expect(floatOp?.data?.intrinsic).toBe('IR::f32_ge')
})

test("buildStrataRegistry: '!=' has a Float overload (f32.ne)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const floatOp = lookupTypedOperator(registry, '!=', 'Float')
    expect(floatOp?.data?.intrinsic).toBe('IR::f32_ne')
})

test("buildStrataRegistry: '%' has no Float overload (WASM has no f32 modulo)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    // Falls back to Int primary since no Float variant is registered.
    const floatOp = lookupTypedOperator(registry, '%', 'Float')
    expect(floatOp?.data?.intrinsic).toBe('IR::i32_rem_s')
})

test("buildStrataRegistry: bitwise '<<' falls back to Int primary for Float lookup", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const floatOp = lookupTypedOperator(registry, '<<', 'Float')
    expect(floatOp?.data?.intrinsic).toBe('IR::i32_shl')
})

// ---------------------------------------------------------------------------
// Round 37: keyword typed dispatch, metadata strata, || strata consistency
// ---------------------------------------------------------------------------

test("buildStrataRegistry: @toFloat registers typed variant @toFloat:Int", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    // @toFloat converts Int → Float, so it registers under the 'Int' typeKind.
    const typed = lookupTypedKeyword(registry, '@toFloat', 'Int')
    expect(typed?.data?.intrinsic).toBe('IR::f32_convert_i32_s')
})

test("buildStrataRegistry: @toInt registers typed variant @toInt:Float", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    // @toInt converts Float → Int, so it registers under the 'Float' typeKind.
    const typed = lookupTypedKeyword(registry, '@toInt', 'Float')
    expect(typed?.data?.intrinsic).toBe('IR::i32_trunc_f32_s')
})

test("buildStrataRegistry: @toFloat plain entry still exists (backward compat)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(registry.keywords['@toFloat']?.data?.intrinsic).toBe('IR::f32_convert_i32_s')
})

test("buildStrataRegistry: lookupTypedKeyword falls back to plain entry for unknown typeKind", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    // @toFloat has no 'Bool' variant — should fall back to the plain entry.
    const fallback = lookupTypedKeyword(registry, '@toFloat', 'Bool')
    expect(fallback?.data?.intrinsic).toBe('IR::f32_convert_i32_s')
})

test("buildStrataRegistry: @export keyword is registered (D-D-1 migrated to @stratum form)", () => {
    // D-D-1 migration: @export moved from `@stratum_keyword` to the new
    // `@stratum := { register::keyword '@export'; on::lower '@export', H; }` form.
    // The keyword is still registered and the lowerer fires the on::lower
    // handler — but the underlying StrataType and intrinsic markers are
    // no longer set (those were legacy-form artifacts).
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(registry.keywords['@export']).toBeDefined()
    expect(registry.handlers.lower.has('@export')).toBe(true)
})

test("buildStrataRegistry: @export registered in defKinds (D-D-1 migrated, codegenKind 'stratum_def')", () => {
    // D-D-1 migration: register::keyword now sets codegenKind to
    // 'stratum_def' — the lowerer routes to on::lower handlers for the
    // actual IR emission.
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const defKind = registry.defKinds['@export']
    expect(defKind).toBeDefined()
    expect(defKind.codegenKind).toBe('stratum_def')
})

test("buildStrataRegistry: || operator has IR::control_or intrinsic (strata-driven)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    // || is registered as an operator stratum, not hardcoded — verify via intrinsic.
    const entry = registry.operators['||']
    expect(entry?.data?.intrinsic).toBe('IR::control_or')
    expect(entry?.type).toBe(StrataType.Control)
})

// ---------------------------------------------------------------------------
// Round 40: IR expander hook — buildStrataRegistry populates registry.expanders
// ---------------------------------------------------------------------------

test("buildStrataRegistry: populates registry.expanders with built-in control-flow expanders", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    // All 8 built-in expanders must be registered.
    const expected = [
        'IR::control_if',
        'IR::control_loop',
        'IR::control_break',
        'IR::control_continue',
        'IR::control_return',
        'IR::control_and',
        'IR::control_or',
        'IR::control_match',
    ]
    for (const intrinsic of expected) {
        expect(registry.expanders.has(intrinsic)).toBe(true)
    }
})

test("buildStrataRegistry: expanders are callable functions", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const ifExpander = registry.expanders.get('IR::control_if')
    expect(typeof ifExpander).toBe('function')
})

test("buildStrataRegistry: expanders map is a Map instance", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(registry.expanders).toBeInstanceOf(Map)
})
