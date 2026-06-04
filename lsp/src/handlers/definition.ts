import type { Connection, TextDocuments } from 'vscode-languageserver/node.js'
import type { TextDocument } from 'vscode-languageserver-textdocument'
import type { Workspace } from '../workspace.ts'
import { posToCaaS, spanToLocation } from '../lsp-convert.ts'

export function registerDefinition(
    connection: Connection,
    documents: TextDocuments<TextDocument>,
    workspace: Workspace,
): void {
    connection.onDefinition(({ textDocument, position }) => {
        if (!documents.get(textDocument.uri)) return null
        const { line, col } = posToCaaS(position)
        const sym = workspace.compiler.findDefinition(textDocument.uri, line, col)
        if (!sym?.definitionSpan) return null
        return spanToLocation(sym.definitionSpan)
    })
}
