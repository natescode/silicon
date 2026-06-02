// SPDX-License-Identifier: MIT
/**
 * Incremental-parse equivalence property (CaaS tracker 3b — M1).
 *
 * The invariant: `SyntaxTree.withText` / `withChanges` must produce a tree that
 * is **node-for-node identical** to a full reparse of the same final source,
 * for every edit — whether the fast incremental path or the full-reparse
 * fallback is taken.
 *
 * For every fixture in `src/e2e/examples/*.si` we apply seeded, deterministic
 * edits (intra-line char edits, identifier growth, EOF append, newline
 * insertion, `;` deletion/merge, prepend, multi-edit batches, and chained
 * sequences) and assert:
 *   - `canonical(incremental.program) === canonical(full.program)`
 *   - the diagnostics arrays match
 *   - a real fraction of edits actually took the incremental fast path (so the
 *     suite can't pass by always falling back).
 */

import { test, describe, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { parse } from '../../src/caas/index.ts'
import { incrementalReparse, damageFromText, damageFromChanges, stableStringify } from '../../src/caas/incremental.ts'
import { parseProgramWithExtents } from '../../src/parser/parser.ts'
import type { TextChange } from '../../src/caas/textChange.ts'

const EXAMPLES_DIR = join(import.meta.dirname, '../../src/e2e/examples')

function allFixtures(): { name: string; source: string }[] {
    return readdirSync(EXAMPLES_DIR)
        .filter(f => f.endsWith('.si'))
        .sort()
        .map(name => ({ name, source: readFileSync(join(EXAMPLES_DIR, name), 'utf-8') }))
}

/** Deterministic PRNG so failures reproduce exactly. */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0
    return () => {
        a |= 0; a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

const elementCount = (src: string) => parseProgramWithExtents(src).extents.length

// ── coverage tally ─────────────────────────────────────────────────────────
let fastHits = 0
let fastEligible = 0   // edits over multi-element files where reuse is expected

// ---------------------------------------------------------------------------
// Edit generators — each returns a new full-text source (or null to skip).
// ---------------------------------------------------------------------------

/** Lengthen the first decimal literal (intra-line, stays valid). */
function bumpNumber(src: string): string | null {
    const m = src.match(/[^\d](\d)(?=[^\d])/)
    if (!m || m.index === undefined) return null
    const at = m.index + 1
    return src.slice(0, at) + src[at] + src.slice(at)
}

/** Append a character to the first identifier occurrence (intra-line). */
function growIdent(src: string): string | null {
    const m = src.match(/[a-z_][a-z0-9_]*/i)
    if (!m || m.index === undefined) return null
    const end = m.index + m[0].length
    return src.slice(0, end) + 'q' + src.slice(end)
}

/** Append a fresh top-level definition (adds a trailing line). */
function appendDef(src: string): string {
    return src + (src.endsWith('\n') ? '' : '\n') + '@let __probe_zz := 0;'
}

/** Insert a newline right after the first top-level `;` (ΔLines != 0). */
function insertNewline(src: string): string | null {
    const i = src.indexOf(';')
    if (i < 0) return null
    return src.slice(0, i + 1) + '\n' + src.slice(i + 1)
}

/** Delete the first `;` — merges two elements (exercises the boundary guard). */
function deleteSemi(src: string): string | null {
    const i = src.indexOf(';')
    if (i < 0) return null
    return src.slice(0, i) + src.slice(i + 1)
}

/** Prepend a definition (damage at offset 0 → fallback path). */
function prepend(src: string): string {
    return '@let __pre := 0;\n' + src
}

// ---------------------------------------------------------------------------
// Core assertion
// ---------------------------------------------------------------------------

/** Assert withText(newSource) ≡ full parse, and tally fast-path coverage. */
function assertEquivalentText(src: string, newSource: string, expectFast: boolean): void {
    const tree = parse(src).tree
    const inc = tree.withText(newSource)
    const full = parse(newSource)

    expect(stableStringify(inc.tree.program)).toBe(stableStringify(full.tree.program))
    expect(stableStringify(inc.diagnostics)).toBe(stableStringify(full.diagnostics))

    // Independently measure whether the fast path applied (same function the
    // public path uses) and re-verify its result.
    const { extents } = parseProgramWithExtents(src)
    const dmg = damageFromText(src, newSource)
    if (dmg !== null) {
        const direct = incrementalReparse(src, extents, newSource, dmg)
        if (direct !== null) {
            fastHits++
            expect(stableStringify(direct.program)).toBe(stableStringify(full.tree.program))
        }
    }
    if (expectFast) fastEligible++
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('incremental parse ≡ full reparse (3b/M1)', () => {
    for (const { name, source } of allFixtures()) {
        const multi = elementCount(source) >= 2

        test(`${name}: intra-line number/identifier edits`, () => {
            for (const gen of [bumpNumber, growIdent]) {
                const next = gen(source)
                if (next !== null) assertEquivalentText(source, next, multi)
            }
        })

        test(`${name}: append / newline / merge / prepend`, () => {
            assertEquivalentText(source, appendDef(source), elementCount(source) >= 1)
            const nl = insertNewline(source); if (nl) assertEquivalentText(source, nl, false)
            const del = deleteSemi(source); if (del) assertEquivalentText(source, del, false)
            assertEquivalentText(source, prepend(source), false)
        })

        test(`${name}: chained edits stay equivalent`, () => {
            const seed = [...name].reduce((a, c) => a + c.charCodeAt(0), 0)
            const rand = mulberry32(seed)
            let cur = source
            let tree = parse(cur).tree
            for (let step = 0; step < 4; step++) {
                const gens = [bumpNumber, growIdent, appendDef]
                const next = gens[Math.floor(rand() * gens.length)](cur)
                if (next === null || next === cur) continue
                const inc = tree.withText(next)
                const full = parse(next)
                expect(stableStringify(inc.tree.program)).toBe(stableStringify(full.tree.program))
                cur = next
                tree = inc.tree   // propagate the (possibly incremental) tree to the next step
            }
        })
    }
})

describe('incremental parse via withChanges (3b/M1)', () => {
    test('range-based single + multi edits ≡ full', () => {
        // Two top-level lets on separate lines; edit the literal on each.
        const src = '@let a := 1;\n@let b := 2;\n@let c := 3;'
        const tree = parse(src).tree

        // Single change: "2" → "2002" on line 2 (col 11..12, endCol exclusive).
        const single: TextChange[] = [
            { range: { startLine: 2, startCol: 11, endLine: 2, endCol: 12 }, newText: '2002' },
        ]
        const afterSingle = '@let a := 1;\n@let b := 2002;\n@let c := 3;'
        expect(stableStringify(tree.withChanges(single).tree.program))
            .toBe(stableStringify(parse(afterSingle).tree.program))
        expect(damageFromChanges(src, single)).not.toBeNull()

        // Multi change: edit line 1 and line 3 literals at once (disjoint).
        const multi: TextChange[] = [
            { range: { startLine: 1, startCol: 11, endLine: 1, endCol: 12 }, newText: '11' },
            { range: { startLine: 3, startCol: 11, endLine: 3, endCol: 12 }, newText: '33' },
        ]
        const afterMulti = '@let a := 11;\n@let b := 2;\n@let c := 33;'
        expect(stableStringify(tree.withChanges(multi).tree.program))
            .toBe(stableStringify(parse(afterMulti).tree.program))
    })

    test('empty change set is a no-op equivalent to the source', () => {
        const src = '@let a := 1;\n@let b := 2;'
        const tree = parse(src).tree
        expect(stableStringify(tree.withChanges([]).tree.program))
            .toBe(stableStringify(parse(src).tree.program))
    })

    test('an edit that makes the file un-lexable falls back without throwing', () => {
        // The incremental path lexes the whole new source up front (to parse the
        // window with absolute positions).  An edit that introduces a lex error
        // — even outside the window — must fall back to a full reparse and
        // surface the diagnostic, never throw.  Regression for the
        // parseProgramFragment construction-time lex error.
        const src = '@let a := 1;\n@let b := 2;\n@let c := 3;'
        const tree = parse(src).tree
        const edited = '@let a := 1;\n@let b := `;\n@let c := 3;'   // backtick is not a token
        let inc!: ReturnType<typeof tree.withText>
        expect(() => { inc = tree.withText(edited) }).not.toThrow()
        const full = parse(edited)
        expect(stableStringify(inc.tree.program)).toBe(stableStringify(full.tree.program))
        expect(stableStringify(inc.diagnostics)).toBe(stableStringify(full.diagnostics))
        expect(full.diagnostics.length).toBeGreaterThan(0)   // it really is a parse error
    })
})

describe('incremental fast path is actually exercised', () => {
    test('a real fraction of eligible edits reused work', () => {
        // fastEligible is accumulated by the equivalence tests above; require the
        // fast path to fire on the clear majority of reuse-eligible edits.
        expect(fastEligible).toBeGreaterThan(0)
        expect(fastHits).toBeGreaterThanOrEqual(Math.ceil(fastEligible * 0.5))
    })
})
