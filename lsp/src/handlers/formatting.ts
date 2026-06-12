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

    // `textDocument/rangeFormatting` — format only the selected lines.  The
    // compiler's `formatRange` expands the range to whole lines first.  LSP
    // ranges are 0-based half-open; CaaS `SourceRange` is 1-based.
    connection.onDocumentRangeFormatting(({ textDocument, range }): TextEdit[] => {
        if (!documents.get(textDocument.uri)) return []
        return workspace.compiler.formatRange(textDocument.uri, {
            startLine: range.start.line + 1,
            startCol:  range.start.character + 1,
            endLine:   range.end.line + 1,
            endCol:    range.end.character + 1,
        }).map(e => ({ range: spanToRange(e.span), newText: e.newText }))
    })
}
