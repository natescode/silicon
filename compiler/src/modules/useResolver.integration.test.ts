// SPDX-License-Identifier: MIT
/**
 * Integration test: @use followed by a full compile pipeline.
 * Asserts the two-file fixture from bootstrap-plan Phase −1.C gate:
 *   main.si calls helper.si's @fn — compiles end-to-end.
 */

import { test, expect, describe } from 'bun:test'
import { resolve } from 'path'
import { resolveUses } from './useResolver'
import parse from '../parser'
import { addToAstSemantics, type Program } from '../ast'
import { compileToWat } from '../codegen'
import { buildStrataRegistry, elaborate } from '../elaborator'
import { typecheck, formatTypeError } from '../types'
import { siliconGrammar } from '../grammar'

function P(p: string): string { return resolve('/', p) }

function fullCompile(entrySource: string, entryPath: string, files: Record<string, string>): string {
    const lookup: Record<string, string> = {}
    for (const [k, v] of Object.entries(files)) lookup[P(k)] = v
    const { source } = resolveUses(entrySource, entryPath, {
        readFile: (p) => lookup[p],
        fileExists: (p) => p in lookup,
    })
    const match = parse(source)
    const ast = addToAstSemantics(siliconGrammar)(match).toAst() as Program
    const registry = buildStrataRegistry(ast)
    const { program: elab } = elaborate(ast, registry)
    const { program: typed, errors, functions } = typecheck(elab, registry)
    if (errors.length > 0) throw new Error('type: ' + errors.map(formatTypeError).join('; '))
    return compileToWat(typed, registry, functions)
}

describe('@use end-to-end', () => {
    test('main.si calls helper.si @fn — full pipeline succeeds', () => {
        const files = {
            'helper.si': '\\\\ add (Int, Int) -> Int\n@fn add a, b := { a + b };',
            'main.si':   "@use 'helper.si';\n@global sum := { &add 1, 2 };",
        }
        const wat = fullCompile(files['main.si'], P('main.si'), files)
        expect(wat).toContain('$add')
        expect(wat).toContain('$sum')
        expect(wat).toContain('call $add')
    })

    test('three-file chain compiles', () => {
        const files = {
            'leaf.si': '@fn one  := { 1 };',
            'mid.si':  "@use 'leaf.si';\n@fn two := { (&one) + (&one) };",
            'main.si': "@use 'mid.si';\n@global result := { &two };",
        }
        const wat = fullCompile(files['main.si'], P('main.si'), files)
        expect(wat).toContain('$one')
        expect(wat).toContain('$two')
        expect(wat).toContain('$result')
    })
})
