/**
 * Workspace — multi-document project state (CaaS-4).
 *
 * A Workspace owns a shared strata registry and a set of open Documents.
 * Each Document holds its current source, parsed SyntaxTree, elaborated tree,
 * SemanticModel, and the union of all per-phase diagnostics.
 *
 * Typical usage (single-file):
 *
 *   const ws = new Workspace()
 *   const doc = ws.openDocument('main.si', source)
 *   if (doc.diagnostics.length) { ... }
 *   console.log(doc.model.allDiagnostics)
 *
 * Typical usage (subscribing to changes):
 *
 *   const unsub = ws.onDidChange(({ uri, document, kind }) => {
 *     console.log(kind, uri, document.diagnostics.length, 'diagnostics')
 *   })
 *   ws.editDocument('main.si', newSource)
 *   unsub()  // stop listening
 *
 * Cross-document symbol resolution (CaaS-5) is not yet implemented.
 * All documents share one registry; strata defined in any document are
 * visible to all documents opened after `buildRegistry` runs (i.e. on
 * the first `openDocument` call, or via `Workspace({ registry })`.
 */

import { parse, elaborate, typecheck, buildRegistry, SyntaxTree } from './index'
import type { ElaboratorRegistry } from '../elaborator/registry'
import type { SemanticModel, Symbol as CaaSSymbol } from '../ast/semanticModel'
import type { Diagnostic, SourceSpan } from '../errors/diagnostic'

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

/** The full compiled state of one source file in a Workspace. */
export interface Document {
    /** URI / path used as the key in the Workspace. */
    readonly uri: string
    /** Current source text. */
    readonly source: string
    /** Monotonically increasing edit counter. Starts at 1. */
    readonly version: number
    /** Parse-phase output. */
    readonly tree: SyntaxTree
    /** Elaborate-phase output. */
    readonly elabTree: SyntaxTree
    /** Typecheck-phase output; queryable semantic overlay. */
    readonly model: SemanticModel
    /** All diagnostics from every phase, in pipeline order. */
    readonly diagnostics: readonly Diagnostic[]
}

// ---------------------------------------------------------------------------
// Change events
// ---------------------------------------------------------------------------

export interface DocumentChangeEvent {
    readonly kind: 'opened' | 'changed' | 'closed'
    readonly uri: string
    /** The new document state (undefined when kind === 'closed'). */
    readonly document: Document | undefined
}

export type ChangeListener = (event: DocumentChangeEvent) => void

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export interface WorkspaceOptions {
    /** Pre-built registry. If omitted, one is built from the first opened document. */
    registry?: ElaboratorRegistry
}

export class Workspace {
    #registry: ElaboratorRegistry | undefined
    readonly #docs = new Map<string, Document>()
    readonly #listeners = new Set<ChangeListener>()

    constructor(options: WorkspaceOptions = {}) {
        this.#registry = options.registry
    }

    // ── registry ─────────────────────────────────────────────────────────────

    /**
     * The shared strata registry for this workspace.  Built lazily from the
     * first document opened unless one was provided to the constructor.
     * `undefined` before any document is opened.
     */
    get registry(): ElaboratorRegistry | undefined {
        return this.#registry
    }

    // ── document map ──────────────────────────────────────────────────────────

    /** All currently open documents, keyed by URI. */
    get documents(): ReadonlyMap<string, Document> {
        return this.#docs
    }

    /** Retrieve a single open document, or undefined if not open. */
    getDocument(uri: string): Document | undefined {
        return this.#docs.get(uri)
    }

    // ── lifecycle ─────────────────────────────────────────────────────────────

