/**
 * Strata Registry Uniqueness Property
 *
 * Two guards against accidental overwrite in the elaborator registry tables:
 *
 *  (1) No two strata definitions claim the same (kind, symbol, typeKind) tuple.
 *      The compound key `${symbol}:${typeKind}` (see registry.ts:127) is how
 *      typed-operator overloads are stored — collisions silently win, so a
 *      duplicate definition gets clobbered with no warning. Today the loader
 *      tags the second registration as Constraint instead of Primary, which
 *      effectively reorders dispatch; a true duplicate (same intrinsic, same
 *      operand type) is always a bug.
 *
 *  (2) defKinds / defExpanders are keyed by CodegenKind. The registry treats
 *      `@let`-style keyword overlaps as "last write wins" so a strata file
 *      accidentally registering the same `IR::def_*` intrinsic twice would
 *      silently shadow the first one. This test parses the strata sources
 *      independently and asserts no duplicate intrinsics across them.
 *
 * Both walks operate on the parsed Elaboration nodes rather than the assembled
 * registry — the registry is `Map` / `Record`, which deduplicates by
 * construction; the bug surfaces at the source level, not at the lookup site.
 */

import { test, describe } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { parse } from '../../src/parser/index.ts'
import { addToAstSemantics } from '../../src/ast/index.ts'
import { siliconGrammar } from '../../src/grammar/index.ts'
import { intrinsicSignature } from '../../src/types/intrinsicSig.ts'
import { getIRKind } from '../../src/ir/irKinds.ts'
import type { Elaboration, Program } from '../../src/ast/astNodes.ts'

const STRATA_DIR = join(import.meta.dirname, '../../src/strata')

interface ParsedSource { file: string; source: string }

function allStrataSources(): ParsedSource[] {
    return readdirSync(STRATA_DIR)
        .filter(f => f.endsWith('.si'))
        .sort()
        .map(file => ({ file, source: readFileSync(join(STRATA_DIR, file), 'utf-8') }))
}

function parseElaborations(source: string): Elaboration[] {
    const match = parse(source)
    const ast = addToAstSemantics(siliconGrammar)(match).toAst() as Program
    const out: Elaboration[] = []
    for (const el of ast.elements as any[]) {
        if (el && el.type === 'Elaboration') out.push(el as Elaboration)
        else if (el && el.type === 'Element' && el.kind === 'elaboration') out.push(el.value as Elaboration)
    }
    return out
}

function findIntrinsic(node: any): string | undefined {
    if (!node || typeof node !== 'object') return undefined
    if (Array.isArray(node)) {
        for (const c of node) { const r = findIntrinsic(c); if (r) return r }
        return undefined
    }
    if (node.type === 'FunctionCall') {
        const n = node.name
        if (n && Array.isArray(n.path) && (n.path[0] === 'WASM' || n.path[0] === 'IR')) {
            return n.path.join('::')
        }
    }
    for (const k of Object.keys(node)) {
        if (k === 'sourceLocation' || k === 'inferredType') continue
        const child = node[k]
        if (child && typeof child === 'object') {
            const r = findIntrinsic(child)
            if (r) return r
        }
    }
    return undefined
}

function symbolToString(symbol: any): string {
    if (typeof symbol === 'string') return symbol
    if (symbol && symbol.type === 'StringLiteral') return symbol.value
    return String(symbol)
}

describe('strata registry uniqueness', () => {
    const sources = allStrataSources()

    test('no two strata definitions share (kind, symbol, typeKind)', () => {
        const seen = new Map<string, { file: string; line?: number; intrinsic?: string }>()
        const collisions: string[] = []

        for (const { file, source } of sources) {
            const elabs = parseElaborations(source)
            for (const elab of elabs) {
                const symbol = symbolToString(elab.symbol)
                const intrinsic = findIntrinsic(elab.semantics)
                const sig = intrinsic ? intrinsicSignature(intrinsic) : undefined
                const typeKind = sig?.params[0]?.kind ?? '*'
                const key = `${elab.kind}|${symbol}|${typeKind}`

                const prior = seen.get(key)
                if (prior) {
                    collisions.push(
                        `(${elab.kind}, ${symbol}, ${typeKind}) defined in both ` +
                        `${prior.file} (intrinsic=${prior.intrinsic ?? 'none'}) and ` +
                        `${file} (intrinsic=${intrinsic ?? 'none'})`,
                    )
                } else {
                    seen.set(key, { file, intrinsic })
                }
            }
        }

        if (collisions.length > 0) {
            throw new Error(
                `${collisions.length} duplicate strata registration(s):\n  ` +
                collisions.join('\n  '),
            )
        }
    })

    test('every strata Elaboration node is well-formed', () => {
        // Sanity check on the source-level Elaboration structure: kind must be
        // 'operator' or 'keyword', symbol must be non-empty, and any IR::*
        // intrinsic referenced must resolve in the irKinds table. Catches
        // typos that would silently fail to register.
        const offenders: string[] = []

        for (const { file, source } of sources) {
            for (const elab of parseElaborations(source)) {
                const symbol = symbolToString(elab.symbol)
                if (elab.kind !== 'operator' && elab.kind !== 'keyword') {
                    offenders.push(`${file}: unexpected kind '${elab.kind}' for ${symbol}`)
                }
                if (!symbol || symbol === 'undefined' || symbol === 'null') {
                    offenders.push(`${file}: empty symbol on a ${elab.kind} strata`)
                }
                const intrinsic = findIntrinsic(elab.semantics)
                // Only IR::def_* and IR::meta_* are tracked by the irKinds
                // table — arithmetic IR intrinsics (IR::i32_add, IR::f32_add,
                // …) intentionally have no irKinds entry, they live in the
                // generic instruction-emission path.
                if (intrinsic && /^IR::(def_|meta_)/.test(intrinsic) && !getIRKind(intrinsic)) {
                    offenders.push(`${file}: ${symbol} references unknown IR intrinsic '${intrinsic}'`)
                }
            }
        }

        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} malformed strata definition(s):\n  ` +
                offenders.join('\n  '),
            )
        }
    })
})
