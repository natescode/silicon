// SPDX-License-Identifier: MIT
// Temporary profiling harness for the hand-written parser.
import { Lexer } from '../src/parser/handwritten/lexer'
import { parseToAst } from '../src/parser/handwritten/parser'

// Reuse the bench generator inline (small copy to avoid import cycles).
function rng(seed: number) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const OPS = ['+', '-', '*', '/', '==', '<', '>']
function expr(r: () => number, d: number): string {
    if (d <= 0) return r() < 0.5 ? String(Math.floor(r() * 1000)) : 'v' + Math.floor(r() * 8)
    if (r() < 0.5) return `${expr(r, d - 1)} ${OPS[Math.floor(r() * OPS.length)]} ${expr(r, d - 1)}`
    return `fn${Math.floor(r() * 16)}(${expr(r, d - 1)}, ${expr(r, d - 1)})`
}
function gen(nFns: number, stmts: number): string {
    const r = rng(12345); const out: string[] = []
    for (let i = 0; i < nFns; i++) {
        out.push(`\\\\ fn${i} (Int, Int) -> Int`, `@fn fn${i} a, b := {`)
        for (let j = 0; j < stmts; j++) out.push(`    @mut v${j % 8} := ${expr(r, 3)};`)
        out.push(`    ${expr(r, 3)}`, `};`)
    }
    return out.join('\n') + '\n'
}

const src = gen(160, 16)
console.log(`program: ${(src.length / 1024).toFixed(1)} KiB, ${src.split('\n').length} lines\n`)

// Phase split.
let t = performance.now()
const toks = new Lexer(src).tokenize()
const lexMs = performance.now() - t
console.log(`tokenize:  ${lexMs.toFixed(1)} ms  (${toks.length} tokens)`)

for (let i = 0; i < 3; i++) parseToAst(src)            // warmup
t = performance.now()
parseToAst(src)
const parseMs = performance.now() - t
console.log(`parseToAst (incl. lex): ${parseMs.toFixed(1)} ms`)
console.log(`throughput: ${((src.length / 1024 / 1024) / (parseMs / 1000)).toFixed(1)} MiB/s`)
