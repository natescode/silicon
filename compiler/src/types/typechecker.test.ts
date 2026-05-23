/**
 * Unit tests for the Silicon type checker.
 *
 * Covers literal inference, operator compatibility (strict, no coercion),
 * identifier resolution, array homogeneity, annotation checking, and WASM
 * intrinsic signature dispatch.
 *
 * Tests build ASTs directly via `ASTFactory` so they exercise the checker in
 * isolation from the parser.
 */

import { test, expect } from 'bun:test'
import {
    ASTFactory,
    type Program,
    type ExpressionStart,
    type BinOp,
    type ExpressionEnd,
    type Item,
} from '../ast/astNodes'
import typecheck from './typechecker'
import {
    TypeInt,
    TypeFloat,
    TypeBool,
    TypeString,
    ArrayOf,
    typeEquals,
} from './types'

// ------------------------------------------------------------------
// Helpers for building expression ASTs concisely
// ------------------------------------------------------------------

function intExp(v: string): ExpressionStart {
    const lit = ASTFactory.literal('int', ASTFactory.intLiteral(v, 'decimal'))
    return ASTFactory.expressionStart(
        'expressionEnd',
        ASTFactory.expressionEnd('literal', lit)
    )
}

function intExpEnd(v: string): ExpressionEnd {
    const lit = ASTFactory.literal('int', ASTFactory.intLiteral(v, 'decimal'))
    return ASTFactory.expressionEnd('literal', lit)
}

function floatExp(v: string): ExpressionStart {
    const lit = ASTFactory.literal('float', ASTFactory.floatLiteral(v))
    return ASTFactory.expressionStart(
        'expressionEnd',
        ASTFactory.expressionEnd('literal', lit)
    )
}

function floatExpEnd(v: string): ExpressionEnd {
    const lit = ASTFactory.literal('float', ASTFactory.floatLiteral(v))
    return ASTFactory.expressionEnd('literal', lit)
}

function boolExpEnd(v: boolean): ExpressionEnd {
    const lit = ASTFactory.literal('boolean', ASTFactory.booleanLiteral(v))
    return ASTFactory.expressionEnd('literal', lit)
}

function stringExpEnd(v: string): ExpressionEnd {
    const lit = ASTFactory.literal('string', ASTFactory.stringLiteral(v))
    return ASTFactory.expressionEnd('literal', lit)
}

function wrapItem(e: ExpressionStart): Program {
    const item = ASTFactory.item('expression', e)
    const element = ASTFactory.element('item', item)
    return ASTFactory.program([element])
}

/** Unwrap the first expression's BinOp, assuming that's what the program is. */
function firstBinOp(p: Program): BinOp {
    const el = p.elements[0]
    const it = el.value as Item
    const expr = it.value as ExpressionStart
    return expr.value as BinOp
}

// ------------------------------------------------------------------
// Literal inference
// ------------------------------------------------------------------

test('infers Int from integer literal', () => {
    const prog = wrapItem(intExp('42'))
    const { errors, program } = typecheck(prog)
    expect(errors).toHaveLength(0)
    const item = program.elements[0].value as Item
    const expr = item.value as ExpressionStart
    expect(typeEquals(expr.inferredType, TypeInt)).toBe(true)
})

test('infers Float from float literal', () => {
    const prog = wrapItem(floatExp('3.14'))
    const { errors, program } = typecheck(prog)
    expect(errors).toHaveLength(0)
    const item = program.elements[0].value as Item
    const expr = item.value as ExpressionStart
    expect(typeEquals(expr.inferredType, TypeFloat)).toBe(true)
})

test('infers Bool from boolean literal', () => {
    const prog = wrapItem(ASTFactory.expressionStart(
        'expressionEnd',
        boolExpEnd(true)
    ))
    const { errors, program } = typecheck(prog)
    expect(errors).toHaveLength(0)
    const item = program.elements[0].value as Item
    const expr = item.value as ExpressionStart
    expect(typeEquals(expr.inferredType, TypeBool)).toBe(true)
})

