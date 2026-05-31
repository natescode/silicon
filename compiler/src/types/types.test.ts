// SPDX-License-Identifier: MIT
/**
 * Unit tests for SiliconType, WASM mapping, and helpers.
 */

import { test, expect } from 'bun:test'
import {
    type SiliconType,
    TypeInt,
    TypeFloat,
    TypeString,
    TypeBool,
    TypeUnknown,
    ArrayOf,
    FunctionOf,
    DistinctOf,
    SumOf,
    wasmTypeOf,
    typeEquals,
    formatType,
    parseTypeName,
    isNumeric,
    isComparable,
    isEqualityComparable,
} from './types'

// ------------------------------------------------------------------
// WASM value-type mapping
// ------------------------------------------------------------------

test('wasmTypeOf: Int lowers to i32', () => {
    expect(wasmTypeOf(TypeInt)).toBe('i32')
})

test('wasmTypeOf: Float lowers to f32', () => {
    expect(wasmTypeOf(TypeFloat)).toBe('f32')
})

test('wasmTypeOf: Bool lowers to i32', () => {
    expect(wasmTypeOf(TypeBool)).toBe('i32')
})

test('wasmTypeOf: String lowers to i32 (pointer)', () => {
    expect(wasmTypeOf(TypeString)).toBe('i32')
})

test('wasmTypeOf: Array lowers to i32 (pointer)', () => {
    expect(wasmTypeOf(ArrayOf(TypeInt))).toBe('i32')
    expect(wasmTypeOf(ArrayOf(TypeFloat))).toBe('i32')
})

test('wasmTypeOf: Unknown lowers to i32 (conservative)', () => {
    expect(wasmTypeOf(TypeUnknown)).toBe('i32')
})

// ------------------------------------------------------------------
// Type equality
// ------------------------------------------------------------------

test('typeEquals: primitive identity', () => {
    expect(typeEquals(TypeInt, TypeInt)).toBe(true)
    expect(typeEquals(TypeFloat, TypeFloat)).toBe(true)
    expect(typeEquals(TypeBool, TypeBool)).toBe(true)
    expect(typeEquals(TypeString, TypeString)).toBe(true)
})

test('typeEquals: distinct primitives are unequal', () => {
    expect(typeEquals(TypeInt, TypeFloat)).toBe(false)
    expect(typeEquals(TypeInt, TypeBool)).toBe(false)
    expect(typeEquals(TypeString, TypeInt)).toBe(false)
})

test('typeEquals: Array equality is elementwise recursive', () => {
    expect(typeEquals(ArrayOf(TypeInt), ArrayOf(TypeInt))).toBe(true)
    expect(typeEquals(ArrayOf(TypeInt), ArrayOf(TypeFloat))).toBe(false)
    expect(typeEquals(ArrayOf(ArrayOf(TypeInt)), ArrayOf(ArrayOf(TypeInt)))).toBe(true)
    expect(typeEquals(ArrayOf(ArrayOf(TypeInt)), ArrayOf(ArrayOf(TypeFloat)))).toBe(false)
})

// ------------------------------------------------------------------
// Parsing surface type names
// ------------------------------------------------------------------

test('parseTypeName: known surface names', () => {
    expect(parseTypeName('Int')).toEqual(TypeInt)
    expect(parseTypeName('Float')).toEqual(TypeFloat)
    expect(parseTypeName('String')).toEqual(TypeString)
    expect(parseTypeName('Bool')).toEqual(TypeBool)
})

test('parseTypeName: WASM-flavored aliases are accepted', () => {
    expect(parseTypeName('i32')).toEqual(TypeInt)
    expect(parseTypeName('f32')).toEqual(TypeFloat)
})

test('parseTypeName: unknown names return undefined', () => {
    expect(parseTypeName('Widget')).toBeUndefined()
    expect(parseTypeName('int')).toBeUndefined() // lowercase not accepted
})

// ------------------------------------------------------------------
// Formatting
// ------------------------------------------------------------------

test('formatType: primitives', () => {
    expect(formatType(TypeInt)).toBe('Int')
    expect(formatType(TypeFloat)).toBe('Float')
    expect(formatType(TypeString)).toBe('String')
    expect(formatType(TypeBool)).toBe('Bool')
})

test('formatType: nested arrays', () => {
    expect(formatType(ArrayOf(TypeInt))).toBe('Array[Int]')
    expect(formatType(ArrayOf(ArrayOf(TypeFloat)))).toBe('Array[Array[Float]]')
})

// ------------------------------------------------------------------
// Type-class predicates
// ------------------------------------------------------------------

test('isNumeric: Int and Float only', () => {
    expect(isNumeric(TypeInt)).toBe(true)
    expect(isNumeric(TypeFloat)).toBe(true)
    expect(isNumeric(TypeBool)).toBe(false)
    expect(isNumeric(TypeString)).toBe(false)
    expect(isNumeric(ArrayOf(TypeInt))).toBe(false)
})

