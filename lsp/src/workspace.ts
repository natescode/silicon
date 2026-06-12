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
import { Workspace as CompilerWorkspace, type Document, type Project } from '@silicon/compiler'
import { uriToPath, pathToUri } from './lsp-convert.ts'

export type { Document }

export class Workspace {
    /** The incremental compiler workspace backing every query. */
    readonly compiler = new CompilerWorkspace()

    /** Component roots whose source files have already been opened, with the
     *  list discovered for each (ADR-0024 — avoids re-scanning the tree on
     *  every keystroke). */
    readonly #scannedComponents = new Map<string, string[]>()

    /** CaaS Project per component root (Stage 3): groups a component's documents
     *  so cross-document visibility is scoped to the component — two unrelated
     *  projects open in one editor window never cross-resolve. */
    readonly #componentProjects = new Map<string, Project>()

    /** Release retained state on server shutdown.  Drops the component scan
     *  caches + project map so the compiler workspace and its open documents
     *  become unreferenced.  Best-effort and idempotent — the process exits
     *  immediately after `onExit`, so this is about prompt cleanup. */
    dispose(): void {
        this.#scannedComponents.clear()
        this.#componentProjects.clear()
    }

    /** Open (or update) a document and return its compiled state.
     *  Opens any `@use` dependencies AND, inside an `sgl.toml` project, every
     *  sibling source file (ADR-0024 directory=module) into the same workspace
     *  first so cross-file references resolve. */
    update(uri: string, text: string): Document | undefined {
        // `@use` is not grammar-recognised (it's a CLI pre-pass), so strip it to
        // offset-preserving whitespace before the compiler sees it.
        const source = stripUseDirectives(text)

        // ADR-0024: inside a project, a module's files auto-include (no `@use`),
        // so open every component source file too — this is what makes a bare
        // intra-module call (`mul` defined in ops.si, used in helpers.si) and a
        // cross-module `math::square` resolve. The component's docs are grouped
        // into one CaaS Project (Stage 3) so visibility stays component-scoped.
        const project = this.#ensureComponentOpen(uri)

        // Ensure `@use` dependencies are open too (legacy / standalone files).
        // These ride the same project as the active document when it has one.
        for (const depUri of extractUses(text, uriToPath(uri))) {
            if (depUri === uri || this.compiler.getDocument(depUri)) continue
            this.#openFromDisk(depUri, project)
        }

        // Compiling the active document LAST means its `externalSymbols` already
        // sees every sibling.
        return this.compile(uri, source, project)
    }

    /** Open every source file of the `sgl.toml` component that owns `uri`
     *  (excluding the active document) into the component's CaaS Project, and
     *  return that Project. No-op (returns undefined) for a standalone file. */
    #ensureComponentOpen(activeUri: string): Project | undefined {
        const filePath = uriToPath(activeUri)
        const root = findComponentRoot(path.dirname(filePath))
        if (!root) return undefined             // standalone file — keep @use-only behaviour
        let project = this.#componentProjects.get(root)
        if (!project) {
            project = this.compiler.addProject(`component:${root}`)
            this.#componentProjects.set(root, project)
        }
        let files = this.#scannedComponents.get(root)
        if (!files) {
            files = listComponentSiFiles(root)
            this.#scannedComponents.set(root, files)
        }
        for (const f of files) {
            const fileUri = pathToUri(f)
            if (fileUri === activeUri || this.compiler.getDocument(fileUri)) continue
            this.#openFromDisk(fileUri, project)
        }
        return project
    }

    /** Read a file from disk and open it (background) into the compiler
     *  workspace — into `project` when given. Best-effort: unreadable /
     *  malformed files are skipped. */
    #openFromDisk(fileUri: string, project: Project | undefined): void {
        try {
            const src = stripUseDirectives(fs.readFileSync(uriToPath(fileUri), 'utf-8'))
            if (project) project.addDocument(fileUri, src)
            else this.compiler.openDocument(fileUri, src)
        } catch {
            // Unreadable target — skip; not fatal to the active document.
        }
    }

    /** Forget a component's cached file list (e.g. a file was added/removed),
     *  so the next edit re-scans it. */
    invalidateComponentScan(componentRoot: string): void {
        this.#scannedComponents.delete(componentRoot)
    }

    /**
     * React to a watched-file change (Stage 3): a created/deleted `.si` file or
     * an edited `sgl.toml` invalidates the owning component's cached file list
     * and refreshes its open document set, so cross-file navigation stays
     * correct without the user re-editing.
     */
    handleWatchedChange(fileUri: string, kind: 'created' | 'changed' | 'deleted'): void {
        const filePath = uriToPath(fileUri)
        const isToml = path.basename(filePath) === 'sgl.toml'
        const root = isToml ? path.dirname(filePath) : findComponentRoot(path.dirname(filePath))
        if (!root) {
            if (kind === 'deleted') this.compiler.closeDocument(fileUri)
            return
        }
        this.invalidateComponentScan(root)
        if (kind === 'deleted' && !isToml) {
            try { this.compiler.closeDocument(fileUri) } catch { /* not open */ }
        }
        // If this component is already active (has a Project), re-open its files
        // so a newly-added module file is immediately resolvable.
        if (this.#componentProjects.has(root)) this.#refreshComponent(root)
    }

    /** Re-scan a component and open any not-yet-open source files into its
     *  Project. Used after a watched-file change. */
    #refreshComponent(root: string): void {
        const project = this.#componentProjects.get(root)
        if (!project) return
        const files = listComponentSiFiles(root)
        this.#scannedComponents.set(root, files)
        for (const f of files) {
            const fileUri = pathToUri(f)
            if (this.compiler.getDocument(fileUri)) continue
            this.#openFromDisk(fileUri, project)
        }
    }

    /** Compile already-stripped source via open- or edit-document, into the
     *  given component `project` on first open (Stage 3). */
    private compile(uri: string, source: string, project?: Project): Document | undefined {
        const fresh = () => (project ? project.addDocument(uri, source) : this.compiler.openDocument(uri, source))
        try {
            return this.compiler.getDocument(uri)
                ? this.compiler.editDocument(uri, source)
                : fresh()
        } catch {
            // A compiler-internal throw (not a user error — those come back as
            // diagnostics).  Recover by reopening fresh; give up gracefully.
            try {
                if (this.compiler.getDocument(uri)) this.compiler.closeDocument(uri)
                return fresh()
            } catch {
                return undefined
            }
        }
    }

    /** The current compiled state for a URI, if open. */
    getDoc(uri: string): Document | undefined {
        return this.compiler.getDocument(uri)
    }

    /**
     * Cross-file diagnostic invalidation: after `changedUri` was updated,
     * re-check every open document whose visible symbol surface changed and
     * return the recompiled Documents (with fresh `diagnostics`).  The
     * diagnostics handler republishes these so a signature edit in `lib.si`
     * immediately surfaces (or clears) errors in an open `main.si`.
     */
    refreshDependents(changedUri: string): Document[] {
        return this.compiler.refreshDependents(changedUri)
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
