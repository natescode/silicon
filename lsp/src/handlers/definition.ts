import type { Connection, TextDocuments } from 'vscode-languageserver/node.js'
import type { TextDocument } from 'vscode-languageserver-textdocument'
import type { Workspace } from '../workspace.ts'
import { posToCaaS, spanToLocation } from '../lsp-convert.ts'

export function registerDefinition(
    connection: Connection,
    documents: TextDocuments<TextDocument>,
    workspace: Workspace,
): void {
    const define = ({ textDocument, position }: any) => {
        if (!documents.get(textDocument.uri)) return null
        const { line, col } = posToCaaS(position)
        const sym = workspace.compiler.findDefinition(textDocument.uri, line, col)
        if (!sym?.definitionSpan) return null
        return spanToLocation(sym.definitionSpan)
    }
    connection.onDefinition(define)
    // `textDocument/declaration` — Silicon has no separate declaration vs
    // definition (no forward decls), so it aliases go-to-definition.
    connection.onDeclaration(define)

    // `textDocument/typeDefinition` — jump to the declaration of the symbol's
    // TYPE (e.g. the `@type`/`@enum` of a `Sum`/`Distinct`), not the symbol.
    connection.onTypeDefinition(({ textDocument, position }) => {
        if (!documents.get(textDocument.uri)) return null
        const { line, col } = posToCaaS(position)
        const sym = workspace.compiler.typeDefinition(textDocument.uri, line, col)
        if (!sym?.definitionSpan) return null
        return spanToLocation(sym.definitionSpan)
    })
}
