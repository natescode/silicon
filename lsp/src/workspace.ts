/**
 * Workspace — a thin adapter over the compiler's incremental CaaS
 * `Workspace` (`@silicon/compiler`).
 *
 * Every edit goes through `openDocument` / `editDocument`, so the LSP rides
 * the incremental parse → elaborate → typecheck engine: an edit reparses only
 * the damaged window, reuses unchanged elaboration, and replays the unchanged
 * type-check prefix.  The returned `Document` carries the queryable
 * `SemanticModel` and `diagnostics` the handlers consume.
 *
 * Cross-file resolution is by *open documents*: the compiler workspace builds
 * each document's `externalSymbols` from every other open document, so opening
 * a file's `@use` dependencies into the same workspace makes cross-file
 * references resolve with real types — no diagnostic-suppression heuristics.
 *
 * The document key is the LSP `file://` URI; the compiler stamps that URI onto
 * every `SourceSpan.file`, so navigation results carry URIs directly.
 */

import * as path from 'node:path'
import * as fs from 'node:fs'
import { Workspace as CompilerWorkspace, type Document } from '@silicon/compiler'
import { uriToPath, pathToUri } from './lsp-convert.ts'

export type { Document }

export class Workspace {
    /** The incremental compiler workspace backing every query. */
    readonly compiler = new CompilerWorkspace()

    /** Open (or update) a document and return its compiled state.
     *  Opens any `@use` dependencies into the same workspace first so
     *  cross-file references resolve. */
    update(uri: string, text: string): Document | undefined {
        // `@use` is not grammar-recognised (it's a CLI pre-pass), so strip it to
        // offset-preserving whitespace before the compiler sees it.
        const source = stripUseDirectives(text)

        // Ensure dependencies are open first (best-effort; missing files surface
        // as the elaborator's own diagnostic once @use is supported end-to-end).
        for (const depUri of extractUses(text, uriToPath(uri))) {
            if (depUri === uri || this.compiler.getDocument(depUri)) continue
            try {
                const depText = fs.readFileSync(uriToPath(depUri), 'utf-8')
                this.compiler.openDocument(depUri, stripUseDirectives(depText))
            } catch {
                // Unreadable @use target — skip; not fatal to this document.
            }
        }

        return this.compile(uri, source)
    }

    /** Compile already-stripped source via open- or edit-document. */
    private compile(uri: string, source: string): Document | undefined {
        try {
            return this.compiler.getDocument(uri)
                ? this.compiler.editDocument(uri, source)
                : this.compiler.openDocument(uri, source)
        } catch {
            // A compiler-internal throw (not a user error — those come back as
            // diagnostics).  Recover by reopening fresh; give up gracefully.
            try {
                if (this.compiler.getDocument(uri)) this.compiler.closeDocument(uri)
                return this.compiler.openDocument(uri, source)
            } catch {
                return undefined
            }
        }
    }

    /** The current compiled state for a URI, if open. */
    getDoc(uri: string): Document | undefined {
        return this.compiler.getDocument(uri)
    }

    /** Drop a document from the workspace (on didClose). */
    close(uri: string): void {
        this.compiler.closeDocument(uri)
    }
}

/**
 * Replace every `@use '...';` directive with same-length whitespace so line +
 * column offsets stay stable for diagnostics and navigation.  Trailing
 * semicolon and any inline `# comment` on the directive's line are absorbed.
 */
export function stripUseDirectives(text: string): string {
    return text.replace(
        /@use\s+'[^']*'\s*;?[ \t]*(?:#[^\n\r]*)?/g,
        (match) => match.replace(/[^\n\r]/g, ' '),
    )
}

/** Resolve `@use 'path.si'` targets (relative to the current file) to URIs. */
function extractUses(text: string, currentFile: string): string[] {
    const dir = path.dirname(currentFile)
    const out: string[] = []
    const re = /@use\s+'([^']+)'/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
        out.push(pathToUri(path.resolve(dir, m[1])))
    }
    return out
}
