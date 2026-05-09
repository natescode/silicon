/**
 * Integration tests: Silicon source → type-checked AST.
 *
 * Exercises the type checker through the full parse → AST → elaborate →
 * typecheck chain. These tests catch interactions between the grammar/AST
 * layer and the type system that unit tests can't reach.
 */

import { test, expect } from 'bun:test'
import parse from '../parser'
import addToAstSemantics from '../ast/toAst'
import elaborate from '../elaborator/elaborator'
import typecheck from './typechecker'
import { type Program } from '../ast/astNodes'
import { siliconGrammar } from '../grammar'
import { TypeInt, TypeFloat, TypeBool, TypeString, ArrayOf, typeEquals } from './types'

function check(src: string) {
    const match = parse(src)
    const ast = addToAstSemantics(siliconGrammar)(match).toAst() as Program
    const { program: elab, registry } = elaborate(ast)
    return typecheck(elab, registry)
}

test('"5;" — int literal, no errors', () => {
    const { errors } = check('5;')
    expect(errors).toHaveLength(0)
})

test('"3.14;" — float literal, no errors', () => {
    const { errors } = check('3.14;')
    expect(errors).toHaveLength(0)
})

test('"@true;" — bool literal, no errors', () => {
    const { errors } = check('@true;')
    expect(errors).toHaveLength(0)
})

test('"\'hi\';" — string literal, no errors', () => {
    const { errors } = check("'hi';")
    expect(errors).toHaveLength(0)
})

test('"1 + 2;" — Int + Int clean', () => {
    const { errors } = check('1 + 2;')
    expect(errors).toHaveLength(0)
})

test('"1.5 + 2.5;" — Float + Float clean', () => {
    const { errors } = check('1.5 + 2.5;')
    expect(errors).toHaveLength(0)
})

test('"1 + 2.5;" — strict: Int + Float is an error', () => {
    const { errors } = check('1 + 2.5;')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('InvalidOperator')
})

test('"1 < 2;" — comparison yields Bool, clean', () => {
    const { errors } = check('1 < 2;')
    expect(errors).toHaveLength(0)
})

test('"$[1, 2, 3];" — homogeneous int array clean', () => {
    const { errors } = check('$[1, 2, 3];')
    expect(errors).toHaveLength(0)
})

test('"$[1, 2.0];" — heterogeneous array errors', () => {
    const { errors } = check('$[1, 2.0];')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('HeterogeneousArray')
})

test('"x = 10; x + 1;" — identifier flows through', () => {
    const { errors } = check('x = 10; x + 1;')
    expect(errors).toHaveLength(0)
})

test('"x = 10; y + 1;" — unbound identifier errors', () => {
    const { errors } = check('x = 10; y + 1;')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('UnboundIdentifier')
})

test('complex expression "(1 + 2) * 3 - 4;" clean', () => {
    const { errors } = check('(1 + 2) * 3 - 4;')
    expect(errors).toHaveLength(0)
})

test('mixed operators all-Int clean', () => {
    const { errors } = check('1 + 2 - 3 * 4 / 5 % 2;')
    expect(errors).toHaveLength(0)
})

test('all comparison operators on Int clean', () => {
    for (const op of ['<', '>', '<=', '>=', '==', '!=']) {
        const { errors } = check(`3 ${op} 5;`)
        expect(errors).toHaveLength(0)
    }
})

test('type annotation Int matches int literal', () => {
    // Silicon grammar supports `@let x:Int := 5`
    const { errors } = check('@let x:Int := 5;')
    expect(errors).toHaveLength(0)
})

test('type annotation Float on int binding is an error', () => {
    const { errors } = check('@let x:Float := 5;')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('Annotation')
})

test('unknown type annotation errors', () => {
    const { errors } = check('@let x:Widget := 5;')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('UnknownType')
})

test('WASM::i32_add intrinsic type-checks', () => {
    const { errors } = check('&WASM::i32_add 1, 2;')
    expect(errors).toHaveLength(0)
})

test('WASM::i32_add with float operand fails', () => {
    const { errors } = check('&WASM::i32_add 1, 2.5;')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('Mismatch')
})

test('annotation informs inferred types (i32 alias)', () => {
    // Using i32 as annotation is allowed as a low-level escape hatch
    const { errors, program } = check('@let x:i32 := 42;')
    expect(errors).toHaveLength(0)
    // The definition's type should resolve as Int
    // (we don't introspect beyond "no errors" since Definition node isn't
    // an expression and doesn't carry inferredType directly)
})
