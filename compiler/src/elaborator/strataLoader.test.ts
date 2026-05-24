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

test("buildStrataRegistry: registers bitwise operators (D-D-4 migrated)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    for (const op of ['|', '^', '<<', '>>']) {
        expect(registry.operators[op]).toBeDefined()
        // Dispatch via on::lower handler instead of legacy intrinsic field.
        expect(registry.handlers.lower.has(op)).toBe(true)
    }
})

test("buildStrataRegistry: registers || as operator stratum", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(registry.operators['||']).toBeDefined()
})

test("buildStrataRegistry: registers @if (D-D-2 migrated to new @stratum form)", () => {
    // D-D-2: @if rewritten to `@stratum If := { register::expression_keyword '@if'; on::lower '@if', If_lower; }`.
    // StrataType.Keyword (not Control) and no intrinsic field — the new-form
    // typechecker / lowerer dispatch via the on::lower handler instead.
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const entry = registry.keywords['@if']
    expect(entry).toBeDefined()
    expect(entry.type).toBe(StrataType.Keyword)
    expect(registry.handlers.lower.has('@if')).toBe(true)
})

test("buildStrataRegistry: registers @loop (D-D-9 migrated; on::lower handler)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const entry = registry.keywords['@loop']
    expect(entry).toBeDefined()
    expect(registry.handlers.lower.has('@loop')).toBe(true)
})

test("buildStrataRegistry: registers @break and @continue (D-D-8 migrated)", () => {
    // D-D-8: dispatch now via on::lower handler, not legacy intrinsic.
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(registry.keywords['@break']).toBeDefined()
    expect(registry.keywords['@continue']).toBeDefined()
    expect(registry.handlers.lower.has('@break')).toBe(true)
    expect(registry.handlers.lower.has('@continue')).toBe(true)
})

test("buildStrataRegistry: registers @return (D-D-8 migrated)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(registry.keywords['@return']).toBeDefined()
    expect(registry.handlers.lower.has('@return')).toBe(true)
})

test("buildStrataRegistry: registers @toInt and @toFloat cast strata (D-D-5 migrated)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(registry.keywords['@toInt']).toBeDefined()
    expect(registry.keywords['@toFloat']).toBeDefined()
    expect(registry.handlers.lower.has('@toInt')).toBe(true)
    expect(registry.handlers.lower.has('@toFloat')).toBe(true)
})

// ---------------------------------------------------------------------------
// Def-kinds registration
// ---------------------------------------------------------------------------

test("buildStrataRegistry: registers @let, @fn, @var def-kinds (D-D-11b migrated; @var still legacy)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    // D-D-11b migrated @let/@fn — both now codegenKind 'stratum_def'.
    // @var stays legacy (codegenKind 'global') pending D-D-11c.
    expect(registry.defKinds['@let']?.codegenKind).toBe('stratum_def')
    expect(registry.defKinds['@fn']?.codegenKind).toBe('stratum_def')
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

test("buildStrataRegistry: '+' is registered (D-D-7a migrated; dispatches via on::lower)", () => {
    // D-D-7a migrated '+' (and other Int arithmetic/comparison operators) to
    // the new @stratum form.  No intrinsic / bodyTemplate fields on the
    // primary entry; the on::lower handler synthesises the IRBinOp directly.
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const plus = registry.operators['+']
    expect(plus).toBeDefined()
    expect(registry.handlers.lower.has('+')).toBe(true)
    expect((plus.data as any)?.body).toBeUndefined()
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

// D-D-7a migrated: Int arithmetic/comparison operators no longer carry a
// typeSignature on the primary entry (no intrinsic to derive it from).  The
// typechecker uses the legacy Float/Int64 overloads' signatures for typed
// dispatch and falls back to the on::lower handler for Int.
test("buildStrataRegistry: '+' registered with on::lower handler (D-D-7a migrated)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(registry.operators['+']).toBeDefined()
    expect(registry.handlers.lower.has('+')).toBe(true)
})

test("buildStrataRegistry: '*' registered with on::lower handler (D-D-7a migrated)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(registry.operators['*']).toBeDefined()
    expect(registry.handlers.lower.has('*')).toBe(true)
})

test("buildStrataRegistry: '<' registered with on::lower handler (D-D-7b migrated)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(registry.operators['<']).toBeDefined()
    expect(registry.handlers.lower.has('<')).toBe(true)
})

