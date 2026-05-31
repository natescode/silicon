import type { Connection, TextDocuments } from 'vscode-languageserver/node.js'
import { DiagnosticSeverity } from 'vscode-languageserver/node.js'
import type { TextDocument } from 'vscode-languageserver-textdocument'
import type { Workspace } from '../workspace.ts'
import type { Diagnostic as SiliconDiag } from '../../../src/errors/diagnostic.ts'

/**
 * Debounce window for re-checking on change.  See plan §6
 * "Granularity of re-checking" — 200ms is comfortable for sub-3500-LoC
 * files, the upper bound the bootstrap source pushes us to.
 */
const DEBOUNCE_MS = 200

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
        const analysis = workspace.update(doc.uri, doc.getText())
        const diagnostics = analysis.diagnostics.map(toLspDiagnostic)
        connection.sendDiagnostics({ uri: doc.uri, diagnostics })
    }

    documents.onDidOpen(({ document }) => {
        // First analysis loads the document so primeUses can read its
        // @use graph; the second re-runs with the dependencies in
        // cache so cross-file unbound-identifier suppression takes
        // effect on the very first publishDiagnostics.
        workspace.update(document.uri, document.getText())
        workspace.primeUses(document.uri)
        publish(document)
    })
    documents.onDidChangeContent(({ document }) => schedule(document))
    documents.onDidSave(({ document }) => publish(document))
}

function severityFor(d: SiliconDiag): DiagnosticSeverity {
    if (d.code === 'E0100' || d.code === 'E0200' || d.code === 'E0201') return DiagnosticSeverity.Error
    if (d.code.startsWith('W')) return DiagnosticSeverity.Warning
    return DiagnosticSeverity.Error
}

function toLspDiagnostic(d: SiliconDiag) {
    // Silicon spans are 1-indexed; LSP wants 0-indexed.
    const startLine = Math.max(0, d.span.line - 1)
    const startCol  = Math.max(0, d.span.col - 1)
    const len = Math.max(1, d.span.length)
    return {
        range: {
            start: { line: startLine, character: startCol },
            end:   { line: startLine, character: startCol + len },
        },
        severity: severityFor(d),
        code: d.code,
        source: `silicon.${d.phase}`,
        message: d.hint ? `${d.message}\n${d.hint}` : d.message,
    }
}
