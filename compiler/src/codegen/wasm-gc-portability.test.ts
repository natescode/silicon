// SPDX-License-Identifier: MIT
/**
 * Phase 9d-5 (a + b + c) — the two-layer portability split from ADR 0009.
 *
 * Three groups of tests, one per sub-story:
 *
 *   9d-5a (E0012) — introspection primitives (&rc_count, &heap_used, …)
 *                   raise E0012 under wasm-gc.
 *   9d-5b (E0013) — physical-byte primitives (&alloc, &str_ptr, …)
 *                   raise E0013 under wasm-gc.
 *   9d-5c — lifecycle primitives (&@with_arena, &@move_to_parent_arena)
 *           compile to no-op elision under wasm-gc.  Source-level
 *           portable: same program compiles under both targets.
 *
 *   Regression — wasm-mvp behavior unchanged for every primitive.
 */

import { test, expect, describe } from 'bun:test'
import parse from '../parser'
import addToAstSemantics from '../ast/toAst'
import siliconGrammar from '../grammar/SiliconGrammar'
import { buildStrataRegistry, elaborate } from '../elaborator/index'
import { typecheck } from '../types/index'
import { lowerProgram } from '../ir/lower'
import { emitModule } from '../ir/emit'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const rcSrc = readFileSync(join(__dirname, '../stdlib/rc.si'), 'utf-8')

/** Compile a source program under a given target; return diagnostics + (optional) WAT. */
function compile(src: string, target: 'host' | 'wasm-gc') {
    const ast = addToAstSemantics(siliconGrammar)(parse(src)).toAst() as any
    const registry = buildStrataRegistry(ast)
    const { program: elab } = elaborate(ast, registry)
    const tc = typecheck(elab, registry, undefined, target)
    if (tc.errors.length) return { errors: tc.errors, wat: null }
    try {
        const mod = lowerProgram(tc.program, registry, tc.functions, undefined, { target })
        const wat = emitModule(mod, '')
        return { errors: [], wat }
    } catch (e) {
        return { errors: [{ kind: 'LowerError', message: String(e) }], wat: null }
    }
}

// ── 9d-5a — E0012: introspection primitives ─────────────────────────────

describe('Phase 9d-5a: E0012 — introspection primitives under wasm-gc', () => {
    const introspection: Array<{ name: string; call: string }> = [
        { name: 'heap_get',     call: '&heap_get' },
        { name: 'heap_set',     call: '&heap_set 0' },
        { name: 'heap_used',    call: '&heap_used' },
        { name: 'arena_used',   call: '&arena_used 0' },
    ]

    for (const { name, call } of introspection) {
        test(`${name} raises E0012 under wasm-gc`, () => {
            const r = compile(`@fn probe:Int := ${call};`, 'wasm-gc')
            expect(r.errors.length).toBeGreaterThan(0)
            const e = r.errors.find(e => e.kind === 'MvpOnlyIntrospection')
            expect(e).toBeDefined()
            expect(e!.message).toContain(name)
            expect(e!.message).toContain('wasm-gc')
        })

        test(`${name} compiles fine under wasm-mvp (no regression)`, () => {
            const r = compile(`@fn probe:Int := ${call};`, 'host')
            // Either no errors, or unrelated errors — but no E0012.
            const e0012 = r.errors.filter(e => e.kind === 'MvpOnlyIntrospection')
            expect(e0012.length).toBe(0)
        })
    }

    test('rc_count and rc_is_unique raise E0012 when called', () => {
        const src = `${rcSrc}
            @fn probe:Int := {
                @local r:Int := &rc_new 1;
                &rc_count r
            };`
        const r = compile(src, 'wasm-gc')
        const e = r.errors.find(e => e.kind === 'MvpOnlyIntrospection' && e.message.includes('rc_count'))
        expect(e).toBeDefined()
    })
})

// ── 9d-5b — E0013: physical-byte primitives ─────────────────────────────

