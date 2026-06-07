// SPDX-License-Identifier: MIT
/**
 * ADVERSARIAL: rapid sequential edits that FLIP TYPES on reused elements.
 *
 * Category goal: construct multi-element programs where editing element A
 * (e.g. a function signature line, or a function's body/arity) changes a type
 * that element B — REUSED, unchanged text — depends on.  Then verify the
 * incrementally-edited document stays byte-identical to a FRESH full compile of
 * the same final source across every authoritative surface:
 *
 *   1. diagnostics          (code + span + message, sorted)
 *   2. symbols              (name|kind|displayString|definitionSpan|isImplicitlyDeclared, sorted)
 *   3. per-node model.typeOf (walk elabTree.program via astChildren, in order)
 *   4. elaboration structure (stableStringify(program) with `inferredType` STRIPPED)
 *
 * `inferredType` is a documented NON-authoritative backward-compat stamp that
 * may legitimately be stale on reused nodes — we strip it before comparing
 * structure and rely on model.typeOf as the authoritative per-node type.
 *
 * Seeded mulberry32 randomness → any failure reproduces from its seed.
 */

import { test, describe, expect } from 'bun:test'
import { Workspace, type Document } from '../../src/caas/workspace.ts'
import { parse } from '../../src/caas/index.ts'
import { stableStringify } from '../../src/caas/incremental.ts'
import { astChildren } from '../../src/ast/astChildren.ts'

// ── reuse-firing instrumentation ─────────────────────────────────────────────
// The incremental-elaboration path only runs when the parse layer reports
// `_elementReuse` with at least one `reused` group (otherwise the Workspace
// falls back to a full elaborate).  We count, across a chain, how many edits
// actually exercised reuse so the suite can't pass vacuously by always falling
// back to a full recompile.
let reuseEdits = 0
let totalEdits = 0

/** Re-derive the parse-layer reuse classification for one edit (old→new). */
function reuseStats(oldSource: string, newSource: string): { reused: number; total: number } | undefined {
    const tree = parse(oldSource, { file: 'm.si' }).tree
    const r = tree.withText(newSource, { file: 'm.si' })._elementReuse
    if (r === undefined) return undefined
    return { reused: r.filter(x => x.kind === 'reused').length, total: r.length }
}

