import type { Connection, TextDocuments, CompletionItem as LspCompletionItem } from 'vscode-languageserver/node.js'
import type { TextDocument } from 'vscode-languageserver-textdocument'
import type { Workspace } from '../workspace.ts'
import { posToCaaS, completionKindToLsp } from '../lsp-convert.ts'

export function registerCompletion(
    connection: Connection,
    documents: TextDocuments<TextDocument>,
    workspace: Workspace,
): void {
    connection.onCompletion(({ textDocument, position }): LspCompletionItem[] => {
        const doc = documents.get(textDocument.uri)
        if (!doc) return []
        const { line, col } = posToCaaS(position)
        const prefix = wordPrefixAt(doc, position)
        const items = workspace.compiler.getCompletions(textDocument.uri, line, col, prefix)
        return items.map(it => ({
            label: it.label,
            kind: completionKindToLsp(it.kind),
            detail: it.detail,
            documentation: it.docComment,
        }))
    })
}

/** The identifier characters immediately left of the cursor — the completion
 *  prefix the Workspace filters on. */
function wordPrefixAt(doc: TextDocument, pos: { line: number; character: number }): string | undefined {
    const line = doc.getText({
        start: { line: pos.line, character: 0 },
        end: { line: pos.line, character: pos.character },
    })
    const m = line.match(/[A-Za-z_][A-Za-z0-9_]*$/)
    return m ? m[0] : undefined
}
