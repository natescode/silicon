// SPDX-License-Identifier: MIT
/**
 * Parser benchmark: ohm (parse → toAst) vs the hand-written recursive-descent
 * parser (parseToAst), over generated large Silicon programs.
 *
 *   bun run compiler/bench/parse-bench.ts
 *
 * Programs are generated from a seeded PRNG so runs are comparable, and each
 * size is gated on AST-equality between the two parsers before timing (so we
 * only ever benchmark inputs that produce identical output).
 */

import { parse, addToAstSemantics, siliconGrammar } from '../src/pipeline'
import { parseToAst } from '../src/parser/handwritten/parser'

const sem = addToAstSemantics(siliconGrammar)
const ohmToAst = (src: string) => sem(parse(src)).toAst()

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

// ── program generator ───────────────────────────────────────────────────────
const OPS = ['+', '-', '*', '/', '%', '==', '!=', '<', '>', '<=', '>=']
const KW_CALLS = ['@add', '@sub', '@mul', '@eq']

function genExpr(rand: () => number, depth: number): string {
    if (depth <= 0) {
        const r = rand()
        if (r < 0.4) return String(Math.floor(rand() * 1000))
        if (r < 0.7) return 'v' + Math.floor(rand() * 8)
        if (r < 0.85) return `'s${Math.floor(rand() * 100)}'`
        return `(${Math.floor(rand() * 100)} + v${Math.floor(rand() * 8)})`
    }
    const r = rand()
    if (r < 0.45) {
        // binary chain of 2-4 terms
        const n = 2 + Math.floor(rand() * 3)
        const parts: string[] = [genExpr(rand, depth - 1)]
        for (let i = 1; i < n; i++) {
            parts.push(OPS[Math.floor(rand() * OPS.length)])
            parts.push(genExpr(rand, depth - 1))
        }
        return parts.join(' ')
    }
    if (r < 0.7) {
        // user call: &name a, b, c
        const argc = 1 + Math.floor(rand() * 3)
        const args = Array.from({ length: argc }, () => genExpr(rand, depth - 1))
        return `&fn${Math.floor(rand() * 16)} ${args.join(', ')}`
    }
    if (r < 0.85) {
        // builtin keyword call
        const kw = KW_CALLS[Math.floor(rand() * KW_CALLS.length)]
        return `&${kw} ${genExpr(rand, depth - 1)}, ${genExpr(rand, depth - 1)}`
    }
    // if-expression
    return `&@if ${genExpr(rand, depth - 1)}, { ${genExpr(rand, depth - 1)} }, { ${genExpr(rand, depth - 1)} }`
}

function genFunction(rand: () => number, idx: number, stmts: number): string {
    const lines: string[] = []
    lines.push(`\\\\ fn${idx} (Int, Int) -> Int`)
    lines.push(`@fn fn${idx} a, b := {`)
    for (let i = 0; i < stmts; i++) {
        const r = rand()
        if (r < 0.45) lines.push(`    @local v${i % 8} := ${genExpr(rand, 3)};`)
        else if (r < 0.7) lines.push(`    v${i % 8} = ${genExpr(rand, 3)};`)
        else lines.push(`    ${genExpr(rand, 3)};`)
    }
    lines.push(`    ${genExpr(rand, 3)}`)   // trailing expression
    lines.push(`};`)
    return lines.join('\n')
}

function genTypes(rand: () => number, n: number): string {
    const out: string[] = []
    for (let i = 0; i < n; i++) {
        out.push(`@type Sum${i} := $A${i} x | $B${i} y, z | $C${i};`)
        out.push(`@enum Enum${i} := Red${i} | Green${i} | Blue${i};`)
    }
    return out.join('\n')
}

function genProgram(numFns: number, stmtsPerFn: number, seed = 1): string {
    const rand = rng(seed)
    const parts: string[] = [genTypes(rand, Math.max(2, numFns >> 4))]
    for (let i = 0; i < numFns; i++) parts.push(genFunction(rand, i, stmtsPerFn))
    return parts.join('\n\n') + '\n'
}

// ── timing ───────────────────────────────────────────────────────────────────
function bench(fn: () => void, iters: number, warmup: number): number {
    for (let i = 0; i < warmup; i++) fn()
    const t0 = performance.now()
    for (let i = 0; i < iters; i++) fn()
    return (performance.now() - t0) / iters                 // avg ms per parse
}

interface Tier { name: string; fns: number; stmts: number; iters: number }
const TIERS: Tier[] = [
    { name: 'small',  fns: 20,  stmts: 8,  iters: 20 },
    { name: 'medium', fns: 70,  stmts: 12, iters: 5 },
    { name: 'large',  fns: 160, stmts: 16, iters: 2 },
]

console.log('Parser benchmark — ohm (parse+toAst) vs hand-written parseToAst\n')
const header = ['tier', 'lines', 'KiB', 'ohm ms', 'hand ms', 'speedup', 'hand MiB/s', 'AST'].join('\t')
console.log(header)
console.log('-'.repeat(header.length + 40))

for (const t of TIERS) {
    const src = genProgram(t.fns, t.stmts, 12345)
    const lines = src.split('\n').length
    const kib = src.length / 1024

    // Correctness gate: identical AST before we time anything.
    let astOk = false
    try {
        astOk = JSON.stringify(ohmToAst(src)) === JSON.stringify(parseToAst(src))
    } catch (e) {
        console.log(`${t.name}\tERROR during AST check: ${(e as Error).message}`)
        continue
    }
    if (!astOk) {
        console.log(`${t.name}\tAST MISMATCH — skipping timing`)
        continue
    }

    // ohm is slow; give it minimal warmup. The hand-written parser is timed
    // with enough warmup for the JIT and many iters for a stable mean.
    const ohmMs = bench(() => { ohmToAst(src) }, t.iters, 1)
    const handMs = bench(() => { parseToAst(src) }, Math.max(t.iters, 20), 5)
    const speedup = (ohmMs / handMs).toFixed(1) + 'x'
    const mibps = ((kib / 1024) / (handMs / 1000)).toFixed(1)
    console.log([t.name, lines, kib.toFixed(1), ohmMs.toFixed(1), handMs.toFixed(1), speedup, mibps, astOk ? 'equal' : 'DIFF'].join('\t'))
}