test("buildStrataRegistry: '==' registered with on::lower handler (D-D-7b migrated)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(registry.operators['==']).toBeDefined()
    expect(registry.handlers.lower.has('==')).toBe(true)
})

// D-D-5 migrated: cast keywords no longer carry typeSignature on the
// primary entry.  The typechecker hardcodes their signatures (see
// typechecker.ts migratedCastSig) so behavior is preserved.
test("buildStrataRegistry: @toFloat dispatches via on::lower (D-D-5 migrated)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(registry.keywords['@toFloat']).toBeDefined()
    expect(registry.handlers.lower.has('@toFloat')).toBe(true)
})

test("buildStrataRegistry: @toInt dispatches via on::lower (D-D-5 migrated)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(registry.keywords['@toInt']).toBeDefined()
    expect(registry.handlers.lower.has('@toInt')).toBe(true)
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

test("buildStrataRegistry: '+' primary is the Int (i32) variant (D-D-7a migrated)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    // D-D-7a: primary now dispatches via on::lower (no intrinsic field).
    expect(registry.operators['+']).toBeDefined()
    expect(registry.handlers.lower.has('+')).toBe(true)
    expect(registry.operators['+']?.type).not.toBe(StrataType.Constraint)
})

// D-D-7c migrated: Float overloads no longer carry data.intrinsic — they
// dispatch via the typed on::lower handler (registered under '+:Float' etc.).
test("buildStrataRegistry: '+' has a Float overload (D-D-7c migrated)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(lookupTypedOperator(registry, '+', 'Float')).toBeDefined()
    expect(registry.handlers.lower.has('+:Float')).toBe(true)
})

test("buildStrataRegistry: '-' has a Float overload (D-D-7c migrated)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(lookupTypedOperator(registry, '-', 'Float')).toBeDefined()
    expect(registry.handlers.lower.has('-:Float')).toBe(true)
})

test("buildStrataRegistry: '*' has a Float overload (D-D-7c migrated)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(lookupTypedOperator(registry, '*', 'Float')).toBeDefined()
    expect(registry.handlers.lower.has('*:Float')).toBe(true)
})

test("buildStrataRegistry: '/' has a Float overload (D-D-7c migrated)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(lookupTypedOperator(registry, '/', 'Float')).toBeDefined()
    expect(registry.handlers.lower.has('/:Float')).toBe(true)
})

test("buildStrataRegistry: '<' has a Float overload (D-D-7c migrated)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(lookupTypedOperator(registry, '<', 'Float')).toBeDefined()
    expect(registry.handlers.lower.has('<:Float')).toBe(true)
})

test("buildStrataRegistry: '==' has a Float overload (D-D-7c migrated)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(lookupTypedOperator(registry, '==', 'Float')).toBeDefined()
    expect(registry.handlers.lower.has('==:Float')).toBe(true)
})

test("buildStrataRegistry: bitwise '|' has no Float overload (no f32 counterpart) (D-D-4 migrated)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    // Typed lookup falls back to Int primary for bitwise ops.  After D-D-4
    // migration, the primary entry no longer carries intrinsic; we just
    // confirm typed lookup falls through to it.
    const floatOp = lookupTypedOperator(registry, '|', 'Float')
    expect(floatOp).toBeDefined()
})

