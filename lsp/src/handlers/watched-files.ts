import {
    type Connection, DidChangeWatchedFilesNotification,
    FileChangeType, WatchKind,
} from 'vscode-languageserver/node.js'
import type { Workspace } from '../workspace.ts'

/**
 * Stage 3 (ADR-0024): keep the open document set in sync with the filesystem.
 * Routes watched create / change / delete events to the workspace so a
 * newly-added module file becomes resolvable without the user re-editing, and a
 * deleted file is dropped. Call {@link registerFileWatchers} from the server's
 * `onInitialized` to ask the client to start delivering these events.
 */
export function registerWatchedFiles(connection: Connection, workspace: Workspace): void {
    connection.onDidChangeWatchedFiles(({ changes }) => {
        for (const c of changes) {
            const kind = c.type === FileChangeType.Created ? 'created'
                : c.type === FileChangeType.Deleted ? 'deleted'
                : 'changed'
            workspace.handleWatchedChange(c.uri, kind)
        }
    })
}

/** Best-effort dynamic registration of `**​/*.si` + `**​/sgl.toml` watchers.
 *  Clients without dynamic-registration capability silently ignore it. */
export function registerFileWatchers(connection: Connection): void {
    connection.client.register(DidChangeWatchedFilesNotification.type, {
        watchers: [
            { globPattern: '**/*.si',     kind: WatchKind.Create | WatchKind.Delete },
            { globPattern: '**/sgl.toml', kind: WatchKind.Create | WatchKind.Change | WatchKind.Delete },
        ],
    }).catch(() => { /* client lacks dynamic-registration capability — fine */ })
}
