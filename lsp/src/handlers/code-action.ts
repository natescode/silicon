import type { Connection, TextDocuments, CodeAction as LspCodeAction } from 'vscode-languageserver/node.js'
import { CodeActionKind } from 'vscode-languageserver/node.js'
import type { TextDocument } from 'vscode-languageserver-textdocument'
import type { Workspace } from '../workspace.ts'
import { getCodeActions } from '@silicon/compiler'
import { spanToRange } from '../lsp-convert.ts'

const KIND_MAP: Record<string, string> = {
    quickfix: CodeActionKind.QuickFix,
    refactor: CodeActionKind.Refactor,
    source: CodeActionKind.Source,
}

export function registerCodeActions(
    connection: Connection,
    _documents: TextDocuments<TextDocument>,
    workspace: Workspace,
): void {
    connection.onCodeAction(({ textDocument, range }): LspCodeAction[] => {
        const doc = workspace.getDoc(textDocument.uri)
        if (!doc) return []

        const out: LspCodeAction[] = []
        for (const diag of doc.diagnostics) {
            // Only diagnostics overlapping the requested range (0-based lines).
            const dl = diag.span.line - 1
            if (dl < range.start.line || dl > range.end.line) continue

            for (const action of getCodeActions(diag, doc.source)) {
                out.push({
                    title: action.title,
                    kind: KIND_MAP[action.kind] ?? CodeActionKind.QuickFix,
                    isPreferred: action.isPreferred,
                    edit: {
                        changes: {
                            [textDocument.uri]: action.edits.map(e => ({
                                range: spanToRange(e.span),
                                newText: e.newText,
                            })),
                        },
                    },
                })
            }
        }
        return out
    })
}
