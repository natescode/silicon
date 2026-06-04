import type { Connection, TextDocuments, DocumentSymbol } from 'vscode-languageserver/node.js'
import type { TextDocument } from 'vscode-languageserver-textdocument'
import type { Workspace } from '../workspace.ts'
import type { CaaSSymbol } from '@silicon/compiler'
import { spanToRange, symbolKindToLsp } from '../lsp-convert.ts'

export function registerDocumentSymbols(
    connection: Connection,
    _documents: TextDocuments<TextDocument>,
    workspace: Workspace,
): void {
    connection.onDocumentSymbol(({ textDocument }): DocumentSymbol[] => {
        const doc = workspace.getDoc(textDocument.uri)
        if (!doc) return []

        const all = [...doc.model.allSymbols].filter(s => s.definitionSpan)
        const childrenOf = new Map<CaaSSymbol, CaaSSymbol[]>()
        const tops: CaaSSymbol[] = []
        for (const s of all) {
            const parent = s.containingSymbol
            if (parent && parent.definitionSpan) {
                const list = childrenOf.get(parent) ?? []
                list.push(s)
                childrenOf.set(parent, list)
            } else {
                tops.push(s)
            }
        }
        return tops.map(t => toDocumentSymbol(t, childrenOf))
    })
}

function toDocumentSymbol(
    sym: CaaSSymbol,
    childrenOf: Map<CaaSSymbol, CaaSSymbol[]>,
): DocumentSymbol {
    const range = spanToRange(sym.definitionSpan!)
    return {
        name: sym.name,
        detail: sym.displayString,
        kind: symbolKindToLsp(sym.kind),
        range,
        selectionRange: range,
        children: (childrenOf.get(sym) ?? []).map(c => toDocumentSymbol(c, childrenOf)),
    }
}