    /**
     * Open a new document and run all compilation phases.
     *
     * If the workspace has no registry yet, one is built from `source`.
     * Fires a `'opened'` change event.
     *
     * Throws if `uri` is already open — call `editDocument` for subsequent
     * versions.
     */
    openDocument(uri: string, source: string): Document {
        if (this.#docs.has(uri)) {
            throw new Error(`Document already open: ${uri}. Use editDocument() to update it.`)
        }
        const doc = this.#compile(uri, source, 1)
        this.#docs.set(uri, doc)
        this.#emit({ kind: 'opened', uri, document: doc })
        return doc
    }

    /**
     * Apply a full-text replacement to an open document.
     *
     * Re-parses via `SyntaxTree.withText()` (reusing the existing tree's file
     * name), then re-elaborates and re-typechecks against the shared registry.
     * Fires a `'changed'` change event.
     *
     * Throws if `uri` is not open.
     */
    editDocument(uri: string, newSource: string): Document {
        const existing = this.#docs.get(uri)
        if (!existing) {
            throw new Error(`Document not open: ${uri}. Use openDocument() first.`)
        }
        const doc = this.#compile(uri, newSource, existing.version + 1)
        this.#docs.set(uri, doc)
        this.#emit({ kind: 'changed', uri, document: doc })
        return doc
    }

    /**
     * Close a document and remove it from the workspace.
     * Fires a `'closed'` change event.
     */
    closeDocument(uri: string): void {
        if (!this.#docs.has(uri)) return
        this.#docs.delete(uri)
        this.#emit({ kind: 'closed', uri, document: undefined })
    }

    // ── change subscriptions ─────────────────────────────────────────────────

    /**
     * Subscribe to document change events.
     *
     * @returns An unsubscribe function — call it to stop receiving events.
     *
     * @example
     *   const unsub = ws.onDidChange(e => console.log(e.kind, e.uri))
     *   // ... later:
     *   unsub()
     */
    onDidChange(listener: ChangeListener): () => void {
        this.#listeners.add(listener)
        return () => this.#listeners.delete(listener)
    }

    // ── navigation (CaaS-5) ───────────────────────────────────────────────────

    /**
     * Find the symbol whose definition or reference occupies `(line, col)`
     * in `uri`.  Both coordinates are 1-based (matching editor conventions).
     *
     * Returns `undefined` if the document is not open or no symbol covers the
     * position.  Use `symbol.definitionSpan` to jump to the declaration.
     */
    findDefinition(uri: string, line: number, col: number): CaaSSymbol | undefined {
        return this.#docs.get(uri)?.model.symbolAtPosition(line, col)
    }

    /**
     * Find all reference spans for the symbol at `(line, col)` in `uri`.
     *
     * Returns an empty array if the document is not open, the position covers
     * no symbol, or location info was not available (pre-Ohm ASTs).
     */
    findReferences(uri: string, line: number, col: number): readonly SourceSpan[] {
        const doc = this.#docs.get(uri)
        if (!doc) return []
        const sym = doc.model.symbolAtPosition(line, col)
        if (!sym) return []
        return doc.model.referenceSpans(sym)
    }

    // ── internal ──────────────────────────────────────────────────────────────

    #compile(uri: string, source: string, version: number): Document {
        const allDiags: Diagnostic[] = []

        // 1. Parse
        const parseResult = parse(source, { file: uri })
        allDiags.push(...parseResult.diagnostics)

        // 2. Build or reuse registry
        if (!this.#registry) {
            this.#registry = buildRegistry(parseResult.tree)
        }

        // 3. Elaborate
        const elabResult = elaborate(parseResult.tree, this.#registry)
        allDiags.push(...elabResult.diagnostics)

        // 4. Typecheck
        const checkResult = typecheck(elabResult.tree, elabResult.registry)
        allDiags.push(...checkResult.diagnostics)

        return {
            uri,
            source,
            version,
            tree: parseResult.tree,
            elabTree: elabResult.tree,
            model: checkResult.model,
            diagnostics: allDiags,
        }
    }

    #emit(event: DocumentChangeEvent): void {
        for (const listener of this.#listeners) {
            listener(event)
        }
    }
}
