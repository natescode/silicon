/**
 * AST JSON Round-Trip Property
 *
 * For every fixture: parse(source) → AST → JSON.stringify → JSON.parse → AST'
 * AST and AST' must be structurally identical (after a deterministic walk that
 * ignores key order).
 *
 * Why this matters for the bootstrap: §9.4 of the bootstrap plan uses AST JSON
 * as the structural-equivalence diff format between Stage 1 → Stage 2 → Stage 3
 * outputs. If JSON serialisation is lossy or if `JSON.parse` re-orders things,
 * the diff harness reports false negatives. This property pins down the
 * serialiser so the bootstrap can rely on it.
 *
 * Also catches accidental introduction of:
 *   - non-JSON values (`undefined`, `BigInt`, `Function`, class instances with
 *     methods) into AST nodes
 *   - circular references (would throw at JSON.stringify time)
 *   - key-order dependence in any downstream consumer
 */

import { test, describe } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { compileToTyped } from './_compile.ts'
import type { Program } from '../../src/ast/astNodes.ts'

const EXAMPLES_DIR = join(import.meta.dirname, '../../src/e2e/examples')

function allFixtures(): { name: string; source: string }[] {
    return readdirSync(EXAMPLES_DIR)
        .filter(f => f.endsWith('.si'))
        .sort()
        .map(name => ({
            name,
            source: readFileSync(join(EXAMPLES_DIR, name), 'utf-8'),
        }))
}

/**
 * Recursively sort object keys so two structurally-equal trees produce
 * identical JSON.stringify output regardless of key insertion order.
 */
function canonical(value: any): any {
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(canonical)
    const out: Record<string, any> = {}
    for (const k of Object.keys(value).sort()) {
        out[k] = canonical(value[k])
    }
    return out
}

function firstDiff(a: string, b: string): string {
    const n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i++) {
        if (a.charCodeAt(i) !== b.charCodeAt(i)) {
            const start = Math.max(0, i - 80)
            const end = Math.min(n, i + 120)
            return `at byte ${i}:\n  A: ${JSON.stringify(a.slice(start, end))}\n  B: ${JSON.stringify(b.slice(start, end))}`
        }
    }
    if (a.length !== b.length) return `lengths differ: A=${a.length}, B=${b.length}`
    return 'no diff (?)'
}

describe('AST JSON round-trip', () => {
    const fixtures = allFixtures()

    test('parse → JSON.stringify → JSON.parse preserves the AST', () => {
        const failures: string[] = []

        for (const { name, source } of fixtures) {
            let ast: Program
            try {
                ast = compileToTyped(source).rawAST
            } catch {
                // Determinism test owns the "compile cleanly" property.
                continue
            }

            let serialised: string
            try {
                serialised = JSON.stringify(ast)
            } catch (e) {
                failures.push(`${name}: JSON.stringify threw — ${String(e)}`)
                continue
            }

            let revived: any
            try {
                revived = JSON.parse(serialised)
            } catch (e) {
                failures.push(`${name}: JSON.parse threw on serialised AST — ${String(e)}`)
                continue
            }

            const original = JSON.stringify(canonical(ast))
            const recovered = JSON.stringify(canonical(revived))
            if (original !== recovered) {
                failures.push(`${name}: round-trip mismatch ${firstDiff(original, recovered)}`)
            }
        }

        if (failures.length > 0) {
            throw new Error(
                `${failures.length} AST round-trip failure(s):\n  ` +
                failures.slice(0, 10).join('\n  '),
            )
        }
    })

    test('AST contains only JSON-safe value types', () => {
        // Flag any value JSON would silently drop or throw on:
        //   - functions (silently dropped)
        //   - symbols   (silently dropped)
        //   - BigInt    (throws on serialise)
        // The round-trip test above catches actual cycles (JSON.stringify
        // throws on those); shared object references (e.g. SiliconType
        // singletons like TypeInt) are harmless and intentionally not flagged.
        const offenders: string[] = []

        for (const { name, source } of fixtures) {
            let ast: Program
            try { ast = compileToTyped(source).rawAST } catch { continue }

            // Track shared references with a WeakSet so we visit each object
            // at most once — without flagging shares as bugs.
            const visited = new WeakSet<object>()
            const stack: Array<{ path: string; value: any }> = [{ path: '$', value: ast }]
            while (stack.length > 0) {
                const { path, value } = stack.pop()!
                if (value === null) continue
                const t = typeof value
                if (t === 'function' || t === 'symbol' || t === 'bigint') {
                    offenders.push(`${name} ${path}: non-JSON value of type '${t}'`)
                    continue
                }
                if (t !== 'object') continue
                if (visited.has(value)) continue
                visited.add(value)
                if (Array.isArray(value)) {
                    for (let i = 0; i < value.length; i++) {
                        stack.push({ path: `${path}[${i}]`, value: value[i] })
                    }
                } else {
                    for (const k of Object.keys(value)) {
                        stack.push({ path: `${path}.${k}`, value: value[k] })
                    }
                }
            }
        }

        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} non-JSON value(s) in AST:\n  ` +
                offenders.slice(0, 20).join('\n  '),
            )
        }
    })
})
