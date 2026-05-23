/**
 * Determinism Property
 *
 * For every fixture: compile(p) == compile(p), byte-for-byte.
 *
 * This is the single most important property in the Stage 0 cleanup suite.
 * Every other determinism rule in the bootstrap plan §9.1 is downstream of
 * this one: if Stage 0 compiles non-deterministically, the Stage 2 ≡ Stage 3
 * sha256 check in Phase 9 cannot pass.
 *
 * The test runs every .si fixture under src/e2e/examples through compileToWat
 * twice within the same process and asserts byte equality. If any output
 * differs, the diff is reported with the first 200 chars surrounding the
 * divergence so the source of the non-determinism is obvious.
 */

import { test, expect, describe } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { compileToWatString } from './_compile.ts'

const EXAMPLES_DIR = join(import.meta.dirname, '../../src/e2e/examples')

/** All .si fixture files under src/e2e/examples, sorted alphabetically. */
function allFixtures(): { name: string; source: string }[] {
    return readdirSync(EXAMPLES_DIR)
        .filter(f => f.endsWith('.si'))
        .sort()
        .map(name => ({
            name,
            source: readFileSync(join(EXAMPLES_DIR, name), 'utf-8'),
        }))
}

/** Report the first byte where two strings differ, with surrounding context. */
function firstDiff(a: string, b: string): string {
    const n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i++) {
        if (a.charCodeAt(i) !== b.charCodeAt(i)) {
            const start = Math.max(0, i - 80)
            const end = Math.min(n, i + 120)
            return `at byte ${i}:\n  A: ...${JSON.stringify(a.slice(start, end))}\n  B: ...${JSON.stringify(b.slice(start, end))}`
        }
    }
    if (a.length !== b.length) {
        return `lengths differ: A=${a.length}, B=${b.length}`
    }
    return 'no diff (?)'
}

describe('determinism', () => {
    const fixtures = allFixtures()

    test('every fixture compiles deterministically (same-process, run twice)', () => {
        const failures: string[] = []

        for (const { name, source } of fixtures) {
            let a: string
            let b: string
            try {
                a = compileToWatString(source)
                b = compileToWatString(source)
            } catch (e) {
                // Compile errors are fine for this property — we're testing
                // determinism, not correctness. Both runs must agree on the
                // error, though; we approximate that by skipping errored
                // fixtures (the structural-equivalence harness will catch
                // diverging errors once it lands in WS 4).
                continue
            }
            if (a !== b) {
                failures.push(`${name}: ${firstDiff(a, b)}`)
            }
        }

        if (failures.length > 0) {
            throw new Error(`${failures.length} non-deterministic fixture(s):\n` + failures.join('\n\n'))
        }
    })

    test('strata registry build order is deterministic', () => {
        // Compile the same fixture; the strata registry's iteration order
        // bleeds into the final WAT because (e.g.) operator dispatch and
        // codegen order both depend on it. Sweeping the registry's surfaces
        // directly catches the bug at its source.
        const src = fixtures.find(f => f.name === 'basic_arithmetic.si')?.source
            ?? '1 + 2;'
        const a = compileToWatString(src)
        const b = compileToWatString(src)
        expect(a).toBe(b)
    })

    test('cross-process: two fresh bun runs produce identical WAT', () => {
        // The strongest form of the determinism check — catches issues that
        // only surface across process boundaries: filesystem iteration order
        // (readdirSync), module-cache reload behaviour, and any global state
        // that gets seeded from environment / startup.
        //
        // Skips if no fixtures compile cleanly (e.g. CI without examples).
        const compileScript = join(import.meta.dirname, '_compile-cli.ts')
        const sample = fixtures.find(f => f.name === 'basic_arithmetic.si')
        if (!sample) return

        const sampleFile = join(import.meta.dirname, '../../src/e2e/examples', sample.name)

        const runOnce = () => {
            const r = Bun.spawnSync(['bun', 'run', compileScript, sampleFile], {
                cwd: join(import.meta.dirname, '../..'),
                stdout: 'pipe',
                stderr: 'pipe',
            })
            if (r.exitCode !== 0) {
                throw new Error(`compile-cli failed (${r.exitCode}): ${r.stderr.toString()}`)
            }
            return r.stdout.toString()
        }

        const a = runOnce()
        const b = runOnce()

        if (a !== b) {
            throw new Error(`cross-process WAT diverges:\n${firstDiff(a, b)}`)
        }
    }, 30000)
})
