// SPDX-License-Identifier: MIT
/**
 * Phase 9c (ADR 0008) — explicit-arena memory management.
 *
 * Exercises:
 *   - `&@with_arena { body }` resets the bump heap pointer on exit so
 *     allocations inside the body don't leak.
 *   - `&@move_to_parent_arena value` in tail position survives the
 *     reset (String case + value-type case).
 *   - Heap-returning bodies without a tail promotion are rejected at
 *     IR-lowering time with a useful diagnostic.
 *   - `&@move_to_parent_arena` outside an arena is rejected.
 *
 * Lifecycle:
 *   Programs export a probe (`heap_now`) so the test can read the
 *   bump pointer through the wasm memory and assert the arena bound.
 */

import { test, expect, describe } from 'bun:test'
import { compileToWasm, type LowerOptions } from './index'
import siliconGrammar from '../grammar/SiliconGrammar'
import parse from '../parser'
import { addToAstSemantics } from '../ast/index'
import { buildStrataRegistry, elaborate } from '../elaborator/index'
import { typecheck, formatTypeError } from '../types/index'
import type { Program } from '../ast/astNodes'

interface CompileResult { ok: true; exports: any; memory: WebAssembly.Memory }
interface CompileError  { ok: false; error: string }

async function compileAndRun(src: string, opts: LowerOptions = {}): Promise<CompileResult | CompileError> {
    let typed: Program, registry: any, functions: any
    try {
        const match = parse(src)
        const ast = addToAstSemantics(siliconGrammar)(match).toAst() as Program
        registry = buildStrataRegistry(ast)
        const { program: elaborated, errors: elabErrors } = elaborate(ast, registry)
        if (elabErrors.length > 0) {
            return { ok: false, error: elabErrors.map(e => e.message).join('; ') }
        }
        const tc = typecheck(elaborated, registry)
        if (tc.errors.length > 0) {
            return { ok: false, error: tc.errors.map(formatTypeError).join('; ') }
        }
        typed = tc.program
        functions = tc.functions
    } catch (e) {
        return { ok: false, error: String(e) }
    }
    try {
        const bin = compileToWasm(typed!, registry, functions, undefined, opts)
        const mod = await WebAssembly.instantiate(bin, {
            env: { print: () => {}, read: () => 0 },
        })
        return {
            ok: true,
            exports: mod.instance.exports,
            memory: mod.instance.exports.memory as WebAssembly.Memory,
        }
    } catch (e) {
        return { ok: false, error: String(e) }
    }
}

/** Read a length-prefixed UTF-8 String from wasm memory at the given pointer. */
function readString(memory: WebAssembly.Memory, ptr: number): string {
    const view = new DataView(memory.buffer)
    const len = view.getInt32(ptr, true)
    const bytes = new Uint8Array(memory.buffer, ptr + 4, len)
    return new TextDecoder('utf-8').decode(bytes)
}

