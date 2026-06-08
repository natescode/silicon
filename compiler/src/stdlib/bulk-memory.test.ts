// SPDX-License-Identifier: MIT
/**
 * Tier-1: bulk-memory (ADR-0008/0022). The prelude `mem_copy` and stdlib
 * `mem_fill` lower to the single `memory.copy` / `memory.fill` instructions
 * instead of byte-wise loops. We assert the emitted module uses those ops and
 * stays spec-valid. (Correctness of the copy/fill themselves is covered by the
 * allocator / vec / hashmap suites, which route element shifts through mem_copy.)
 *
 * Compilation goes through `resolveUses` + the built-in module registry — the
 * same file-based path the CLI/std_modules tests use — so `@use 'mem'` reads
 * mem.si fresh from disk (not the embedded playground bundle).
 */

import { test, expect, describe } from 'bun:test'
import { resolve, dirname } from 'node:path'
import { compile } from '../caas'
import { resolveUses } from '../modules/useResolver'
import { loadModules } from '../modules'
import { validateWasmBinary } from '../codegen/wasm-validator'

const ENTRY_PATH = resolve(__dirname, '../../entry.si')

function compileSrc(src: string, target: 'host' | 'wasm-gc' = 'host') {
    const { source } = resolveUses(src, ENTRY_PATH, { target })
    const moduleReg = loadModules(dirname(ENTRY_PATH))
    const r = compile(source, { file: ENTRY_PATH, moduleRegistry: moduleReg, target, emitBinary: true } as any)
    expect(r.diagnostics.map(d => `${d.code}: ${d.message}`)).toEqual([])
    expect(r.binary).toBeDefined()
    return r
}

describe('bulk-memory lowering', () => {
    test('mem_fill lowers to the memory.fill instruction', () => {
        const r = compileSrc(`@use 'mem';
\\\\ go (Int) -> Int
@fn go p := { mem_fill(p, 65, 16) };
@export go;`)
        expect(r.wat).toContain('memory.fill')
        expect(validateWasmBinary(r.binary!).ok).toBe(true)
    })

    test('the prelude mem_copy lowers to the memory.copy instruction', () => {
        const r = compileSrc(`\\\\ id (Int) -> Int
@fn id x := x;
@export id;`)
        expect(r.wat).toContain('memory.copy')
        expect(validateWasmBinary(r.binary!).ok).toBe(true)
    })

    test('mem_fill + the prelude memory.copy validate under wasm-gc', () => {
        // After the module split, `mem` holds only portable byte ops (no
        // heap_get/heap_set), so `@use 'mem'` — and thus mem_fill — now compiles
        // under wasm-gc too. (The mvp-only bump-pointer helper lives in 'heap'.)
        const r = compileSrc(`@use 'mem';
\\\\ go (Int) -> Int
@fn go p := { mem_fill(p, 0, 8) };
@export go;`, 'wasm-gc')
        expect(r.wat).toContain('memory.fill')
        expect(r.wat).toContain('memory.copy')   // always-emitted prelude
        expect(validateWasmBinary(r.binary!).ok).toBe(true)
    })
})
