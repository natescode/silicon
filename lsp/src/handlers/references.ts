import type { Connection, TextDocuments, Location } from 'vscode-languageserver/node.js'
import type { TextDocument } from 'vscode-languageserver-textdocument'
import type { Workspace } from '../workspace.ts'
import { posToCaaS, spanToLocation } from '../lsp-convert.ts'

export function registerReferences(
    connection: Connection,
    documents: TextDocuments<TextDocument>,
    workspace: Workspace,
): void {
    connection.onReferences(({ textDocument, position }): Location[] => {
        if (!documents.get(textDocument.uri)) return []
        const { line, col } = posToCaaS(position)
        const spans = workspace.compiler.findReferences(textDocument.uri, line, col)
        return spans.map(spanToLocation)
    })
}
