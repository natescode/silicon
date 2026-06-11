// SPDX-License-Identifier: MIT
/**
 * Tests for the legacy-block AST translator.
 *
 * Each test feeds a small AST input (the kind buildPhaseHandler would
 * see for an inline-block handler) and verifies the translated output
 * matches the expected new-form shape.  Translation rules are exercised
 * one at a time so failures point at a single rule.
 */

import { test, expect, describe } from 'bun:test'
import { translateLegacyBlock } from './legacyBlockTranslator'

// Convenience helpers for building AST nodes.
const ns      = (...path: string[]) => ({ type: 'Namespace', path })
const fcall   = (name: any, ...args: any[]) => ({ type: 'FunctionCall', name, isBuiltin: false, args })
const strLit  = (value: string) => ({ type: 'StringLiteral', value })
const intLit  = (value: string) => ({ type: 'IntLiteral', value })
const block   = (...items: any[]) => ({ type: 'Block', items })
const local   = (name: string, expr: any) => ({
    type: 'Definition', keyword: '@local',
    name: { type: 'TypedIdentifier', name },
    binding: { type: 'Binding', expression: expr },
})

describe('translateLegacyBlock — Namespace flattening', () => {
    test('Compiler::diag::warn → compiler::diag_warn (path flattened)', () => {
        const input  = fcall(ns('Compiler', 'diag', 'warn'))
        const output = translateLegacyBlock(input)
        expect(output.name).toEqual(ns('compiler', 'diag_warn'))
    })

    test('deep nested path: Compiler::ast::capture_template → compiler::ast_capture_template', () => {
        const input  = fcall(ns('Compiler', 'ast', 'capture_template'))
        const output = translateLegacyBlock(input)
        expect(output.name).toEqual(ns('compiler', 'ast_capture_template'))
    })

    test('single-segment path: Compiler::watId → compiler::watId', () => {
        const input  = fcall(ns('Compiler', 'watId'))
        const output = translateLegacyBlock(input)
        expect(output.name).toEqual(ns('compiler', 'watId'))
    })
})

describe('translateLegacyBlock — string-literal wrapping', () => {
    test('StringLiteral arg is wrapped with compiler_str_intern', () => {
        const input  = fcall(ns('Compiler', 'watId'), strLit('foo'))
        const output = translateLegacyBlock(input)
        expect(output.args.length).toBe(1)
        expect(output.args[0].name).toEqual(ns('compiler', 'compiler_str_intern'))
        expect(output.args[0].args[0]).toEqual(strLit('foo'))
        expect(output.args[0].args[1]).toEqual(intLit('0'))
    })

    test('IntLiteral arg is NOT wrapped', () => {
        const input  = fcall(ns('Compiler', 'ir', 'makeConst'), intLit('42'), strLit('i32'))
        const output = translateLegacyBlock(input)
        expect(output.args[0]).toEqual(intLit('42'))                   // unchanged
        expect(output.args[1].name).toEqual(ns('compiler', 'compiler_str_intern'))   // wrapped
    })

    test('Namespace arg (variable reference) is NOT wrapped', () => {
        const input  = fcall(ns('Compiler', 'lowerExpr'), ns('node'))
        const output = translateLegacyBlock(input)
        expect(output.args[0]).toEqual(ns('node'))
    })
})

describe('translateLegacyBlock — special state() handling', () => {
    test("Compiler::state 'stratum' → compiler::state_stratum (no args)", () => {
        const input  = fcall(ns('Compiler', 'state'), strLit('stratum'))
        const output = translateLegacyBlock(input)
        expect(output.name).toEqual(ns('compiler', 'state_stratum'))
        expect(output.args).toEqual([])
    })

    test("Compiler::state 'instance' → compiler::state_instance (no args)", () => {
        const input  = fcall(ns('Compiler', 'state'), strLit('instance'))
        const output = translateLegacyBlock(input)
        expect(output.name).toEqual(ns('compiler', 'state_instance'))
        expect(output.args).toEqual([])
    })
})

describe('translateLegacyBlock — node-field access', () => {
    test('node.name.name → compiler_ast_str_field(node, intern("name.name"))', () => {
        const input  = ns('node', 'name', 'name')
        const output = translateLegacyBlock(input)
        expect(output.name).toEqual(ns('compiler', 'compiler_ast_str_field'))
        expect(output.args[0]).toEqual(ns('node'))
        // arg 1 is intern("name.name")
        expect(output.args[1].name).toEqual(ns('compiler', 'compiler_str_intern'))
        expect(output.args[1].args[0]).toEqual(strLit('name.name'))
    })

    test('bare node reference (no dot path) is NOT translated', () => {
        const input  = ns('node')
        const output = translateLegacyBlock(input)
        expect(output).toEqual(ns('node'))
    })

    test('Namespace not starting with param name is NOT translated', () => {
        const input  = ns('other', 'field')
        const output = translateLegacyBlock(input)
        expect(output).toEqual(ns('other', 'field'))
    })

    test('node-field access inside a Compiler:: call arg', () => {
        const input  = fcall(ns('Compiler', 'watId'), ns('node', 'name', 'name'))
        const output = translateLegacyBlock(input)
        // The arg is now a compiler_ast_str_field call, which returns a string id.
        // Should NOT be additionally wrapped with str_intern (we only wrap StringLiteral).
        expect(output.args[0].name).toEqual(ns('compiler', 'compiler_ast_str_field'))
    })
})

