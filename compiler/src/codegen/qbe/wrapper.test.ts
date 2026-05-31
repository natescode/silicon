// SPDX-License-Identifier: MIT
/**
 * QBE main-wrapper transforms — pure-unit tests (no toolchain).
 * (Split from linker.test.ts when the cc/qbe drivers moved to the CLI package.)
 */

import { describe, test, expect } from 'bun:test'
import { hasQbeMain, injectMainWrapper } from './wrapper'

describe('hasQbeMain', () => {
    test('returns true when $main is defined', () => {
        expect(hasQbeMain('function w $main() {\n@start\n\tret 0\n}')).toBe(true)
    })

    test('returns false when no $main is present', () => {
        expect(hasQbeMain('function w $add(w %x, w %y) {\n@start\n\tret 0\n}')).toBe(false)
    })

    test('returns false for empty IR', () => {
        expect(hasQbeMain('')).toBe(false)
    })
})

describe('injectMainWrapper', () => {
    test('is a no-op when $main already exists', () => {
        const ir = 'function w $main() {\n@start\n\tret 42\n}'
        expect(injectMainWrapper(ir)).toBe(ir)
    })

    test('appends a main wrapper when no $main exists', () => {
        const ir = 'function w $add(w %x, w %y) {\n@start\n\tret 0\n}'
        const out = injectMainWrapper(ir)
        expect(out).toContain('$main')
        expect(out).toContain('ret 0')
    })

    test('injected main calls $__sgl_entry when present', () => {
        const ir = 'function $__sgl_entry() {\n@start\n\tret\n}'
        const out = injectMainWrapper(ir)
        expect(out).toContain('call $__sgl_entry')
    })

    test('injected main is minimal when no entry function exists', () => {
        const ir = 'function w $helper(w %x) {\n@start\n\tret %x\n}'
        const out = injectMainWrapper(ir)
        expect(out).toContain('$main')
        expect(out).not.toContain('$__sgl_entry')
    })
})