test('isComparable: numeric + Bool (ordering operators)', () => {
    expect(isComparable(TypeInt)).toBe(true)
    expect(isComparable(TypeFloat)).toBe(true)
    expect(isComparable(TypeBool)).toBe(true)
    expect(isComparable(TypeString)).toBe(false)
    expect(isComparable(ArrayOf(TypeInt))).toBe(false)
})

test('isEqualityComparable: numeric + Bool + String', () => {
    expect(isEqualityComparable(TypeInt)).toBe(true)
    expect(isEqualityComparable(TypeFloat)).toBe(true)
    expect(isEqualityComparable(TypeBool)).toBe(true)
    expect(isEqualityComparable(TypeString)).toBe(true)
    expect(isEqualityComparable(ArrayOf(TypeInt))).toBe(false)
})

test('wasmTypeOf: Function lowers to i32 (function table index)', () => {
    expect(wasmTypeOf(FunctionOf([TypeInt], TypeFloat))).toBe('i32')
    expect(wasmTypeOf(FunctionOf([], TypeInt))).toBe('i32')
})

test('typeEquals: Function structural equality', () => {
    const f1 = FunctionOf([TypeInt, TypeFloat], TypeBool)
    const f2 = FunctionOf([TypeInt, TypeFloat], TypeBool)
    const f3 = FunctionOf([TypeInt], TypeBool)
    const f4 = FunctionOf([TypeInt, TypeFloat], TypeInt)
    expect(typeEquals(f1, f2)).toBe(true)
    expect(typeEquals(f1, f3)).toBe(false)
    expect(typeEquals(f1, f4)).toBe(false)
    expect(typeEquals(f1, TypeInt)).toBe(false)
})

test('formatType: Function type', () => {
    expect(formatType(FunctionOf([TypeInt, TypeFloat], TypeBool))).toBe('Function(Int, Float) -> Bool')
    expect(formatType(FunctionOf([], TypeInt))).toBe('Function() -> Int')
})

// ------------------------------------------------------------------
// Distinct types
// ------------------------------------------------------------------

test('DistinctOf: creates a Distinct kind with correct name and underlying', () => {
    const age = DistinctOf('age', TypeInt)
    expect(age.kind).toBe('Distinct')
    if (age.kind === 'Distinct') {
        expect(age.name).toBe('age')
        expect(age.underlying).toBe(TypeInt)
    }
})

test('wasmTypeOf: Distinct lowers to its underlying WASM type', () => {
    expect(wasmTypeOf(DistinctOf('age', TypeInt))).toBe('i32')
    expect(wasmTypeOf(DistinctOf('weight', TypeFloat))).toBe('f32')
})

test('typeEquals: Distinct is equal only to itself', () => {
    const age = DistinctOf('age', TypeInt)
    const age2 = DistinctOf('age', TypeInt)
    const height = DistinctOf('height', TypeInt)
    expect(typeEquals(age, age2)).toBe(true)
    expect(typeEquals(age, height)).toBe(false)
    expect(typeEquals(age, TypeInt)).toBe(false)
})

test('formatType: Distinct renders as the user-defined name', () => {
    expect(formatType(DistinctOf('UserId', TypeInt))).toBe('UserId')
})

test('parseTypeName: resolves alias names from the alias table', () => {
    const aliases = new Map<string, SiliconType>([['Metres', TypeInt]])
    expect(parseTypeName('Metres', aliases)).toBe(TypeInt)
    expect(parseTypeName('Unknown', aliases)).toBeUndefined()
})

test('parseTypeName: alias table is optional — built-in names still resolve', () => {
    expect(parseTypeName('Int')).toBe(TypeInt)
    expect(parseTypeName('Float')).toBe(TypeFloat)
})

// ------------------------------------------------------------------
// Sum types
// ------------------------------------------------------------------

test('SumOf: creates a Sum kind with correct name and variants', () => {
    const color = SumOf('Color', ['Red', 'Green', 'Blue'])
    expect(color.kind).toBe('Sum')
    if (color.kind === 'Sum') {
        expect(color.name).toBe('Color')
        expect(color.variants).toEqual(['Red', 'Green', 'Blue'])
    }
})

test('wasmTypeOf: Sum lowers to i32', () => {
    expect(wasmTypeOf(SumOf('Color', ['Red', 'Green', 'Blue']))).toBe('i32')
})

test('typeEquals: Sum is equal only to itself (same name)', () => {
    const color = SumOf('Color', ['Red', 'Green', 'Blue'])
    const color2 = SumOf('Color', ['Red', 'Green', 'Blue'])
    const direction = SumOf('Direction', ['North', 'South'])
    expect(typeEquals(color, color2)).toBe(true)
    expect(typeEquals(color, direction)).toBe(false)
    expect(typeEquals(color, TypeInt)).toBe(false)
})

test('formatType: Sum renders as Name(V1 | V2 | ...)', () => {
    expect(formatType(SumOf('Color', ['Red', 'Green', 'Blue']))).toBe('Color(Red | Green | Blue)')
})

test('isEqualityComparable: Sum types support == and !=', () => {
    expect(isEqualityComparable(SumOf('Color', ['Red', 'Green']))).toBe(true)
})