// ── PRNG ────────────────────────────────────────────────────────────────────
function mulberry32(seed: number): () => number {
    let a = seed >>> 0
    return () => {
        a |= 0; a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

const SIG = '\\\\'   // literal `\\` signature-line prefix in source

// ── Authoritative surface fingerprints ───────────────────────────────────────

function diagFingerprint(doc: Document): string {
    return doc.diagnostics
        .map(d => {
            const s = d.span
            return `${d.code}|${s?.file}:${s?.line}:${s?.col}:${s?.length}|${d.message}`
        })
        .sort()
        .join('\n')
}

function symbolFingerprint(doc: Document): string {
    return [...doc.model.allSymbols]
        .map(s => {
            const ds = s.definitionSpan
            const span = ds ? `${ds.file}:${ds.line}:${ds.col}:${ds.length}` : '-'
            return `${s.name}|${s.kind}|${s.displayString}|${span}|${s.isImplicitlyDeclared}`
        })
        .sort()
        .join('\n')
}

/** Pre-order walk of the elaborated program via astChildren. */
function walkNodes(program: object): object[] {
    const out: object[] = []
    const stack: object[] = [program]
    // Use an explicit pre-order walk (deterministic, matches astChildren order).
    function rec(node: object) {
        out.push(node)
        for (const c of astChildren(node)) rec(c)
    }
    rec(program)
    return out
}

function perNodeTypeFingerprint(doc: Document): string {
    const nodes = walkNodes(doc.elabTree.program)
    const parts: string[] = []
    for (const n of nodes) {
        const t = doc.model.typeOf(n)
        parts.push(t ? typeKey(t) : '∅')
    }
    return parts.join('\n')
}

/** A stable structural key for a SiliconType (order-independent of identity). */
function typeKey(t: any): string {
    return JSON.stringify(canonical(t))
}

/** Strip the non-authoritative `inferredType` stamp recursively, then stringify. */
function elabStructureFingerprint(doc: Document): string {
    return stableStringify(stripInferredType(doc.elabTree.program))
}

function stripInferredType(value: any): any {
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(stripInferredType)
    const out: Record<string, any> = {}
    for (const k of Object.keys(value)) {
        if (k === 'inferredType') continue
        out[k] = stripInferredType(value[k])
    }
    return out
}

function canonical(value: any): any {
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(canonical)
    const out: Record<string, any> = {}
    for (const k of Object.keys(value).sort()) out[k] = canonical(value[k])
    return out
}

// ── Equivalence assertion: incremental doc vs fresh full compile ──────────────

interface Mismatch {
    surface: 'diagnostics' | 'symbols' | 'per-node-type' | 'elab-structure'
    inc: string
    full: string
}

function compareToFresh(incDoc: Document, finalSource: string): Mismatch | null {
    const fresh = new Workspace().openDocument('m.si', finalSource)

    const incDiag = diagFingerprint(incDoc), fullDiag = diagFingerprint(fresh)
    if (incDiag !== fullDiag) return { surface: 'diagnostics', inc: incDiag, full: fullDiag }

    const incSym = symbolFingerprint(incDoc), fullSym = symbolFingerprint(fresh)
    if (incSym !== fullSym) return { surface: 'symbols', inc: incSym, full: fullSym }

    const incTy = perNodeTypeFingerprint(incDoc), fullTy = perNodeTypeFingerprint(fresh)
    if (incTy !== fullTy) return { surface: 'per-node-type', inc: incTy, full: fullTy }

    const incEl = elabStructureFingerprint(incDoc), fullEl = elabStructureFingerprint(fresh)
    if (incEl !== fullEl) return { surface: 'elab-structure', inc: incEl, full: fullEl }

    return null
}

function reportMismatch(seed: number, initial: string, edits: string[], m: Mismatch): string {
    const lines = [
        `DIVERGENCE on surface '${m.surface}' (seed=${seed})`,
        `INITIAL SOURCE:\n${initial}`,
        `EDIT SEQUENCE (${edits.length}):`,
        ...edits.map((e, i) => `  [edit ${i + 1}]:\n${e}`),
        `INCREMENTAL:\n${m.inc}`,
        `FULL:\n${m.full}`,
    ]
    return lines.join('\n')
}

/** Run an edit chain on one workspace, asserting equivalence after EVERY edit. */
function runChain(seed: number, initial: string, edits: string[]): void {
    const ws = new Workspace()
    ws.openDocument('m.si', initial)
    // Verify the initial open matches a fresh open (sanity).
    {
        const m = compareToFresh(ws.getDocument('m.si')!, initial)
        if (m) throw new Error(reportMismatch(seed, initial, [], m))
    }
    const applied: string[] = []
    let prevSource = initial
    for (const next of edits) {
        // Measure whether this edit exercised parse-layer reuse (and hence the
        // incremental-elaboration path) BEFORE applying it on the live ws.
        const stats = reuseStats(prevSource, next)
        totalEdits++
        if (stats && stats.reused > 0) reuseEdits++

        const doc = ws.editDocument('m.si', next)
        applied.push(next)
        const m = compareToFresh(doc, next)
        if (m) throw new Error(reportMismatch(seed, initial, applied, m))
        prevSource = next
    }
}

// ── Source builders for the type-flip scenarios ───────────────────────────────

/** A function `add` (sig + body) followed by a `caller` that calls it. */
function buildPair(sigTypes: string, body: string, callArgs: string): string {
    return [
        `${SIG} add (${sigTypes})`,
        `@fn add x, y := ${body};`,
        `${SIG} caller (Int)`,
        `@fn caller z := add(${callArgs});`,
    ].join('\n')
}

// The space of signatures/bodies we flip between.  Each flip changes add's
// type; the REUSED `caller` element depends on it.
const SIG_VARIANTS = ['Int, Int', 'Float, Int', 'Int, Float', 'Float, Float']
const BODY_VARIANTS = ['x + y', 'x * y', 'x - y', '{ x + y }', '{ @mut t := x; t + y }']
const CALL_VARIANTS = ['z, 1', 'z, 2', '1, z', 'z, z']

describe('ADV typeflip: add-signature edits, caller reused', () => {
    test('randomized edit chains across signature/body/call flips', () => {
        let cases = 0
        const NUM_SEEDS = 30
        const EDITS_PER_CHAIN = 6
        for (let seed = 1; seed <= NUM_SEEDS; seed++) {
            const rand = mulberry32(seed)
            const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]

            let sig = pick(SIG_VARIANTS)
            let body = pick(BODY_VARIANTS)
            let call = pick(CALL_VARIANTS)
            const initial = buildPair(sig, body, call)

            const edits: string[] = []
            for (let i = 0; i < EDITS_PER_CHAIN; i++) {
                // Flip exactly one dimension per edit, so element A changes while
                // element B (caller, or the add-fn body) is candidate for reuse.
                const dim = Math.floor(rand() * 3)
                if (dim === 0) sig = pick(SIG_VARIANTS)
                else if (dim === 1) body = pick(BODY_VARIANTS)
                else call = pick(CALL_VARIANTS)
                edits.push(buildPair(sig, body, call))
            }
            runChain(seed, initial, edits)
            cases += edits.length + 1
        }
        console.log(`[typeflip pair] cases run: ${cases}`)
        expect(cases).toBeGreaterThan(0)
    }, 120_000)
})

// ── Int -> error -> Int across a binding chain ────────────────────────────────

/**
 * A chain of three lets where each binding depends on the previous.  We toggle
 * the FIRST binding's type between a valid Int expression and a type-error
 * expression, forcing the downstream (reused) bindings' types to flip
 * Int -> error -> Int across the chain.
 */
function buildLetChain(firstExpr: string): string {
    return [
        `a := ${firstExpr};`,
        'b := a + 1;',
        'c := b + 2;',
        'd := c + 3;',
    ].join('\n')
}

const FIRST_EXPRS = [
    '0',            // Int  → whole chain Int
    '1 + 2',        // Int
    '1.5',          // Float → a+1 mixes Float+Int → error propagates
    'true',         // Bool → error
    '10',           // Int
]

describe('ADV typeflip: Int->error->Int binding chain, downstream reused', () => {
    test('toggling the head binding flips downstream reused types', () => {
        let cases = 0
        for (let seed = 1; seed <= 25; seed++) {
            const rand = mulberry32(seed * 7919)
            const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]
            const initial = buildLetChain(pick(FIRST_EXPRS))
            const edits: string[] = []
            for (let i = 0; i < 8; i++) edits.push(buildLetChain(pick(FIRST_EXPRS)))
            runChain(seed, initial, edits)
            cases += edits.length + 1
        }
        console.log(`[let chain] cases run: ${cases}`)
        expect(cases).toBeGreaterThan(0)
    }, 120_000)
})

