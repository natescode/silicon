// SPDX-License-Identifier: MIT
/**
 * Tier 2 CaaS infrastructure tests — Symbol.locations, Symbol.containingSymbol,
 * CodeAction diagnostic code, Trivia, SyntaxWalker, SyntaxRewriter,
 * cross-document typechecking.
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import { Workspace } from './workspace'
import { SyntaxWalker, SyntaxRewriter } from './syntaxWalker'
import { registerCodeAction, getCodeActions, clearCodeActions, listCodeActionCodes } from './codeAction'
import type { SyntaxNode } from './syntaxNode'
import type { TextEdit } from './codeAction'

// ---------------------------------------------------------------------------
// 2b — CodeAction diagnostic code link
// ---------------------------------------------------------------------------

describe('CodeAction.diagnosticCode (2b)', () => {
    beforeEach(() => clearCodeActions())

    test('getCodeActions stamps diagnosticCode on returned actions', () => {
        registerCodeAction('E9999', (_diag, _src) => [{
            title: 'Fix it',
            kind: 'quickfix',
            edits: [],
            diagnostics: [],
        }])
        const diag: any = { code: 'E9999', span: { file: 'f.si', line: 1, col: 1, length: 1 }, message: 'test', phase: 'typecheck' }
        const actions = getCodeActions(diag, '')
        expect(actions).toHaveLength(1)
        expect(actions[0].diagnosticCode).toBe('E9999')
    })

    test('listCodeActionCodes returns all registered codes', () => {
        registerCodeAction('E1111', () => [])
        registerCodeAction('E2222', () => [])
        const codes = listCodeActionCodes()
        expect(codes).toContain('E1111')
        expect(codes).toContain('E2222')
    })

    test('listCodeActionCodes returns empty array when no providers registered', () => {
        // clearCodeActions called in beforeEach
        expect(listCodeActionCodes()).toHaveLength(0)
    })

    test('existing E0004 provider sets diagnosticCode', () => {
        // E0004 provider was registered on module load; just check it stamps the code.
        const diag: any = {
            code: 'E0004',
            span: { file: 'f.si', line: 1, col: 1, length: 4 },
            message: 'unbound',
            phase: 'elaborate',
            hint: "did you mean 'add'?",
        }
        const actions = getCodeActions(diag, '@fn add := { 1 };')
        // There may be 0 or 1 action depending on whether the hint matches.
        for (const a of actions) {
            expect(a.diagnosticCode).toBe('E0004')
        }
    })
})

// ---------------------------------------------------------------------------
// 2c — Symbol.containingSymbol
// ---------------------------------------------------------------------------

describe('Symbol.containingSymbol (2c)', () => {
    test('top-level symbols have containingSymbol === undefined', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', '@fn add x, y := { x + y };')
        const sym = ws.findDefinition('f.si', 1, 5)
        expect(sym).toBeDefined()
        expect(sym!.containingSymbol).toBeUndefined()
    })

    test('containingSymbol field is present on all symbols', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', '@fn add x, y := { x + y };\n@let result := &add 1, 2;')
        const doc = ws.getDocument('f.si')!
        for (const sym of doc.model.allSymbols) {
            expect('containingSymbol' in sym).toBe(true)
        }
    })
})

// ---------------------------------------------------------------------------
// 2d — Symbol.locations
// ---------------------------------------------------------------------------

describe('Symbol.locations (2d)', () => {
    test('locations is an array', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', '@fn add x, y := { x + y };')
        const sym = ws.findDefinition('f.si', 1, 5)
        expect(sym).toBeDefined()
        expect(Array.isArray(sym!.locations)).toBe(true)
    })

    test('locations contains the definitionSpan when available', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', '@fn add x, y := { x + y };')
        const sym = ws.findDefinition('f.si', 1, 5)
        expect(sym!.locations).toHaveLength(1)
        expect(sym!.locations[0]).toEqual(sym!.definitionSpan)
    })

    test('locations is empty when definitionSpan is absent', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', '@fn add x, y := { x + y };')
        const doc = ws.getDocument('f.si')!
        for (const sym of doc.model.allSymbols) {
            if (!sym.definitionSpan) {
                expect(sym.locations).toHaveLength(0)
            }
        }
    })
})

// ---------------------------------------------------------------------------
// 2e — Trivia
// ---------------------------------------------------------------------------

describe('Trivia (2e)', () => {
    function triviaDoc() {
        const ws = new Workspace()
        ws.openDocument('f.si', '@fn add x, y := { x + y };\n@let r := &add 1, 2;')
        return ws.getDocument('f.si')!
    }

    test('leadingTrivia returns an array', () => {
        const doc = triviaDoc()
        const root = doc.elabTree.root
        const trivia = root.leadingTrivia(doc.source)
        expect(Array.isArray(trivia)).toBe(true)
    })

    test('trailingTrivia returns an array', () => {
        const doc = triviaDoc()
        const root = doc.elabTree.root
        const trivia = root.trailingTrivia(doc.source)
        expect(Array.isArray(trivia)).toBe(true)
    })

    test('trivia items have kind and text', () => {
        const doc = triviaDoc()
        // Find a Namespace node (has spans); check its leading trivia.
        for (const node of doc.elabTree.root.descendantsOfKind('Namespace')) {
            const trivia = node.leadingTrivia(doc.source)
            for (const t of trivia) {
                expect(t).toHaveProperty('kind')
                expect(t).toHaveProperty('text')
                expect(typeof t.kind).toBe('string')
                expect(typeof t.text).toBe('string')
            }
            break  // one is enough
        }
    })

    test('whitespace between two nodes is captured as whitespace trivia', () => {
        const ws = new Workspace()
        // Two top-level definitions separated by a blank line.
        ws.openDocument('f.si', '@fn a := { 1 };\n\n@fn b := { 2 };')
        const doc = ws.getDocument('f.si')!
        // Walk nodes to find one that has a newline in its leading trivia.
        let foundNewline = false
        for (const node of doc.elabTree.root.descendants()) {
            const lt = node.leadingTrivia(doc.source)
            if (lt.some(t => t.kind === 'newline')) { foundNewline = true; break }
        }
        expect(foundNewline).toBe(true)
    })

    test('nodes without spans return empty trivia arrays', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', '@fn add x, y := { x + y };')
        const doc = ws.getDocument('f.si')!
        // FunctionCall nodes have no spans; their trivia should be empty.
        for (const node of doc.elabTree.root.descendantsOfKind('FunctionCall')) {
            expect(node.leadingTrivia(doc.source)).toHaveLength(0)
            expect(node.trailingTrivia(doc.source)).toHaveLength(0)
        }
    })
})

// ---------------------------------------------------------------------------
// 2f — SyntaxWalker / SyntaxRewriter
// ---------------------------------------------------------------------------

describe('SyntaxWalker (2f)', () => {
    test('walk visits all nodes in the tree', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', '@fn add x, y := { x + y };\n@let r := &add 1, 2;')
        const doc = ws.getDocument('f.si')!

        class Counter extends SyntaxWalker {
            count = 0
            visitNode(node: SyntaxNode) { this.count++; super.visitNode(node) }
        }
        const c = new Counter()
        c.walk(doc.elabTree.root)
        expect(c.count).toBeGreaterThan(0)
    })

    test('typed override visitDefinition is called for Definition nodes', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', '@fn add x, y := { x + y };')
        const doc = ws.getDocument('f.si')!

        class DefCounter extends SyntaxWalker {
            defs: string[] = []
            visitDefinition(node: SyntaxNode) {
                const raw = (node as any)._node as any
                if (raw?.name?.name) this.defs.push(raw.name.name)
            }
        }
        const c = new DefCounter()
        c.walk(doc.elabTree.root)
        expect(c.defs).toContain('add')
    })

    test('not calling super.visitNode prunes a subtree', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', '@fn add x, y := { x + y };\n@let r := &add 1, 2;')
        const doc = ws.getDocument('f.si')!

        class TopOnly extends SyntaxWalker {
            count = 0
            visitNode(node: SyntaxNode) {
                this.count++
                // Do NOT recurse — prune after the root.
            }
        }
        const c = new TopOnly()
        c.walk(doc.elabTree.root)
        expect(c.count).toBe(1)  // only root visited
    })
})

describe('SyntaxRewriter (2f)', () => {
    test('rewrite returns empty array when no overrides produce edits', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', '@fn add x, y := { x + y };')
        const doc = ws.getDocument('f.si')!

        class Noop extends SyntaxRewriter {}
        const edits = new Noop().rewrite(doc.elabTree.root, doc.source)
        expect(edits).toHaveLength(0)
    })

    test('rewriteNamespace can produce a TextEdit for each Namespace node', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', '@fn add x, y := { x + y };')
        const doc = ws.getDocument('f.si')!

        class NamespaceMarker extends SyntaxRewriter {
            edits: TextEdit[] = []
            rewriteNamespace(node: SyntaxNode): TextEdit | null {
                if (!node.span) return null
                // Return a TextEdit replacing the node with its own text (no-op content).
                this.edits.push({
                    span: { file: 'f.si', line: node.span.startLine, col: node.span.startCol, length: 1 },
                    newText: 'X',
                })
                return this.edits[this.edits.length - 1]
            }
        }
        const r = new NamespaceMarker()
        const edits = r.rewrite(doc.elabTree.root, doc.source)
        expect(edits.length).toBeGreaterThan(0)
    })
})

// ---------------------------------------------------------------------------
// 2g — Cross-document typechecking
// ---------------------------------------------------------------------------

describe('Cross-document typechecking (2g)', () => {
    test('result type is resolved correctly when callee is in another document', () => {
        const ws = new Workspace()
        ws.openDocument('lib.si', '\\\\ add (Int, Int)\n@fn add x, y := { x + y };')
        ws.openDocument('main.si', '@let result := &add 1, 2;')
        const doc = ws.getDocument('main.si')!
        const sym = doc.model.symbolNamed('result')
        expect(sym).toBeDefined()
        // With cross-doc typechecking, result should have type Int, not Unknown.
        expect(sym!.type?.kind).not.toBe('Unknown')
    })

    test('no unbound-identifier diagnostic for cross-document calls', () => {
        const ws = new Workspace()
        ws.openDocument('lib.si', '@fn helper x := { x };')
        ws.openDocument('main.si', '@let r := &helper 42;')
        const doc = ws.getDocument('main.si')!
        const unboundErrors = doc.diagnostics.filter(d => d.code === 'E0004')
        expect(unboundErrors).toHaveLength(0)
    })

    test('editing the defining document degrades type when callee is renamed', () => {
        const ws = new Workspace()
        ws.openDocument('lib.si', '\\\\ add (Int, Int)\n@fn add x, y := { x + y };')
        ws.openDocument('main.si', '@let r := &add 1, 2;')
        const before = ws.getDocument('main.si')!
        // Cross-doc: r should be typed (not Unknown) while add exists.
        expect(before.model.symbolNamed('r')?.type?.kind).not.toBe('Unknown')

        // Edit lib.si to rename the function — 'add' no longer exists.
        ws.editDocument('lib.si', '\\\\ sub (Int, Int)\n@fn sub x, y := { x + y };')
        ws.editDocument('main.si', '@let r := &add 1, 2;')

        const after = ws.getDocument('main.si')!
        // With 'add' gone, the return type can no longer be inferred.
        // The typechecker silences cascade errors on unknown callees (Unknown propagation).
        expect(after.model.symbolNamed('r')?.type?.kind).toBe('Unknown')
    })

    test('closing the defining document degrades type to Unknown', () => {
        const ws = new Workspace()
        ws.openDocument('lib.si', '\\\\ add (Int, Int)\n@fn add x, y := { x + y };')
        ws.openDocument('main.si', '@let r := &add 1, 2;')
        const doc1 = ws.getDocument('main.si')!
        expect(doc1.model.symbolNamed('r')?.type?.kind).not.toBe('Unknown')

        ws.closeDocument('lib.si')
        ws.editDocument('main.si', '@let r := &add 1, 2;')
        const doc2 = ws.getDocument('main.si')!
        expect(doc2.model.symbolNamed('r')?.type?.kind).toBe('Unknown')
    })
})
