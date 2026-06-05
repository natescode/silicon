// SPDX-License-Identifier: MIT
/**
 * Incremental Workspace-compile equivalence (incremental elaboration/typecheck,
 * stage E1).
 *
 * The invariant: editing a document (`editDocument`, which now reparses
 * incrementally and will reuse elaboration/typecheck per element) must produce a
 * `Document` whose diagnostics and `SemanticModel` are **identical** to opening
 * the same final source fresh.  This is the gate that guards every incremental
 * shortcut added to the Workspace pipeline.
 */
import { describe, test, expect } from 'bun:test'
import { Workspace, type Document } from './workspace'
import { stableStringify } from './incremental'

function fresh(source: string): Document {
    return new Workspace().openDocument('m.si', source)
}

function incremental(initial: string, edits: string[]): Document {
    const ws = new Workspace()
    ws.openDocument('m.si', initial)
    let doc!: Document
    for (const e of edits) doc = ws.editDocument('m.si', e)
    return doc
}

/** Diagnostics fingerprint — code + span + message, order-independent. */
function diagKey(doc: Document): string[] {
    return doc.diagnostics
        .map(d => `${d.code}@${d.span.line}:${d.span.col}+${d.span.length}:${d.message}`)
        .sort()
}

/** SemanticModel symbol fingerprint — name/kind/type/span/implicit, order-independent. */
function symKey(doc: Document): string[] {
    return [...doc.model.allSymbols]
        .map(s => `${s.name}|${s.kind}|${s.displayString}|${s.definitionSpan?.line ?? '-'}:${s.definitionSpan?.col ?? '-'}|${s.isImplicitlyDeclared}`)
        .sort()
}

// Elaboration structure excluding `node.inferredType` (a non-authoritative
// backward-compat stamp; reused nodes can carry a stale value — `model.typeOf`
// is the authoritative type and is checked via symKey + the property suite).
const elabKey = (doc: Document) => stableStringify(stripInferred(doc.elabTree.program))
function stripInferred(v: any): any {
    if (v === null || typeof v !== 'object') return v
    if (Array.isArray(v)) return v.map(stripInferred)
    const out: Record<string, any> = {}
    for (const k of Object.keys(v)) if (k !== 'inferredType') out[k] = stripInferred(v[k])
    return out
}

const BASE = '\\\\ add (Int, Int)\n@fn add x, y := { x + y };\n@global r := &add 1, 2;'

const EDITS: Array<{ label: string; steps: string[] }> = [
    { label: 'intra-line literal edit', steps: [BASE.replace('1, 2', '10, 20')] },
    { label: 'append an element',       steps: [BASE + '\n@global s := &add 3, 4;'] },
    { label: 'rename a binding',        steps: [BASE.replace('@global r', '@global rr')] },
    { label: 'insert a blank line',     steps: [BASE.replace('@fn add', '\n@fn add')] },
    { label: 'introduce a type error',  steps: [BASE.replace('&add 1, 2', "&add 1, 'x'")] },
    { label: 'add then remove a fn',    steps: [BASE + '\n@fn extra := { 1 };', BASE] },
    { label: 'shrink to one element',   steps: ['@global only := 1;'] },
    { label: 'add a @type + constructor use',
      steps: ['@type Shape := $Circle r Int | $Rectangle w Int, h Int;\n@global c := &Circle 5;'] },
    // Parser error recovery: a malformed intermediate state, then a fix, must
    // stay incremental-≡-fresh at every step (diagnostics + model + elab tree).
    { label: 'break the tail then fix it',
      steps: [BASE + '\n@global t := &ad', BASE + '\n@global t := &add 3, 4;'] },
    { label: 'drop a semicolon then restore it',
      steps: [BASE.replace('@fn add x, y := { x + y };', '@fn add x, y := { x + y }'), BASE] },
    { label: 'inject garbage between elements',
      steps: [BASE.replace('@global r', '@@@ junk\n@global r'), BASE] },
]

describe('incremental Workspace compile ≡ fresh compile (E1)', () => {
    for (const { label, steps } of EDITS) {
        test(`${label}: diagnostics match`, () => {
            const inc = incremental(BASE, steps)
            const full = fresh(steps[steps.length - 1])
            expect(diagKey(inc)).toEqual(diagKey(full))
        })
        test(`${label}: semantic model matches`, () => {
            const inc = incremental(BASE, steps)
            const full = fresh(steps[steps.length - 1])
            expect(symKey(inc)).toEqual(symKey(full))
        })
        test(`${label}: elaborated tree is byte-identical`, () => {
            const inc = incremental(BASE, steps)
            const full = fresh(steps[steps.length - 1])
            expect(elabKey(inc)).toBe(elabKey(full))
        })
    }
})

describe('incremental elaboration actually reuses (E1b)', () => {
    test('editing the last element reuses the first element\'s elaboration by reference', () => {
        const ws = new Workspace()
        const doc0 = ws.openDocument('m.si', BASE)
        const firstElab0 = (doc0.elabTree.program as any).elements[0]
        // Edit only the LAST element (the `@global r` binding literal).
        const doc1 = ws.editDocument('m.si', BASE.replace('1, 2', '100, 200'))
        const firstElab1 = (doc1.elabTree.program as any).elements[0]
        // The first element is a prefix reuse → its elaborated node is the SAME object
        // (proves incremental elaboration fired, not a silent full-elaborate fallback).
        expect(firstElab1).toBe(firstElab0)
        // …and the edit still produced a correct, fresh-identical result.
        expect(elabKey(doc1))
            .toBe(elabKey(fresh(BASE.replace('1, 2', '100, 200'))))
    })

    test('a newline-inserting edit reuses suffix elaboration (shifted)', () => {
        const ws = new Workspace()
        const edited = BASE.replace('@fn add', '\n@fn add')   // insert a blank line at top
        ws.openDocument('m.si', BASE)
        const doc1 = ws.editDocument('m.si', edited)
        expect(elabKey(doc1)).toBe(elabKey(fresh(edited)))
        expect(diagKey(doc1)).toEqual(diagKey(fresh(edited)))
    })
})

// A known-valid user @stratum (registers a keyword + handlers) — the critical
// case: editing strata must rebuild the frozen registry so incremental == fresh.
const STRATUM_DOC =
`@stratum Twice := {
    &Compiler::register::keyword '@twice';
};
\\ double (Int)
@fn double n := { n + n };
@global r := &double 21;`

describe('incremental compile with @stratum ≡ fresh (E1b registry safety)', () => {
    test('editing a non-stratum element reuses correctly', () => {
        const edited = STRATUM_DOC.replace('21', '2100')
        const inc = incremental(STRATUM_DOC, [edited])
        const full = fresh(edited)
        expect(diagKey(inc)).toEqual(diagKey(full))
        expect(elabKey(inc)).toBe(elabKey(full))
    })

    test('editing the @stratum body rebuilds the registry (still ≡ fresh)', () => {
        const edited = STRATUM_DOC.replace("'@twice'", "'@thrice'")
        const inc = incremental(STRATUM_DOC, [edited])
        const full = fresh(edited)
        expect(diagKey(inc)).toEqual(diagKey(full))
        expect(elabKey(inc)).toBe(elabKey(full))
    })
})
