/**
 * Phase 5c-1 — stdlib Slice[T] runtime tests.
 *
 * Compiles a Silicon program that @use's src/stdlib/slice.si, allocates
 * a backing buffer via &alloc, constructs a Slice through the
 * @struct-generated constructor (&Slice ptr, len), and exercises every
 * accessor (slice_ptr / slice_len / slice_get_i32 / slice_set_i32 /
 * slice_get_byte / slice_set_byte) end-to-end through compiled wasm.
 */

import { test, expect, describe } from 'bun:test'
import { join } from 'path'
import { readFileSync } from 'fs'
import { compileToWasm } from '../codegen/index'
import siliconGrammar from '../grammar/SiliconGrammar'
import parse from '../parser'
import { addToAstSemantics } from '../ast/index'
import { buildStrataRegistry, elaborate } from '../elaborator/index'
import { typecheck } from '../types/index'
import type { Program } from '../ast/astNodes'

const sliceSrc = readFileSync(join(__dirname, 'slice.si'), 'utf-8')
const optionSrc = readFileSync(join(__dirname, 'option.si'), 'utf-8')

interface Exports {
    memory: WebAssembly.Memory
    [name: string]: any
}

async function compileAndRun(testFns: Record<string, string>): Promise<Exports> {
    const userFns = Object.entries(testFns)
        .map(([name, body]) => `@fn ${name}:Int := ${body};`)
        .join('\n')
    const userExports = Object.keys(testFns)
        .map(name => `@export ${name};`)
        .join('\n')
    // option.si must come before slice.si because slice's bounds-checked
    // accessors construct Option values via &Some / &None.
    const source = `${optionSrc}\n${sliceSrc}\n${userFns}\n${userExports}`

    const match = parse(source)
    const ast = addToAstSemantics(siliconGrammar)(match).toAst() as Program
    const registry = buildStrataRegistry(ast)
    const { program: elaborated } = elaborate(ast, registry)
    const { program: typed, functions } = typecheck(elaborated, registry)
    const bin = compileToWasm(typed, registry, functions)
    const mod = await WebAssembly.instantiate(bin, {
        env: { print: () => {}, read: () => 0 },
    })
    return mod.instance.exports as unknown as Exports
}