describe('translateLegacyBlock — scope-variable method calls', () => {
    test('&s::set k, v after @local s := state — translates to state_set(s, intern(k), v)', () => {
        const setCall = fcall(ns('s', 'set'), strLit('key'), intLit('42'))
        const input = block(
            local('s', fcall(ns('Compiler', 'state'), strLit('stratum'))),
            setCall,
        )
        const output = translateLegacyBlock(input)
        // First item: @local s := compiler::state_stratum (no args)
        expect(output.items[0].binding.expression.name).toEqual(ns('compiler', 'state_stratum'))
        // Second item: state_set(s_ref, intern('key'), 42)
        expect(output.items[1].name).toEqual(ns('compiler', 'state_set'))
        expect(output.items[1].args[0]).toEqual(ns('s'))
        expect(output.items[1].args[1].name).toEqual(ns('compiler', 'compiler_str_intern'))
        expect(output.items[1].args[2]).toEqual(intLit('42'))
    })

    test('&s::get k after @local s := state — translates to state_get(s, intern(k))', () => {
        const getCall = fcall(ns('s', 'get'), strLit('key'))
        const input = block(
            local('s', fcall(ns('Compiler', 'state'), strLit('instance'))),
            getCall,
        )
        const output = translateLegacyBlock(input)
        expect(output.items[1].name).toEqual(ns('compiler', 'state_get'))
        expect(output.items[1].args[0]).toEqual(ns('s'))
        expect(output.items[1].args[1].name).toEqual(ns('compiler', 'compiler_str_intern'))
    })
})

describe('translateLegacyBlock — pass-through', () => {
    test('@local declaration is preserved (binding expression translated)', () => {
        const input = local('x', fcall(ns('Compiler', 'watId'), strLit('foo')))
        const output = translateLegacyBlock(input)
        expect(output.keyword).toBe('@local')
        expect(output.name.name).toBe('x')
        expect(output.binding.expression.name).toEqual(ns('compiler', 'watId'))
    })

    test('arithmetic (+, ==) passes through unchanged', () => {
        const input = { type: 'BinaryOp', operator: '+', left: intLit('1'), right: intLit('2') }
        const output = translateLegacyBlock(input)
        expect(output).toEqual(input)
    })

    test('input is not mutated (deep clone)', () => {
        const input  = fcall(ns('Compiler', 'watId'), strLit('foo'))
        const before = JSON.stringify(input)
        translateLegacyBlock(input)
        expect(JSON.stringify(input)).toBe(before)
    })
})

describe('translateLegacyBlock — comptime string `+` → str_concat', () => {
    const binop = (op: string, left: any, right: any) => ({ type: 'BinaryOp', operator: op, left, right })

    test("'lit' + <string import call> routes to compiler::str_concat", () => {
        const input = binop('+', strLit('tmpl::'), fcall(ns('Compiler', 'callee', 'name'), ns('node')))
        const output = translateLegacyBlock(input)
        expect(output.name).toEqual(ns('compiler', 'str_concat'))
        expect(output.args[0].name).toEqual(ns('compiler', 'compiler_str_intern'))
        expect(output.args[1].name).toEqual(ns('compiler', 'callee_name'))
    })

    test('two string-tracked LOCALS concat via str_concat (no literal in the chain)', () => {
        const input = block(
            local('a', fcall(ns('Compiler', 'callee', 'name'), ns('node'))),
            local('b', fcall(ns('Compiler', 'type', 'mangle_suffix'), ns('bs'))),
            local('c', binop('+', ns('a'), ns('b'))),
        )
        const output = translateLegacyBlock(input)
        const c = output.items[2]
        expect(c.binding.expression.name).toEqual(ns('compiler', 'str_concat'))
        expect(c.binding.expression.args[0]).toEqual(ns('a'))
        expect(c.binding.expression.args[1]).toEqual(ns('b'))
    })

    test('a local bound from string + is itself string-tracked (chained concat)', () => {
        const input = block(
            local('mono', binop('+', strLit('id'), fcall(ns('Compiler', 'type', 'mangle_suffix'), ns('bs')))),
            local('key', binop('+', ns('mono'), ns('mono'))),
        )
        const output = translateLegacyBlock(input)
        expect(output.items[1].binding.expression.name).toEqual(ns('compiler', 'str_concat'))
    })

    test("mixed 'count: ' + 2 renders the number via str_of_int", () => {
        const input = binop('+', strLit('count: '), intLit('2'))
        const output = translateLegacyBlock(input)
        expect(output.name).toEqual(ns('compiler', 'str_concat'))
        expect(output.args[1].name).toEqual(ns('compiler', 'str_of_int'))
        expect(output.args[1].args[0]).toEqual(intLit('2'))
    })

    test('numeric + over plain ints still passes through unchanged', () => {
        const input = binop('+', intLit('1'), ns('n'))
        const output = translateLegacyBlock(input)
        expect(output).toEqual(input)
    })

    test('@nil() lowers to IntLiteral 0', () => {
        const input = { type: 'FunctionCall', name: '@nil', isBuiltin: true, args: [] }
        const output = translateLegacyBlock(input)
        expect(output).toEqual(intLit('0'))
    })
})