test('infers String from string literal', () => {
    const prog = wrapItem(ASTFactory.expressionStart(
        'expressionEnd',
        stringExpEnd('hello')
    ))
    const { errors, program } = typecheck(prog)
    expect(errors).toHaveLength(0)
    const item = program.elements[0].value as Item
    const expr = item.value as ExpressionStart
    expect(typeEquals(expr.inferredType, TypeString)).toBe(true)
})

// ------------------------------------------------------------------
// Arithmetic — strict, no coercion
// ------------------------------------------------------------------

test('Int + Int yields Int with no errors', () => {
    const bin = ASTFactory.binOp(intExp('1'), '+', intExpEnd('2'))
    const exp = ASTFactory.expressionStart('binOp', bin)
    const { errors, program } = typecheck(wrapItem(exp))
    expect(errors).toHaveLength(0)
    const bop = firstBinOp(program)
    expect(typeEquals(bop.inferredType, TypeInt)).toBe(true)
})

test('Float + Float yields Float with no errors', () => {
    const bin = ASTFactory.binOp(floatExp('1.0'), '+', floatExpEnd('2.0'))
    const exp = ASTFactory.expressionStart('binOp', bin)
    const { errors, program } = typecheck(wrapItem(exp))
    expect(errors).toHaveLength(0)
    const bop = firstBinOp(program)
    expect(typeEquals(bop.inferredType, TypeFloat)).toBe(true)
})

test('Int + Float is a type error (no implicit coercion)', () => {
    const bin = ASTFactory.binOp(intExp('1'), '+', floatExpEnd('2.0'))
    const exp = ASTFactory.expressionStart('binOp', bin)
    const { errors } = typecheck(wrapItem(exp))
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('InvalidOperator')
})

test('Int + String is a type error', () => {
    const bin = ASTFactory.binOp(intExp('1'), '+', stringExpEnd('x'))
    const exp = ASTFactory.expressionStart('binOp', bin)
    const { errors } = typecheck(wrapItem(exp))
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('InvalidOperator')
})

test('Bool + Bool coerces to Int (lexer/bit-pack ergonomics)', () => {
    // At the WASM level Bool === Int (both are i32).  Since bootstrap-plan
    // §Phase 1 needs to write byte-level dispatchers like
    //   (b == 35) * (next == 35)
    // the typechecker silently coerces Bool to Int in arithmetic / bitwise
    // positions.  Equality and ordering operators still return Bool.
    const left = ASTFactory.expressionStart('expressionEnd', boolExpEnd(true))
    const bin = ASTFactory.binOp(left, '+', boolExpEnd(false))
    const exp = ASTFactory.expressionStart('binOp', bin)
    const { errors } = typecheck(wrapItem(exp))
    expect(errors).toEqual([])
})

// ------------------------------------------------------------------
// Comparison — yields Bool
// ------------------------------------------------------------------

test('Int < Int yields Bool', () => {
    const bin = ASTFactory.binOp(intExp('1'), '<', intExpEnd('2'))
    const exp = ASTFactory.expressionStart('binOp', bin)
    const { errors, program } = typecheck(wrapItem(exp))
    expect(errors).toHaveLength(0)
    const bop = firstBinOp(program)
    expect(typeEquals(bop.inferredType, TypeBool)).toBe(true)
})

test('Float == Float yields Bool', () => {
    const bin = ASTFactory.binOp(floatExp('1.0'), '==', floatExpEnd('1.0'))
    const exp = ASTFactory.expressionStart('binOp', bin)
    const { errors, program } = typecheck(wrapItem(exp))
    expect(errors).toHaveLength(0)
    const bop = firstBinOp(program)
    expect(typeEquals(bop.inferredType, TypeBool)).toBe(true)
})

test('Int < Float is a type error', () => {
    const bin = ASTFactory.binOp(intExp('1'), '<', floatExpEnd('2.0'))
    const exp = ASTFactory.expressionStart('binOp', bin)
    const { errors } = typecheck(wrapItem(exp))
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('InvalidOperator')
})

test('String == String yields Bool (reference equality)', () => {
    const left = ASTFactory.expressionStart('expressionEnd', stringExpEnd('a'))
    const bin = ASTFactory.binOp(left, '==', stringExpEnd('b'))
    const exp = ASTFactory.expressionStart('binOp', bin)
    const { errors, program } = typecheck(wrapItem(exp))
    expect(errors).toHaveLength(0)
    const bop = firstBinOp(program)
    expect(typeEquals(bop.inferredType, TypeBool)).toBe(true)
})

