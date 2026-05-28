// SPDX-License-Identifier: MIT
/**
 * Bench result comparator (story 10b-5 — CI signal).
 *
 *   bun run scripts/bench-compare.ts base.json current.json
 *
 * Reads two `bench.ts --json` outputs and reports per-sample deltas.
 * Exits non-zero only on a >2x regression on one of the headline
 * metrics; smaller regressions are warn-only.  Bench noise on shared
 * CI runners is real; tight thresholds give false positives.
 */

import { readFileSync } from 'fs'

const FAIL_RATIO = Number(process.env.BENCH_FAIL_RATIO ?? 2.0)
const WARN_RATIO = Number(process.env.BENCH_WARN_RATIO ?? 1.25)

const HEADLINE = new Set([
    'small.compile',
    'medium.compile',
    'large.compile',
])

interface Sample {
    fixture: string
    stage: string
    medianMs: number
    watBytes?: number
}

interface Report {
    samples: Sample[]
}

const [, , baseFile, currentFile] = process.argv
if (!baseFile || !currentFile) {
    console.error('usage: bun run scripts/bench-compare.ts <base.json> <current.json>')
    process.exit(2)
}

const base: Report = JSON.parse(readFileSync(baseFile, 'utf-8'))
const current: Report = JSON.parse(readFileSync(currentFile, 'utf-8'))

const baseMap = new Map(base.samples.map(s => [`${s.fixture}.${s.stage}`, s]))

let failures = 0
let warnings = 0

console.log('Stage             | base ms  | curr ms  | ratio   | base wat | curr wat | wat Δ')
console.log('------------------+----------+----------+---------+----------+----------+-------')

for (const s of current.samples) {
    const key = `${s.fixture}.${s.stage}`
    const b = baseMap.get(key)
    if (!b) {
        console.log(`${key.padEnd(17)} | (new)`)
        continue
    }
    const ratio = s.medianMs / b.medianMs
    const watDelta = (s.watBytes ?? 0) - (b.watBytes ?? 0)
    const marker = ratio >= FAIL_RATIO ? ' FAIL' : ratio >= WARN_RATIO ? ' WARN' : ''
    console.log(`${key.padEnd(17)} | ${b.medianMs.toFixed(2).padStart(8)} | ${s.medianMs.toFixed(2).padStart(8)} | ${ratio.toFixed(2).padStart(7)} | ${(b.watBytes ?? 0).toString().padStart(8)} | ${(s.watBytes ?? 0).toString().padStart(8)} | ${watDelta >= 0 ? '+' : ''}${watDelta}${marker}`)
    if (ratio >= FAIL_RATIO && HEADLINE.has(key)) failures++
    else if (ratio >= WARN_RATIO) warnings++
}

console.log()
if (failures > 0) {
    console.error(`::error::${failures} headline regression(s) ≥ ${FAIL_RATIO}x`)
    process.exit(1)
}
if (warnings > 0) {
    console.warn(`::warning::${warnings} regression(s) ≥ ${WARN_RATIO}x (warn-only)`)
}
console.log('OK')
