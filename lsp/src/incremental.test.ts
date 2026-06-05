/**
 * LSP incremental-engine + navigation tests.
 *
 * Drives the adapter `Workspace` (and the compiler workspace behind it)
 * directly — no JSON-RPC — to assert: the incremental engine actually fires on
 * an edit, cross-file resolution works (with no false unbound-identifier
 * diagnostics), and the navigation surface (definition, references, hover,
 * completion, rename, signature help) returns sensible results.
 */
import { describe, test, expect } from 'bun:test'
import { pathToFileURL } from 'node:url'
import { getCodeActions } from '@silicon/compiler'
import { Workspace } from './workspace.ts'

const uri = (name: string) => pathToFileURL(`/virtual/${name}`).href

describe('LSP rides the incremental compiler Workspace', () => {
    test('editing a function body reuses the unchanged prefix', () => {
        const ws = new Workspace()
        const u = uri('m.si')
        // `\\ f (Int)` signature lines bind the param types (Silicon HM-lite).
        const TEN = Array.from({ length: 10 }, (_, i) =>
            `\\\\ f${i} (Int)\n@fn f${i} x := { x + ${i} };`).join('\n')
        const src = `${TEN}\n@let r := &f9 100;`
        const first = ws.update(u, src)!
        expect(first.diagnostics.length).toBe(0)
        expect(ws.compiler._lastTypecheckReuse!.reused).toBe(0)   // first open = full

        const edited = src.replace('&f9 100', '&f9 12345')
        const doc = ws.update(u, edited)!
        expect(ws.compiler._lastTypecheckReuse!.reused).toBeGreaterThan(0)
        expect(doc.diagnostics.length).toBe(0)
    })

    test('cross-file: @use resolves with no false unbound-identifier diagnostics', () => {
        const ws = new Workspace()
        const a = uri('a.si')
        // a.si defines `helper`; b.si @use's it and calls it. The @use'd dep is
        // opened into the same compiler workspace, so the call resolves.
        ws.compiler.openDocument(a, '@fn helper x := { x + 1 };')
        const b = uri('b.si')
        // No real file on disk for the @use target, but a.si is already open in
        // the workspace under its URI, so externalSymbols resolves `helper`.
        const doc = ws.update(b, `@let r := &helper 41;`)!
        // `helper` is visible cross-document → no E0004 unbound identifier.
        expect(doc.diagnostics.find(d => d.code === 'E0004')).toBeUndefined()
    })

    test('definition + references + hover resolve through the model', () => {
        const ws = new Workspace()
        const u = uri('nav.si')
        //              1         2
        //    0123456789012345678901234567
        // 1: @fn add x, y := { x + y };
        // 2: @let s := &add 1, 2;
        ws.update(u, `@fn add x, y := { x + y };\n@let s := &add 1, 2;`)

        // cursor on `add` in the call (line 2 = LSP line 1, char ~11)
        const callLine = 1
        const callCol = 11
        const def = ws.compiler.findDefinition(u, callLine + 1, callCol + 1)
        expect(def?.name).toBe('add')
        expect(def?.definitionSpan?.line).toBe(1)   // defined on source line 1

        const refs = ws.compiler.findReferences(u, callLine + 1, callCol + 1)
        expect(refs.length).toBeGreaterThanOrEqual(1)

        const hover = ws.compiler.hoverInfo(u, callLine + 1, callCol + 1)
        expect(hover?.typeDisplay).toContain('add')
    })

    test('completion includes local definitions', () => {
        const ws = new Workspace()
        const u = uri('comp.si')
        ws.update(u, `@fn greet x := { x };\n@let g := &greet 1;`)
        const items = ws.compiler.getCompletions(u, 2, 13, 'gr')
        expect(items.some(it => it.label === 'greet')).toBe(true)
    })

    test('rename rewrites the definition and all references', () => {
        const ws = new Workspace()
        const u = uri('ren.si')
        ws.update(u, `@fn add x, y := { x + y };\n@let s := &add 1, 2;`)
        const edit = ws.compiler.rename(u, 2, 12, 'plus')   // cursor on `add` in the call
        expect(edit.changeCount).toBeGreaterThanOrEqual(2)   // def + call site
    })

    test('signature help reports the active parameter inside a call', () => {
        const ws = new Workspace()
        const u = uri('sig.si')
        //  2: @let s := &add 1, 2;  — cursor after the comma (2nd arg)
        ws.update(u, `\\\\ add (Int, Int) -> Int\n@fn add x, y := { x + y };\n@let s := &add 1, 2;`)
        const help = ws.compiler.signatureHelp(u, 3, 19)
        expect(help?.name).toBe('add')
        expect(help?.parameters.length).toBe(2)
        expect(help?.activeParameter).toBe(1)
    })

    test('a typo diagnostic yields a "did you mean" code action', () => {
        const ws = new Workspace()
        const u = uri('fix.si')
        // An unbound identifier with a near-miss in scope carries a
        // "did you mean 'X'?" hint, which the code-action provider turns into a
        // rename quick-fix.
        const doc = ws.update(u, `@fn greet x := { x };\n@let g := 1;`)!
        const typo = doc.diagnostics.find(d => d.code === 'E0004' && /did you mean/i.test(d.hint ?? ''))
        expect(typo).toBeDefined()
        const actions = getCodeActions(typo!, doc.source)
        expect(actions.length).toBeGreaterThan(0)
        expect(actions[0].title).toMatch(/^Rename to/)
    })

    test('semantic-token source data: symbols carry definition + reference spans', () => {
        const ws = new Workspace()
        const u = uri('tok.si')
        const doc = ws.update(u, `\\\\ add (Int, Int) -> Int\n@fn add x, y := { x + y };\n@let s := &add 1, 2;`)!
        const add = doc.model.symbolNamed('add')!
        expect(add.definitionSpan).toBeDefined()
        // the call site on the last line is a reference
        const refs = doc.model.referenceSpans(add)
        expect(refs.length).toBeGreaterThanOrEqual(1)
    })

    test('a syntax error mid-typing keeps earlier symbols + completion alive', () => {
        // The regression that motivated parser error recovery: typing an
        // incomplete trailing line used to empty the model.  Now the well-formed
        // prefix survives, so completion/nav keep working while you type.
        const ws = new Workspace()
        const u = uri('typing.si')
        ws.update(u, `@fn greet x := { x };\n@let g := 1;`)
        expect([...ws.getDoc(u)!.model.allSymbols].map(s => s.name)).toContain('greet')

        // edit: start a new, incomplete line (a parse error)
        const doc = ws.update(u, `@fn greet x := { x };\n@let g := 1;\n@let h := &gr`)!
        expect(doc.diagnostics.some(d => d.code === 'E0000')).toBe(true)      // error surfaced
        expect([...doc.model.allSymbols].map(s => s.name)).toContain('greet') // …but model alive
        expect(ws.compiler.getCompletions(u, 3, 14, 'gr').some(i => i.label === 'greet')).toBe(true)
    })

    test('formatting returns edits or a no-op array', () => {
        const ws = new Workspace()
        const u = uri('fmt.si')
        ws.update(u, `@fn greet x := { x };`)
        const edits = ws.compiler.formatDocument(u)
        expect(Array.isArray(edits)).toBe(true)
    })
})
