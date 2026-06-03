// SPDX-License-Identifier: MIT
/**
 * Incremental Workspace-compile equivalence — property test (incremental
 * semantics E1).
 *
 * For every example fixture, apply a seeded sequence of random edits through a
 * single Workspace (which reparses + re-elaborates incrementally) and, after
 * EACH edit, assert the resulting Document is identical to a fresh Workspace
 * compile of the same source — diagnostics, SemanticModel symbols, and the
 * elaborated tree (byte-for-byte). This exercises chained edits, the elaboration
 * cache, suffix elemBase shifts, registry handling, and the full-compile
 * fallbacks all at once.
 */
import { test, describe, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { Workspace, type Document } from '../../src/caas/workspace.ts'
import { stableStringify } from '../../src/caas/incremental.ts'
import { astChildren } from '../../src/ast/astChildren.ts'

const EXAMPLES = join(import.meta.dirname, '../../src/e2e/examples')

function fixtures(): { name: string; source: string }[] {
    return readdirSync(EXAMPLES).filter(f => f.endsWith('.si')).sort()
        .map(name => ({ name, source: readFileSync(join(EXAMPLES, name), 'utf-8') }))
}

function mulberry32(seed: number): () => number {
    let a = seed >>> 0
    return () => {
        a |= 0; a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

function diagKey(doc: Document): string {
    return doc.diagnostics
        .map(d => `${d.code}@${d.span.line}:${d.span.col}+${d.span.length}:${d.message}`)
        .sort().join('\n')
}
function symKey(doc: Document): string {
    return [...doc.model.allSymbols]
        .map(s => `${s.name}|${s.kind}|${s.displayString}|${s.definitionSpan?.line ?? '-'}:${s.definitionSpan?.col ?? '-'}|${s.isImplicitlyDeclared}`)
        .sort().join('\n')
}
/**
 * Elaboration structure, EXCLUDING `node.inferredType` — a non-authoritative
 * backward-compat stamp the typechecker writes with a "keep best, never downgrade
 * to Unknown" heuristic, so a reused node can legitimately carry a stale stamp
 * while the authoritative `model.typeOf` (compared separately) is correct.
 */
const elabKey = (doc: Document) => stableStringify(stripInferred(doc.elabTree.program))
function stripInferred(v: any): any {
    if (v === null || typeof v !== 'object') return v
    if (Array.isArray(v)) return v.map(stripInferred)
    const out: Record<string, any> = {}
    for (const k of Object.keys(v)) if (k !== 'inferredType') out[k] = stripInferred(v[k])
    return out
}

/** Authoritative per-node types from the SemanticModel, in structural order. */
function typeKey(doc: Document): string {
    const out: string[] = []
    const walk = (n: any) => {
        if (n === null || typeof n !== 'object') return
        const t = doc.model.typeOf(n)
        out.push(t ? stableStringify(t) : '-')
        for (const c of astChildren(n)) walk(c)
    }
    walk(doc.elabTree.program)
    return out.join(',')
}

const EDIT_CHARS = [' ', '1', 'x', 'q', ';', '\n', ')', '+', '@', 'r']

/** Apply one pseudo-random edit (insert / delete / replace) to `src`. */
function mutate(src: string, rand: () => number): string {
    if (src.length === 0) return '@let x := 1;'
    const at = Math.floor(rand() * src.length)
    const op = rand()
    const ch = EDIT_CHARS[Math.floor(rand() * EDIT_CHARS.length)]
    if (op < 0.34) return src.slice(0, at) + ch + src.slice(at)         // insert
    if (op < 0.67) return src.slice(0, at) + src.slice(at + 1)          // delete
    return src.slice(0, at) + ch + src.slice(at + 1)                    // replace
}

function freshCompile(source: string): Document {
    return new Workspace().openDocument('m.si', source)
}

describe('incremental Workspace compile ≡ fresh (property, E1)', () => {
    for (const { name, source } of fixtures()) {
        test(`${name}: 12 chained random edits stay equivalent`, () => {
            const rand = mulberry32([...name].reduce((a, c) => a + c.charCodeAt(0), 7))
            const ws = new Workspace()
            ws.openDocument('m.si', source)
            let cur = source
            for (let step = 0; step < 12; step++) {
                const next = mutate(cur, rand)
                if (next === cur) continue
                const inc = ws.editDocument('m.si', next)
                const full = freshCompile(next)
                expect(diagKey(inc)).toBe(diagKey(full))
                expect(symKey(inc)).toBe(symKey(full))
                expect(elabKey(inc)).toBe(elabKey(full))   // elaboration structure
                expect(typeKey(inc)).toBe(typeKey(full))   // authoritative per-node types
                cur = next
            }
        })
    }
})
