import type { Connection, TextDocuments } from 'vscode-languageserver/node.js'
import type { TextDocument } from 'vscode-languageserver-textdocument'
import type { Workspace } from '../workspace.ts'
import { posToCaaS, sourceRangeToRange, hoverMarkdown } from '../lsp-convert.ts'

export function registerHover(
    connection: Connection,
    documents: TextDocuments<TextDocument>,
    workspace: Workspace,
): void {
    connection.onHover(({ textDocument, position }) => {
        if (!documents.get(textDocument.uri)) return null
        const { line, col } = posToCaaS(position)
        const info = workspace.compiler.hoverInfo(textDocument.uri, line, col)
        if (!info) return null
        return {
            contents: { kind: 'markdown', value: hoverMarkdown(info.typeDisplay, info.docComment) },
            range: info.range ? sourceRangeToRange(info.range) : undefined,
        }
    })
}
