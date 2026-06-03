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

const BASE = '\\\\ add (Int, Int)\n@fn add x, y := { x + y };\n@let r := &add 1, 2;'

const EDITS: Array<{ label: string; steps: string[] }> = [
    { label: 'intra-line literal edit', steps: [BASE.replace('1, 2', '10, 20')] },
    { label: 'append an element',       steps: [BASE + '\n@let s := &add 3, 4;'] },
    { label: 'rename a binding',        steps: [BASE.replace('@let r', '@let rr')] },
    { label: 'insert a blank line',     steps: [BASE.replace('@fn add', '\n@fn add')] },
    { label: 'introduce a type error',  steps: [BASE.replace('&add 1, 2', "&add 1, 'x'")] },
    { label: 'add then remove a fn',    steps: [BASE + '\n@fn extra := { 1 };', BASE] },
    { label: 'shrink to one element',   steps: ['@let only := 1;'] },
    { label: 'add a @type + constructor use',
      steps: ['@type Shape := $Circle r Int | $Rectangle w Int, h Int;\n@let c := &Circle 5;'] },
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
    }
})
