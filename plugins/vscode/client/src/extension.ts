/**
 * VS Code client wrapper for the bundled Silicon language server.
 *
 * The server is shipped inside this VSIX at `lsp/dist/index.js` — a
 * single bundled Node script produced by `bun run build:server`.  At
 * activation we spawn it as a child `node` process and keep the
 * connection alive for the lifetime of the extension.
 */

import * as path from 'node:path'
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

    // ctx.extensionPath points at the installed extension root.  The
    // bundled server lives at <extensionRoot>/lsp/dist/index.js.
    const serverPath = path.join(ctx.extensionPath, 'lsp', 'dist', 'index.js')

    const serverOptions: ServerOptions = {
        run: {
            command: 'node',
            args: [serverPath, '--stdio'],
            transport: TransportKind.stdio,
        },
        debug: {
            command: 'node',
            args: ['--inspect=6009', serverPath, '--stdio'],
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
