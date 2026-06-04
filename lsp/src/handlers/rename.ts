import type { Connection, TextDocuments, WorkspaceEdit, TextEdit } from 'vscode-languageserver/node.js'
import type { TextDocument } from 'vscode-languageserver-textdocument'
import type { Workspace } from '../workspace.ts'
import { posToCaaS, spanToRange, toUri } from '../lsp-convert.ts'

export function registerRename(
    connection: Connection,
    documents: TextDocuments<TextDocument>,
    workspace: Workspace,
): void {
    connection.onRenameRequest(({ textDocument, position, newName }): WorkspaceEdit | null => {
        if (!documents.get(textDocument.uri)) return null
        const { line, col } = posToCaaS(position)
        const edit = workspace.compiler.rename(textDocument.uri, line, col, newName)
        if (edit.changeCount === 0) return null

        const changes: Record<string, TextEdit[]> = {}
        for (const [file, edits] of edit) {
            changes[toUri(file)] = edits.map(e => ({
                range: spanToRange(e.span),
                newText: e.newText,
            }))
        }
        return { changes }
    })
}
