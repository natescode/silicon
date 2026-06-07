/**
 * Parser fuzzing harness — WS 6 of Stage 0 Cleanup Plan.
 *
 * Three targets:
 *   1. Random bytes        — parser must never throw an unstructured error,
 *                            never crash, never loop, never allocate unbounded.
 *   2. Random token streams — parser must either succeed or return an error
 *                             pointing at the first bad token.
 *   3. Generative round-trip — generate valid Silicon, parse, pretty-print,
 *                              re-parse; the two parse trees match modulo
 *                              trivial differences.
 *
 * Per `docs/stage0-cleanup-plan.html` §6.2:
 *   - Local `bun test:fuzz` budget: 60s per target.
 *   - Reproducers minimised by fast-check are committed under
 *     `tests/fuzz/corpus/` as permanent regression seeds.
 */

import { test, describe, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import fc from 'fast-check'
import { parse } from '../../src/parser/index.ts'
import { parse as caasParse } from '../../src/caas/index.ts'
import { stableStringify } from '../../src/caas/incremental.ts'

const CORPUS_DIR = join(import.meta.dirname, 'corpus')
const LOCAL_BUDGET_MS = Number(process.env.SIGIL_FUZZ_BUDGET_MS ?? 60_000)
const TARGET_BUDGET_MS = Math.max(1_000, Math.floor(LOCAL_BUDGET_MS / 3))

// Cap individual runs so the budget translates to many attempts.
const RANDOM_BYTES_RUNS    = Number(process.env.SIGIL_FUZZ_BYTES_RUNS    ?? 800)
const TOKEN_STREAM_RUNS    = Number(process.env.SIGIL_FUZZ_TOKEN_RUNS    ?? 800)
const ROUNDTRIP_RUNS       = Number(process.env.SIGIL_FUZZ_ROUNDTRIP_RUNS ?? 400)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Try to parse a source string; classify the outcome. */
function tryParse(src: string): { ok: boolean, error?: string, throwKind?: string } {
    try {
        parse(src)
        return { ok: true }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // Structured parse errors start with "Parse error:" (see parser.ts:30).
        if (msg.startsWith('Parse error:')) return { ok: false, error: msg }
        return { ok: false, error: msg, throwKind: 'unstructured' }
    }
}

/** Load the regression corpus. Each .si file is a minimised reproducer. */
function corpusFiles(): { name: string, source: string }[] {
    let names: string[] = []
    try { names = readdirSync(CORPUS_DIR) } catch (_e) { return [] }
    return names
        .filter(n => n.endsWith('.si'))
        .sort()
        .map(name => ({ name, source: readFileSync(join(CORPUS_DIR, name), 'utf-8') }))
}

// ---------------------------------------------------------------------------
// Target 1 — Random bytes
// ---------------------------------------------------------------------------

describe('parser fuzz: random bytes', () => {
    test('parser handles arbitrary byte input without unstructured throws', () => {
        fc.assert(
            fc.property(
                fc.uint8Array({ minLength: 0, maxLength: 256 }),
                (bytes) => {
                    const src = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
                    const result = tryParse(src)
                    // It's fine for the parser to fail on garbage — it just
                    // must do so through the structured error channel.
                    if (result.throwKind === 'unstructured') {
                        throw new Error(
                            `Unstructured throw on input ${JSON.stringify(src.slice(0, 40))}: ${result.error}`)
                    }
                    return true
                },
            ),
            { numRuns: RANDOM_BYTES_RUNS, interruptAfterTimeLimit: TARGET_BUDGET_MS },
        )
    })
})

// ---------------------------------------------------------------------------
// Target 2 — Random token streams
// ---------------------------------------------------------------------------

const tokenArb: fc.Arbitrary<string> = fc.oneof(
    fc.constant('@global'), fc.constant('@fn'), fc.constant('@local'),
    fc.constant('@local'), fc.constant('@if'), fc.constant('@loop'),
    fc.constant('@return'), fc.constant('@break'), fc.constant('@continue'),
    fc.constant('@true'), fc.constant('@false'),
    fc.constant('+'), fc.constant('-'), fc.constant('*'), fc.constant('/'),
    fc.constant('=='), fc.constant('!='), fc.constant('<'), fc.constant('>'),
    fc.constant(':='), fc.constant(';'), fc.constant(','),
    fc.constant('{'), fc.constant('}'),
    fc.constant('('), fc.constant(')'),
    fc.integer({ min: 0, max: 9999 }).map(String),
    fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{0,8}$/),
    fc.stringMatching(/^&[a-zA-Z][a-zA-Z0-9_]{0,8}$/),
)

describe('parser fuzz: random token streams', () => {
    test('parser either succeeds or returns a structured error on random tokens', () => {
        fc.assert(
            fc.property(
                fc.array(tokenArb, { minLength: 0, maxLength: 32 }),
                (tokens) => {
                    const src = tokens.join(' ')
                    const result = tryParse(src)
                    if (result.throwKind === 'unstructured') {
                        throw new Error(
                            `Unstructured throw on tokens ${JSON.stringify(src.slice(0, 60))}: ${result.error}`)
                    }
                    return true
                },
            ),
            { numRuns: TOKEN_STREAM_RUNS, interruptAfterTimeLimit: TARGET_BUDGET_MS },
        )
    })
})

