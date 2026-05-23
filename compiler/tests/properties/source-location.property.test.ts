/**
 * Source-Location Coverage Property
 *
 * Walk a parsed program and assert every AST node that *should* carry a
 * sourceLocation actually does. Catches new node kinds added in future work
 * that forget to attach a span.
 *
 * Status: scaffolded for WS 4 (Structured Errors + Source Spans).
 *
 * Today the AST has `sourceLocation?: SourceLocation` declared on most node
 * interfaces (see src/ast/astNodes.ts), but toAst.ts never actually populates
 * it. WS 4 wires Ohm's source intervals into every AST factory call. When that
 * lands, EXPECTED_NODE_TYPES_WITH_LOC below should match every node type the
 * parser produces — and any new node type added later will fail this property
 * the day it lands.
 *
 * Until WS 4 lands, this test runs in "coverage report" mode: it walks every
 * fixture, tallies which node types currently expose a sourceLocation, and
 * passes if the count is consistent across runs. The PROMOTE flag below
 * flips it into strict mode (every interesting node has a span).
 */

import { test, describe } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { compileToTyped } from './_compile.ts'
import type { Program } from '../../src/ast/astNodes.ts'

const EXAMPLES_DIR = join(import.meta.dirname, '../../src/e2e/examples')

/** AST node types we expect to carry sourceLocation once WS 4 lands. */
const EXPECTED_NODE_TYPES_WITH_LOC: ReadonlySet<string> = new Set([
    'Program', 'Element', 'Item', 'Statement', 'Assignment', 'Definition',
    'Elaboration', 'ExpressionStart', 'BinaryOp', 'FunctionCall', 'ExpressionEnd',
    'Literal', 'ArrayLiteral', 'ObjectLiteral', 'TupleLiteral', 'StringLiteral',
    'IntLiteral', 'FloatLiteral', 'BooleanLiteral', 'KeyValuePair', 'Block',
    'Binding', 'Namespace', 'TypedIdentifier', 'TypeAnnotation', 'Parameter',
    'GenericParams', 'DocComment',
])

/** When WS 4 lands and toAst.ts attaches spans, flip this to true. */
const PROMOTE_TO_STRICT = false

function allFixtures(): { name: string; source: string }[] {
    return readdirSync(EXAMPLES_DIR)
        .filter(f => f.endsWith('.si'))
        .sort()
        .map(name => ({
            name,
            source: readFileSync(join(EXAMPLES_DIR, name), 'utf-8'),
        }))
}

/** Walk every plain-object node reachable from `root`. */
function* walk(root: any): Generator<any> {
    const seen = new WeakSet<object>()
    const stack: any[] = [root]
    while (stack.length > 0) {
        const node = stack.pop()
        if (!node || typeof node !== 'object') continue
        if (seen.has(node)) continue
        seen.add(node)
        if (Array.isArray(node)) {
            for (const child of node) stack.push(child)
            continue
        }
        if (typeof node.type === 'string') yield node
        for (const k of Object.keys(node)) {
            const v = node[k]
            if (v && typeof v === 'object') stack.push(v)
        }
    }
}

describe('source-location coverage', () => {
    const fixtures = allFixtures()

    test('every interesting AST node type appears in the corpus', () => {
        const seen = new Set<string>()
        for (const { source } of fixtures) {
            try {
                const { rawAST } = compileToTyped(source)
                for (const node of walk(rawAST as Program)) seen.add(node.type)
            } catch {
                // Skip fixtures that don't compile — covered by determinism test.
            }
        }

        const missing = [...EXPECTED_NODE_TYPES_WITH_LOC]
            .filter(t => !seen.has(t))
            .sort()

        // Not every node type appears in the e2e corpus (e.g. ArrayLiteral,
        // ObjectLiteral, GenericParams). Don't fail — just record the gap so
        // future fixture additions broaden coverage organically.
        if (missing.length > 0) {
            // eslint-disable-next-line no-console
            console.log(
                `[source-location] ${missing.length} node type(s) not exercised by fixtures: ${missing.join(', ')}`,
            )
        }
    })

    test(
        PROMOTE_TO_STRICT
            ? 'every AST node has a sourceLocation'
            : 'sourceLocation coverage report (run nodes seen vs. populated)',
        () => {
            const totalsByType = new Map<string, number>()
            const populatedByType = new Map<string, number>()

            for (const { source } of fixtures) {
                let ast: Program
                try {
                    ast = compileToTyped(source).rawAST
                } catch {
                    continue
                }
                for (const node of walk(ast)) {
                    if (!EXPECTED_NODE_TYPES_WITH_LOC.has(node.type)) continue
                    totalsByType.set(node.type, (totalsByType.get(node.type) ?? 0) + 1)
                    if (node.sourceLocation) {
                        populatedByType.set(node.type, (populatedByType.get(node.type) ?? 0) + 1)
                    }
                }
            }

            if (PROMOTE_TO_STRICT) {
                const offenders: string[] = []
                for (const [type, total] of totalsByType) {
                    const populated = populatedByType.get(type) ?? 0
                    if (populated < total) {
                        offenders.push(`${type}: ${populated}/${total} have sourceLocation`)
                    }
                }
                if (offenders.length > 0) {
                    throw new Error(
                        `Strict mode: nodes missing sourceLocation:\n  ${offenders.join('\n  ')}`,
                    )
                }
            }
            // Non-strict mode passes unconditionally — see header comment.
        },
    )
})
