// SPDX-License-Identifier: MIT
/**
 * Incremental type-checking (E2) — reuse-firing + equivalence.
 *
 * The equivalence property (incremental compile ≡ fresh) is covered exhaustively
 * by incremental-compile.test.ts and the property/adversarial suites.  THIS file
 * guards the thing equivalence alone can't catch: that the prefix-reuse engine
 * actually *fires* (replays unchanged elements instead of silently re-checking
 * everything).  Without these, the engine could regress to full-capture and the
 * equivalence tests would still pass — shipping dead code.
 */
import { describe, test, expect } from 'bun:test'
import { Workspace, type Document } from './workspace'
import { astChildren } from '../ast/astChildren'

function symKey(doc: Document): string[] {
    return [...doc.model.allSymbols]
        .map(s => `${s.name}|${s.kind}|${s.displayString}|${s.definitionSpan?.line ?? '-'}:${s.definitionSpan?.col ?? '-'}|${s.isImplicitlyDeclared}`)
        .sort()
}
function diagKey(doc: Document): string[] {
    return doc.diagnostics.map(d => `${d.code}@${d.span.line}:${d.span.col}+${d.span.length}:${d.message}`).sort()
}
/** Authoritative per-node types in structural order (the strongest surface). */
function typeKey(doc: Document): string {
    const out: string[] = []
    const walk = (n: any): void => {
        if (n === null || typeof n !== 'object') return
        const t = doc.model.typeOf(n)
        out.push(t ? JSON.stringify(t) : '-')
        for (const c of astChildren(n)) walk(c)
    }
    walk(doc.elabTree.program)
    return out.join(',')
}
function fresh(source: string): Document { return new Workspace().openDocument('m.si', source) }

// Ten annotated functions, then a final binding that calls the last one. Editing
// the final binding's literal leaves the first ten elements a verbatim prefix.
const TEN = Array.from({ length: 10 }, (_, i) =>
    `\\\\ f${i} (Int)\n@fn f${i} x := { x + ${i} };`).join('\n')
const DOC = `${TEN}\nr := f9(100);`

describe('E2 incremental type-check actually reuses the prefix', () => {
    test('editing the last element replays the unchanged prefix (reused > 0)', () => {
        const ws = new Workspace()
        ws.openDocument('m.si', DOC)
        const total = ws._lastTypecheckReuse!.total
        expect(ws._lastTypecheckReuse).toEqual({ reused: 0, total })   // first open = full capture

        const edited = DOC.replace('f9(100)', 'f9(12345)')
        const doc = ws.editDocument('m.si', edited)
        // The 11 prior elements minus the edited one (and its window) are replayed.
        expect(ws._lastTypecheckReuse!.reused).toBeGreaterThanOrEqual(total - 1)
        expect(ws._lastTypecheckReuse!.total).toBe(total)

        // …and the result is byte-identical to a fresh full compile.
        const full = fresh(edited)
        expect(symKey(doc)).toEqual(symKey(full))
        expect(diagKey(doc)).toEqual(diagKey(full))
        expect(typeKey(doc)).toBe(typeKey(full))
    })

    test('an edit near the top reuses little or nothing but stays correct', () => {
        const ws = new Workspace()
        ws.openDocument('m.si', DOC)
        const edited = DOC.replace('x + 0', 'x + 999')   // edits f0 (first element)
        const doc = ws.editDocument('m.si', edited)
        // First element changed → prefix is empty (re-check from index 0).
        expect(ws._lastTypecheckReuse!.reused).toBe(0)
        const full = fresh(edited)
        expect(typeKey(doc)).toBe(typeKey(full))
        expect(symKey(doc)).toEqual(symKey(full))
    })

    test('a fresh-var-leaking suffix is renumbered correctly after a prefix replay', () => {
        // `None()` with no pinning annotation leaks an order-dependent ?Tn into the
        // typeMap. A prefix replay must advance the shared counter so the suffix's
        // ?Tn matches a full check exactly.
        const base = `${TEN}\na := None();\nb := None();`
        const ws = new Workspace()
        ws.openDocument('m.si', base)
        const edited = base.replace('x + 5', 'x + 55')   // edit a middle annotated fn
        const doc = ws.editDocument('m.si', edited)
        expect(typeKey(doc)).toBe(typeKey(fresh(edited)))
    })

    test('a prefix element that forward-references a renamed suffix def is NOT stale-reused', () => {
        // element 0 (`r`) forward-references `gg`, defined in element 1.
        // Renaming gg→hh changes a DECLARATION, so a fresh check makes element 0's
        // `gg()` unbound. The prefix must NOT be replayed (its result depends on the
        // changed declaration) — the preRegSig gate forces a full re-check.
        const base = `r := gg(1);
\\\\ gg (Int)
@fn gg x := {
    x
};`
        const ws = new Workspace()
        ws.openDocument('m.si', base)
        const edited = base.replace(/gg/g, 'hh')   // rename the def (and its sig line)
        const doc = ws.editDocument('m.si', edited)
        expect(ws._lastTypecheckReuse!.reused).toBe(0)   // gate engaged: declaration changed
        const full = fresh(edited)
        expect(diagKey(doc)).toEqual(diagKey(full))      // `gg()` now unbound, identically
        expect(symKey(doc)).toEqual(symKey(full))
        expect(typeKey(doc)).toBe(typeKey(full))
    })

    test('changing a forward-referenced annotation stays equivalent (gate falls back)', () => {
        const base = `r := add(1, 2);
\\\\ add (Int, Int)
@fn add x, y := {
    x + y
};`
        const ws = new Workspace()
        ws.openDocument('m.si', base)
        const edited = base.replace('(Int, Int)', '(Float, Float)').replace('x + y', 'toFloat(x)')
        const doc = ws.editDocument('m.si', edited)
        const full = fresh(edited)
        expect(diagKey(doc)).toEqual(diagKey(full))
        expect(typeKey(doc)).toBe(typeKey(full))
    })

    test('repeated edits to the tail keep reusing and stay equivalent', () => {
        const ws = new Workspace()
        ws.openDocument('m.si', DOC)
        let cur = DOC
        for (let i = 0; i < 5; i++) {
            cur = cur.replace(/f9\(\d+\)/, `f9(${1000 + i})`)
            const doc = ws.editDocument('m.si', cur)
            expect(ws._lastTypecheckReuse!.reused).toBeGreaterThan(0)
            expect(typeKey(doc)).toBe(typeKey(fresh(cur)))
        }
    })
})
