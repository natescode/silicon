/**
 * WASI _start export — Phase −1.E of bootstrap plan.
 *
 * The WASI runner (wasmtime, wasmer, etc.) invokes the function exported
 * as exactly `_start`.  Stage 0 always synthesises `$__start` as the
 * module-init wrapper; under `--target=wasix` we additionally export it
 * under the WASI-mandated name so `wasmtime sigil.wasm` runs the program
 * without an --invoke flag.
 *
 * Tests here exercise the compile-time wiring only. The "runtime
 * actually picks up _start" check lives in the Phase 0 WASIX smoke test.
 */

import { test, expect, describe } from 'bun:test'
import { join } from 'path'
import { parse } from '../../src/parser/index.ts'
import { addToAstSemantics, type Program } from '../../src/ast/index.ts'
import { compileToWat } from '../../src/codegen/index.ts'
import { buildStrataRegistry, elaborate } from '../../src/elaborator/index.ts'
import { typecheck, formatTypeError } from '../../src/types/index.ts'
import { siliconGrammar } from '../../src/grammar/index.ts'
import { loadModules } from '../../src/modules/index.ts'

const PROJECT_ROOT = join(import.meta.dirname, '../..')

function compile(source: string, target: 'host' | 'wasix' = 'host'): string {
    const moduleRegistry = loadModules(PROJECT_ROOT)
    const match = parse(source)
    const ast = addToAstSemantics(siliconGrammar)(match).toAst() as Program
    const registry = buildStrataRegistry(ast)
    const { program: elab } = elaborate(ast, registry)
    const { program: typed, errors, functions } = typecheck(elab, registry)
    if (errors.length > 0) throw new Error('type: ' + errors.map(formatTypeError).join('; '))
    return compileToWat(typed, registry, functions, moduleRegistry, { target })
}

describe('WASIX _start export', () => {
    test('default host target: no _start export emitted', () => {
        const wat = compile('@let main := { 42 };')
        expect(wat).not.toContain('(export "_start"')
    })

    test('wasix target: always emits (export "_start" (func $__start))', () => {
        // Even with no top-level statements, $__start exists as a no-op
        // so the WASIX runner has something to invoke.
        const wat = compile('@let main := { 42 };', 'wasix')
        expect(wat).toContain('(export "_start" (func $__start))')
        expect(wat).toMatch(/\(func \$__start\b/)
    })

    test('wasix target with top-level statements: $__start contains them', () => {
        const wat = compile([
            '@let helper := { 7 };',
            '&helper;',
        ].join('\n'), 'wasix')
        expect(wat).toContain('(export "_start" (func $__start))')
        // Top-level &helper call appears in $__start's body.
        const startIdx = wat.indexOf('(func $__start')
        expect(startIdx).toBeGreaterThan(-1)
        expect(wat.slice(startIdx)).toContain('call $helper')
    })

    test('wasix target without top-level statements: $__start body is empty', () => {
        const wat = compile('@let lonely := { 1 };', 'wasix')
        const startIdx = wat.indexOf('(func $__start')
        expect(startIdx).toBeGreaterThan(-1)
        // No calls inside $__start.
        const startEnd = wat.indexOf('\n)', startIdx)
        const body = wat.slice(startIdx, startEnd)
        expect(body).not.toContain('call $')
    })
})
