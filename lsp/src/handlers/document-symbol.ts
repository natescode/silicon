import type { Connection, TextDocuments } from 'vscode-languageserver/node.js'
import { SymbolKind as LspKind } from 'vscode-languageserver/node.js'
import type { TextDocument } from 'vscode-languageserver-textdocument'
import type { Workspace } from '../workspace.ts'
import type { SymbolEntry, SymbolKind } from '../symbol-index.ts'

const KIND_MAP: Record<SymbolKind, LspKind> = {
    fn:      LspKind.Function,
    let:     LspKind.Constant,
    var:     LspKind.Variable,
    extern:  LspKind.Function,
    type:    LspKind.Class,
    stratum: LspKind.Operator,
    local:   LspKind.Variable,
    param:   LspKind.Variable,
    use:     LspKind.Module,
}

export function registerDocumentSymbols(
    connection: Connection,
    _documents: TextDocuments<TextDocument>,
    workspace: Workspace,
): void {
    connection.onDocumentSymbol(({ textDocument }) => {
        const analysis = workspace.get(textDocument.uri)
        if (!analysis) return []

        // Build a flat list of top-level symbols, each with its enclosed
        // locals/params nested as children.  VS Code's Outline pane
        // renders this hierarchically.
        const tops = analysis.symbols.filter(s => !s.container)
        return tops.map(top => toLspSymbol(top, childrenOf(top.name, analysis.symbols)))
    })
}

function childrenOf(parent: string, all: SymbolEntry[]): SymbolEntry[] {
    return all.filter(s => s.container === parent)
}

function toLspSymbol(s: SymbolEntry, children: SymbolEntry[]): any {
    const detail = [s.keyword, s.typeAnnotation].filter(Boolean).join(' ')
    return {
        name:           s.name,
        detail,
        kind:           KIND_MAP[s.kind],
        range:          s.range,
        selectionRange: s.selectionRange,
        children:       children.map(c => toLspSymbol(c, [])),
    }
}
