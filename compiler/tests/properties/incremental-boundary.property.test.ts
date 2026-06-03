// SPDX-License-Identifier: MIT
/**
 * ADVERSARIAL: element merge / split / deletion / whitespace / comments.
 *
 * Targets the incremental-elaboration reuse machinery (commit 73a24e9) at the
 * spots most likely to break the "incremental edited doc ≡ fresh full compile"
 * contract:
 *   - delete a `;`  → merges two top-level elements into one (parse error or
 *                      one combined element); the suffix-reuse boundary guard
 *                      and the damage window are stressed.
 *   - insert a `;`  → splits one element into two.
 *   - delete a whole element (and its trailing `;`).
 *   - insert / delete blank lines between elements (ΔLines != 0 → M3 suffix
 *     shift).
 *   - insert / delete `##` line comments between elements (these live in the
 *     GAP between element extents — not owned by either extent — so an edit in
 *     the gap exercises window classification).
 *   - edits at EXACT element boundaries: the byte just before / at / after a
 *     `;`, the first byte of an element, the last byte, and inside the gap.
 *
 * For every edit we assert the incrementally-edited Document equals a fresh
 * Workspace compile of the same final source on ALL FOUR authoritative
 * surfaces: diagnostics (code+span+full message), symbols, per-node
 * model.typeOf, and stripped (no inferredType) elaboration structure.
 */
import { test, describe, expect } from 'bun:test'
import { Workspace, type Document } from '../../src/caas/workspace.ts'
import { stableStringify } from '../../src/caas/incremental.ts'
import { astChildren } from '../../src/ast/astChildren.ts'

