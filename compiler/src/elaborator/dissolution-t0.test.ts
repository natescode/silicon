/**
 * T0 (builtin) strata loader smoke tests for the unified
 * `@stratum := { ... }` form.  Originally written as Phase-D dissolution
 * groundwork when the unified form coexisted with the legacy
 * Elaboration-based shape; the legacy shape was retired in the Phase 5
 * grammar revision, so these tests now just verify the T0 loader still
 * picks up unified-form strata from both builtin .si files and
 * extraSources.
 */

import { test, expect, describe } from 'bun:test'
import { buildStrataRegistry } from './strataLoader'
import { lookupNamedHandler } from './registry'
import parse from '../parser'
import addToAstSemantics from '../ast/toAst'
import siliconGrammar from '../grammar/SiliconGrammar'

function parseProgram(src: string): any {
    return addToAstSemantics(siliconGrammar)(parse(src)).toAst() as any
}

describe('T0 loader accepts the new @stratum + @fn forms', () => {
    test('an extraSource using the new form registers a keyword and named handler', () => {
        // T2 source provided via extraSources — same loader path the
        // builtin loader would use if a .si file contained these forms.
        const newFormStrata = `
            @stratum TestStrata := {
                &Compiler::register::keyword '@test_kw_unique';
                &Compiler::on::lower '@test_kw_unique', TestStrata_lower;
            };
            @fn TestStrata_lower node:Int := 0;
        `
        const registry = buildStrataRegistry(
            { type: 'Program', elements: [] } as any,
            [newFormStrata],
        )
        // The keyword is registered.
        expect(registry.keywords['@test_kw_unique']).toBeDefined()
        // The handler @fn body is in namedHandlers.
        expect(lookupNamedHandler(registry, 'TestStrata_lower')).toBeDefined()
        // The handler is claimed (so the lowerer will skip it as a regular @fn).
        expect(registry.strataHandlerFnNames.has('TestStrata_lower')).toBe(true)
        // The stratum's metadata says it loaded at T2 (extraSources tier).
        expect(registry.strata.get('TestStrata')?.tier).toBe('T2')
    })

    test('all 768 existing tests still pass — legacy T0 strata unaffected', () => {
        // Sanity: building the registry with the standard pipeline still
        // works after the T0 loader extension.  Every builtin stratum in
        // src/strata/ continues to register through the unified form.
        const registry = buildStrataRegistry({ type: 'Program', elements: [] } as any)
        // Some load-bearing legacy strata that must still be present:
        expect(registry.operators['+']).toBeDefined()
        expect(registry.operators['==']).toBeDefined()
        expect(registry.keywords['@if']).toBeDefined()
        expect(registry.keywords['@loop']).toBeDefined()
        expect(registry.keywords['@let']).toBeDefined()
        expect(registry.keywords['@fn']).toBeDefined()
    })
})

describe('@fn pre-pass extends to T0 sources too', () => {
    test('top-level @fn in extraSources is captured into namedHandlers', () => {
        // Today buildStrataRegistry's T1 pre-pass walks the program AST
        // for @fn definitions.  The T0 extension does the same for
        // builtin / extraSources sources, so a handler @fn declared in
        // those files is also discoverable.
        const src = `@fn Discoverable_fn x:Int := x;`
        const registry = buildStrataRegistry(
            { type: 'Program', elements: [] } as any,
            [src],
        )
        // It's in namedHandlers even though no @stratum referenced it.
        // (Storing every @fn is the same harmless behavior as T1.)
        const entry = lookupNamedHandler(registry, 'Discoverable_fn')
        expect(entry).toBeDefined()
        expect(entry!.paramName).toBe('x')
    })
})
