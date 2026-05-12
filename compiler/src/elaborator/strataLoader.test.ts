/**
 * Strata Loader Tests
 *
 * Tests for buildStrataRegistry in isolation from the elaboration walk.
 * Verifies that built-in strata are registered correctly and that
 * user-defined strata from the AST are picked up and merged in.
 */

import { test, expect } from 'bun:test'
import { buildStrataRegistry } from './strataLoader'
import { ASTFactory } from '../ast/astNodes'
import { StrataType } from './strataenum'

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
        expect(registry.operators[op].data?.intrinsic).toMatch(/^WASM::i32_/)
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
    expect(entry.data?.intrinsic).toBe('WASM::control_if')
})

test("buildStrataRegistry: registers @loop as Control stratum", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const entry = registry.keywords['@loop']
    expect(entry).toBeDefined()
    expect(entry.type).toBe(StrataType.Control)
    expect(entry.data?.intrinsic).toBe('WASM::control_loop')
})

test("buildStrataRegistry: registers @break and @continue", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(registry.keywords['@break']?.data?.intrinsic).toBe('WASM::control_break')
    expect(registry.keywords['@continue']?.data?.intrinsic).toBe('WASM::control_continue')
})

test("buildStrataRegistry: registers @return", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(registry.keywords['@return']?.data?.intrinsic).toBe('WASM::control_return')
})

test("buildStrataRegistry: registers @toInt and @toFloat cast strata", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    expect(registry.keywords['@toInt']?.data?.intrinsic).toBe('WASM::i32_trunc_f32_s')
    expect(registry.keywords['@toFloat']?.data?.intrinsic).toBe('WASM::f32_convert_i32_s')
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
    expect(plus.data?.intrinsic).toBe('WASM::i32_add')
    // The raw body AST must not be stored — only derived data.
    expect((plus.data as any)?.body).toBeUndefined()
})

test("buildStrataRegistry: operator strata carry bodyTemplate with argRefs", () => {
    const registry = buildStrataRegistry(ASTFactory.program([]))
    const plus = registry.operators['+']
    expect(plus.data?.bodyTemplate).toBeDefined()
    expect(plus.data?.bodyTemplate?.argRefs).toEqual(['left', 'right'])
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
