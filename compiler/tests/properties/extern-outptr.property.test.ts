/**
 * Out-pointer @extern calling convention — Phase −1.F of bootstrap plan.
 *
 * Verifies that:
 *   - $scratch_alloc is present in the runtime,
 *   - a Silicon program can pass a scratch address to an @extern that
 *     would normally write through it (the host write is a runtime
 *     concern, not a compile-time one),
 *   - WASM::i32_load reads back from the address.
 *
 * The end-to-end "host actually wrote through the pointer" check belongs
 * with the WASIX smoke test in Phase 0 — here we only assert the
 * compile-time plumbing works.
 */

import { test, expect, describe } from 'bun:test'
import { compileToWatString } from './_compile'

describe('extern out-pointer convention', () => {
    test('$scratch_alloc helper is emitted into every module', () => {
        const wat = compileToWatString('x := 1;')
        expect(wat).toContain('$scratch_alloc')
        expect(wat).toContain('(export "scratch_alloc" (func $scratch_alloc))')
    })

    test('extern accepting an out-pointer compiles, reads result via i32_load', () => {
        // void-returning extern: host writes through the `scratch` address.
        const src = [
            "\\\\ @extern host_write_fd (Int, Int) -> Void;",
            "\\\\ openIt (Int) -> Int",
            "@fn openIt scratch := {",
            "  host_write_fd(42, scratch);",
            "  WASM::i32_load(scratch)",
            "};",
        ].join('\n')
        const wat = compileToWatString(src)
        expect(wat).toContain('host_write_fd')
        expect(wat).toContain('i32.load')
    })

    test('scratch_alloc can be invoked from user code and result threaded as i32', () => {
        // Silicon callers reference the helper by the dollar-stripped name —
        // the call lowers to (call $scratch_alloc) at WAT level.
        const src = [
            "\\\\ @extern host_fill (Int, Int) -> Void;",
            "go := {",
            "  buf := scratch_alloc(16);",
            "  host_fill(buf, 16);",
            "  WASM::i32_load(buf)",
            "};",
        ].join('\n')
        const wat = compileToWatString(src)
        expect(wat).toContain('call $scratch_alloc')
        expect(wat).toContain('host_fill')
    })
})
