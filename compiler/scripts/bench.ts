// SPDX-License-Identifier: MIT
/**
 * Sigil performance baseline harness (story 10b-5).
 *
 * Measures wall-clock for three pipeline shapes on three fixture sizes:
 *
 *   parse              parse only (Ohm grammar → AST)
 *   compile (WAT)      parse → elaborate → typecheck → lower → WAT text
 *
 * Each measurement is N iterations (default 11); reports min / median /
 * stddev / max in ms.  Hyperfine-style.  Deterministic — every iteration
 * starts from the same source string.
 *
 * Output:
 *   bun run scripts/bench.ts                  human-readable table
 *   bun run scripts/bench.ts --json           machine-readable JSON
 *   SIGIL_BENCH_RUNS=21 bun run scripts/bench.ts
 *
 * The baseline numbers + methodology are published in
 * `docs/performance.md` and CI emits warn-only regression alerts on
 * >2x slowdowns on the headline metrics (story 10b-5).
 */

import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import { performance } from 'perf_hooks'
import { parse, compile } from '../src/caas/index.ts'

const RUNS = Number(process.env.SIGIL_BENCH_RUNS ?? 11)
const WARMUP = Number(process.env.SIGIL_BENCH_WARMUP ?? 2)
const JSON_OUT = process.argv.includes('--json')

const FIXTURES = [
    { name: 'small',  file: 'tests/bench/fixtures/small.si'  },
    { name: 'medium', file: 'tests/bench/fixtures/medium.si' },
    { name: 'large',  file: 'tests/bench/fixtures/large.si'  },
]

interface Sample {
    fixture: string
    stage: string
    loc: number
    bytes: number
    runs: number
    minMs: number
    medianMs: number
    meanMs: number
    stddevMs: number
    maxMs: number
    /** WAT bytes — only set for the compile stage; lets us track
     *  emit-size regressions alongside compile time. */
    watBytes?: number
}

function stats(samples: number[]): { min: number; median: number; mean: number; stddev: number; max: number } {
    const sorted = [...samples].sort((a, b) => a - b)
    const min = sorted[0]
    const max = sorted[sorted.length - 1]
    const mid = Math.floor(sorted.length / 2)
    const median = sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid]
    const mean = samples.reduce((s, x) => s + x, 0) / samples.length
    const variance = samples.reduce((s, x) => s + (x - mean) ** 2, 0) / samples.length
    const stddev = Math.sqrt(variance)
    return { min, median, mean, stddev, max }
}

function loc(src: string): number {
    return src.split('\n').length
}

function bench(label: string, fn: () => void, runs: number, warmup: number): number[] {
    for (let i = 0; i < warmup; i++) fn()
    const samples: number[] = []
    for (let i = 0; i < runs; i++) {
        const t = performance.now()
        fn()
        samples.push(performance.now() - t)
    }
    return samples
}

function run(): Sample[] {
    const out: Sample[] = []
    for (const fx of FIXTURES) {
        const src = readFileSync(fx.file, 'utf-8')
        const lines = loc(src)
        const bytes = statSync(fx.file).size

        // --- parse only ---
        {
            const samples = bench(`parse ${fx.name}`, () => { parse(src) }, RUNS, WARMUP)
            out.push({
                fixture: fx.name, stage: 'parse',
                loc: lines, bytes, runs: RUNS,
                minMs: round(stats(samples).min),
                medianMs: round(stats(samples).median),
                meanMs: round(stats(samples).mean),
                stddevMs: round(stats(samples).stddev),
                maxMs: round(stats(samples).max),
            })
        }

        // --- full compile to WAT ---
        {
            let lastWatBytes = 0
            const samples = bench(`compile ${fx.name}`, () => {
                const r = compile(src)
                lastWatBytes = r.wat.length
                if (r.diagnostics.length > 0) {
                    throw new Error(`bench fixture ${fx.name} no longer compiles cleanly: ${r.diagnostics[0].message}`)
                }
            }, RUNS, WARMUP)
            out.push({
                fixture: fx.name, stage: 'compile',
                loc: lines, bytes, runs: RUNS,
                minMs: round(stats(samples).min),
                medianMs: round(stats(samples).median),
                meanMs: round(stats(samples).mean),
                stddevMs: round(stats(samples).stddev),
                maxMs: round(stats(samples).max),
                watBytes: lastWatBytes,
            })
        }
    }
    return out
}

function round(n: number): number {
    return Math.round(n * 100) / 100
}

function formatTable(samples: Sample[]): string {
    const cols = ['fixture', 'stage', 'LOC', 'src B', 'wat B', 'min ms', 'median', 'mean', 'stddev', 'max']
    const rows = samples.map(s => [
        s.fixture, s.stage,
        s.loc.toString(),
        s.bytes.toString(),
        s.watBytes?.toString() ?? '-',
        s.minMs.toString(),
        s.medianMs.toString(),
        s.meanMs.toString(),
        s.stddevMs.toString(),
        s.maxMs.toString(),
    ])
    const widths = cols.map((c, i) => Math.max(c.length, ...rows.map(r => r[i].length)))
    const head = cols.map((c, i) => c.padEnd(widths[i])).join(' | ')
    const sep  = widths.map(w => '-'.repeat(w)).join('-+-')
    const body = rows.map(r => r.map((c, i) => c.padEnd(widths[i])).join(' | ')).join('\n')
    return `${head}\n${sep}\n${body}`
}

const samples = run()
if (JSON_OUT) {
    console.log(JSON.stringify({
        runs: RUNS,
        warmup: WARMUP,
        platform: `${process.platform}-${process.arch}`,
        node: process.version,
        bun: typeof Bun !== 'undefined' ? Bun.version : undefined,
        timestamp: new Date().toISOString(),
        samples,
    }, null, 2))
} else {
    console.log(`Sigil bench — ${RUNS} runs per measurement, ${WARMUP} warmup`)
    console.log(`Platform: ${process.platform}-${process.arch}, bun ${typeof Bun !== 'undefined' ? Bun.version : 'unknown'}`)
    console.log()
    console.log(formatTable(samples))
}
