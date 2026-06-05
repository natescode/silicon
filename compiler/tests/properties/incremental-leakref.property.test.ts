// SPDX-License-Identifier: MIT
/**
 * Incremental type-check (E2) property: the fresh-var LEAK hazard crossed with
 * reference reordering — the riskiest interaction for prefix-replay soundness.
 *
 * A bare `&None` body leaks an order-dependent `Option[?Tn]` into `model.typeOf`,
 * where `n` is a function of how many fresh vars the *prefix* consumed.  The
 * engine replays each reused group's `freshConsumed` count, so a leaking suffix
 * element must land on the identical `?Tn` it would get from a full check.  At
 * the same time, references to shared names must stay in source order (reference
 * spans / symbol-at-position).  This fuzzes random programs through random edit
 * chains and asserts the incremental Workspace stays byte-identical to a fresh
 * full compile across diagnostics, symbols, per-node types, reference spans, and
 * symbol-at-position — with reuse actually firing.
 */
import { test, expect } from 'bun:test'
import { Workspace } from '../../src/caas/workspace'
import { astChildren } from '../../src/ast/astChildren'
import type { SemanticModel } from '../../src/ast/semanticModel'

function mulberry32(seed: number): () => number {
    let a = seed >>> 0
    return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
function spanKey(s: any): string { return `${s.file}:${s.line}:${s.col}+${s.length}` }
function diagDigest(doc: any): string {
    return doc.diagnostics.map((d: any) => `${d.code}@${d.span.line}:${d.span.col}+${d.span.length}:${d.message}`).sort().join('\n')
}
function symDigest(m: SemanticModel): string {
    return [...m.allSymbols].map(s => `${s.name}|${s.kind}|${s.displayString}|${s.definitionSpan?.line ?? '-'}:${s.definitionSpan?.col ?? '-'}|${s.isImplicitlyDeclared}`).sort().join('\n')
}
function typeDigest(m: SemanticModel, program: any): string {
    const out: string[] = []
    const walk = (n: any): void => { if (n === null || typeof n !== 'object') return; const t = m.typeOf(n); out.push(t ? JSON.stringify(t) : '-'); for (const c of astChildren(n)) walk(c) }
    walk(program); return out.join(',')
}
function refSpanDigest(m: SemanticModel): string {
    const names = new Set<string>(); for (const s of m.allSymbols) names.add(s.name)
    const lines: string[] = []
    for (const name of [...names].sort()) { const sym = m.symbolNamed(name); if (!sym) continue; lines.push(`${name} -> [${m.referenceSpans(sym).map(spanKey).join(' ')}] (n=${m.referencesTo(sym).length})`) }
    return lines.join('\n')
}
function satpDigest(m: SemanticModel, source: string): string {
    const lines = source.split('\n'); const out: string[] = []
    for (let li = 0; li < lines.length; li++) for (let ci = 0; ci < lines[li].length; ci++) { const sym = m.symbolAtPosition(li + 1, ci + 1); if (sym) out.push(`${li + 1}:${ci + 1}=${sym.name}`) }
    return out.join('\n')
}
function assertEquiv(label: string, inc: any, fresh: any, r: any): string | null {
    const ctx = `[${label}] reuse=${r?.reused}/${r?.total}`
    const checks: Array<[string, string, string]> = [
        ['DIAG', diagDigest(inc), diagDigest(fresh)],
        ['SYM', symDigest(inc.model), symDigest(fresh.model)],
        ['TYPE', typeDigest(inc.model, inc.elabTree.program), typeDigest(fresh.model, fresh.elabTree.program)],
        ['REFSPAN', refSpanDigest(inc.model), refSpanDigest(fresh.model)],
        ['SATP', satpDigest(inc.model, inc.source), satpDigest(fresh.model, fresh.source)],
    ]
    for (const [tag, x, y] of checks) if (x !== y) return `${ctx} ${tag}\nINC:\n${x}\nFRESH:\n${y}`
    return null
}

// Each let body is one of: a call chain (refs f/g/q), a bare &None (LEAK), or
// &Some <chain> (resolves, no leak). Order of &None bodies determines ?Tn.
type Body = { t: 'call'; calls: string[] } | { t: 'none' } | { t: 'some'; calls: string[] }
function bodyStr(b: Body): string {
    if (b.t === 'none') return '&None'
    if (b.t === 'some') return `&Some ${chainStr(b.calls)}`
    return chainStr(b.calls)
}
function chainStr(calls: string[]): string {
    if (calls.length === 0) return '1'
    let s = '1'
    for (let i = calls.length - 1; i >= 0; i--) s = i === calls.length - 1 ? `&${calls[i]} ${s}` : `&${calls[i]} (${s})`
    return s
}
type Elem = { kind: 'fn'; name: string } | { kind: 'let'; name: string; body: Body }
function elemStr(e: Elem): string {
    if (e.kind === 'fn') return `@fn ${e.name} x := { x + 1 };`
    return `@global ${e.name} := ${bodyStr(e.body)};`
}
const progStr = (p: Elem[]) => p.map(elemStr).join('\n')

const FNS = ['f', 'g']
const UNB = ['q']
const LETS = ['a', 'b', 'c', 'd', 'e', 'm', 'n']
function callable(p: Elem[]): string[] { return [...p.filter(e => e.kind === 'fn').map(e => (e as any).name), ...UNB] }

function randBody(rnd: () => number, cal: string[]): Body {
    const k = rnd()
    if (k < 0.35) return { t: 'none' }   // leak
    if (k < 0.55) { const calls: string[] = []; const d = 1 + Math.floor(rnd() * 2); for (let i = 0; i < d; i++) calls.push(cal[Math.floor(rnd() * cal.length)]); return { t: 'some', calls } }
    const calls: string[] = []; const d = 1 + Math.floor(rnd() * 3); for (let i = 0; i < d; i++) calls.push(cal[Math.floor(rnd() * cal.length)]); return { t: 'call', calls }
}
function genProgram(rnd: () => number): Elem[] {
    const els: Elem[] = []
    const nFns = 1 + Math.floor(rnd() * FNS.length)
    for (let i = 0; i < nFns; i++) els.push({ kind: 'fn', name: FNS[i] })
    const nLets = 3 + Math.floor(rnd() * 4)
    const cal = [...FNS.slice(0, nFns), ...UNB]
    for (let i = 0; i < nLets && i < LETS.length; i++) els.push({ kind: 'let', name: LETS[i], body: randBody(rnd, cal) })
    return els
}
function mutate(p: Elem[], rnd: () => number): Elem[] {
    const q = p.map(e => e.kind === 'let' ? { ...e, body: structuredClone(e.body) } : { ...e }) as Elem[]
    const lets = q.map((e, i) => [e, i] as const).filter(([e]) => e.kind === 'let')
    if (!lets.length) return q
    const cal = callable(q)
    const [, li] = lets[Math.floor(rnd() * lets.length)]
    const tgt = q[li] as Extract<Elem, { kind: 'let' }>
    const c = Math.floor(rnd() * 7)
    switch (c) {
        case 0: tgt.body = randBody(rnd, cal); break                  // change body (may add/remove a leak)
        case 1: if (tgt.body.t !== 'none') (tgt.body as any).calls.push(cal[Math.floor(rnd() * cal.length)]); break
        case 2: if (tgt.body.t !== 'none' && (tgt.body as any).calls.length) (tgt.body as any).calls.pop(); break
        case 3: { // insert let
            const used = new Set(q.filter(e => e.kind === 'let').map(e => (e as any).name))
            const free = LETS.find(n => !used.has(n))
            if (free) q.splice(1 + Math.floor(rnd() * q.length), 0, { kind: 'let', name: free, body: randBody(rnd, cal) })
            break
        }
        case 4: if (lets.length > 1) q.splice(li, 1); break           // delete
        case 5: { // swap adjacent lets
            const idxs = q.map((e, i) => [e, i] as const).filter(([e]) => e.kind === 'let').map(([, i]) => i)
            if (idxs.length >= 2) { const j = Math.floor(rnd() * (idxs.length - 1));[q[idxs[j]], q[idxs[j + 1]]] = [q[idxs[j + 1]], q[idxs[j]]] }
            break
        }
        case 6: { // rename
            const used = new Set(q.filter(e => e.kind === 'let').map(e => (e as any).name))
            const free = LETS.find(n => !used.has(n)); if (free) tgt.name = free; break
        }
    }
    return q
}

test('leak+ref fuzz: order-dependent ?Tn and reference order stay equivalent under prefix replay', () => {
    const SEEDS = Number(process.env.LR_SEEDS ?? 200)
    const EDITS = Number(process.env.LR_EDITS ?? 12)
    let total = 0, reuse = 0, firstFail: string | null = null
    for (let s = 0; s < SEEDS && !firstFail; s++) {
        const rnd = mulberry32(0xC0FFEE ^ (s * 40503))
        let prog = genProgram(rnd)
        const uri = `lr${s}.si`
        const ws = new Workspace()
        let src = progStr(prog)
        ws.openDocument(uri, src)
        for (let e = 0; e < EDITS && !firstFail; e++) {
            const next = mutate(prog, rnd); const ns = progStr(next)
            if (ns === src) { prog = next; continue }
            prog = next; src = ns
            const doc = ws.editDocument(uri, ns)
            const r = ws._lastTypecheckReuse; total++
            if (r && r.reused > 0) reuse++
            const fresh = new Workspace().openDocument(uri, ns)
            const f = assertEquiv(`s${s}/e${e}`, doc, fresh, r)
            if (f) firstFail = f + `\nSOURCE:\n${ns}`
        }
    }
    expect(firstFail).toBeNull()
    expect(total).toBeGreaterThan(0)
    expect(reuse).toBeGreaterThan(0)   // the engine must actually replay prefixes
}, 600000)
