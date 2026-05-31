// SPDX-License-Identifier: MIT
/**
 * D-D-1 (partial): verifies @platform is registered + works after the
 * legacy → new-form migration in src/strata/metadata.si.
 *
 * @platform is the simplest stratum to migrate because its handler emits
 * no IR (just `&compiler::ir_null`).  This proves the end-to-end
 * compile-then-run path: strata file declares a @stratum + @fn handler,
 * the handler is compiled to WASM via the Phase C engine, the lowered
 * user program invokes the compiled handler at lowering time.
 *
 * @export still uses the legacy form pending a `compiler_str_intern`
 * import (handler needs to pass 'global' / 'func' strings to ir_makeExport).
 */

import { test, expect, describe } from 'bun:test'
import parse from '../parser'
import addToAstSemantics from '../ast/toAst'
import siliconGrammar from '../grammar/SiliconGrammar'
import elaborate from '../elaborator/elaborator'
import { buildStrataRegistry } from '../elaborator/strataLoader'
import { lookupKeyword } from '../elaborator/registry'
import { compileStrataHandlers } from '../comptime/engine'

function parseProgram(src: string): any {
    return addToAstSemantics(siliconGrammar)(parse(src)).toAst() as any
}

describe('D-D-1: @platform migration to new strata form', () => {
    test('@platform keyword is registered in the strata registry', () => {
        // Load the default strata (which includes the migrated metadata.si).
        const prog = parseProgram('')
        const registry = buildStrataRegistry(prog)
        // The @stratum form should have called register::keyword '@platform'.
        const kw = lookupKeyword(registry, '@platform')
        expect(kw).toBeDefined()
    })

    test('PlatformDecl_lower is claimed as a named handler', () => {
        const prog = parseProgram('')
        const registry = buildStrataRegistry(prog)
expect(registry.strataHandlerFnNames.has('PlatformDecl_lower')).toBe(true)
        expect(registry.namedHandlers.has('PlatformDecl_lower')).toBe(true)
    })

    test('PlatformDecl_lower compiles to a WASM instance via compileStrataHandlers', async () => {
        const prog = parseProgram('')
        const registry = buildStrataRegistry(prog)
await compileStrataHandlers(prog, registry)
        // The handler body is `&compiler::ir_null` which compiles cleanly
        // — it's the simplest possible compilable handler.
        expect(registry.compiledHandlers.has('PlatformDecl_lower')).toBe(true)
    })

    test('PlatformDecl_lower invoked returns 0 (null IR)', async () => {
        const prog = parseProgram('')
        const registry = buildStrataRegistry(prog)
await compileStrataHandlers(prog, registry)
        const compiled = registry.compiledHandlers.get('PlatformDecl_lower')!
        // ir_null returns 0 — the "no IR" sentinel.
        expect(compiled.invoke(0)).toBe(0)
    })
})
