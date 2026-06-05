// SPDX-License-Identifier: MIT
/**
 * Standard-library modules — mem / num / str / io (snake_case).
 *
 * Behavior tests: each program `@use`s a stdlib module and `@export`s a
 * probe function.  We instantiate under the `host` target (linear
 * memory, no WASI needed for the pure modules) and assert the returned
 * value — Int results directly, String results by reading the
 * length-prefixed UTF-8 payload back out of the instance's memory.
 *
 * io's WASI surface (print/read_line) can't be exercised through bare
 * `WebAssembly.instantiate`, so it gets a compile-success check instead.
 */

import { describe, test, expect } from 'bun:test'
import { resolve, dirname } from 'node:path'
import { compile } from '../caas/index'
import { resolveUses } from '../modules/useResolver'
import { loadModules } from '../modules'

interface Exports { [name: string]: any; memory: WebAssembly.Memory }

const ENTRY_PATH = resolve(__dirname, '../../entry.si')

/** Compile via the same high-level path the CLI uses (`compile` + the
 *  built-in module registry), so WASI module signatures are known. */
function compileBinary(src: string, target: 'host' | 'wasix'): Uint8Array {
    const { source } = resolveUses(src, ENTRY_PATH, { target })
    const moduleReg = loadModules(dirname(ENTRY_PATH))
    const result = compile(source, {
        file: ENTRY_PATH, moduleRegistry: moduleReg, target, emitBinary: true,
    })
    if (result.diagnostics.length) {
        throw new Error(result.diagnostics.map((d: any) => d.message).join('; '))
    }
    return result.binary as Uint8Array
}

async function compileRun(src: string): Promise<Exports> {
    const bin = compileBinary(src, 'host')
    const mod = await WebAssembly.instantiate(bin, { env: { print: () => {}, read: () => 0 } })
    return mod.instance.exports as unknown as Exports
}

/** Read a length-prefixed UTF-8 Silicon String out of an instance's memory. */
function readStr(exp: Exports, ptr: number): string {
    const view = new DataView(exp.memory.buffer)
    const len = view.getInt32(ptr, true)
    const bytes = new Uint8Array(exp.memory.buffer, ptr + 4, len)
    return new TextDecoder().decode(bytes)
}

async function runInt(body: string): Promise<number> {
    const exp = await compileRun(`${body}\n@export probe;`)
    return exp.probe() as number
}

async function runStr(body: string): Promise<string> {
    const exp = await compileRun(`${body}\n@export probe;`)
    return readStr(exp, exp.probe() as number)
}

describe('stdlib/mem', () => {
    test('align_up rounds up to the next multiple', async () => {
        expect(await runInt(`@use 'mem';\n\\\\ probe () -> Int\n@fn probe := &align_up 13, 4;`)).toBe(16)
        expect(await runInt(`@use 'mem';\n\\\\ probe () -> Int\n@fn probe := &align_up 16, 4;`)).toBe(16)
        expect(await runInt(`@use 'mem';\n\\\\ probe () -> Int\n@fn probe := &align_up 1, 8;`)).toBe(8)
    })
})

describe('stdlib/num — integer helpers', () => {
    const P = `@use 'num';`
    test('int_max / int_min', async () => {
        expect(await runInt(`${P}\n\\\\ probe () -> Int\n@fn probe := &int_max 3, 9;`)).toBe(9)
        expect(await runInt(`${P}\n\\\\ probe () -> Int\n@fn probe := &int_min 3, 9;`)).toBe(3)
    })
    test('int_abs of a negative', async () => {
        expect(await runInt(`${P}\n\\\\ probe () -> Int\n@fn probe := &int_abs (0 - 42);`)).toBe(42)
    })
    test('int_clamp below / inside / above', async () => {
        expect(await runInt(`${P}\n\\\\ probe () -> Int\n@fn probe := &int_clamp (0 - 5), 0, 10;`)).toBe(0)
        expect(await runInt(`${P}\n\\\\ probe () -> Int\n@fn probe := &int_clamp 5, 0, 10;`)).toBe(5)
        expect(await runInt(`${P}\n\\\\ probe () -> Int\n@fn probe := &int_clamp 15, 0, 10;`)).toBe(10)
    })
    test('int_pow', async () => {
        expect(await runInt(`${P}\n\\\\ probe () -> Int\n@fn probe := &int_pow 2, 10;`)).toBe(1024)
        expect(await runInt(`${P}\n\\\\ probe () -> Int\n@fn probe := &int_pow 5, 0;`)).toBe(1)
    })
    test('int_digits', async () => {
        expect(await runInt(`${P}\n\\\\ probe () -> Int\n@fn probe := &int_digits 0;`)).toBe(1)
        expect(await runInt(`${P}\n\\\\ probe () -> Int\n@fn probe := &int_digits 12345;`)).toBe(5)
    })
})

