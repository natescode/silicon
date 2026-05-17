/**
 * VS Code client wrapper for silicon-lsp.
 *
 * Spawns the language server as a `bun run` child process on demand,
 * registers it under the `silicon` document selector, and keeps the
 * connection alive for the lifetime of the extension.
 *
 * The server can be located via the `silicon.lsp.serverPath` setting;
 * if empty, we resolve `lsp-silicon/src/index.ts` relative to the first
 * workspace folder.  This matches the in-monorepo layout shipped today;
 * once `lsp-silicon` is on npm we'll switch to resolving the binary
 * via `require.resolve`.
 */

import * as path from 'node:path'
import * as fs from 'node:fs'
import {
    workspace, window, ExtensionContext, Disposable, commands,
} from 'vscode'
import {
    LanguageClient, LanguageClientOptions, ServerOptions, TransportKind,
} from 'vscode-languageclient/node'

let client: LanguageClient | undefined

export async function activate(ctx: ExtensionContext): Promise<void> {
    const config = workspace.getConfiguration('silicon.lsp')
    if (!config.get<boolean>('enabled', true)) {
        return
    }

    const serverPath = resolveServerPath(config.get<string>('serverPath', ''))
    if (!serverPath) {
        window.showWarningMessage(
            'Silicon LSP: could not locate lsp-silicon/src/index.ts. ' +
            'Set silicon.lsp.serverPath in settings or open the sigil repo as a workspace folder.',
        )
        return
    }

    const serverOptions: ServerOptions = {
        run: {
            command: 'bun',
            args: ['run', serverPath, '--stdio'],
            transport: TransportKind.stdio,
        },
        debug: {
            command: 'bun',
            args: ['run', '--inspect=0.0.0.0:6009', serverPath, '--stdio'],
            transport: TransportKind.stdio,
        },
    }

    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'silicon' }],
        synchronize: {
            fileEvents: workspace.createFileSystemWatcher('**/*.si'),
        },
        outputChannelName: 'Silicon LSP',
    }

    client = new LanguageClient('silicon', 'Silicon Language Server',
        serverOptions, clientOptions)

    ctx.subscriptions.push(
        client.start() as unknown as Disposable,
        commands.registerCommand('silicon.lsp.restart', async () => {
            if (!client) return
            await client.stop()
            await client.start()
            window.showInformationMessage('Silicon LSP restarted')
        }),
    )
}

export async function deactivate(): Promise<void> {
    if (!client) return
    await client.stop()
}

/**
 * Locate the lsp-silicon entry point.  Search order:
 *   1. The explicit setting if non-empty.
 *   2. <workspace>/lsp-silicon/src/index.ts.
 *   3. <extension-dir>/../lsp-silicon/src/index.ts (sibling-folder layout).
 */
function resolveServerPath(explicit: string): string | undefined {
    if (explicit && fs.existsSync(explicit)) return explicit

    const folders = workspace.workspaceFolders ?? []
    for (const f of folders) {
        const cand = path.join(f.uri.fsPath, 'lsp-silicon', 'src', 'index.ts')
        if (fs.existsSync(cand)) return cand
    }
    return undefined
}