test('String < String is a type error (no ordering on pointers)', () => {
    const left = ASTFactory.expressionStart('expressionEnd', stringExpEnd('a'))
    const bin = ASTFactory.binOp(left, '<', stringExpEnd('b'))
    const exp = ASTFactory.expressionStart('binOp', bin)
    const { errors } = typecheck(wrapItem(exp))
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('InvalidOperator')
})

// ------------------------------------------------------------------
// Arrays — homogeneous enforcement
// ------------------------------------------------------------------

test('Array of Ints types as Array[Int]', () => {
    const arr = ASTFactory.arrayLiteral([
        intExp('1'), intExp('2'), intExp('3'),
    ])
    const lit = ASTFactory.literal('array', arr)
    const exp = ASTFactory.expressionStart(
        'expressionEnd',
        ASTFactory.expressionEnd('literal', lit)
    )
    const { errors, program } = typecheck(wrapItem(exp))
    expect(errors).toHaveLength(0)
    const item = program.elements[0].value as Item
    const e = item.value as ExpressionStart
    expect(typeEquals(e.inferredType, ArrayOf(TypeInt))).toBe(true)
})

test('Heterogeneous array produces error', () => {
    const arr = ASTFactory.arrayLiteral([
        intExp('1'), floatExp('2.0'),
    ])
    const lit = ASTFactory.literal('array', arr)
    const exp = ASTFactory.expressionStart(
        'expressionEnd',
        ASTFactory.expressionEnd('literal', lit)
    )
    const { errors } = typecheck(wrapItem(exp))
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('HeterogeneousArray')
})

// ------------------------------------------------------------------
// Identifier scope — assignments and references
// ------------------------------------------------------------------

test('Assignment registers identifier and reference resolves', () => {
    // x = 10; x + 1
    const assign = ASTFactory.assignment(
        ASTFactory.namespace(['x']),
        intExp('10')
    )
    const stmt1 = ASTFactory.statement('assignment', assign)
    const item1 = ASTFactory.item('statement', stmt1)
    const elem1 = ASTFactory.element('item', item1)

    const nsRef = ASTFactory.namespace(['x'])
    const leftExp = ASTFactory.expressionStart(
        'expressionEnd',
        ASTFactory.expressionEnd('namespace', nsRef)
    )
    const bin = ASTFactory.binOp(leftExp, '+', intExpEnd('1'))
    const exp2 = ASTFactory.expressionStart('binOp', bin)
    const item2 = ASTFactory.item('expression', exp2)
    const elem2 = ASTFactory.element('item', item2)

    const prog = ASTFactory.program([elem1, elem2])
    const { errors, program } = typecheck(prog)
    expect(errors).toHaveLength(0)
    const it = program.elements[1].value as Item
    const expr = it.value as ExpressionStart
    const bop = expr.value as BinOp
    expect(typeEquals(bop.inferredType, TypeInt)).toBe(true)
})

test('Unbound identifier produces error', () => {
    const nsRef = ASTFactory.namespace(['unknown_var'])
    const exp = ASTFactory.expressionStart(
        'expressionEnd',
        ASTFactory.expressionEnd('namespace', nsRef)
    )
    const { errors } = typecheck(wrapItem(exp))
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('UnboundIdentifier')
})

// ------------------------------------------------------------------
// Type annotations
// ------------------------------------------------------------------

test('Definition with matching type annotation passes', () => {
    // @let x:Int := 5
    const typed = ASTFactory.typedIdentifier('x', ASTFactory.typeAnnotation('Int'))
    const binding = ASTFactory.binding(intExpEnd('5'))
    const def = ASTFactory.definition('@let', typed, [], undefined, binding)
    const stmt = ASTFactory.statement('definition', def)
    const item = ASTFactory.item('statement', stmt)
    const elem = ASTFactory.element('item', item)
    const prog = ASTFactory.program([elem])

    const { errors } = typecheck(prog)
    expect(errors).toHaveLength(0)
})