describe('stdlib/num — number <-> string', () => {
    const P = `@use 'num';`
    test('int_to_str', async () => {
        expect(await runStr(`${P}\n\\\\ probe () -> String\n@fn probe := &int_to_str 0;`)).toBe('0')
        expect(await runStr(`${P}\n\\\\ probe () -> String\n@fn probe := &int_to_str 42;`)).toBe('42')
        expect(await runStr(`${P}\n\\\\ probe () -> String\n@fn probe := &int_to_str (0 - 12345);`)).toBe('-12345')
    })
    test('str_to_int', async () => {
        expect(await runInt(`${P}\n\\\\ probe () -> Int\n@fn probe := &str_to_int '12345';`)).toBe(12345)
        expect(await runInt(`${P}\n\\\\ probe () -> Int\n@fn probe := &str_to_int '-9';`)).toBe(-9)
        expect(await runInt(`${P}\n\\\\ probe () -> Int\n@fn probe := &str_to_int 'abc';`)).toBe(0)
    })
    test('round-trip int_to_str . str_to_int', async () => {
        expect(await runInt(`${P}\n\\\\ probe () -> Int\n@fn probe := &str_to_int (&int_to_str (0 - 678));`)).toBe(-678)
    })
    test('float_to_str (exact halves)', async () => {
        expect(await runStr(`${P}\n\\\\ probe () -> String\n@fn probe := &float_to_str 3.0;`)).toBe('3.000000')
        expect(await runStr(`${P}\n\\\\ probe () -> String\n@fn probe := &float_to_str 2.5;`)).toBe('2.500000')
        expect(await runStr(`${P}\n\\\\ probe () -> String\n@fn probe := &float_to_str (0.0 - 2.5);`)).toBe('-2.500000')
    })
})

describe('stdlib/str', () => {
    const P = `@use 'str';`
    test('str_eq', async () => {
        expect(await runInt(`${P}\n\\\\ probe () -> Int\n@fn probe := &@if (&str_eq 'abc', 'abc'), { 1 }, { 0 };`)).toBe(1)
        expect(await runInt(`${P}\n\\\\ probe () -> Int\n@fn probe := &@if (&str_eq 'abc', 'abd'), { 1 }, { 0 };`)).toBe(0)
        expect(await runInt(`${P}\n\\\\ probe () -> Int\n@fn probe := &@if (&str_eq 'ab', 'abc'), { 1 }, { 0 };`)).toBe(0)
    })
    test('str_starts_with / str_ends_with', async () => {
        expect(await runInt(`${P}\n\\\\ probe () -> Int\n@fn probe := &@if (&str_starts_with 'hello world', 'hello'), { 1 }, { 0 };`)).toBe(1)
        expect(await runInt(`${P}\n\\\\ probe () -> Int\n@fn probe := &@if (&str_ends_with 'hello world', 'world'), { 1 }, { 0 };`)).toBe(1)
        expect(await runInt(`${P}\n\\\\ probe () -> Int\n@fn probe := &@if (&str_ends_with 'hello world', 'hell'), { 1 }, { 0 };`)).toBe(0)
    })
    test('str_index_of / str_contains', async () => {
        expect(await runInt(`${P}\n\\\\ probe () -> Int\n@fn probe := &str_index_of 'hello world', 'world';`)).toBe(6)
        expect(await runInt(`${P}\n\\\\ probe () -> Int\n@fn probe := &str_index_of 'hello world', 'xyz';`)).toBe(-1)
        expect(await runInt(`${P}\n\\\\ probe () -> Int\n@fn probe := &@if (&str_contains 'hello world', 'o w'), { 1 }, { 0 };`)).toBe(1)
    })
    test('str_slice', async () => {
        expect(await runStr(`${P}\n\\\\ probe () -> String\n@fn probe := &str_slice 'hello world', 0, 5;`)).toBe('hello')
        expect(await runStr(`${P}\n\\\\ probe () -> String\n@fn probe := &str_slice 'hello world', 6, 11;`)).toBe('world')
        expect(await runStr(`${P}\n\\\\ probe () -> String\n@fn probe := &str_slice 'hi', 0, 99;`)).toBe('hi')
    })
    test('str_repeat', async () => {
        expect(await runStr(`${P}\n\\\\ probe () -> String\n@fn probe := &str_repeat 'ab', 3;`)).toBe('ababab')
        expect(await runStr(`${P}\n\\\\ probe () -> String\n@fn probe := &str_repeat '=', 10;`)).toBe('==========')
        expect(await runStr(`${P}\n\\\\ probe () -> String\n@fn probe := &str_repeat 'x', 0;`)).toBe('')
    })
    test('str_byte_len / str_is_empty', async () => {
        expect(await runInt(`${P}\n\\\\ probe () -> Int\n@fn probe := &str_byte_len 'hello';`)).toBe(5)
        expect(await runInt(`${P}\n\\\\ probe () -> Int\n@fn probe := &@if (&str_is_empty ''), { 1 }, { 0 };`)).toBe(1)
    })
})

describe('stdlib/io', () => {
    test('io module resolves and compiles under the wasix target', () => {
        // WASI surface — compiled the way `sgl run` does (target=wasix).
        // The whole module (plus its num/mem deps) must resolve,
        // typecheck, and lower to a valid binary.
        const bin = compileBinary(`@use 'io';
            \\\\ probe () -> Int
            @fn probe := {
                &print 'hi';
                &print_int 42;
                &print_bool @true;
                &print_float 1.5;
                &print_str 'no-newline';
                &eprint 'err';
                0
            };
            @export probe;`, 'wasix')
        expect(bin.length).toBeGreaterThan(0)
    })
})
