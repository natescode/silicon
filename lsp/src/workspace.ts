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
 * a file's `@use` dependencies — AND, for an ADR-0024 project, its sibling
 * module files — into the same workspace makes cross-file references resolve
 * with real types and powers cross-file go-to-definition.
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

    /** Component roots whose source files have already been opened, with the
     *  list discovered for each (ADR-0024 — avoids re-scanning the tree on
     *  every keystroke). */
    readonly #scannedComponents = new Map<string, string[]>()

    /** Open (or update) a document and return its compiled state.
     *  Opens any `@use` dependencies AND, inside an `sgl.toml` project, every
     *  sibling source file (ADR-0024 directory=module) into the same workspace
     *  first so cross-file references resolve. */
    update(uri: string, text: string): Document | undefined {
        // `@use` is not grammar-recognised (it's a CLI pre-pass), so strip it to
        // offset-preserving whitespace before the compiler sees it.
        const source = stripUseDirectives(text)

        // Ensure dependencies are open first (best-effort; missing files surface
        // as the elaborator's own diagnostic once @use is supported end-to-end).
        for (const depUri of extractUses(text, uriToPath(uri))) {
            if (depUri === uri || this.compiler.getDocument(depUri)) continue
            this.#openFromDisk(depUri)
        }

        // ADR-0024: inside a project, a module's files auto-include (no `@use`),
        // so open every component source file too — this is what makes a bare
        // intra-module call (`mul` defined in ops.si, used in helpers.si) and a
        // cross-module `math::square` resolve. Compiling the active document
        // LAST means its `externalSymbols` already sees every sibling.
        this.#ensureComponentOpen(uri)

        return this.compile(uri, source)
    }

    /** Open every source file of the `sgl.toml` component that owns `uri`
     *  (excluding the active document). No-op for a standalone file. */
    #ensureComponentOpen(activeUri: string): void {
        const filePath = uriToPath(activeUri)
        const root = findComponentRoot(path.dirname(filePath))
        if (!root) return                       // standalone file — keep @use-only behaviour
        let files = this.#scannedComponents.get(root)
        if (!files) {
            files = listComponentSiFiles(root)
            this.#scannedComponents.set(root, files)
        }
        for (const f of files) {
            const fileUri = pathToUri(f)
            if (fileUri === activeUri || this.compiler.getDocument(fileUri)) continue
            this.#openFromDisk(fileUri)
        }
    }

    /** Read a file from disk and open it (background) into the compiler
     *  workspace. Best-effort: unreadable / malformed files are skipped. */
    #openFromDisk(fileUri: string): void {
        try {
            const text = fs.readFileSync(uriToPath(fileUri), 'utf-8')
            this.compiler.openDocument(fileUri, stripUseDirectives(text))
        } catch {
            // Unreadable target — skip; not fatal to the active document.
        }
    }

    /** Forget a component's cached file list (e.g. a file was added/removed),
     *  so the next edit re-scans it. */
    invalidateComponentScan(componentRoot: string): void {
        this.#scannedComponents.delete(componentRoot)
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

/** Walk up from `dir` to the nearest `sgl.toml`-rooted component, or null when
 *  the file is standalone (no enclosing project). Mirrors the CLI's discovery. */
export function findComponentRoot(dir: string): string | null {
    let cur = path.resolve(dir)
    for (;;) {
        if (fs.existsSync(path.join(cur, 'sgl.toml'))) return cur
        const parent = path.dirname(cur)
        if (parent === cur) return null
        cur = parent
    }
}

/** Every `.si` source file under a component root (recursive), skipping
 *  host-wrapper / tooling dirs and any nested component (its own `sgl.toml`).
 *  Each directory under the root is a module (ADR-0024); these are the files
 *  the LSP opens together so a module's symbols resolve across files. */
export function listComponentSiFiles(componentRoot: string): string[] {
    const out: string[] = []
    const walk = (dir: string, isRoot: boolean): void => {
        if (!isRoot && fs.existsSync(path.join(dir, 'sgl.toml'))) return   // nested component — its own unit
        let entries: fs.Dirent[]
        try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const e of entries) {
            if (e.isDirectory()) {
                if (e.name === 'modules' || e.name === 'node_modules' || e.name.startsWith('.')) continue
                walk(path.join(dir, e.name), false)
            } else if (e.name.endsWith('.si')) {
                out.push(path.join(dir, e.name))
            }
        }
    }
    walk(componentRoot, true)
    return out.sort()
}
