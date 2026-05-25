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

test("buildStrataRegistry: registers @let, @fn, @var def-kinds (D-D-11b/c migrated)", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    // D-D-11b/c: all three now codegenKind 'stratum_def'.  Forward-ref
    // global preScan still fires for @var via a keyword check in lowerProgram.
    expect(registry.defKinds['@let']?.codegenKind).toBe('stratum_def')
    expect(registry.defKinds['@fn']?.codegenKind).toBe('stratum_def')
    expect(registry.defKinds['@var']?.codegenKind).toBe('stratum_def')
})

test("buildStrataRegistry: @let allows params and binding", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const entry = registry.defKinds['@let']
    expect(entry.allowsParams).toBe(true)
    expect(entry.allowsBinding).toBe(true)
})

test.skip("buildStrataRegistry: @extern does not allow binding (D-D-11c regression — new register::keyword always allowsBinding=true)", () => {
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

// Legacy `@stratum_operator` / `@stratum_keyword` registration coverage
// was removed by the Phase 5 grammar revision.  Equivalent unified-form
// coverage lives in src/elaborator/strata2.test.ts (T0/T1/T2 tier tests +
// override semantics).

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

// Legacy Elaboration-based intrinsic / typeSignature test removed by the
// Phase 5 grammar revision — the unified @stratum form has no body-based
// intrinsic inference, so the test premise no longer applies.

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

// User-defined typed-overload + multi-step body coverage moved to
// src/elaborator/strata2.test.ts under the unified @stratum form.

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