// ── Mid-element edits with a stable tail (suffix reuse stress) ────────────────

/**
 * Three independent functions.  We edit the MIDDLE function's signature/body so
 * the PREFIX (f1) is reused verbatim and the SUFFIX (f3) is reused with a
 * shifted elemBase — both must keep correct types/diagnostics while the middle
 * flips between well-typed and ill-typed.
 */
function buildTriple(midSig: string, midBody: string): string {
    return [
        `${SIG} f1 (Int)`,
        '@fn f1 a := a + 1;',
        `${SIG} f2 (${midSig})`,
        `@fn f2 p, q := ${midBody};`,
        `${SIG} f3 (Int)`,
        '@fn f3 m := m + 100;',
    ].join('\n')
}

describe('ADV typeflip: middle-element edit, prefix+suffix reused', () => {
    test('flip middle fn while neighbours are reused', () => {
        let cases = 0
        for (let seed = 1; seed <= 25; seed++) {
            const rand = mulberry32(seed * 104729)
            const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]
            const sigs = ['Int, Int', 'Float, Int', 'Float, Float', 'Int, Float']
            const bodies = ['p + q', 'p - q', 'p * q', '{ p + q }']
            const initial = buildTriple(pick(sigs), pick(bodies))
            const edits: string[] = []
            for (let i = 0; i < 8; i++) edits.push(buildTriple(pick(sigs), pick(bodies)))
            runChain(seed, initial, edits)
            cases += edits.length + 1
        }
        console.log(`[triple] cases run: ${cases}`)
        expect(cases).toBeGreaterThan(0)
    }, 120_000)
})

// ── Element-count-changing edits (reuse alignment shifts) ─────────────────────

/**
 * A producer `p` and a consumer `c` that calls it, with an OPTIONAL middle
 * function inserted/removed between them.  Inserting/removing the middle
 * element shifts the reuse alignment (the consumer's group index changes), and
 * simultaneously we flip `p`'s signature so the reused consumer's view of `p`
 * flips between well-typed and ill-typed.  This stresses the index-mapping in
 * `incrementalReparse`'s `suffixOldStart`/`reuse[]` alignment together with a
 * type flip.
 */
function buildWithOptionalMiddle(pSig: string, hasMiddle: boolean): string {
    const lines = [
        `${SIG} p (${pSig})`,
        '@fn p x, y := x + y;',
    ]
    if (hasMiddle) {
        lines.push(`${SIG} mid (Int)`, '@fn mid w := w * 2;')
    }
    lines.push(`${SIG} c (Int)`, '@fn c z := p(z, 1);')
    return lines.join('\n')
}

describe('ADV typeflip: element insert/remove shifts reuse + flips type', () => {
    test('toggle a middle element while flipping the producer signature', () => {
        let cases = 0
        const sigs = ['Int, Int', 'Float, Int', 'Float, Float']
        for (let seed = 1; seed <= 25; seed++) {
            const rand = mulberry32(seed * 1299709)
            const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]
            let sig = pick(sigs)
            let hasMid = rand() < 0.5
            const initial = buildWithOptionalMiddle(sig, hasMid)
            const edits: string[] = []
            for (let i = 0; i < 8; i++) {
                // Randomly toggle the middle element and/or the producer sig.
                if (rand() < 0.6) hasMid = !hasMid
                if (rand() < 0.7) sig = pick(sigs)
                edits.push(buildWithOptionalMiddle(sig, hasMid))
            }
            runChain(seed, initial, edits)
            cases += edits.length + 1
        }
        console.log(`[insert/remove] cases run: ${cases}`)
        expect(cases).toBeGreaterThan(0)
    }, 120_000)
})