describe('Phase 5c-1: Slice[T] runtime', () => {
    test('slice_ptr / slice_len expose the constructor fields', async () => {
        const ex = await compileAndRun({
            test_ptr: `{
                @local buf:Int := &alloc 16;
                @local s:Slice[Int] := &Slice buf, 4;
                (&slice_ptr s) - buf
            }`,
            test_len: `{
                @local buf:Int := &alloc 16;
                @local s:Slice[Int] := &Slice buf, 4;
                &slice_len s
            }`,
        })
        expect(ex.test_ptr()).toBe(0)   // slice_ptr returns exactly the buffer base
        expect(ex.test_len()).toBe(4)
    })

    test('slice_get_i32 / slice_set_i32 round-trip 4-byte elements', async () => {
        const ex = await compileAndRun({
            test_set_get: `{
                @local buf:Int := &alloc 16;
                @local s:Slice[Int] := &Slice buf, 4;
                &slice_set_i32 s, 0, 100;
                &slice_set_i32 s, 1, 200;
                &slice_set_i32 s, 2, 300;
                &slice_set_i32 s, 3, 400;
                (&slice_get_i32 s, 0) + (&slice_get_i32 s, 1)
                + (&slice_get_i32 s, 2) + (&slice_get_i32 s, 3)
            }`,
        })
        expect(ex.test_set_get()).toBe(1000)  // 100+200+300+400
    })

    test('slice_get_byte / slice_set_byte address individual bytes', async () => {
        const ex = await compileAndRun({
            test_bytes: `{
                @local buf:Int := &alloc 8;
                @local s:Slice[Int] := &Slice buf, 8;
                &slice_set_byte s, 0, 65;
                &slice_set_byte s, 1, 66;
                &slice_set_byte s, 2, 67;
                &slice_set_byte s, 7, 200;
                (&slice_get_byte s, 0) + (&slice_get_byte s, 1)
                + (&slice_get_byte s, 2) + (&slice_get_byte s, 7)
            }`,
            test_byte_unsigned: `{
                @local buf:Int := &alloc 4;
                @local s:Slice[Int] := &Slice buf, 4;
                &slice_set_byte s, 0, 255;
                &slice_get_byte s, 0
            }`,
        })
        expect(ex.test_bytes()).toBe(398)        // 65+66+67+200
        expect(ex.test_byte_unsigned()).toBe(255) // zero-extended, not sign-extended
    })

    test('Slice[T] is nominally distinct per T', async () => {
        // Slice[Int] and Slice[u8] are distinct types — accessors
        // parameterised by T accept either, but a Slice[Int]-only
        // helper would not accept a Slice[u8] (verified by the type
        // checker; this test just confirms the [u8] flavour compiles
        // and runs end-to-end).
        const ex = await compileAndRun({
            test_u8_slice: `{
                @local buf:Int := &alloc 4;
                @local s:Slice[u8] := &Slice buf, 4;
                &slice_set_byte s, 0, 1;
                &slice_set_byte s, 1, 2;
                &slice_set_byte s, 2, 4;
                &slice_set_byte s, 3, 8;
                (&slice_get_byte s, 0) + (&slice_get_byte s, 1)
                + (&slice_get_byte s, 2) + (&slice_get_byte s, 3)
            }`,
        })
        expect(ex.test_u8_slice()).toBe(15)
    })

    test('slice_len reflects construction; mutations do not affect length', async () => {
        const ex = await compileAndRun({
            test_len_after_writes: `{
                @local buf:Int := &alloc 16;
                @local s:Slice[Int] := &Slice buf, 4;
                &slice_set_i32 s, 0, 99;
                &slice_set_i32 s, 1, 99;
                &slice_set_i32 s, 2, 99;
                &slice_set_i32 s, 3, 99;
                &slice_len s
            }`,
        })
        expect(ex.test_len_after_writes()).toBe(4)
    })
})

describe('Phase 5c-2: Slice[T] bounds-checked indexing', () => {
    test('slice_in_bounds returns 1 for in-range, 0 for out-of-range', async () => {
        const ex = await compileAndRun({
            test_in_lo:   `{
                @local buf:Int := &alloc 16;
                @local s:Slice[Int] := &Slice buf, 4;
                &slice_in_bounds s, 0
            }`,
            test_in_hi:   `{
                @local buf:Int := &alloc 16;
                @local s:Slice[Int] := &Slice buf, 4;
                &slice_in_bounds s, 3
            }`,
            test_out_neg: `{
                @local buf:Int := &alloc 16;
                @local s:Slice[Int] := &Slice buf, 4;
                &slice_in_bounds s, (0 - 1)
            }`,
            test_out_eq:  `{
                @local buf:Int := &alloc 16;
                @local s:Slice[Int] := &Slice buf, 4;
                &slice_in_bounds s, 4
            }`,
            test_out_far: `{
                @local buf:Int := &alloc 16;
                @local s:Slice[Int] := &Slice buf, 4;
                &slice_in_bounds s, 999
            }`,
        })
        expect(ex.test_in_lo()).toBe(1)
        expect(ex.test_in_hi()).toBe(1)
        expect(ex.test_out_neg()).toBe(0)
        expect(ex.test_out_eq()).toBe(0)
        expect(ex.test_out_far()).toBe(0)
    })

    test('slice_at_i32 returns Some(v) in range, None out of range — composed via option_unwrap_or', async () => {
        const ex = await compileAndRun({
            test_at_in: `{
                @local buf:Int := &alloc 16;
                @local s:Slice[Int] := &Slice buf, 4;
                &slice_set_i32 s, 2, 777;
                &option_unwrap_or (&slice_at_i32 s, 2), 0
            }`,
            test_at_eq: `{
                @local buf:Int := &alloc 16;
                @local s:Slice[Int] := &Slice buf, 4;
                &option_unwrap_or (&slice_at_i32 s, 4), 1234
            }`,
            test_at_neg: `{
                @local buf:Int := &alloc 16;
                @local s:Slice[Int] := &Slice buf, 4;
                &option_unwrap_or (&slice_at_i32 s, (0 - 1)), 1234
            }`,
        })
        expect(ex.test_at_in()).toBe(777)
        expect(ex.test_at_eq()).toBe(1234)
        expect(ex.test_at_neg()).toBe(1234)
    })

    test('slice_at_byte returns Some(byte) in range, None out of range', async () => {
        const ex = await compileAndRun({
            test_byte_at_in: `{
                @local buf:Int := &alloc 8;
                @local s:Slice[Int] := &Slice buf, 8;
                &slice_set_byte s, 5, 42;
                &option_unwrap_or (&slice_at_byte s, 5), 0
            }`,
            test_byte_at_out: `{
                @local buf:Int := &alloc 8;
                @local s:Slice[Int] := &Slice buf, 8;
                &option_unwrap_or (&slice_at_byte s, 99), 1234
            }`,
        })
        expect(ex.test_byte_at_in()).toBe(42)
        expect(ex.test_byte_at_out()).toBe(1234)
    })
})

