import type { Connection, TextDocuments } from 'vscode-languageserver/node.js'
import type { TextDocument } from 'vscode-languageserver-textdocument'
import type { Workspace } from '../workspace.ts'
import { toLspDiagnostic } from '../lsp-convert.ts'

/**
 * Debounce window for re-checking on change.  The incremental engine makes a
 * re-check sub-millisecond on a body edit, but debouncing still coalesces
 * bursts of keystrokes into one publish.
 */
const DEBOUNCE_MS = 150

export function registerDiagnostics(
    connection: Connection,
    documents: TextDocuments<TextDocument>,
    workspace: Workspace,
): void {
    const pending = new Map<string, NodeJS.Timeout>()

    const schedule = (doc: TextDocument) => {
        const prev = pending.get(doc.uri)
        if (prev) clearTimeout(prev)
        pending.set(doc.uri, setTimeout(() => {
            pending.delete(doc.uri)
            publish(doc)
        }, DEBOUNCE_MS))
    }

    const publish = (doc: TextDocument) => {
        const compiled = workspace.update(doc.uri, doc.getText())
        const diagnostics = (compiled?.diagnostics ?? []).map(toLspDiagnostic)
        connection.sendDiagnostics({ uri: doc.uri, diagnostics })
    }

    documents.onDidOpen(({ document }) => publish(document))
    documents.onDidChangeContent(({ document }) => schedule(document))
    documents.onDidSave(({ document }) => publish(document))
    documents.onDidClose(({ document }) => {
        const prev = pending.get(document.uri)
        if (prev) clearTimeout(prev)
        pending.delete(document.uri)
        workspace.close(document.uri)
        connection.sendDiagnostics({ uri: document.uri, diagnostics: [] })
    })
}
