/**
 * Workstream A — Step 1: realloc + mem_copy allocator primitives.
 *
 * Runtime tests for the new prelude functions added to enable growable
 * containers (Vec, HashMap) in Phase 5a.  The primitives live in both
 * `src/codegen/std.wat` (text path) and `src/codegen/prelude-ir.ts`
 * (direct-binary path); the byte-equal codegen test already guarantees
 * they emit identical wasm, so we only need to verify one path
 * behaves correctly at runtime.
 *
 * What's tested:
 *  - `mem_copy(dst, src, n)` copies n bytes byte-for-byte.
 *  - `realloc(0, 0, n)` is equivalent to plain alloc for fresh blocks.
 *  - `realloc(old_ptr, old_size, new_size)` preserves min(old, new) bytes
 *    of contents at the new pointer.
 *  - `realloc` returns a fresh pointer (the bump allocator never reuses
 *    the old block; that's by design for the 1.0 leak-on-grow model).
 */

import { test, expect, describe } from 'bun:test'
import { compileToWasm } from './index'
import siliconGrammar from '../grammar/SiliconGrammar'
import parse from '../parser'
import { addToAstSemantics } from '../ast/index'
import { buildStrataRegistry, elaborate } from '../elaborator/index'
import { typecheck } from '../types/index'
import type { Program } from '../ast/astNodes'

interface PreludeExports {
    memory: WebAssembly.Memory
    alloc: (size: number) => number
    realloc: (oldPtr: number, oldSize: number, newSize: number) => number
    mem_copy: (dst: number, src: number, nBytes: number) => void
}

async function instantiatePrelude(): Promise<PreludeExports> {
    // Minimal source that just emits the std prelude; no user code.
    const source = `42;`
    const match = parse(source)
    const ast = addToAstSemantics(siliconGrammar)(match).toAst() as Program
    const registry = buildStrataRegistry(ast)
    const { program: elaborated } = elaborate(ast, registry)
    const { program: typed, functions } = typecheck(elaborated, registry)
    const bin = compileToWasm(typed, registry, functions)
    const mod = await WebAssembly.instantiate(bin, {
        env: { print: () => {}, read: () => 0 },
    })
    return mod.instance.exports as unknown as PreludeExports
}

function writeBytes(memory: WebAssembly.Memory, addr: number, bytes: number[]): void {
    const buf = new Uint8Array(memory.buffer)
    for (let i = 0; i < bytes.length; i++) buf[addr + i] = bytes[i]
}

function readBytes(memory: WebAssembly.Memory, addr: number, n: number): number[] {
    const buf = new Uint8Array(memory.buffer)
    return Array.from(buf.slice(addr, addr + n))
}

describe('Workstream A — Step 1: allocator primitives', () => {
    test('mem_copy copies n bytes from src to dst', async () => {
        const { memory, alloc, mem_copy } = await instantiatePrelude()
        const src = alloc(8)
        const dst = alloc(8)
        writeBytes(memory, src, [10, 20, 30, 40, 50, 60, 70, 80])
        writeBytes(memory, dst, [0, 0, 0, 0, 0, 0, 0, 0])
        mem_copy(dst, src, 8)
        expect(readBytes(memory, dst, 8)).toEqual([10, 20, 30, 40, 50, 60, 70, 80])
    })

    test('mem_copy with n=0 is a no-op', async () => {
        const { memory, alloc, mem_copy } = await instantiatePrelude()
        const src = alloc(4)
        const dst = alloc(4)
        writeBytes(memory, src, [1, 2, 3, 4])
        writeBytes(memory, dst, [99, 99, 99, 99])
        mem_copy(dst, src, 0)
        expect(readBytes(memory, dst, 4)).toEqual([99, 99, 99, 99])
    })

    test('mem_copy with partial length only copies the prefix', async () => {
        const { memory, alloc, mem_copy } = await instantiatePrelude()
        const src = alloc(8)
        const dst = alloc(8)
        writeBytes(memory, src, [1, 2, 3, 4, 5, 6, 7, 8])
        writeBytes(memory, dst, [99, 99, 99, 99, 99, 99, 99, 99])
        mem_copy(dst, src, 3)
        expect(readBytes(memory, dst, 8)).toEqual([1, 2, 3, 99, 99, 99, 99, 99])
    })

    test('realloc(0, 0, n) returns a fresh allocation', async () => {
        const { alloc, realloc } = await instantiatePrelude()
        const a = alloc(0)  // heap pointer
        const grown = realloc(0, 0, 16)
        expect(grown).toBeGreaterThanOrEqual(a)
    })

    test('realloc preserves the old contents up to min(old, new)', async () => {
        const { memory, alloc, realloc } = await instantiatePrelude()
        const old = alloc(8)
        writeBytes(memory, old, [11, 22, 33, 44, 55, 66, 77, 88])
        const grown = realloc(old, 8, 32)
        // First 8 bytes of grown must match the old contents.
        expect(readBytes(memory, grown, 8)).toEqual([11, 22, 33, 44, 55, 66, 77, 88])
    })

    test('realloc to a smaller size truncates to new_size bytes', async () => {
        const { memory, alloc, realloc } = await instantiatePrelude()
        const old = alloc(16)
        writeBytes(memory, old, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
        const shrunk = realloc(old, 16, 4)
        // Only first 4 bytes carried over.
        expect(readBytes(memory, shrunk, 4)).toEqual([1, 2, 3, 4])
    })

    test('realloc returns a fresh pointer (old block is leaked, not reused)', async () => {
        // The 1.0 bump allocator never reuses freed memory.  Verify
        // realloc always returns a higher address than the old block.
        const { alloc, realloc } = await instantiatePrelude()
        const old = alloc(64)
        const grown = realloc(old, 64, 128)
        expect(grown).toBeGreaterThan(old)
    })

    test('realloc with new_size > old_size leaves uninitialised tail (no zero-fill guarantee)', async () => {
        // Documenting current behaviour: the tail beyond old_size is
        // whatever the bump allocator's heap contained at that address.
        // Vec callers must initialise the tail before reading it.
        const { memory, alloc, realloc } = await instantiatePrelude()
        const old = alloc(4)
        writeBytes(memory, old, [0xAA, 0xBB, 0xCC, 0xDD])
        const grown = realloc(old, 4, 16)
        // First 4 bytes preserved.
        expect(readBytes(memory, grown, 4)).toEqual([0xAA, 0xBB, 0xCC, 0xDD])
        // Tail bytes are not guaranteed to be anything in particular;
        // we just check the call didn't trap and the prefix is intact.
    })
})
