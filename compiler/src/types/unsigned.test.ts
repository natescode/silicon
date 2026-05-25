/**
 * Phase 5b — unsigned integer types (u8/u16/u32/u64).
 *
 * Proves:
 *  - Surface names `u8`, `u16`, `u32`, `u64` parse into distinct SiliconType variants.
 *  - WASM representation: u8/u16/u32 → i32, u64 → i64.
 *  - Operator dispatch routes `/`, `%`, `>>`, `<`, `>`, `<=`, `>=` to `*_u`
 *    WASM instruction variants when operands are unsigned.
 *  - Shared-semantics operators (+, -, *, ==, !=) fall back to signed
 *    primary handlers — same WAT for both signed and unsigned operands.
 */

import { test, expect, describe } from 'bun:test'
import {
    parseTypeName,
    wasmTypeOf,
    formatType,
    isNumeric,
    isUnsigned,
    isComparable,
    isEqualityComparable,
    TypeUInt8,
    TypeUInt16,
    TypeUInt32,
    TypeUInt64,
    TypeInt,
    typeEquals,
} from './types'
import parse from '../parser'
import addToAstSemantics from '../ast/toAst'
import siliconGrammar from '../grammar/SiliconGrammar'
import elaborate from '../elaborator/elaborator'
import { buildStrataRegistry } from '../elaborator/strataLoader'
import { compileStrataHandlers } from '../comptime/engine'
import typecheck from './typechecker'
import { lowerProgram } from '../ir/lower'
import { emitModule } from '../ir/emit'

function parseProgram(src: string): any {
    return addToAstSemantics(siliconGrammar)(parse(src)).toAst() as any
}

async function compileToWat(src: string): Promise<string> {
    const prog = parseProgram(src)
    const registry = buildStrataRegistry(prog)
    await compileStrataHandlers(prog, registry)
    const elab = elaborate(prog, registry)
    const { program: typedProg, functions } = typecheck(elab.program, registry)
    const mod = lowerProgram(typedProg, registry, functions)
    return emitModule(mod, '')
}

describe('Phase 5b: unsigned type parsing', () => {
    test('u8 parses to UInt8', () => {
        expect(parseTypeName('u8')).toEqual(TypeUInt8)
        expect(parseTypeName('UInt8')).toEqual(TypeUInt8)
    })
    test('u16 parses to UInt16', () => {
        expect(parseTypeName('u16')).toEqual(TypeUInt16)
    })
    test('u32 parses to UInt32', () => {
        expect(parseTypeName('u32')).toEqual(TypeUInt32)
    })
    test('u64 parses to UInt64', () => {
        expect(parseTypeName('u64')).toEqual(TypeUInt64)
    })
    test('unsigned types are NOT equal to Int', () => {
        expect(typeEquals(TypeUInt32, TypeInt)).toBe(false)
        expect(typeEquals(TypeUInt8, TypeUInt16)).toBe(false)
    })
})

describe('Phase 5b: unsigned WASM representation', () => {
    test('u8/u16/u32 lower to i32', () => {
        expect(wasmTypeOf(TypeUInt8)).toBe('i32')
        expect(wasmTypeOf(TypeUInt16)).toBe('i32')
        expect(wasmTypeOf(TypeUInt32)).toBe('i32')
    })
    test('u64 lowers to i64', () => {
        expect(wasmTypeOf(TypeUInt64)).toBe('i64')
    })
})

describe('Phase 5b: type predicates', () => {
    test('isNumeric includes all unsigned types', () => {
        expect(isNumeric(TypeUInt8)).toBe(true)
        expect(isNumeric(TypeUInt64)).toBe(true)
    })
    test('isUnsigned distinguishes unsigned from signed', () => {
        expect(isUnsigned(TypeUInt32)).toBe(true)
        expect(isUnsigned(TypeInt)).toBe(false)
    })
    test('isComparable / isEqualityComparable include unsigned', () => {
        expect(isComparable(TypeUInt32)).toBe(true)
        expect(isEqualityComparable(TypeUInt64)).toBe(true)
    })
    test('formatType emits surface u8/u16/u32/u64 names', () => {
        expect(formatType(TypeUInt8)).toBe('u8')
        expect(formatType(TypeUInt16)).toBe('u16')
        expect(formatType(TypeUInt32)).toBe('u32')
        expect(formatType(TypeUInt64)).toBe('u64')
    })
})

describe('Phase 5b: codegen routes unsigned ops to *_u WASM variants', () => {
    test('u32 / u32 emits i32.div_u', async () => {
        const wat = await compileToWat(`@fn divu a:u32, b:u32 := a / b;`)
        expect(wat).toContain('i32.div_u')
        expect(wat).not.toContain('i32.div_s')
    })
    test('u32 % u32 emits i32.rem_u', async () => {
        const wat = await compileToWat(`@fn modu a:u32, b:u32 := a % b;`)
        expect(wat).toContain('i32.rem_u')
        expect(wat).not.toContain('i32.rem_s')
    })
    test('u32 < u32 emits i32.lt_u', async () => {
        const wat = await compileToWat(`@fn ltu a:u32, b:u32 := a < b;`)
        expect(wat).toContain('i32.lt_u')
        expect(wat).not.toContain('i32.lt_s')
    })
    test('u64 / u64 emits i64.div_u', async () => {
        const wat = await compileToWat(`@fn divu64 a:u64, b:u64 := a / b;`)
        expect(wat).toContain('i64.div_u')
        expect(wat).not.toContain('i64.div_s')
    })
    test('u64 > u64 emits i64.gt_u', async () => {
        const wat = await compileToWat(`@fn gtu64 a:u64, b:u64 := a > b;`)
        expect(wat).toContain('i64.gt_u')
        expect(wat).not.toContain('i64.gt_s')
    })
    test('u8 / u8 routes through the u8 typed stratum', async () => {
        const wat = await compileToWat(`@fn divu8 a:u8, b:u8 := a / b;`)
        expect(wat).toContain('i32.div_u')
    })

    // Operators where signed and unsigned WASM instructions are the same:
    // these should still compile and emit the shared instruction.
    test('u32 + u32 emits i32.add (no signedness distinction needed)', async () => {
        const wat = await compileToWat(`@fn addu a:u32, b:u32 := a + b;`)
        expect(wat).toContain('i32.add')
    })
    test('u32 == u32 emits i32.eq (no signedness distinction needed)', async () => {
        const wat = await compileToWat(`@fn equ a:u32, b:u32 := a == b;`)
        expect(wat).toContain('i32.eq')
    })
})

describe('Phase 5b: signed vs unsigned dispatch is operand-driven', () => {
    test('signed Int / Int still uses div_s', async () => {
        const wat = await compileToWat(`@fn divs a:Int, b:Int := a / b;`)
        expect(wat).toContain('i32.div_s')
        expect(wat).not.toContain('i32.div_u')
    })
    test('signed Int64 / Int64 still uses i64.div_s', async () => {
        const wat = await compileToWat(`@fn divs64 a:Int64, b:Int64 := a / b;`)
        expect(wat).toContain('i64.div_s')
        expect(wat).not.toContain('i64.div_u')
    })
})