test('Definition with mismatched type annotation produces error', () => {
    // @let x:Float := 5
    const typed = ASTFactory.typedIdentifier('x', ASTFactory.typeAnnotation('Float'))
    const binding = ASTFactory.binding(intExpEnd('5'))
    const def = ASTFactory.definition('@let', typed, [], undefined, binding)
    const stmt = ASTFactory.statement('definition', def)
    const item = ASTFactory.item('statement', stmt)
    const elem = ASTFactory.element('item', item)
    const prog = ASTFactory.program([elem])

    const { errors } = typecheck(prog)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('Annotation')
})

test('Unknown type annotation produces error', () => {
    const typed = ASTFactory.typedIdentifier('x', ASTFactory.typeAnnotation('Widget'))
    const binding = ASTFactory.binding(intExpEnd('5'))
    const def = ASTFactory.definition('@let', typed, [], undefined, binding)
    const stmt = ASTFactory.statement('definition', def)
    const item = ASTFactory.item('statement', stmt)
    const elem = ASTFactory.element('item', item)
    const prog = ASTFactory.program([elem])

    const { errors } = typecheck(prog)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('UnknownType')
})

// ------------------------------------------------------------------
// WASM intrinsic signatures
// ------------------------------------------------------------------

test('WASM::i32_add types as (Int,Int)→Int', () => {
    // &WASM::i32_add 1, 2
    const call = ASTFactory.functionCall(
        ASTFactory.namespace(['WASM', 'i32_add']),
        false,
        [intExp('1'), intExp('2')],
    )
    const exp = ASTFactory.expressionStart('functionCall', call)
    const { errors, program } = typecheck(wrapItem(exp))
    expect(errors).toHaveLength(0)
    const item = program.elements[0].value as Item
    const e = item.value as ExpressionStart
    expect(typeEquals(e.inferredType, TypeInt)).toBe(true)
})

test('WASM::f32_lt types operands as Float and returns Bool', () => {
    const call = ASTFactory.functionCall(
        ASTFactory.namespace(['WASM', 'f32_lt']),
        false,
        [floatExp('1.0'), floatExp('2.0')],
    )
    const exp = ASTFactory.expressionStart('functionCall', call)
    const { errors, program } = typecheck(wrapItem(exp))
    expect(errors).toHaveLength(0)
    const item = program.elements[0].value as Item
    const e = item.value as ExpressionStart
    expect(typeEquals(e.inferredType, TypeBool)).toBe(true)
})

test('WASM intrinsic with wrong-typed arg produces Mismatch', () => {
    // &WASM::i32_add 1, 2.0  — second arg is Float, expected Int
    const call = ASTFactory.functionCall(
        ASTFactory.namespace(['WASM', 'i32_add']),
        false,
        [intExp('1'), floatExp('2.0')],
    )
    const exp = ASTFactory.expressionStart('functionCall', call)
    const { errors } = typecheck(wrapItem(exp))
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('Mismatch')
})

test('WASM intrinsic with wrong arity produces Mismatch', () => {
    // &WASM::i32_add 1  — expected 2 args
    const call = ASTFactory.functionCall(
        ASTFactory.namespace(['WASM', 'i32_add']),
        false,
        [intExp('1')],
    )
    const exp = ASTFactory.expressionStart('functionCall', call)
    const { errors } = typecheck(wrapItem(exp))
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('Mismatch')
})

// ------------------------------------------------------------------
// Conversion intrinsics let users bridge Int/Float explicitly
// ------------------------------------------------------------------

test('f32_convert_i32_s converts Int to Float, no coercion error', () => {
    // Int + f32_convert_i32_s(Int) should still be an error because left
    // is Int and right is Float — this test verifies the conversion
    // intrinsic types correctly.
    const call = ASTFactory.functionCall(
        ASTFactory.namespace(['WASM', 'f32_convert_i32_s']),
        false,
        [intExp('5')],
    )
    const exp = ASTFactory.expressionStart('functionCall', call)
    const { errors, program } = typecheck(wrapItem(exp))
    expect(errors).toHaveLength(0)
    const item = program.elements[0].value as Item
    const e = item.value as ExpressionStart
    expect(typeEquals(e.inferredType, TypeFloat)).toBe(true)
})

