// SPDX-License-Identifier: MIT
import { describe, test, expect } from 'bun:test'
import { inlineStdlibUses } from './inlineUses'

describe('inlineStdlibUses', () => {
    test('inlines a bare-name stdlib module and strips the @use line', () => {
        const out = inlineStdlibUses(`@use 'num';
@fn main := int_to_str(42);`)
        expect(out).not.toContain(`@use 'num'`)
        expect(out).toContain('int_to_str')          // num's body is present
        expect(out).toContain('@fn main')            // user body preserved
    })

    test('expands transitive dependencies (io -> num -> mem) once each', () => {
        const out = inlineStdlibUses(`@use 'io';\n@fn main := 0;`)
        // io pulls in num and mem; align_up (mem) and int_to_str (num) appear.
        expect(out).toContain('align_up')
        expect(out).toContain('int_to_str')
        expect(out).toContain('write_bytes')
        // de-duplicated: mem's heap_align defined exactly once.
        const defs = out.match(/@fn heap_align/g) ?? []
        expect(defs.length).toBe(1)
    })

    test('leaves non-stdlib (path) uses untouched', () => {
        const src = `@use '../local/thing.si';\n@fn main := 0;`
        expect(inlineStdlibUses(src)).toBe(src)
    })

    test('no @use → source returned unchanged', () => {
        const src = `@fn main := 0;`
        expect(inlineStdlibUses(src)).toBe(src)
    })

    test('dependency precedes dependent (mem before num)', () => {
        const out = inlineStdlibUses(`@use 'num';\n@fn m := 0;`)
        expect(out.indexOf('@fn align_up')).toBeLessThan(out.indexOf('@fn int_to_str'))
    })
})