describe('Phase 5c-3: String → Slice[u8] bridge', () => {
    test('string_as_slice reports the correct byte length', async () => {
        const ex = await compileAndRun({
            test_len_abc:  `{ @local s:Slice[u8] := &string_as_slice 'abc';   &slice_len s }`,
            test_len_hi:   `{ @local s:Slice[u8] := &string_as_slice 'hi';    &slice_len s }`,
            test_len_zero: `{ @local s:Slice[u8] := &string_as_slice '';      &slice_len s }`,
        })
        expect(ex.test_len_abc()).toBe(3)
        expect(ex.test_len_hi()).toBe(2)
        expect(ex.test_len_zero()).toBe(0)
    })

    test('slice_get_byte over a string slice yields the UTF-8 byte values', async () => {
        const ex = await compileAndRun({
            test_a:    `{ @local s:Slice[u8] := &string_as_slice 'abc'; &slice_get_byte s, 0 }`,
            test_b:    `{ @local s:Slice[u8] := &string_as_slice 'abc'; &slice_get_byte s, 1 }`,
            test_c:    `{ @local s:Slice[u8] := &string_as_slice 'abc'; &slice_get_byte s, 2 }`,
            test_zero: `{ @local s:Slice[u8] := &string_as_slice 'A';   &slice_get_byte s, 0 }`,
        })
        expect(ex.test_a()).toBe(97)     // 'a'
        expect(ex.test_b()).toBe(98)     // 'b'
        expect(ex.test_c()).toBe(99)     // 'c'
        expect(ex.test_zero()).toBe(65)  // 'A'
    })

    test('bounds-checked access composes with the string slice', async () => {
        const ex = await compileAndRun({
            test_in:  `{
                @local s:Slice[u8] := &string_as_slice 'xyz';
                &option_unwrap_or (&slice_at_byte s, 1), 0
            }`,
            test_out: `{
                @local s:Slice[u8] := &string_as_slice 'xyz';
                &option_unwrap_or (&slice_at_byte s, 99), 1234
            }`,
        })
        expect(ex.test_in()).toBe(121)   // 'y'
        expect(ex.test_out()).toBe(1234) // out-of-range → None → default
    })

    test('emoji round-trips its UTF-8 bytes via the slice', async () => {
        // '☃' is U+2603 → 0xE2 0x98 0x83 in UTF-8 (3 bytes).
        const ex = await compileAndRun({
            test_len:  `{ @local s:Slice[u8] := &string_as_slice '☃'; &slice_len s }`,
            test_b0:   `{ @local s:Slice[u8] := &string_as_slice '☃'; &slice_get_byte s, 0 }`,
            test_b1:   `{ @local s:Slice[u8] := &string_as_slice '☃'; &slice_get_byte s, 1 }`,
            test_b2:   `{ @local s:Slice[u8] := &string_as_slice '☃'; &slice_get_byte s, 2 }`,
        })
        expect(ex.test_len()).toBe(3)
        expect(ex.test_b0()).toBe(0xE2)
        expect(ex.test_b1()).toBe(0x98)
        expect(ex.test_b2()).toBe(0x83)
    })
})
