#!/usr/bin/env bun
/**
 * Silicon Language Server — stdio entry point.
 *
 * Backed by the compiler's incremental CaaS `Workspace`: every edit reparses
 * only the damaged window, reuses unchanged elaboration, and replays the
 * unchanged type-check prefix.  Features (diagnostics, symbols, definition,
 * hover, completion, references, rename, signature help, formatting, semantic
 * tokens, code actions) are thin adapters over the compiler's `SemanticModel`
 * and Workspace navigation API — see the per-handler files under handlers/.
 */

import {
    createConnection, ProposedFeatures, TextDocuments,
    TextDocumentSyncKind, StreamMessageReader, StreamMessageWriter,
} from 'vscode-languageserver/node.js'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { Workspace } from './workspace.ts'
import { SEMANTIC_TOKEN_TYPES } from './lsp-convert.ts'
import { registerDiagnostics } from './handlers/diagnostics.ts'
import { registerDocumentSymbols } from './handlers/document-symbol.ts'
import { registerDefinition } from './handlers/definition.ts'
import { registerHover } from './handlers/hover.ts'
import { registerCompletion } from './handlers/completion.ts'
import { registerReferences } from './handlers/references.ts'
import { registerRename } from './handlers/rename.ts'
import { registerSignatureHelp } from './handlers/signature-help.ts'
import { registerFormatting } from './handlers/formatting.ts'
import { registerSemanticTokens } from './handlers/semantic-tokens.ts'
import { registerCodeActions } from './handlers/code-action.ts'
import { registerWatchedFiles, registerFileWatchers } from './handlers/watched-files.ts'

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

/** Whether the client supports dynamic registration of file watchers. */
let canWatchFiles = false

connection.onInitialize((params) => {
    // Only register file watchers (Stage 3) if the client supports it — sending
    // an unsolicited `client/registerCapability` to a client that doesn't would
    // be a protocol violation.
    canWatchFiles = params.capabilities?.workspace?.didChangeWatchedFiles?.dynamicRegistration === true
    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            documentSymbolProvider: true,
            definitionProvider: true,
            hoverProvider: true,
            completionProvider: { triggerCharacters: ['&', '@', ':'] },
            referencesProvider: true,
            renameProvider: true,
            signatureHelpProvider: { triggerCharacters: ['(', ',', ' '] },
            documentFormattingProvider: true,
            codeActionProvider: true,
            semanticTokensProvider: {
                legend: { tokenTypes: SEMANTIC_TOKEN_TYPES, tokenModifiers: [] },
                full: true,
            },
        },
        serverInfo: { name: 'silicon-lsp', version: '0.2.0' },
    }
})

connection.onInitialized(() => {
    connection.console.info('silicon-lsp initialised (incremental engine)')
    if (canWatchFiles) registerFileWatchers(connection)
})

// Wire up handlers.  Each registration attaches its own document /
// connection listeners.
registerDiagnostics(connection, documents, workspace)
registerDocumentSymbols(connection, documents, workspace)
registerDefinition(connection, documents, workspace)
registerHover(connection, documents, workspace)
registerCompletion(connection, documents, workspace)
registerReferences(connection, documents, workspace)
registerRename(connection, documents, workspace)
registerSignatureHelp(connection, documents, workspace)
registerFormatting(connection, documents, workspace)
registerSemanticTokens(connection, documents, workspace)
registerCodeActions(connection, documents, workspace)
registerWatchedFiles(connection, workspace)

documents.listen(connection)
connection.listen()
