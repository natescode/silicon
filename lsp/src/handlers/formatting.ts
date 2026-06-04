import type { Connection, TextDocuments, TextEdit } from 'vscode-languageserver/node.js'
import type { TextDocument } from 'vscode-languageserver-textdocument'
import type { Workspace } from '../workspace.ts'
import { spanToRange } from '../lsp-convert.ts'

export function registerFormatting(
    connection: Connection,
    documents: TextDocuments<TextDocument>,
    workspace: Workspace,
): void {
    connection.onDocumentFormatting(({ textDocument }): TextEdit[] => {
        if (!documents.get(textDocument.uri)) return []
        return workspace.compiler.formatDocument(textDocument.uri).map(e => ({
            range: spanToRange(e.span),
            newText: e.newText,
        }))
    })
}
