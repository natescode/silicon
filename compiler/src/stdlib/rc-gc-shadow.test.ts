// SPDX-License-Identifier: MIT
/**
 * Phase 9d-6 — end-to-end test that src/stdlib/gc/rc.si shadows
 * src/stdlib/rc.si under --target=wasm-gc.  Verifies:
 *
 *   1. Resolving rc.si under wasm-gc picks the gc/rc.si file (no
 *      &alloc, no &WASM::i32_store).
 *   2. The identity-shim source typechecks cleanly under wasm-gc
 *      (rc_new / rc_clone / rc_drop / rc_get all valid; rc_count /
 *      rc_is_unique correctly absent — they'd raise E0012 if called
 *      because they aren't defined in the gc shadow).
 *   3. Under wasm-mvp the original rc.si is used (the gc shadow is
 *      ignored), so refcount semantics work as Phase 9c shipped them.
 */

import { test, expect, describe } from 'bun:test'
import { resolve } from 'path'
import { resolveUses } from '../modules/useResolver'
import parse from '../parser'
import addToAstSemantics from '../ast/toAst'
import siliconGrammar from '../grammar/SiliconGrammar'
import { buildStrataRegistry, elaborate } from '../elaborator/index'
import { typecheck } from '../types/index'

const RC_MVP_PATH = resolve(__dirname, 'rc.si')
const RC_GC_PATH  = resolve(__dirname, 'gc', 'rc.si')

describe('Phase 9d-6: src/stdlib/gc/rc.si shadow', () => {

    test('wasm-gc resolves to gc/rc.si, not rc.si', () => {
        const main = `@use '${RC_MVP_PATH}';\n@fn test_id := rc_new(42);`
        const { visited } = resolveUses(main, resolve(__dirname, 'test-main.si'),
            { target: 'wasm-gc' })
        expect(visited).toContain(RC_GC_PATH)
        expect(visited).not.toContain(RC_MVP_PATH)
    })

    test('host resolves to the original rc.si (gc shadow is ignored)', () => {
        const main = `@use '${RC_MVP_PATH}';\n@fn test_id := rc_new(42);`
        const { visited } = resolveUses(main, resolve(__dirname, 'test-main.si'),
            { target: 'host' })
        expect(visited).toContain(RC_MVP_PATH)
        expect(visited).not.toContain(RC_GC_PATH)
    })

    test('gc/rc.si identity shim typechecks cleanly under wasm-gc', () => {
        const main = `@use '${RC_MVP_PATH}';
            @fn test_lifecycle := {
                @mut r := rc_new(42);
                @mut r2 := rc_clone(r);
                rc_drop(r2);
                rc_get(r)
            };`
        const { source } = resolveUses(main, resolve(__dirname, 'test-main.si'),
            { target: 'wasm-gc' })
        const ast = addToAstSemantics(siliconGrammar)(parse(source)).toAst() as any
        const registry = buildStrataRegistry(ast)
        const { program: elab } = elaborate(ast, registry)
        const tc = typecheck(elab, registry, undefined, 'wasm-gc')
        // Should be no errors — the gc shadow's identity functions
        // have the same signatures as the mvp version.
        expect(tc.errors).toEqual([])
    })

    test('gc/rc.si does NOT export rc_count / rc_is_unique', () => {
        // These two were E0012-rejected per ADR 0009's introspection
        // layer.  The gc shadow file must not define them — if it did,
        // user code under wasm-gc would compile silently and produce
        // misleading results.  Calling them from user code under
        // wasm-gc raises E0012.
        const main = `@use '${RC_MVP_PATH}';
            @fn test_count := {
                @mut r := rc_new(1);
                rc_count(r)
            };`
        const { source } = resolveUses(main, resolve(__dirname, 'test-main.si'),
            { target: 'wasm-gc' })
        const ast = addToAstSemantics(siliconGrammar)(parse(source)).toAst() as any
        const registry = buildStrataRegistry(ast)
        const { program: elab } = elaborate(ast, registry)
        const tc = typecheck(elab, registry, undefined, 'wasm-gc')
        // E0012 from the typechecker pass — &rc_count is in the
        // MVP_ONLY_INTROSPECTION set.
        const e0012 = tc.errors.find(e => e.kind === 'MvpOnlyIntrospection'
                                       && e.message.includes('rc_count'))
        expect(e0012).toBeDefined()
    })

    test('full Rc lifecycle compiles under wasm-mvp (Phase 9c regression)', () => {
        const main = `@use '${RC_MVP_PATH}';
            @fn test_full := {
                @mut r := rc_new(100);
                @mut r2 := rc_clone(r);
                rc_drop(r2);
                rc_get(r)
            };`
        const { source } = resolveUses(main, resolve(__dirname, 'test-main.si'),
            { target: 'host' })
        const ast = addToAstSemantics(siliconGrammar)(parse(source)).toAst() as any
        const registry = buildStrataRegistry(ast)
        const { program: elab } = elaborate(ast, registry)
        const tc = typecheck(elab, registry, undefined, 'host')
        expect(tc.errors).toEqual([])
    })
})