// ------------------------------------------------------------------
// User-defined function signatures
// ------------------------------------------------------------------

function makeDefinition(
    keyword: string,
    name: string,
    params: { name: string; type: string }[],
    body: ExpressionStart
) {
    const paramNodes = params.map(p =>
        ASTFactory.parameter(p.name, ASTFactory.typeAnnotation(p.type))
    )
    const binding = ASTFactory.binding(body)
    const typedId = ASTFactory.typedIdentifier(name)
    return ASTFactory.definition(keyword, typedId, paramNodes, undefined, binding)
}

test('call site resolves return type of a user-defined function', () => {
    // @let add x:Int, y:Int := x + y;
    // &add 1, 2   ← should infer Int
    const addDef = makeDefinition('@let', 'add',
        [{ name: 'x', type: 'Int' }, { name: 'y', type: 'Int' }],
        ASTFactory.expressionStart(
            'binOp',
            ASTFactory.binOp(
                ASTFactory.expressionStart('expressionEnd', ASTFactory.expressionEnd('namespace', ASTFactory.namespace(['x']))),
                '+',
                ASTFactory.expressionEnd('namespace', ASTFactory.namespace(['y']))
            )
        )
    )
    const call = ASTFactory.functionCall('add', false, [intExp('1'), intExp('2')])
    const callExp = ASTFactory.expressionStart('functionCall', call)

    const stmt = ASTFactory.statement('definition', addDef)
    const defItem = ASTFactory.item('statement', stmt)
    const defEl = ASTFactory.element('item', defItem)
    const callItem = ASTFactory.item('expression', callExp)
    const callEl = ASTFactory.element('item', callItem)
    const prog = ASTFactory.program([defEl, callEl])

    const { errors, program } = typecheck(prog)
    expect(errors).toHaveLength(0)
    const callItemNode = program.elements[1].value as Item
    const callExprNode = callItemNode.value as ExpressionStart
    expect(typeEquals(callExprNode.inferredType, TypeInt)).toBe(true)
})

test('call with wrong arg type emits a mismatch error', () => {
    // @let double x:Int := x + x;
    // &double 1.5   ← Float arg to Int param → error
    const doubleDef = makeDefinition('@let', 'double',
        [{ name: 'x', type: 'Int' }],
        ASTFactory.expressionStart(
            'binOp',
            ASTFactory.binOp(
                ASTFactory.expressionStart('expressionEnd', ASTFactory.expressionEnd('namespace', ASTFactory.namespace(['x']))),
                '+',
                ASTFactory.expressionEnd('namespace', ASTFactory.namespace(['x']))
            )
        )
    )
    const call = ASTFactory.functionCall('double', false, [floatExp('1.5')])
    const callExp = ASTFactory.expressionStart('functionCall', call)

    const stmt = ASTFactory.statement('definition', doubleDef)
    const defItem = ASTFactory.item('statement', stmt)
    const defEl = ASTFactory.element('item', defItem)
    const callItem = ASTFactory.item('expression', callExp)
    const callEl = ASTFactory.element('item', callItem)
    const prog = ASTFactory.program([defEl, callEl])

    const { errors } = typecheck(prog)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('Mismatch')
})

test('call with wrong arity emits an error', () => {
    // @let add x:Int, y:Int := x + y;
    // &add 1   ← too few args → error
    const addDef = makeDefinition('@let', 'add',
        [{ name: 'x', type: 'Int' }, { name: 'y', type: 'Int' }],
        intExp('0')
    )
    const call = ASTFactory.functionCall('add', false, [intExp('1')])
    const callExp = ASTFactory.expressionStart('functionCall', call)

    const stmt = ASTFactory.statement('definition', addDef)
    const defItem = ASTFactory.item('statement', stmt)
    const defEl = ASTFactory.element('item', defItem)
    const callItem = ASTFactory.item('expression', callExp)
    const callEl = ASTFactory.element('item', callItem)
    const prog = ASTFactory.program([defEl, callEl])

    const { errors } = typecheck(prog)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('Mismatch')
})
