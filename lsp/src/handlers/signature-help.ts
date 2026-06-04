import type { Connection, TextDocuments, SignatureHelp } from 'vscode-languageserver/node.js'
import type { TextDocument } from 'vscode-languageserver-textdocument'
import type { Workspace } from '../workspace.ts'
import { posToCaaS } from '../lsp-convert.ts'

export function registerSignatureHelp(
    connection: Connection,
    documents: TextDocuments<TextDocument>,
    workspace: Workspace,
): void {
    connection.onSignatureHelp(({ textDocument, position }): SignatureHelp | null => {
        if (!documents.get(textDocument.uri)) return null
        const { line, col } = posToCaaS(position)
        const help = workspace.compiler.signatureHelp(textDocument.uri, line, col)
        if (!help) return null

        const paramList = help.parameters
            .map(p => (p.type ? `${p.name}: ${p.type}` : p.name))
            .join(', ')
        return {
            signatures: [{
                label: `${help.name}(${paramList})`,
                parameters: help.parameters.map(p => ({
                    label: p.type ? `${p.name}: ${p.type}` : p.name,
                })),
            }],
            activeSignature: 0,
            activeParameter: help.activeParameter,
        }
    })
}
