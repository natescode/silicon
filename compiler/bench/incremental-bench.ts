// SPDX-License-Identifier: MIT
/**
 * Incremental-reparse benchmark (CaaS tracker 3b — M1).
 *
 *   bun run compiler/bench/incremental-bench.ts
 *
 * Measures `SyntaxTree.withText(edited)` (incremental) against `parse(edited)`
 * (full reparse) for representative localized edits — editing the first / last /
 * middle function and appending a definition — across generated program tiers.
 * Reports wall-clock speedup and the fraction of top-level elements reused.
 *
 * Programs come from a seeded PRNG so runs are comparable.
 */

import { parse } from '../src/caas/index'
import { parseProgramWithExtents } from '../src/parser/parser'
import { incrementalReparse, damageFromText } from '../src/caas/incremental'

// ── deterministic PRNG (mulberry32) ─────────────────────────────────────────
function rng(seed: number) {
    let a = seed >>> 0
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

// ── program generator (one @fn per top-level element) ───────────────────────
function genFunction(rand: () => number, idx: number, stmts: number): string {
    const lines: string[] = [`\\\\ fn${idx} (Int, Int) -> Int`, `@fn fn${idx} a, b := {`]
    for (let i = 0; i < stmts; i++) {
        lines.push(`    @local v${i % 8} := ${Math.floor(rand() * 1000)} + b;`)
    }
    lines.push(`    a + ${Math.floor(rand() * 1000)}`, `};`)
    return lines.join('\n')
}

function genProgram(numFns: number, stmtsPerFn: number, seed = 12345): string {
    const rand = rng(seed)
    const parts: string[] = []
    for (let i = 0; i < numFns; i++) parts.push(genFunction(rand, i, stmtsPerFn))
    return parts.join('\n\n') + '\n'
}

// ── edits (all valid + intra-line: lengthen a decimal literal) ──────────────
function bumpDigitFrom(src: string, from: number): string {
    let i = from
    while (i < src.length && !(src[i] >= '0' && src[i] <= '9')) i++
    if (i >= src.length) { i = src.search(/\d/) }   // wrap to first digit
    return src.slice(0, i) + src[i] + src.slice(i)
}

/** Insert a blank line near the middle — a newline-changing edit (M3 reuses the
 *  suffix across it; M1 fell back to reparsing it). */
function insertLineMid(src: string): string {
    let i = src.indexOf('\n', Math.floor(src.length / 2))
    if (i < 0) i = src.length
    return src.slice(0, i) + '\n' + src.slice(i)
}

function makeEdits(src: string): { label: string; edited: string }[] {
    return [
        { label: 'edit-first',  edited: bumpDigitFrom(src, 0) },
        { label: 'edit-mid',    edited: bumpDigitFrom(src, Math.floor(src.length / 2)) },
        { label: 'edit-last',   edited: bumpDigitFrom(src, src.length - 120) },
        { label: 'insert-line', edited: insertLineMid(src) },
        { label: 'append',      edited: src + '\\\\ extra () -> Int\n@fn extra := { 1 };\n' },
    ]
}

function bench(fn: () => void, iters: number, warmup: number): number {
    for (let i = 0; i < warmup; i++) fn()
    const t0 = performance.now()
    for (let i = 0; i < iters; i++) fn()
    return (performance.now() - t0) / iters
}

/** Fraction of top-level element groups reused (not reparsed) for this edit. */
function reuseFraction(src: string, edited: string): number {
    const { extents } = parseProgramWithExtents(src)
    const dmg = damageFromText(src, edited)
    if (dmg === null) return 1
    const res = incrementalReparse(src, extents, edited, dmg)
    if (res === null) return 0
    const total = res.extents.length
    return total === 0 ? 1 : res.reusedElements / total
}

interface Tier { name: string; fns: number; stmts: number }
const TIERS: Tier[] = [
    { name: 'small',  fns: 20,  stmts: 8 },
    { name: 'medium', fns: 70,  stmts: 12 },
    { name: 'large',  fns: 160, stmts: 16 },
]

console.log('Incremental reparse vs full reparse — withText(edited) speedup\n')
const header = ['tier', 'KiB', 'edit', 'full ms', 'inc ms', 'speedup', 'reuse%'].join('\t')
console.log(header)
console.log('-'.repeat(header.length + 28))

for (const t of TIERS) {
    const src = genProgram(t.fns, t.stmts)
    const kib = (src.length / 1024).toFixed(1)
    const tree = parse(src).tree
    for (const { label, edited } of makeEdits(src)) {
        const fullMs = bench(() => { parse(edited) }, 50, 10)
        const incMs  = bench(() => { tree.withText(edited) }, 50, 10)
        const speedup = (fullMs / incMs).toFixed(1) + 'x'
        const reuse = (reuseFraction(src, edited) * 100).toFixed(0)
        console.log([t.name, kib, label, fullMs.toFixed(2), incMs.toFixed(2), speedup, reuse].join('\t'))
    }
}