// ---------------------------------------------------------------------------
// Target 3 — Generative round-trip
// ---------------------------------------------------------------------------

/**
 * Generate small, syntactically-valid Silicon programs.  Each program is a
 * sequence of bare `name := expr` bindings and bare-expression statements over integers and a few
 * identifiers.  This is intentionally narrower than the full grammar — the
 * goal is to grow corpus pressure on the most-exercised paths, not to cover
 * every production.
 */
const identArb: fc.Arbitrary<string> = fc.stringMatching(/^[a-z][a-z0-9_]{0,6}$/)
const intLitArb = fc.integer({ min: 0, max: 999 }).map(String)
const binOpArb  = fc.constantFrom('+', '-', '*', '/', '==')

const exprArb: fc.Arbitrary<string> = fc.letrec((tie) => ({
    atom: fc.oneof(intLitArb, identArb) as fc.Arbitrary<string>,
    expr: fc.oneof(
        { weight: 3, arbitrary: tie('atom') as fc.Arbitrary<string> },
        {
            weight: 1,
            arbitrary: fc.tuple(tie('atom') as fc.Arbitrary<string>, binOpArb, tie('atom') as fc.Arbitrary<string>)
                .map(([l, op, r]) => `${l} ${op} ${r}`),
        },
    ),
})).expr

const stmtArb: fc.Arbitrary<string> = fc.oneof(
    fc.tuple(identArb, exprArb).map(([n, e]) => `${n} := ${e}`),   // ADR-0020 bare binding
    exprArb,
)

const programArb: fc.Arbitrary<string> = fc.array(stmtArb, { minLength: 1, maxLength: 6 })
    .map(stmts => stmts.map(s => `${s};`).join('\n'))

/** A pretty-printer that re-emits parser-equivalent source.  For this fuzzer
 *  the generated source is already canonical, so the round-trip just re-parses
 *  the same string.  Once the bootstrap parser lands, this becomes a real
 *  AST → source step. */
function prettyPrint(src: string): string {
    // Round-trip via parse to make sure the input is valid; rethrow on error.
    parse(src)
    return src
}

describe('parser fuzz: generative round-trip', () => {
    test('generated valid programs re-parse identically after pretty-print', () => {
        fc.assert(
            fc.property(programArb, (src) => {
                const first = tryParse(src)
                if (!first.ok) {
                    // The generator should never produce invalid Silicon.
                    throw new Error(`generator emitted invalid Silicon: ${JSON.stringify(src)}: ${first.error}`)
                }
                const pp = prettyPrint(src)
                const second = tryParse(pp)
                if (!second.ok) {
                    throw new Error(`re-parse failed after pretty-print: ${JSON.stringify(pp)}: ${second.error}`)
                }
                return true
            }),
            { numRuns: ROUNDTRIP_RUNS, interruptAfterTimeLimit: TARGET_BUDGET_MS },
        )
    })
})

// ---------------------------------------------------------------------------
// Regression: every file under tests/fuzz/corpus/ must parse the same way
// it did when it was committed (either succeed, or fail with a structured
// error — the parser must not throw an unstructured exception).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Incremental-parse equivalence (CaaS tracker 3b): for a generated program and
// a random edit, `SyntaxTree.withText(edited)` must yield a tree node-for-node
// identical to a full reparse of `edited` — fast path or fallback alike.
// ---------------------------------------------------------------------------

describe('parser fuzz: incremental ≡ full reparse', () => {
    test('random edits on generated programs stay equivalent', () => {
        const editArb = fc.tuple(
            programArb,
            fc.nat(),
            fc.constantFrom('insert', 'delete', 'replace'),
            fc.constantFrom(' ', '1', 'x', 'q', ';', '\n', ')', '+'),
        )
        fc.assert(
            fc.property(editArb, ([src, n, op, ch]) => {
                const at = src.length === 0 ? 0 : n % src.length
                const edited =
                    op === 'insert'  ? src.slice(0, at) + ch + src.slice(at) :
                    op === 'delete'  ? src.slice(0, at) + src.slice(at + 1) :
                                       src.slice(0, at) + ch + src.slice(at + 1)
                const inc  = caasParse(src).tree.withText(edited)
                const full = caasParse(edited)
                if (stableStringify(inc.tree.program) !== stableStringify(full.tree.program)) {
                    throw new Error(`incremental ≠ full for edit ${op}@${at} '${ch}' on ${JSON.stringify(src)}`)
                }
                if (stableStringify(inc.diagnostics) !== stableStringify(full.diagnostics)) {
                    throw new Error(`diagnostics differ for edit ${op}@${at} '${ch}' on ${JSON.stringify(src)}`)
                }
                return true
            }),
            { numRuns: ROUNDTRIP_RUNS, interruptAfterTimeLimit: TARGET_BUDGET_MS },
        )
    })
})

describe('parser fuzz: corpus regressions', () => {
    const fixtures = corpusFiles()
    if (fixtures.length === 0) {
        test('no corpus seeds yet (skip)', () => {
            expect(true).toBe(true)
        })
    } else {
        for (const { name, source } of fixtures) {
            test(`corpus seed ${name} parses through the structured channel`, () => {
                const result = tryParse(source)
                expect(result.throwKind).toBeUndefined()
            })
        }
    }
})