// ── seeded PRNG ─────────────────────────────────────────────────────────────
function mulberry32(seed: number): () => number {
    let a = seed >>> 0
    return () => {
        a |= 0; a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

// ── authoritative-surface projections (full message, exact) ─────────────────
function diagKey(doc: Document): string {
    return doc.diagnostics
        .map(d => `${d.code}@${d.span.line}:${d.span.col}+${d.span.length}:${d.message}`)
        .sort().join('\n')
}
function symKey(doc: Document): string {
    return [...doc.model.allSymbols]
        .map(s => `${s.name}|${s.kind}|${s.displayString}|${s.definitionSpan?.line ?? '-'}:${s.definitionSpan?.col ?? '-'}+${s.definitionSpan?.length ?? '-'}|${s.isImplicitlyDeclared}`)
        .sort().join('\n')
}
function stripInferred(v: any): any {
    if (v === null || typeof v !== 'object') return v
    if (Array.isArray(v)) return v.map(stripInferred)
    const out: Record<string, any> = {}
    for (const k of Object.keys(v)) if (k !== 'inferredType') out[k] = stripInferred(v[k])
    return out
}
const elabKey = (doc: Document) => stableStringify(stripInferred(doc.elabTree.program))
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

function freshCompile(source: string): Document {
    return new Workspace().openDocument('m.si', source)
}

/** Assert one incremental Document equals a fresh compile across all 4 surfaces. */
interface Divergence { surface: string; inc: string; full: string }
function diverge(inc: Document, full: Document): Divergence | null {
    const checks: [string, (d: Document) => string][] = [
        ['diagnostics', diagKey],
        ['symbols', symKey],
        ['per-node-typeOf', typeKey],
        ['elab-structure', elabKey],
    ]
    for (const [surface, proj] of checks) {
        const a = proj(inc), b = proj(full)
        if (a !== b) return { surface, inc: a, full: b }
    }
    return null
}

/**
 * Run an edit sequence through one Workspace and, after EACH edit, compare
 * against a fresh compile of that intermediate source.  Returns the first
 * divergence found (with the failing edit index), or null.
 */
function runSequence(initial: string, edits: string[]): { idx: number; src: string; d: Divergence } | null {
    const ws = new Workspace()
    ws.openDocument('m.si', initial)
    for (let i = 0; i < edits.length; i++) {
        const src = edits[i]
        const inc = ws.editDocument('m.si', src)
        const full = freshCompile(src)
        const d = diverge(inc, full)
        if (d) return { idx: i, src, d }
    }
    return null
}

function reportFail(initial: string, edits: string[], fail: { idx: number; src: string; d: Divergence }): string {
    return [
        `DIVERGENCE on surface "${fail.d.surface}" at edit #${fail.idx}`,
        `  initial: ${JSON.stringify(initial)}`,
        `  edits:   ${edits.slice(0, fail.idx + 1).map(e => JSON.stringify(e)).join('\n           ')}`,
        `  incremental: ${fail.d.inc.slice(0, 600)}`,
        `  fresh:       ${fail.d.full.slice(0, 600)}`,
    ].join('\n')
}

// Base sources with >= 2 top-level elements, varied kinds.
const BASES = [
    '@let a := 1;\n@let b := 2;\n@let c := 3;',
    '@fn add x, y := { x + y };\n@let r := &add 1, 2;',
    '@let a := 1;\n@fn f x := { x + a };\n@let b := &f 10;',
    '@type Pt := $Pt x:Int, y:Int;\n@let p := &Pt 1, 2;',
    '@let a := 1;\n\n## a comment between\n\n@let b := 2;',
    '@enum Color := Red | Green | Blue;\n@let c := Green;\n@let d := Red;',
    '@fn id[T] x:T := x;\n@let n := &id 5;\n@let m := &id 7;',
    '@let a := 1; @let b := 2; @let c := 3;',  // all on one line
]

// ── element-boundary index of a source ──────────────────────────────────────
/** All byte offsets that are "interesting" element boundaries / gap positions. */
function boundaryOffsets(src: string): number[] {
    const offs = new Set<number>([0, src.length])
    for (let i = 0; i < src.length; i++) {
        const c = src[i]
        if (c === ';') { offs.add(i); offs.add(i + 1) }          // before/after a ;
        if (c === '\n') { offs.add(i); offs.add(i + 1) }          // line boundaries (gaps)
        if (c === '#') { offs.add(i); offs.add(i + 1) }           // comment markers
    }
    return [...offs].filter(o => o >= 0 && o <= src.length).sort((a, b) => a - b)
}

// ── structured deterministic scenarios ──────────────────────────────────────
describe('ADV: structured element merge/split/delete/whitespace/comment edits', () => {
    const scenarios: { name: string; initial: string; edits: string[] }[] = [
        {
            name: 'delete first ; (merge a+b → parse error)',
            initial: '@let a := 1;\n@let b := 2;\n@let c := 3;',
            edits: ['@let a := 1\n@let b := 2;\n@let c := 3;'],
        },
        {
            name: 'delete middle ; then restore',
            initial: '@let a := 1;\n@let b := 2;\n@let c := 3;',
            edits: [
                '@let a := 1;\n@let b := 2\n@let c := 3;',
                '@let a := 1;\n@let b := 2;\n@let c := 3;',
            ],
        },
        {
            name: 'split: insert ; in the middle of a binding',
            initial: '@let a := 1 + 2;\n@let b := 5;',
            edits: ['@let a := 1 +; 2;\n@let b := 5;', '@let a := 1; 2;\n@let b := 5;'],
        },
        {
            name: 'delete a whole middle element (incl its ;)',
            initial: '@let a := 1;\n@let b := 2;\n@let c := 3;',
            edits: ['@let a := 1;\n@let c := 3;'],
        },
        {
            name: 'delete the last element',
            initial: '@let a := 1;\n@let b := 2;\n@let c := 3;',
            edits: ['@let a := 1;\n@let b := 2;\n'],
        },
        {
            name: 'delete the first element',
            initial: '@let a := 1;\n@let b := 2;\n@let c := 3;',
            edits: ['@let b := 2;\n@let c := 3;'],
        },
        {
            name: 'insert a ## comment between elements',
            initial: '@let a := 1;\n@let b := 2;\n@let c := 3;',
            edits: ['@let a := 1;\n## inserted\n@let b := 2;\n@let c := 3;'],
        },
        {
            name: 'delete a ## comment between elements',
            initial: '@let a := 1;\n## a comment\n@let b := 2;\n@let c := 3;',
            edits: ['@let a := 1;\n@let b := 2;\n@let c := 3;'],
        },
        {
            name: 'edit text INSIDE a gap comment only',
            initial: '@let a := 1;\n## hello\n@let b := 2;',
            edits: ['@let a := 1;\n## hxllo\n@let b := 2;', '@let a := 1;\n## hello world\n@let b := 2;'],
        },
        {
            name: 'insert blank lines between elements (ΔLines)',
            initial: '@let a := 1;\n@let b := 2;\n@let c := 3;',
            edits: ['@let a := 1;\n\n\n@let b := 2;\n@let c := 3;'],
        },
        {
            name: 'delete blank lines between elements',
            initial: '@let a := 1;\n\n\n@let b := 2;\n@let c := 3;',
            edits: ['@let a := 1;\n@let b := 2;\n@let c := 3;'],
        },
        {
            name: 'merge two-on-one-line by deleting the inner ;',
            initial: '@let a := 1; @let b := 2; @let c := 3;',
            edits: ['@let a := 1 @let b := 2; @let c := 3;'],
        },
        {
            name: 'split inline by adding a ;',
            initial: '@let a := 1; @let b := 2;',
            edits: ['@let a := 1; @let b := 2;; @let c := 3;'],
        },
        {
            name: 'edit at exact boundary: insert space right before a ;',
            initial: '@let a := 1;\n@let b := 2;',
            edits: ['@let a := 1 ;\n@let b := 2;'],
        },
        {
            name: 'edit at exact boundary: insert right after a ;',
            initial: '@let a := 1;\n@let b := 2;',
            edits: ['@let a := 1; \n@let b := 2;'],
        },
        {
            name: 'change a referenced symbol then merge (cross-element type flow)',
            initial: '@let a := 1;\n@fn f x := { x + a };\n@let b := &f 10;',
            edits: [
                '@let a := 1;\n@fn f x := { x + a }\n@let b := &f 10;',  // merge f+b (drop ;)
                '@let a := 1;\n@fn f x := { x + a };\n@let b := &f 10;', // restore
            ],
        },
        {
            name: 'redefine a name used downstream by merge/split cycling',
            initial: '@fn add x, y := { x + y };\n@let r := &add 1, 2;',
            edits: [
                '@fn add x, y := { x + y }\n@let r := &add 1, 2;',    // merge
                '@fn add x, y := { x + y };\n@let r := &add 1, 2;',   // restore (split)
                '@fn add x, y := { x - y };\n@let r := &add 1, 2;',   // edit body
            ],
        },
        {
            name: 'delete trailing ; on last element (no merge target)',
            initial: '@let a := 1;\n@let b := 2;',
            edits: ['@let a := 1;\n@let b := 2'],
        },
        {
            name: 'comment-out an element by prefixing ##',
            initial: '@let a := 1;\n@let b := 2;\n@let c := 3;',
            edits: ['@let a := 1;\n## @let b := 2;\n@let c := 3;'],
        },
        // ── MINIMAL REPRODUCERS of the comment-absorbs-suffix bug ───────────
        {
            // Insert "## " at the exact start of the 2nd element. damageFromText
            // sees a zero-width insertion (the shifted text is byte-identical), so
            // element `b` is reused as an unchanged suffix — but the `## ` now
            // comments it out, so a fresh parse drops `b`. Incremental keeps it.
            name: 'MINREPRO: ## prefix on 2nd element leaks symbol b',
            initial: '@let a := 1;\n@let b := 2;',
            edits: ['@let a := 1;\n## @let b := 2;'],
        },
        {
            // Same defect with a single `#` (still a comment marker) and at the
            // very first element (offset-0 insertion). The `windowStartByte===0`
            // fallback guard does NOT fire because a suffix is reusable, so the
            // whole program is reused verbatim and the commented-out `Color`
            // element survives in the incremental tree.
            name: 'MINREPRO: # prefix on first element leaks (offset-0)',
            initial: '@enum Color := Red | Green | Blue;\n@let c := Green;',
            edits: ['#@enum Color := Red | Green | Blue;\n@let c := Green;'],
        },
        {
            name: 'collapse two elements then re-split at a different point',
            initial: '@let a := 1;\n@let b := 2;',
            edits: [
                '@let a := 1\n@let b := 2;',          // merge
                '@let a :=; 1\n@let b := 2;',         // split at a weird spot
                '@let a := 1;\n@let b := 2;',         // back to clean
            ],
        },
    ]

    for (const s of scenarios) {
        test(s.name, () => {
            const fail = runSequence(s.initial, s.edits)
            if (fail) throw new Error(reportFail(s.initial, s.edits, fail))
        })
    }
})

// ── boundary-targeted seeded random fuzz ─────────────────────────────────────
/**
 * Pick a real element boundary in the current source and apply one of the
 * category operations there: merge (delete nearest ;), split (insert ;),
 * delete an element, toggle blank line, toggle ## comment, whitespace flip.
 */
const OPS = ['delSemi', 'insSemi', 'delElem', 'blankLine', 'comment', 'ws', 'delChar', 'insChar'] as const
const INS_CHARS = [';', '\n', ' ', '#', 'x', '1', '+']

function applyOp(src: string, rand: () => number): string {
    if (src.length === 0) return '@let x := 1;'
    const offs = boundaryOffsets(src)
    const at = offs[Math.floor(rand() * offs.length)]
    const op = OPS[Math.floor(rand() * OPS.length)]
    switch (op) {
        case 'delSemi': {
            const i = src.indexOf(';', Math.max(0, at - 1))
            return i >= 0 ? src.slice(0, i) + src.slice(i + 1) : src
        }
        case 'insSemi':
            return src.slice(0, at) + ';' + src.slice(at)
        case 'delElem': {
            // Delete from the boundary back to the previous ; (or start) forward to next ;.
            const prev = src.lastIndexOf(';', Math.max(0, at - 1))
            const next = src.indexOf(';', at)
            const from = prev >= 0 ? prev + 1 : 0
            const to = next >= 0 ? next + 1 : src.length
            return from < to ? src.slice(0, from) + src.slice(to) : src
        }
        case 'blankLine':
            return src.slice(0, at) + '\n' + src.slice(at)
        case 'comment':
            return src.slice(0, at) + '\n## c\n' + src.slice(at)
        case 'ws':
            return src.slice(0, at) + '  ' + src.slice(at)
        case 'delChar':
            return at < src.length ? src.slice(0, at) + src.slice(at + 1) : src
        case 'insChar':
            return src.slice(0, at) + INS_CHARS[Math.floor(rand() * INS_CHARS.length)] + src.slice(at)
    }
}

describe('ADV: boundary-targeted seeded random edits ≡ fresh', () => {
    const STEPS = 12
    const SEEDS = 8

    for (let b = 0; b < BASES.length; b++) {
        const base = BASES[b]
        test(`base[${b}] ${SEEDS} seeds × ${STEPS} boundary edits`, () => {
            let totalCases = 0
            for (let s = 0; s < SEEDS; s++) {
                const rand = mulberry32(0x9e3779b9 ^ (b * 131 + s))
                const ws = new Workspace()
                ws.openDocument('m.si', base)
                let cur = base
                const history: string[] = []
                for (let step = 0; step < STEPS; step++) {
                    const next = applyOp(cur, rand)
                    if (next === cur) continue
                    history.push(next)
                    const inc = ws.editDocument('m.si', next)
                    const full = freshCompile(next)
                    totalCases++
                    const d = diverge(inc, full)
                    if (d) {
                        throw new Error(reportFail(base, history, { idx: history.length - 1, src: next, d }))
                    }
                    cur = next
                }
            }
            // Sanity: we actually ran a meaningful number of comparisons.
            expect(totalCases).toBeGreaterThan(SEEDS * 5)
        }, 30_000)   // each fresh compile rebuilds the builtin-strata registry (~120ms)
    }
})