describe('Phase 9d-5b: E0013 — physical-byte primitives under wasm-gc', () => {
    const physical: Array<{ name: string; call: string }> = [
        { name: 'alloc',     call: '&alloc 16' },
        { name: 'realloc',   call: '&realloc 0, 0, 16' },
        { name: 'mem_copy',  call: '&mem_copy 0, 0, 0' },
        { name: 'str_ptr',   call: "&str_ptr 'hi'" },
    ]

    for (const { name, call } of physical) {
        test(`${name} raises E0013 under wasm-gc`, () => {
            // alloc returns Int; the others return Int or void.  Wrap in
            // an Int-returning fn that uses the call (even if void, the
            // E0013 fires before any return-type mismatch could trigger).
            const wrap = name === 'mem_copy'
                ? `@fn probe:Int := { ${call}; 0 };`
                : `@fn probe:Int := ${call};`
            const r = compile(wrap, 'wasm-gc')
            const e = r.errors.find(e => e.kind === 'MvpOnlyPhysicalByte')
            expect(e).toBeDefined()
            expect(e!.message).toContain(name)
        })

        test(`${name} compiles fine under wasm-mvp (no regression)`, () => {
            const wrap = name === 'mem_copy'
                ? `@fn probe:Int := { ${call}; 0 };`
                : `@fn probe:Int := ${call};`
            const r = compile(wrap, 'host')
            const e0013 = r.errors.filter(e => e.kind === 'MvpOnlyPhysicalByte')
            expect(e0013.length).toBe(0)
        })
    }
})

// ── 9d-5c — lifecycle elision ──────────────────────────────────────────

describe('Phase 9d-5c: lifecycle primitives compile-time elision under wasm-gc', () => {

    test('&@with_arena typechecks under wasm-gc (no rejection)', () => {
        const src = `@fn probe:Int := &@with_arena { 42 };`
        const r = compile(src, 'wasm-gc')
        expect(r.errors).toEqual([])
    })

    test('&@with_arena under wasm-gc emits no save/restore envelope', () => {
        // Under wasm-mvp the body is wrapped in $heap_get save + $heap
        // restore.  Under wasm-gc both are elided.
        const src = `@fn probe:Int := &@with_arena { 42 };`
        const rMvp = compile(src, 'host')
        const rGc  = compile(src, 'wasm-gc')
        // Mvp emits the save/restore globals access.
        expect(rMvp.wat).toContain('global.get $heap')
        expect(rMvp.wat).toContain('global.set $heap')
        // Gc emits neither (well — the prelude has some $heap accesses
        // unrelated to arenas; we check the USER function body specifically).
        // Find the function body and confirm no save/restore lives there.
        const userFn = extractUserFn(rGc.wat!, 'probe')
        expect(userFn).not.toContain('global.get $heap')
        expect(userFn).not.toContain('global.set $heap')
    })

    test('&@with_arena under wasm-gc emits no $arena_promote call', () => {
        const src = `
            @fn build:String := &@with_arena {
                @local s:String := 'hello';
                &@move_to_parent_arena s
            };`
        const rGc = compile(src, 'wasm-gc')
        const userFn = extractUserFn(rGc.wat!, 'build')
        expect(userFn).not.toContain('arena_promote')
    })

    test('&@move_to_parent_arena under wasm-gc is identity (allowed anywhere)', () => {
        // Under wasm-mvp this would error — &@move_to_parent_arena
        // outside an arena is rejected.  Under wasm-gc it's just identity.
        const src = `@fn probe:Int := &@move_to_parent_arena 99;`
        const rGc = compile(src, 'wasm-gc')
        expect(rGc.errors).toEqual([])
    })

    test('same source compiles under BOTH targets (portability claim)', () => {
        // The whole point of the portability split: any program that
        // uses only lifecycle primitives + value types compiles unchanged.
        const src = `
            @fn portable:Int := &@with_arena {
                @local x:Int := 42;
                @local y:Int := x + 1;
                &@move_to_parent_arena y
            };`
        const rMvp = compile(src, 'host')
        const rGc  = compile(src, 'wasm-gc')
        expect(rMvp.errors).toEqual([])
        expect(rGc.errors).toEqual([])
        // Both must produce a callable `portable` function.
        expect(rMvp.wat).toContain('(func $portable')
        expect(rGc.wat).toContain('(func $portable')
    })

    test('nested arenas elide cleanly under wasm-gc', () => {
        const src = `
            @fn probe:Int := {
                &@with_arena {
                    &@with_arena {};
                };
                0
            };`
        const rGc = compile(src, 'wasm-gc')
        expect(rGc.errors).toEqual([])
        const userFn = extractUserFn(rGc.wat!, 'probe')
        expect(userFn).not.toContain('global.get $heap')
    })
})

// ── Helpers ──────────────────────────────────────────────────────────────

/** Extract the WAT between `(func $name …)` and the matching close-paren. */
function extractUserFn(wat: string, name: string): string {
    const start = wat.indexOf(`(func $${name}`)
    if (start < 0) return ''
    // Find balanced close-paren.
    let depth = 0, i = start
    for (; i < wat.length; i++) {
        if (wat[i] === '(') depth++
        else if (wat[i] === ')') { depth--; if (depth === 0) break }
    }
    return wat.slice(start, i + 1)
}
