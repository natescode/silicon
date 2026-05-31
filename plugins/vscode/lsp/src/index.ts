#!/usr/bin/env bun
/**
 * Silicon Language Server — stdio entry point.
 *
 * Spec: docs/language-server-plan.html — v1 alpha covers diagnostics,
 * document symbols, go-to definition, and hover.  See the per-handler
 * files under handlers/ for the implementation of each.
 */

import {
    createConnection, ProposedFeatures, TextDocuments,
    TextDocumentSyncKind, StreamMessageReader, StreamMessageWriter,
} from 'vscode-languageserver/node.js'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { Workspace } from './workspace.ts'
import { registerDiagnostics } from './handlers/diagnostics.ts'
import { registerDocumentSymbols } from './handlers/document-symbol.ts'
import { registerDefinition } from './handlers/definition.ts'
import { registerHover } from './handlers/hover.ts'

// Default to stdio when no transport flag is passed.  VS Code's
// LanguageClient supplies --stdio explicitly; CLI / smoke tests don't.
const connection = process.argv.includes('--stdio') ||
                    process.argv.includes('--node-ipc') ||
                    process.argv.some(a => a.startsWith('--socket='))
    ? createConnection(ProposedFeatures.all)
    : createConnection(
        new StreamMessageReader(process.stdin),
        new StreamMessageWriter(process.stdout),
      )
const documents = new TextDocuments(TextDocument)
const workspace = new Workspace()

connection.onInitialize(() => ({
    capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        documentSymbolProvider: true,
        definitionProvider: true,
        hoverProvider: true,
    },
    serverInfo: { name: 'silicon-lsp', version: '0.1.0' },
}))

connection.onInitialized(() => {
    connection.console.info('silicon-lsp initialised')
})

// Wire up handlers.  Each registration attaches its own document /
// connection listeners.
registerDiagnostics(connection, documents, workspace)
registerDocumentSymbols(connection, documents, workspace)
registerDefinition(connection, documents, workspace)
registerHover(connection, documents, workspace)

documents.listen(connection)
connection.listen()
