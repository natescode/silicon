// SPDX-License-Identifier: MIT
/**
 * String extensions (ADR 0022) — byte view (`str_bytes`), code-point count,
 * display width, and the `StrBuilder`.  Each probe is compiled via the CLI
 * path (resolveUses + compile) and run under the `host` target; Int results
 * are read directly, String results by decoding the length-prefixed payload.
 */
import { describe, test, expect } from 'bun:test'
import { resolve, dirname } from 'node:path'
import { compile } from '../caas/index'
import { resolveUses } from '../modules/useResolver'
import { loadModules } from '../modules'

interface Exports { [name: string]: any; memory: WebAssembly.Memory }
const ENTRY_PATH = resolve(__dirname, '../../entry.si')

function compileBinary(src: string): Uint8Array {
    const { source } = resolveUses(src, ENTRY_PATH, { target: 'host' })
    const moduleReg = loadModules(dirname(ENTRY_PATH))
    const result = compile(source, {
        file: ENTRY_PATH, moduleRegistry: moduleReg, target: 'host', emitBinary: true,
    })
    if (result.diagnostics.length) {
        throw new Error(result.diagnostics.map((d: any) => d.message).join('; '))
    }
    return result.binary as Uint8Array
}

async function compileRun(src: string): Promise<Exports> {
    const bin = compileBinary(src)
    const mod = await WebAssembly.instantiate(bin, { env: { print: () => {}, read: () => 0 } })
    return mod.instance.exports as unknown as Exports
}

function readStr(exp: Exports, ptr: number): string {
    const view = new DataView(exp.memory.buffer)
    const len = view.getInt32(ptr, true)
    return new TextDecoder().decode(new Uint8Array(exp.memory.buffer, ptr + 4, len))
}

async function runInt(body: string): Promise<number> {
    const exp = await compileRun(`${body}\n@export probe;`)
    return exp.probe() as number
}

async function runStr(body: string): Promise<string> {
    const exp = await compileRun(`${body}\n@export probe;`)
    return readStr(exp, exp.probe() as number)
}

describe('stdlib/str — code points vs bytes', () => {
    test('str_code_point_count counts code points, not bytes', async () => {
        expect(await runInt(`@use 'str';\n\\\\ probe Int\n@fn probe := str_code_point_count('中文');`)).toBe(2)
        expect(await runInt(`@use 'str';\n\\\\ probe Int\n@fn probe := str_code_point_count('ab');`)).toBe(2)
    })
    test('str_len is byte length (3 bytes per CJK code point)', async () => {
        expect(await runInt(`@use 'str';\n\\\\ probe Int\n@fn probe := str_len('中文');`)).toBe(6)
    })
})

describe('stdlib/str — display width (experimental)', () => {
    test('ASCII is 1 column, CJK is 2 columns', async () => {
        expect(await runInt(`@use 'str';\n\\\\ probe Int\n@fn probe := str_width('ab');`)).toBe(2)
        expect(await runInt(`@use 'str';\n\\\\ probe Int\n@fn probe := str_width('中');`)).toBe(2)
        expect(await runInt(`@use 'str';\n\\\\ probe Int\n@fn probe := str_width('a中b');`)).toBe(4)
    })
})

describe('stdlib/slice — str_bytes view', () => {
    test('str_bytes yields a Slice[u8] over the payload (no pointer math)', async () => {
        expect(await runInt(`@use 'option';\n@use 'slice';\n\\\\ probe Int\n@fn probe := slice_get_byte(str_bytes('Hi'), 0);`)).toBe(72)
        expect(await runInt(`@use 'option';\n@use 'slice';\n\\\\ probe Int\n@fn probe := slice_len(str_bytes('Hello'));`)).toBe(5)
    })
})

describe('stdlib/strbuilder', () => {
    test('builds a String from byte + str pieces', async () => {
        expect(await runStr(`@use 'strbuilder';\n\\\\ probe String\n@fn probe := { @mut b := sb_new(8); sb_push_str(b, 'Hi'); sb_push_byte(b, 33); sb_finish(b) };`)).toBe('Hi!')
    })
    test('sb_push_code_point UTF-8 encodes (multi-byte round-trips)', async () => {
        // 中 = U+4E2D = 20013 → 3 UTF-8 bytes, width 2
        expect(await runInt(`@use 'str';\n@use 'strbuilder';\n\\\\ probe Int\n@fn probe := { @mut b := sb_new(4); sb_push_code_point(b, 20013); str_len(sb_finish(b)) };`)).toBe(3)
        expect(await runStr(`@use 'strbuilder';\n\\\\ probe String\n@fn probe := { @mut b := sb_new(4); sb_push_code_point(b, 20013); sb_finish(b) };`)).toBe('中')
    })
})