test("buildStrataRegistry: lookupTypedOperator returns primary for unknown typeKind (D-D-7a migrated)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const result = lookupTypedOperator(registry, '+', 'Bool')
    // D-D-7a: primary `+` no longer has intrinsic; dispatch via on::lower.
    expect(result).toBeDefined()
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

test("buildStrataRegistry: '>' has a Float overload (D-D-7c migrated)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(lookupTypedOperator(registry, '>', 'Float')).toBeDefined()
    expect(registry.handlers.lower.has('>:Float')).toBe(true)
})

test("buildStrataRegistry: '<=' has a Float overload (D-D-7c migrated)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(lookupTypedOperator(registry, '<=', 'Float')).toBeDefined()
    expect(registry.handlers.lower.has('<=:Float')).toBe(true)
})

test("buildStrataRegistry: '>=' has a Float overload (D-D-7c migrated)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(lookupTypedOperator(registry, '>=', 'Float')).toBeDefined()
    expect(registry.handlers.lower.has('>=:Float')).toBe(true)
})

test("buildStrataRegistry: '!=' has a Float overload (D-D-7c migrated)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(lookupTypedOperator(registry, '!=', 'Float')).toBeDefined()
    expect(registry.handlers.lower.has('!=:Float')).toBe(true)
})

test("buildStrataRegistry: '%' has no Float overload (D-D-7a migrated; Int primary)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    // Falls back to Int primary (D-D-7a migrated; on::lower handler-driven).
    const floatOp = lookupTypedOperator(registry, '%', 'Float')
    expect(floatOp).toBeDefined()
})

test("buildStrataRegistry: bitwise '<<' falls back to Int primary for Float lookup (D-D-4 migrated)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const floatOp = lookupTypedOperator(registry, '<<', 'Float')
    expect(floatOp).toBeDefined()
})

// ---------------------------------------------------------------------------
// Round 37: keyword typed dispatch, metadata strata, || strata consistency
// ---------------------------------------------------------------------------

// D-D-5 migrated: cast keywords no longer register typed variants and the
// primary no longer carries an intrinsic.  Dispatch is via on::lower handler
// (Int/Float primary) plus the legacy Int64 overload (ToIntFromInt64).
test("buildStrataRegistry: @toFloat primary registered (D-D-5 migrated)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(registry.keywords['@toFloat']).toBeDefined()
    expect(registry.handlers.lower.has('@toFloat')).toBe(true)
})

test("buildStrataRegistry: @toInt primary registered (D-D-5 migrated)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(registry.keywords['@toInt']).toBeDefined()
    expect(registry.handlers.lower.has('@toInt')).toBe(true)
})

test("buildStrataRegistry: lookupTypedKeyword falls back to plain entry for unknown typeKind (D-D-5 migrated)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    // After D-D-5, plain entry no longer has intrinsic; just check it exists.
    const fallback = lookupTypedKeyword(registry, '@toFloat', 'Bool')
    expect(fallback).toBeDefined()
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

test("buildStrataRegistry: || operator is registered (D-D-3 migrated; on::lower-driven)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const entry = registry.operators['||']
    expect(entry).toBeDefined()
    expect(registry.handlers.lower.has('||')).toBe(true)
})

// ---------------------------------------------------------------------------
// Round 40: IR expander hook — buildStrataRegistry populates registry.expanders
// ---------------------------------------------------------------------------

test("buildStrataRegistry: registry.expanders is empty after D-D-2/3/4/6/7/8/9/10 migrations", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    // All built-in control-flow strata have been migrated to the new @stratum
    // form and now dispatch via on::lower handlers.  The legacy intrinsic
    // expander registry no longer contains them.
    expect(registry.expanders.size).toBe(0)
})

test("buildStrataRegistry: expanders map is a Map instance and is empty after migrations", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(registry.expanders).toBeInstanceOf(Map)
    expect(registry.expanders.size).toBe(0)
})

test("buildStrataRegistry: expanders map is a Map instance", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(registry.expanders).toBeInstanceOf(Map)
})
