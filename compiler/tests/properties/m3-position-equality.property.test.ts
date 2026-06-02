// SPDX-License-Identifier: MIT
/**
 * M3 gate (CaaS tracker 3b): the `PositionTable` (element-relative `relSpan` +
 * element-root `elemBase`) must reconstruct positions **byte-identical** to the
 * legacy absolute `sourceLocation`, for every positioned node, on BOTH the
 * parsed tree AND the elaborated tree (which clones nodes).
 *
 * Since Stage C the caas parse path (`parseProgramWithExtents`) carries positions
 * ONLY as `relSpan`/`elemBase` — no `sourceLocation`. So the oracle is a parallel
 * `parseToAst` tree, which still stamps absolute `sourceLocation`; the two are
 * structurally identical and walked in lockstep.
 */
import { test, describe, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import parseToAst, { parseProgramWithExtents } from '../../src/parser/parser.ts'
import { buildPositionTable } from '../../src/ast/positionTable.ts'
import { astChildren } from '../../src/ast/astChildren.ts'
import elaborate from '../../src/elaborator/elaborator.ts'
import { buildStrataRegistry } from '../../src/elaborator/strataLoader.ts'

const EXAMPLES = join(import.meta.dirname, '../../src/e2e/examples')

function fixtures(): { name: string; source: string }[] {
    return readdirSync(EXAMPLES).filter(f => f.endsWith('.si')).sort()
        .map(name => ({ name, source: readFileSync(join(EXAMPLES, name), 'utf-8') }))
}

/** Walk two structurally-identical trees in lockstep. */
function* pairs(a: any, b: any): Generator<[any, any]> {
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return
    yield [a, b]
    const ac = astChildren(a), bc = astChildren(b)
    const n = Math.min(ac.length, bc.length)
    for (let i = 0; i < n; i++) yield* pairs(ac[i], bc[i])
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
            const caas = parseProgramWithExtents(source).program       // relSpan/elemBase, no sourceLocation
            const ref = parseToAst(source)                              // oracle: absolute sourceLocation
            const pt = buildPositionTable(caas, source)
            for (const [c, r] of pairs(caas, ref)) {
                if (r.sourceLocation) {
                    expect(locEq(pt.loc(c), r.sourceLocation)).toBe(true)
                    totalChecked++
                }
            }
        })

        test(`${name}: elaborated tree (positions survive cloning)`, () => {
            const caas = parseProgramWithExtents(source).program
            const ref = parseToAst(source)
            const elabCaas = (elaborate(caas, buildStrataRegistry(caas)) as any).program
            const elabRef = (elaborate(ref, buildStrataRegistry(ref)) as any).program
            const pt = buildPositionTable(elabCaas, source)
            for (const [c, r] of pairs(elabCaas, elabRef)) {
                if (r.sourceLocation) expect(locEq(pt.loc(c), r.sourceLocation)).toBe(true)
            }
        })
    }

    test('the corpus actually exercises positioned nodes', () => {
        expect(totalChecked).toBeGreaterThan(50)
    })
})
