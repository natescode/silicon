// SPDX-License-Identifier: MIT
/**
 * M3 gate (CaaS tracker 3b): the `PositionTable` (relative encoding) must
 * reconstruct positions **byte-identical** to the legacy absolute
 * `sourceLocation`, for every positioned node, on BOTH the parsed tree AND the
 * elaborated tree (which clones nodes). This proves the relative encoding is
 * correct and survives elaboration before any consumer migrates to it.
 */
import { test, describe, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { parseProgramWithExtents } from '../../src/parser/parser.ts'
import { buildPositionTable } from '../../src/ast/positionTable.ts'
import { astChildren } from '../../src/ast/astChildren.ts'
import elaborate from '../../src/elaborator/elaborator.ts'
import { buildStrataRegistry } from '../../src/elaborator/strataLoader.ts'

const EXAMPLES = join(import.meta.dirname, '../../src/e2e/examples')

function fixtures(): { name: string; source: string }[] {
    return readdirSync(EXAMPLES).filter(f => f.endsWith('.si')).sort()
        .map(name => ({ name, source: readFileSync(join(EXAMPLES, name), 'utf-8') }))
}

function* positioned(node: any): Generator<any> {
    if (node === null || typeof node !== 'object') return
    if (node.sourceLocation) yield node
    for (const c of astChildren(node)) yield* positioned(c)
}

function locEq(a: any, b: any): boolean {
    return !!a && !!b
        && a.startLine === b.startLine && a.startColumn === b.startColumn
        && a.endLine === b.endLine && a.endColumn === b.endColumn
}

let totalChecked = 0

describe('M3 PositionTable.loc ≡ legacy sourceLocation', () => {
    for (const { name, source } of fixtures()) {
        test(`${name}: parsed tree`, () => {
            const { program } = parseProgramWithExtents(source)
            const pt = buildPositionTable(program, source)
            for (const node of positioned(program)) {
                expect(locEq(pt.loc(node), node.sourceLocation)).toBe(true)
                totalChecked++
            }
        })

        test(`${name}: elaborated tree`, () => {
            const { program } = parseProgramWithExtents(source)
            const reg = buildStrataRegistry(program)
            const { program: elab } = elaborate(program, reg) as any
            const pt = buildPositionTable(elab, source)
            for (const node of positioned(elab)) {
                expect(locEq(pt.loc(node), node.sourceLocation)).toBe(true)
            }
        })
    }

    test('the corpus actually exercises positioned nodes', () => {
        expect(totalChecked).toBeGreaterThan(50)
    })
})