// ── Operator-resolution flips on reused operands ──────────────────────────────

/**
 * The producer's signature flip changes which *operator overload* the reused
 * consumer body resolves — e.g. `Int + Int` (i32.add) vs `Float + Float`
 * (f32.add).  Elaboration resolves operators via the strata registry; if a
 * reused element's elaboration captured a stale operator resolution the
 * structure or typeOf would diverge.
 */
function buildOpChain(vSig: string, useExpr: string): string {
    return [
        `${SIG} v (${vSig})`,
        '@fn v a := a;',          // identity-ish producer whose param type drives `use`
        `${SIG} use (${vSig})`,
        `@fn use n := ${useExpr};`,
    ].join('\n')
}

describe('ADV typeflip: operator overload flips on reused consumer', () => {
    test('flip param type so + / * / - re-resolve in the reused body', () => {
        let cases = 0
        const sigs = ['Int', 'Float']
        const exprs = ['n + n', 'n * n', 'n - n', '{ n + n }']
        for (let seed = 1; seed <= 20; seed++) {
            const rand = mulberry32(seed * 15485863)
            const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]
            let sig = pick(sigs)
            let expr = pick(exprs)
            const initial = buildOpChain(sig, expr)
            const edits: string[] = []
            for (let i = 0; i < 8; i++) {
                if (rand() < 0.5) sig = pick(sigs)
                else expr = pick(exprs)
                edits.push(buildOpChain(sig, expr))
            }
            runChain(seed, initial, edits)
            cases += edits.length + 1
        }
        console.log(`[operator] cases run: ${cases}`)
        expect(cases).toBeGreaterThan(0)
    }, 120_000)
})

// ── Newline-shifting edits that move downstream reused elements ───────────────

/**
 * The riskiest case for the symbol surface: an edit that changes the LINE COUNT
 * of an upstream element shifts every downstream element's absolute line/col.
 * Those downstream elements are reused (suffix-shifted by a byte delta), but
 * their `definitionSpan` must report the NEW line — matching a fresh compile —
 * while the upstream signature flip also changes the reused element's types.
 *
 * `front` lines (0..N blank lines + a producer whose body spans 1 or 3 lines)
 * shift the reused consumer; `pSig` flips its type.
 */
function buildShifting(leadBlanks: number, multilineBody: boolean, pSig: string): string {
    const lines: string[] = []
    for (let i = 0; i < leadBlanks; i++) lines.push('')
    lines.push(`${SIG} prod (${pSig})`)
    if (multilineBody) lines.push('@fn prod x, y := {', '  x + y', '};')
    else lines.push('@fn prod x, y := x + y;')
    lines.push(`${SIG} cons (Int)`, '@fn cons z := prod(z, 1);')
    return lines.join('\n')
}

describe('ADV typeflip: newline-shift moves reused element + flips type', () => {
    test('definitionSpan + diagnostics follow the shifted reused element', () => {
        let cases = 0
        const sigs = ['Int, Int', 'Float, Int', 'Float, Float']
        for (let seed = 1; seed <= 25; seed++) {
            const rand = mulberry32(seed * 32452843)
            const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]
            let blanks = Math.floor(rand() * 4)
            let multi = rand() < 0.5
            let sig = pick(sigs)
            const initial = buildShifting(blanks, multi, sig)
            const edits: string[] = []
            for (let i = 0; i < 8; i++) {
                // Each edit perturbs line count (blanks/body) and/or the type.
                if (rand() < 0.6) blanks = Math.floor(rand() * 4)
                if (rand() < 0.5) multi = !multi
                if (rand() < 0.6) sig = pick(sigs)
                edits.push(buildShifting(blanks, multi, sig))
            }
            runChain(seed, initial, edits)
            cases += edits.length + 1
        }
        console.log(`[newline-shift] cases run: ${cases}`)
        expect(cases).toBeGreaterThan(0)
    }, 120_000)
})

// ── Coverage gate: the incremental path must actually fire ────────────────────

describe('ADV typeflip: incremental reuse actually exercised', () => {
    test('a real fraction of edits reused at least one element group', () => {
        // `reuseEdits` / `totalEdits` accumulated by every runChain above.
        console.log(`[coverage] reuseEdits=${reuseEdits} totalEdits=${totalEdits}`)
        expect(totalEdits).toBeGreaterThan(0)
        // If this is ~0 the whole suite degenerated to full recompiles and would
        // not be testing incremental elaboration at all.
        expect(reuseEdits).toBeGreaterThan(Math.floor(totalEdits * 0.2))
    })
})