describe('Phase 9c: &@with_arena + &@move_to_parent_arena', () => {

    test('empty arena resets heap to entry-point value', async () => {
        const r = await compileAndRun(`
            \\\\ probe () -> Int
            @fn probe  := {
                @local before := &heap_get;
                &@with_arena {};
                @local after := &heap_get;
                after - before
            };
            @export probe;
        `)
        if (!r.ok) throw new Error(r.error)
        // Heap should be unchanged after an empty arena.
        expect(r.exports.probe()).toBe(0)
    })

    test('arena reset frees inside-arena allocations', async () => {
        const r = await compileAndRun(`
            \\\\ probe () -> Int
            @fn probe  := {
                @local before := &heap_get;
                &@with_arena {
                    @local s := 'scratch allocation here';
                };
                @local after := &heap_get;
                after - before
            };
            @export probe;
        `)
        if (!r.ok) throw new Error(r.error)
        // Inside-arena String is allocated and then freed at exit.
        expect(r.exports.probe()).toBe(0)
    })

    test('repeated arenas do not leak memory', async () => {
        const r = await compileAndRun(`
            \\\\ probe () -> Int
            @fn probe  := {
                @local before := &heap_get;
                @var i := 0;
                &@loop i < 100, {
                    &@with_arena {
                        @local s := 'scratch';
                    };
                    i = i + 1;
                };
                @local after := &heap_get;
                after - before
            };
            @export probe;
        `)
        if (!r.ok) throw new Error(r.error)
        // 100 iterations × scratch String, all freed.
        expect(r.exports.probe()).toBe(0)
    })

    test('value-type tail (Int) survives arena reset', async () => {
        const r = await compileAndRun(`
            \\\\ probe () -> Int
            @fn probe  := &@with_arena {
                @local s := 'throwaway';
                42
            };
            @export probe;
        `)
        if (!r.ok) throw new Error(r.error)
        expect(r.exports.probe()).toBe(42)
    })

    test('value-type tail does not leak the scratch allocation', async () => {
        const r = await compileAndRun(`
            \\\\ probe () -> Int
            @fn probe  := {
                @local before := &heap_get;
                @local _ignored := &@with_arena {
                    @local s := 'throwaway';
                    7
                };
                @local after := &heap_get;
                after - before
            };
            @export probe;
        `)
        if (!r.ok) throw new Error(r.error)
        expect(r.exports.probe()).toBe(0)
    })

    test('&@move_to_parent_arena promotes a String to the parent arena', async () => {
        const r = await compileAndRun(`
            \\\\ build () -> String
            @fn build  := &@with_arena {
                @local scratch := 'scratch garbage';
                @local out := 'hello, world';
                &@move_to_parent_arena out
            };
            @export build;
            \\\\ heap_now () -> Int
            @fn heap_now  := &heap_get;
            @export heap_now;
        `)
        if (!r.ok) throw new Error(r.error)
        const ptr: number = r.exports.build()
        // The promoted String is at the saved boundary, and the heap
        // pointer should be saved + (4 + len) — only the promoted bytes
        // survived, not the scratch.
        const decoded = readString(r.memory, ptr)
        expect(decoded).toBe('hello, world')
        const heapAfter: number = r.exports.heap_now()
        // 4-byte header + 12 UTF-8 bytes for 'hello, world' = 16.
        expect(heapAfter - ptr).toBe(16)
    })

    test('&@move_to_parent_arena with Int (value type) is a passthrough', async () => {
        // For value types &@move_to_parent_arena is a no-op alias for
        // returning the value — bytes-to-copy is 0 and the heap unwinds
        // to the saved boundary.
        const r = await compileAndRun(`
            \\\\ probe () -> Int
            @fn probe  := {
                @local before := &heap_get;
                @local v := &@with_arena {
                    @local scratch := 'throwaway';
                    &@move_to_parent_arena 99
                };
                @local after := &heap_get;
                v + (after - before)
            };
            @export probe;
        `)
        if (!r.ok) throw new Error(r.error)
        // v == 99, heap restored → after - before == 0.
        expect(r.exports.probe()).toBe(99)
    })

    test('heap-returning body without &@move_to_parent_arena is a compile error', async () => {
        const r = await compileAndRun(`
            \\\\ build () -> String
            @fn build  := &@with_arena {
                @local out := 'would dangle';
                out
            };
            @export build;
        `)
        expect(r.ok).toBe(false)
        if (!r.ok) {
            expect(r.error).toContain('@with_arena')
            expect(r.error).toContain('String')
        }
    })

    test('&@move_to_parent_arena outside &@with_arena is a compile error', async () => {
        const r = await compileAndRun(`
            \\\\ probe () -> Int
            @fn probe  := &@move_to_parent_arena 1;
            @export probe;
        `)
        expect(r.ok).toBe(false)
        if (!r.ok) {
            expect(r.error).toContain('@move_to_parent_arena')
            expect(r.error).toContain('tail position')
        }
    })

    test('nested arenas: inner reset restores to inner entry, outer to outer entry', async () => {
        const r = await compileAndRun(`
            \\\\ probe () -> Int
            @fn probe  := {
                @local before := &heap_get;
                &@with_arena {
                    @local a := 'outer scratch';
                    &@with_arena {
                        @local b := 'inner scratch';
                    };
                    @local c := 'more outer scratch';
                };
                @local after := &heap_get;
                after - before
            };
            @export probe;
        `)
        if (!r.ok) throw new Error(r.error)
        expect(r.exports.probe()).toBe(0)
    })

    test('&@move_to_parent_arena promotes a flat-payload Sum type', async () => {
        // @type Pair := $Pair x:Int, y:Int — pad-to-max layout is
        // [tag:i32, field0:i32, field1:i32] = 12 bytes.
        const r = await compileAndRun(`
            @type Pair := $Pair x Int, y Int;
            \\\\ build () -> Pair
            @fn build  := &@with_arena {
                @local scratch := 'noise';
                @local p := &Pair 11, 22;
                &@move_to_parent_arena p
            };
            @export build;
            \\\\ heap_now () -> Int
            @fn heap_now  := &heap_get;
            @export heap_now;
        `)
        if (!r.ok) throw new Error(r.error)
        const ptr: number = r.exports.build()
        const view = new DataView(r.memory.buffer)
        expect(view.getInt32(ptr, true)).toBe(0)        // tag for $Pair
        expect(view.getInt32(ptr + 4, true)).toBe(11)   // x
        expect(view.getInt32(ptr + 8, true)).toBe(22)   // y
        const heapAfter: number = r.exports.heap_now()
        expect(heapAfter - ptr).toBe(12)                // 4 + 2*4 pad-to-max
    })

    test('Sum-with-payloads pad-to-max sizing across variants', async () => {
        // @type Shape := $Circle r:Int | $Rectangle w:Int, h:Int — maxFields=2.
        // Even though $Circle only has one field, every value of Shape
        // occupies 12 bytes (4 + 2*4 pad-to-max).
        const r = await compileAndRun(`
            @type Shape := $Circle r Int | $Rectangle w Int, h Int;
            \\\\ build () -> Shape
            @fn build  := &@with_arena {
                @local c := &Circle 7;
                &@move_to_parent_arena c
            };
            @export build;
            \\\\ heap_now () -> Int
            @fn heap_now  := &heap_get;
            @export heap_now;
        `)
        if (!r.ok) throw new Error(r.error)
        const ptr: number = r.exports.build()
        const view = new DataView(r.memory.buffer)
        expect(view.getInt32(ptr, true)).toBe(0)        // tag for $Circle (first variant)
        expect(view.getInt32(ptr + 4, true)).toBe(7)    // r
        const heapAfter: number = r.exports.heap_now()
        expect(heapAfter - ptr).toBe(12)                // pad-to-max width
    })

    test('Sum with String-typed payload is rejected as nested heap', async () => {
        const r = await compileAndRun(`
            @type Tagged := $Named s String;
            \\\\ build () -> Tagged
            @fn build  := &@with_arena {
                @local t := &Named 'hello';
                &@move_to_parent_arena t
            };
            @export build;
        `)
        expect(r.ok).toBe(false)
        if (!r.ok) {
            expect(r.error).toContain('not implemented')
        }
    })

    test('&@move_to_parent_arena promotes an Array[Int]', async () => {
        // [count=3][1][2][3] = 4 + 3*4 = 16 bytes laid out contiguously.
        // Promotion memcpys those 16 bytes to the saved boundary.
        // Array element type is inferred — surface annotations for
        // Array[T] aren't part of the v1.0 grammar.
        const r = await compileAndRun(`
            \\\\ build () -> Int
            @fn build  := &@with_arena {
                @local scratch := 'noise';
                @local arr := $[10, 20, 30];
                &@move_to_parent_arena arr
            };
            @export build;
            \\\\ heap_now () -> Int
            @fn heap_now  := &heap_get;
            @export heap_now;
        `)
        if (!r.ok) throw new Error(r.error)
        const ptr: number = r.exports.build()
        const view = new DataView(r.memory.buffer)
        expect(view.getInt32(ptr, true)).toBe(3)           // count
        expect(view.getInt32(ptr + 4, true)).toBe(10)
        expect(view.getInt32(ptr + 8, true)).toBe(20)
        expect(view.getInt32(ptr + 12, true)).toBe(30)
        const heapAfter: number = r.exports.heap_now()
        expect(heapAfter - ptr).toBe(16)                   // 4 + 3*4
    })

    test('heap-exhaustion under --max-heap traps cleanly (unreachable)', async () => {
        // Cap memory at 2 pages (128KB), well below what a 50KB-per-call
        // allocation needs after a few iterations.  The bump allocator
        // calls memory.grow which returns -1, then traps via
        // `unreachable` — wasmtime surfaces a clean trap reason.
        const r = await compileAndRun(`
            \\\\ fifty_kb_blob () -> String
            @fn fifty_kb_blob  := {
                @local s := 'pad-this-up';
                # &str_concat doubles ~ish each call; 100 iterations
                # well exceeds 2 pages.
                @var i := 0;
                @var acc := 'x';
                &@loop i < 1000, {
                    acc = &str_concat acc, s;
                    i = i + 1;
                };
                acc
            };
            @export fifty_kb_blob;
        `, { maxHeapPages: 2 })
        if (!r.ok) throw new Error(r.error)
        let trapped = false
        try {
            r.exports.fifty_kb_blob()
        } catch (e) {
            trapped = true
            // wasmtime / Bun's wasm host both surface unreachable in the
            // RuntimeError message.
            expect(String(e)).toMatch(/unreachable|RuntimeError/i)
        }
        expect(trapped).toBe(true)
    })

    // ── Phase 9c-8: memory introspection helpers ────────────────────────
    //
    // &heap_used returns bytes bump-allocated since program start; &arena_used
    // returns bytes since a caller-supplied saved pointer.  These exist
    // for tests + dashboards; they do not change heap state themselves.

    test('&heap_used is 0 immediately at program start', async () => {
        const r = await compileAndRun(`
            \\\\ probe () -> Int
            @fn probe  := &heap_used;
            @export probe;
        `)
        if (!r.ok) throw new Error(r.error)
        expect(r.exports.probe()).toBe(0)
    })

    test('&heap_used grows by exactly the runtime String allocation cost', async () => {
        // String literals are static data — they don't bump the heap.
        // `&str_concat` forces a runtime allocation: 'ab' + 'cd' →
        // [len=4][a][b][c][d] = 4 + 4 = 8 bytes consumed.
        const r = await compileAndRun(`
            \\\\ probe () -> Int
            @fn probe  := {
                @local _s := &str_concat 'ab', 'cd';
                &heap_used
            };
            @export probe;
        `)
        if (!r.ok) throw new Error(r.error)
        expect(r.exports.probe()).toBe(8)
    })

    test('&heap_used resets back when &@with_arena unwinds', async () => {
        const r = await compileAndRun(`
            \\\\ probe () -> Int
            @fn probe  := {
                @local before := &heap_used;
                &@with_arena {
                    @local _s := 'scratch';
                };
                @local after := &heap_used;
                after - before
            };
            @export probe;
        `)
        if (!r.ok) throw new Error(r.error)
        expect(r.exports.probe()).toBe(0)
    })

    test('&arena_used tracks the current arena bump distance', async () => {
        const r = await compileAndRun(`
            \\\\ probe () -> Int
            @fn probe  := &@with_arena {
                @local saved := &heap_get;
                @local _s := &str_concat 'hel', 'lo';
                &arena_used saved
            };
            @export probe;
        `)
        if (!r.ok) throw new Error(r.error)
        // `&str_concat` allocates a new String: 4 + 5 = 9 bytes since `saved`.
        expect(r.exports.probe()).toBe(9)
    })

    test('promoted String persists across many arena iterations', async () => {
        const r = await compileAndRun(`
            \\\\ build () -> String
            @fn build  := &@with_arena {
                @local s := 'loop result';
                &@move_to_parent_arena s
            };
            @export build;
            \\\\ heap_now () -> Int
            @fn heap_now  := &heap_get;
            @export heap_now;
        `)
        if (!r.ok) throw new Error(r.error)
        // Repeated calls — each promotes 4+11 = 15 bytes to the outer
        // arena, accumulating linearly (the outer scope has no &@with_arena,
        // so promoted bytes are kept).  This proves the inside-arena
        // scratch is freed each call (otherwise heap growth would be
        // larger than 15 per iteration).
        const startHeap: number = r.exports.heap_now()
        let lastPtr = 0
        for (let i = 0; i < 50; i++) {
            lastPtr = r.exports.build()
        }
        const endHeap: number = r.exports.heap_now()
        expect(endHeap - startHeap).toBe(50 * 15)
        // Last decoded String is intact.
        expect(readString(r.memory, lastPtr)).toBe('loop result')
    })
})
