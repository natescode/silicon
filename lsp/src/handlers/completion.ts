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
        const { prefix, module } = contextAt(doc, position)
        const items = workspace.compiler.getCompletions(textDocument.uri, line, col, prefix, { module })
        return items.map(it => ({
            label: it.label,
            kind: completionKindToLsp(it.kind),
            detail: it.detail,
            documentation: it.docComment,
        }))
    })
}

/**
 * The completion context immediately left of the cursor: the identifier
 * `prefix`, and — when the cursor follows a `mod::` qualifier (ADR-0024) — the
 * `module` whose public members should be offered.
 */
function contextAt(
    doc: TextDocument,
    pos: { line: number; character: number },
): { prefix: string | undefined; module: string | undefined } {
    const line = doc.getText({
        start: { line: pos.line, character: 0 },
        end: { line: pos.line, character: pos.character },
    })
    // `mod::partial` (partial may be empty right after `::`).
    const qualified = line.match(/([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)?$/)
    if (qualified) return { prefix: qualified[2] || undefined, module: qualified[1] }
    const m = line.match(/[A-Za-z_][A-Za-z0-9_]*$/)
    return { prefix: m ? m[0] : undefined, module: undefined }
}
