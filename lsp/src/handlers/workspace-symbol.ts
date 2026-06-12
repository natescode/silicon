import type { Connection, SymbolInformation } from 'vscode-languageserver/node.js'
import type { Workspace } from '../workspace.ts'
import { spanToLocation, symbolKindToLsp } from '../lsp-convert.ts'

/**
 * `workspace/symbol` (Ctrl-T) — search every user-written symbol across all
 * open documents by name substring.  Backed by the compiler workspace's symbol
 * index (`workspaceSymbols`), so it spans the whole component, not just the
 * active file.
 */
export function registerWorkspaceSymbols(connection: Connection, workspace: Workspace): void {
    connection.onWorkspaceSymbol(({ query }): SymbolInformation[] => {
        return workspace.compiler.workspaceSymbols(query)
            .filter(sym => sym.definitionSpan)
            .map(sym => ({
                name: sym.name,
                kind: symbolKindToLsp(sym.kind),
                location: spanToLocation(sym.definitionSpan!),
                containerName: sym.containingSymbol?.name,
            }))
    })
}
