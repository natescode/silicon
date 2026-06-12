import type { Connection, TextDocuments, Location, DocumentHighlight } from 'vscode-languageserver/node.js'
import { DocumentHighlightKind } from 'vscode-languageserver/node.js'
import type { TextDocument } from 'vscode-languageserver-textdocument'
import type { Workspace } from '../workspace.ts'
import { posToCaaS, spanToLocation, spanToRange, toUri } from '../lsp-convert.ts'

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

    // `textDocument/documentHighlight` — the same-file occurrences of the
    // symbol under the cursor (editor highlights every use on hover/select).
    // It's `findReferences` narrowed to the active document.
    connection.onDocumentHighlight(({ textDocument, position }): DocumentHighlight[] => {
        if (!documents.get(textDocument.uri)) return []
        const { line, col } = posToCaaS(position)
        return workspace.compiler.findReferences(textDocument.uri, line, col)
            .filter(sp => toUri(sp.file) === textDocument.uri)
            .map(sp => ({ range: spanToRange(sp), kind: DocumentHighlightKind.Text }))
    })
}
