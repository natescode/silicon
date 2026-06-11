// SPDX-License-Identifier: MIT
/**
 * Workspace — multi-document project state (CaaS-4 / CaaS-5).
 *
 * A Workspace owns a shared strata registry and a set of open Documents.
 * Each Document holds its current source, parsed SyntaxTree, elaborated tree,
 * SemanticModel, and the union of all per-phase diagnostics.
 *
 * Project layer (CaaS tracker 3a):
 *   - Documents can be grouped into named `Project`s via `addProject` /
 *     `Project.addDocument`.  Each project has a compile target and dependency
 *     edges to other projects.
 *   - Cross-document type checking is scoped per-project: a document sees only
 *     symbols from its own project plus the transitive closure of that
 *     project's dependencies.  Documents opened through the flat API stay
 *     unassigned and (once any project exists) see only other unassigned docs.
 *   - With no projects created, the workspace is flat and every document sees
 *     every other — fully backward-compatible.
 *
 * Cross-document symbol resolution (CaaS-5):
 *   - A workspace-level symbol index is maintained as documents are opened,
 *     edited, and closed.
 *   - `findDefinition` first queries the local SemanticModel; if that misses
 *     (e.g. an unresolved cross-file call), it walks the SyntaxNode tree for
 *     a Namespace at the position and looks the name up in the index.
 *   - `findReferences` aggregates typechecker-resolved spans AND AST-scanned
 *     Namespace nodes from every open document, then deduplicates.
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
 */

import { parse, elaborate, typecheck, buildRegistry, SyntaxTree } from './index'
import { programNeedsParamInference } from '../types/typechecker'
import {
    incrementalElaborate, elaborateGroupsFull, elabErrorsToDiagnostics, stratumSignature,
    type ElabGroup,
} from './incrementalElaborate'
import {
    incrementalTypecheck, externalSymbolsSignature,
    type TypeGroupCache, type PriorTypeState,
} from './incrementalTypecheck'
import { astChildren } from '../ast/astChildren'
import type { ElaboratorRegistry } from '../elaborator/registry'
import type { SemanticModel, Symbol as CaaSSymbol, SourceRange } from '../ast/semanticModel'
import { typeDisplayString } from '../ast/semanticModel'
import type { SiliconType } from '../types/types'
import type { Diagnostic, SourceSpan } from '../errors/diagnostic'
import type { TextEdit } from './codeAction'
import { applyEdits } from './codeAction'
import type { LowerTarget } from '../ir/lower'
import { MetadataReference, type SymbolManifest } from './metadataReference'

// ---------------------------------------------------------------------------
// Tier 1 LSP return types
// ---------------------------------------------------------------------------

/** Result of a hover / quick-info query at a source position. */
export interface HoverInfo {
    readonly symbol: CaaSSymbol
    /** Human-readable type signature, e.g. "(fn add) Int, Int → Int". */
    readonly typeDisplay: string
    /** Doc comment immediately preceding the definition, if present. */
    readonly docComment?: string
    /** Span to highlight in the editor (the identifier the cursor is over). */
    readonly range?: SourceRange
}

/** One entry in a completion list. */
export interface CompletionItem {
    readonly label: string
    readonly kind: 'function' | 'variable' | 'type' | 'parameter' | 'keyword'
    readonly detail?: string
    readonly docComment?: string
}

/** Per-parameter info for a signature-help popup. */
export interface ParameterInfo {
    readonly name: string
    readonly type?: string
}

/**
 * Options for cancellable workspace queries (CaaS tracker 4e).  Silicon's
 * pipeline is synchronous, so cancellation is cooperative: the query throws
 * (`AbortError`) at its checkpoints if the signal is already aborted.  This is
 * the minimal surface for an async LSP front end to abort superseded requests.
 */
export interface CancellableOptions {
    readonly cancel?: AbortSignal
}

/** Options for {@link Workspace.getCompletions}. */
export interface CompletionOptions extends CancellableOptions {
    /**
     * ADR-0024 — when the cursor follows a `mod::` qualifier, restrict
     * suggestions to module `mod`'s public (`@pub`) members.
     */
    readonly module?: string
}

/** Result of a signature-help query (cursor is inside a function call argument list). */
export interface SignatureHelp {
    readonly name: string
    readonly parameters: readonly ParameterInfo[]
    /** 0-based index of the parameter the cursor is currently editing. */
    readonly activeParameter: number
}

/**
 * A multi-file set of text edits — the result of a rename (CaaS tracker 4d).
 *
 * Extends `Map<uri, TextEdit[]>` (so existing `.get`/`.set`/iteration keep
 * working) and adds `applyTo` for applying the whole edit to a `Workspace` as
 * one operation, plus `changeCount` / `uris` conveniences.
 *
 * @public — Silicon 1.0 stable.
 */
export class WorkspaceEdit extends Map<string, TextEdit[]> {
    /** Total number of individual text edits across all files. */
    get changeCount(): number {
        let n = 0
        for (const edits of this.values()) n += edits.length
        return n
    }

    /** The document URIs this edit touches. */
    get uris(): string[] {
        return [...this.keys()]
    }

    /**
     * Apply every edit to its document in `workspace` (via `editDocument`).
     * Per-file edits are applied together (`applyEdits` sorts them bottom-up so
     * offsets don't shift).  Documents not open in the workspace are skipped.
     * Returns the URIs that were changed.
     */
    applyTo(workspace: Workspace): string[] {
        const changed: string[] = []
        for (const [uri, edits] of this) {
            const doc = workspace.getDocument(uri)
            if (!doc || edits.length === 0) continue
            workspace.editDocument(uri, applyEdits(doc.source, edits))
            changed.push(uri)
        }
        return changed
    }
}

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
    /** Name of the project this document belongs to, or undefined if unassigned (CaaS tracker 3a). */
    readonly projectName?: string
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

/** Options for a Project created via {@link Workspace.addProject} (CaaS tracker 3a). */
export interface ProjectOptions {
    /**
     * Compile target for every document in this project.  Threaded into the
     * typechecker so portability diagnostics (E0012 / E0013) fire for
     * `'wasm-gc'` projects.  Defaults to `'host'`.
     */
    target?: LowerTarget
}

/** One entry in the workspace symbol index. */
interface IndexEntry {
    readonly uri: string
    readonly symbol: CaaSSymbol
}

export class Workspace {
    #registry: ElaboratorRegistry | undefined
    readonly #docs = new Map<string, Document>()
    readonly #listeners = new Set<ChangeListener>()

    /**
     * Workspace-level symbol index — maps symbol name to all known definitions
     * across open documents.  Updated on every open / edit / close.
     *
     * When multiple documents define a symbol with the same name all entries
     * are retained.  `findDefinition` returns the first candidate; callers that
     * need all candidates can use `findDefinitions`.  Full disambiguation of
     * same-named cross-file symbols requires a cross-file type checker.
     */
    readonly #symbolIndex = new Map<string, IndexEntry[]>()

    /** Named projects (CaaS tracker 3a), keyed by project name. */
    readonly #projects = new Map<string, Project>()

    /** Reverse index: document URI → owning project (unassigned URIs are absent). */
    readonly #docToProject = new Map<string, Project>()

    /** Workspace-global metadata references (CaaS tracker 3c), keyed by name. */
    readonly #references = new Map<string, MetadataReference>()

    /**
     * Per-document incremental-elaboration cache (incremental semantics E1b):
     * the prior compile's per-element-group elaboration + a strata signature to
     * detect a stale registry.  Lets an edit re-elaborate only changed elements.
     *
     * Also carries the prior per-group *type-check* cache (E2) plus the
     * cross-document / target signatures that gate type reuse: an edit replays
     * the unchanged prefix's type results when these are stable.
     */
    readonly #elabState = new Map<string, {
        strataSig: string
        groups: ElabGroup[]
        typeCache: TypeGroupCache[]
        preRegSig: string
        externalSig: string
        target: LowerTarget | undefined
    }>()

    /** @internal Last compile's incremental type-check reuse stats (for tests). */
    _lastTypecheckReuse?: { reused: number; total: number }

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

    // ── projects (CaaS tracker 3a) ─────────────────────────────────────────────

    /**
     * Create a new named project.  Documents added via
     * {@link Project.addDocument} are scoped to it for cross-document type
     * checking — a document only sees symbols defined in its own project plus
     * the transitive closure of that project's dependencies.
     *
     * Documents opened through the flat {@link openDocument} API remain
     * unassigned; while at least one project exists they see only other
     * unassigned documents.
     *
     * Throws if a project named `name` already exists.
     */
    addProject(name: string, options: ProjectOptions = {}): Project {
        if (this.#projects.has(name)) {
            throw new Error(`Project already exists: ${name}`)
        }
        const project = new Project(this, name, options.target ?? 'host')
        this.#projects.set(name, project)
        return project
    }

    /** Retrieve a project by name, or undefined if none exists. */
    getProject(name: string): Project | undefined {
        return this.#projects.get(name)
    }

    /** All projects in this workspace, keyed by name. */
    get projects(): ReadonlyMap<string, Project> {
        return this.#projects
    }

    /** The project a document belongs to, or undefined if it is unassigned. */
    projectOf(uri: string): Project | undefined {
        return this.#docToProject.get(uri)
    }

    // ── metadata references (CaaS tracker 3c) ──────────────────────────────────

    /**
     * Add a **workspace-global** metadata reference — a precompiled library's
     * public symbol surface (no source).  Its symbols become available to
     * **every** document for cross-document type checking, hover, and
     * completion, exactly as if they were defined in another open document.
     *
     * For a reference visible only to one project (and its dependents), use
     * {@link Project.addReference} instead.
     *
     * Replacing a reference of the same name updates it.  Returns the loaded
     * {@link MetadataReference}.
     */
    addReference(manifest: SymbolManifest): MetadataReference {
        const ref = new MetadataReference(manifest)
        if (this.#references.has(ref.name)) this.#removeReferenceFromIndex(ref.name)
        this.#references.set(ref.name, ref)
        this.#addReferenceToIndex(ref)
        return ref
    }

    /** Retrieve a workspace-global reference by name. */
    getReference(name: string): MetadataReference | undefined {
        return this.#references.get(name)
    }

    /** All workspace-global references, keyed by name. */
    get references(): ReadonlyMap<string, MetadataReference> {
        return this.#references
    }

    /** @internal Index a reference's symbols for navigation (called by Project too). */
    _indexReference(ref: MetadataReference): void {
        this.#addReferenceToIndex(ref)
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
        return this.#open(uri, source, undefined)
    }

    /**
     * @internal Open a document and associate it with `project`.  Called by
     * {@link Project.addDocument}; not part of the stable public API.
     */
    _openInProject(uri: string, source: string, project: Project): Document {
        return this.#open(uri, source, project)
    }

    #open(uri: string, source: string, project: Project | undefined): Document {
        if (this.#docs.has(uri)) {
            throw new Error(`Document already open: ${uri}. Use editDocument() to update it.`)
        }
        // Record project membership *before* compiling so cross-document scoping
        // is correct on the first pass.
        if (project) {
            this.#docToProject.set(uri, project)
            project._trackUri(uri)
        }
        const doc = this.#compile(uri, source, 1)
        this.#docs.set(uri, doc)
        this.#updateSymbolIndex(uri, doc)
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
        const doc = this.#compile(uri, newSource, existing.version + 1, existing.tree)
        this.#docs.set(uri, doc)
        this.#updateSymbolIndex(uri, doc)
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
        this.#elabState.delete(uri)
        const project = this.#docToProject.get(uri)
        if (project) {
            project._untrackUri(uri)
            this.#docToProject.delete(uri)
        }
        this.#removeFromSymbolIndex(uri)
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
     * **Cross-document**: if the local SemanticModel does not resolve the
     * symbol (e.g. the function is defined in another open document), the
     * workspace walks the SyntaxNode tree for a Namespace at the position and
     * looks the name up in the workspace symbol index.
     *
     * Returns `undefined` if the document is not open or no symbol covers the
     * position.  Use `symbol.definitionSpan` to jump to the declaration.
     */
    findDefinition(uri: string, line: number, col: number): CaaSSymbol | undefined {
        const doc = this.#docs.get(uri)
        if (!doc) return undefined

        // 1. Local model — handles same-document resolution (fast path).
        const local = doc.model.symbolAtPosition(line, col)
        if (local) return local

        // 2. Walk the elaborated SyntaxNode tree to find a Namespace at the
        //    position, then look the name up in the workspace symbol index. A
        //    qualified `mod::name` is resolved to the matching MODULE (ADR-0024
        //    directory=module), so two modules with a same-named member don't
        //    cross-resolve.
        const nspath = namespacePathAtPosition(doc, line, col)
        if (!nspath || nspath.length === 0) return undefined
        return this.#resolveIndexed(nspath, uri)?.symbol
    }

    /**
     * Resolve a `Namespace` path to a single indexed symbol, honouring project
     * visibility (so an unrelated component never cross-resolves). For a
     * qualified `mod::name`, prefer a candidate whose document lives in module
     * `mod`; otherwise fall back to the first visible candidate.
     */
    #resolveIndexed(nspath: string[], currentUri: string): IndexEntry | undefined {
        const name = nspath[nspath.length - 1]
        const candidates = (this.#symbolIndex.get(name) ?? [])
            .filter(e => this.#isEntryVisible(e.uri, currentUri))
        if (candidates.length === 0) return undefined
        if (nspath.length >= 2) {
            const mod = nspath[nspath.length - 2]
            const inModule = candidates.find(e => moduleOfUri(e.uri) === mod)
            if (inModule) return inModule
        }
        return candidates[0]
    }

    /**
     * Like `findDefinition`, but returns **all** candidate symbols when
     * multiple open documents define a symbol with the same name.
     *
     * Resolves the symbol name at `(line, col)` — via the local SemanticModel
     * or a Namespace-node scan — then returns every workspace-indexed entry
     * for that name.  The common case (unique name) returns a one-element
     * array.  An empty array is returned when no symbol covers the position.
     */
    findDefinitions(uri: string, line: number, col: number): CaaSSymbol[] {
        const doc = this.#docs.get(uri)
        if (!doc) return []

        const local = doc.model.symbolAtPosition(line, col)
        const visible = (name: string) => (this.#symbolIndex.get(name) ?? [])
            .filter(e => this.#isEntryVisible(e.uri, uri))
        if (local) return visible(local.name).map(e => e.symbol)
        const nspath = namespacePathAtPosition(doc, line, col)
        if (!nspath || nspath.length === 0) return []
        // A qualified `mod::name` yields the module-matched candidate first.
        const preferred = this.#resolveIndexed(nspath, uri)
        const all = visible(nspath[nspath.length - 1])
        if (!preferred) return all.map(e => e.symbol)
        return [preferred.symbol, ...all.filter(e => e !== preferred).map(e => e.symbol)]
    }

    /**
     * Find all source spans where the symbol at `(line, col)` in `uri` is
     * referenced, across **all open documents**.
     *
     * **Cross-document**: each open document is searched twice — once via its
     * SemanticModel (typechecker-resolved, exact) and once via an AST scan of
     * Namespace nodes (catches calls that the per-file typechecker could not
     * resolve because the definition lives elsewhere).  Results are
     * deduplicated by `file:line:col`.
     *
     * Returns an empty array if the document is not open, the position covers
     * no symbol, or location info was not recorded.
     */
    findReferences(uri: string, line: number, col: number, options: CancellableOptions = {}): readonly SourceSpan[] {
        options.cancel?.throwIfAborted()
        const doc = this.#docs.get(uri)
        if (!doc) return []

        // Resolve the symbol name at the given position.
        const localSym = doc.model.symbolAtPosition(line, col)
        const name = localSym?.name ?? namespaceNameAtPosition(doc, line, col)
        if (!name) return []

        // Aggregate spans from all open documents.
        const seen = new Set<string>()
        const spans: SourceSpan[] = []

        function add(span: SourceSpan) {
            const key = `${span.file}:${span.line}:${span.col}`
            if (seen.has(key)) return
            seen.add(key)
            spans.push(span)
        }

        for (const [docUri, d] of this.#docs) {
            options.cancel?.throwIfAborted()
            if (!this.#isEntryVisible(docUri, uri)) continue   // scope to the active project
            // Typechecker-resolved references (accurate for same-doc, and for
            // any doc compiled with the symbol in scope).
            for (const span of d.model.referenceSpansForName(name)) add(span)

            // AST-based scan — catches cross-file calls the typechecker missed.
            for (const span of namespaceScanForName(d, name)) add(span)
        }

        return spans
    }

    // ── LSP Tier 1 ────────────────────────────────────────────────────────────

    /**
     * Return hover / quick-info for the symbol at `(line, col)` in `uri`.
     *
     * Tries the local SemanticModel first, then falls back to a Namespace scan
     * + workspace symbol index (cross-document).  Returns `undefined` when no
     * symbol covers the position or the document is not open.
     */
    hoverInfo(uri: string, line: number, col: number): HoverInfo | undefined {
        const doc = this.#docs.get(uri)
        if (!doc) return undefined

        const sym = doc.model.symbolAtPosition(line, col) ?? (() => {
            const name = namespaceNameAtPosition(doc, line, col)
            return name ? this.#symbolIndex.get(name)?.[0]?.symbol : undefined
        })()
        if (!sym) return undefined

        const docComment = docCommentForName(doc, sym.name)
        const range = sym.definitionSpan ? spanToRange(sym.definitionSpan) : undefined

        return { symbol: sym, typeDisplay: sym.displayString, docComment, range }
    }

    /**
     * Return completion candidates visible at `(line, col)` in `uri`.
     *
     * Collects all symbols from the current document's SemanticModel plus every
     * symbol in the workspace index (cross-document names), then filters by
     * `prefix` (case-insensitive substring match on the label).  Silicon
     * keywords are appended as `'keyword'` items.
     *
     * Returns an empty array when the document is not open.
     */
    getCompletions(uri: string, _line: number, _col: number, prefix?: string, options: CompletionOptions = {}): CompletionItem[] {
        options.cancel?.throwIfAborted()
        const doc = this.#docs.get(uri)
        if (!doc) return []

        const seen = new Set<string>()
        const items: CompletionItem[] = []

        function add(sym: CaaSSymbol, docStr?: Document) {
            if (seen.has(sym.name)) return
            seen.add(sym.name)
            items.push({
                label:      sym.name,
                kind:       sym.kind === 'stratum' ? 'keyword' : sym.kind,
                detail:     sym.displayString,
                docComment: docStr ? docCommentForName(docStr, sym.name) : undefined,
            })
        }

        // ADR-0024: a qualified `mod::` context offers ONLY module `mod`'s public
        // (`@pub`) members — no locals, no keywords, no other modules.
        if (options.module) {
            for (const [, entries] of this.#symbolIndex) {
                options.cancel?.throwIfAborted()
                for (const entry of entries) {
                    if (moduleOfUri(entry.uri) !== options.module) continue
                    if (!this.#isEntryVisible(entry.uri, uri)) continue
                    if ((entry.symbol.definitionNode as { pub?: boolean })?.pub !== true) continue
                    add(entry.symbol, this.#docs.get(entry.uri))
                }
            }
            if (!prefix) return items
            const lpm = prefix.toLowerCase()
            return items.filter(it => it.label.toLowerCase().includes(lpm))
        }

        // Local symbols first (highest priority).
        for (const sym of doc.model.allSymbols) add(sym, doc)

        // Cross-document symbols from the workspace index, scoped to what this
        // document's project can actually see (CaaS tracker 3a) — don't suggest
        // symbols from unrelated projects or out-of-scope references.
        for (const [, entries] of this.#symbolIndex) {
            options.cancel?.throwIfAborted()
            for (const entry of entries) {
                if (!this.#isEntryVisible(entry.uri, uri)) continue
                const entryDoc = this.#docs.get(entry.uri)
                add(entry.symbol, entryDoc)
            }
        }

        // Built-in Silicon keywords.
        for (const kw of SILICON_KEYWORDS) {
            if (!seen.has(kw)) {
                seen.add(kw)
                items.push({ label: kw, kind: 'keyword' })
            }
        }

        if (!prefix) return items
        const lp = prefix.toLowerCase()
        return items.filter(it => it.label.toLowerCase().includes(lp))
    }

    /**
     * Return signature-help information when the cursor at `(line, col)` in
     * `uri` is inside a function call argument list.
     *
     * Walks the elaborated `SyntaxNode` tree upward from the cursor looking for
     * a `FunctionCall` node whose span contains the position, then resolves the
     * callee and counts commas before the cursor to determine the active
     * parameter index.
     *
     * Returns `undefined` when the position is not inside a call or the callee
     * cannot be resolved.
     */
    signatureHelp(uri: string, line: number, col: number): SignatureHelp | undefined {
        const doc = this.#docs.get(uri)
        if (!doc) return undefined

        const callInfo = functionCallAtPosition(doc, line, col)
        if (!callInfo) return undefined

        const { calleeName, activeParameter } = callInfo

        const sym = doc.model.symbolNamed(calleeName)
                 ?? this.#symbolIndex.get(calleeName)?.[0]?.symbol
        if (!sym || sym.type?.kind !== 'Function') return undefined

        const params: ParameterInfo[] = sym.type.params.map((pt, i) => {
            const pname = paramNameForPosition(doc, calleeName, i) ?? `p${i}`
            return { name: pname, type: typeDisplayString(pt) }
        })

        return { name: calleeName, parameters: params, activeParameter }
    }

    /**
     * Rename the symbol at `(line, col)` in `uri` to `newName` across all open
     * documents.
     *
     * Uses `findReferences` (cross-document) plus the symbol's own
     * `definitionSpan` to build a per-file list of `TextEdit`s.  Returns an
     * empty map when no symbol covers the position or the document is not open.
     */
    rename(uri: string, line: number, col: number, newName: string): WorkspaceEdit {
        const result = new WorkspaceEdit()

        function addEdit(span: SourceSpan) {
            const edits = result.get(span.file)
            if (edits) {
                edits.push({ span, newText: newName })
            } else {
                result.set(span.file, [{ span, newText: newName }])
            }
        }

        const refs = this.findReferences(uri, line, col)
        for (const span of refs) addEdit(span)

        const sym = this.findDefinition(uri, line, col)
        if (sym?.definitionSpan) addEdit(sym.definitionSpan)

        return result
    }

    /**
     * Return `TextEdit`s that normalize the formatting of the entire document
     * at `uri`.
     *
     * Produces a single edit that replaces the whole file with a
     * whitespace-normalized version: consistent spacing around operators, after
     * commas, inside blocks, and between top-level definitions.  Whitespace
     * inside string literals is preserved.
     *
     * Note: without a trivia layer this is a lossy "normalize" operation — user
     * style choices that deviate from the canonical format are not preserved.
     * Full style-preserving formatting requires trivia (CaaS tracker 2e).
     *
     * Returns an empty array when the document is not open.
     */
    formatDocument(uri: string): TextEdit[] {
        const doc = this.#docs.get(uri)
        if (!doc) return []
        return formatSource(doc.source, uri)
    }

    /**
     * Like `formatDocument`, but restricted to `range` (1-based, end-exclusive).
     *
     * Expands the range to whole lines before formatting so that partial-line
     * edits don't create invalid Silicon source.
     *
     * Returns an empty array when the document is not open.
     */
    formatRange(uri: string, range: SourceRange): TextEdit[] {
        const doc = this.#docs.get(uri)
        if (!doc) return []

        const lines = doc.source.split('\n')
        const startIdx = range.startLine - 1
        const endIdx   = Math.min(range.endLine - 1, lines.length - 1)

        const slice  = lines.slice(startIdx, endIdx + 1).join('\n')
        const normalized = normalizeSource(slice)

        const editSpan: SourceSpan = {
            file:   uri,
            line:   range.startLine,
            col:    1,
            length: slice.length,
        }
        if (normalized === slice) return []
        return [{ span: editSpan, newText: normalized }]
    }

    /**
     * Workspace-wide symbol search (LSP `workspace/symbol`, Ctrl-T).  Returns
     * every user-written, located symbol whose name contains `query`
     * (case-insensitive; empty query returns all).  Deduplicated by
     * (name, file, line); implicit/synthesized symbols are excluded.
     */
    workspaceSymbols(query: string): CaaSSymbol[] {
        const q = query.toLowerCase()
        const out: CaaSSymbol[] = []
        const seen = new Set<string>()
        for (const entries of this.#symbolIndex.values()) {
            for (const { symbol } of entries) {
                if (symbol.isImplicitlyDeclared || !symbol.definitionSpan) continue
                if (q && !symbol.name.toLowerCase().includes(q)) continue
                const sp = symbol.definitionSpan
                const key = `${symbol.name} ${sp.file} ${sp.line}`
                if (seen.has(key)) continue
                seen.add(key)
                out.push(symbol)
            }
        }
        return out
    }

    /**
     * Go-to-type-definition (LSP `textDocument/typeDefinition`): resolve the
     * symbol at `(line, col)`, then jump to the definition of its *type* (e.g.
     * the `@type`/`@enum` declaration of a `Sum`/`Distinct`).  Returns the
     * type's defining symbol, or `undefined` when the type is built-in /
     * anonymous / not found.
     */
    typeDefinition(uri: string, line: number, col: number): CaaSSymbol | undefined {
        const sym = this.findDefinition(uri, line, col)
        const t = sym?.type as { kind?: string; name?: string; element?: any } | undefined
        if (!t) return undefined
        // The named, user-declarable type kinds.  Vec[T] unwraps to its element.
        let typeName: string | undefined
        if (t.kind === 'Sum' || t.kind === 'Distinct') typeName = t.name
        else if (t.kind === 'Vec' && t.element && (t.element.kind === 'Sum' || t.element.kind === 'Distinct')) {
            typeName = t.element.name
        }
        if (!typeName) return undefined
        return this.#resolveIndexed([typeName], uri)?.symbol
    }

    // ── internal ──────────────────────────────────────────────────────────────

    #compile(uri: string, source: string, version: number, priorTree?: SyntaxTree): Document {
        const allDiags: Diagnostic[] = []

        // 1. Parse — incrementally from the prior tree when this is an edit
        //    (reparses only the damaged window; byte-identical to a full parse),
        //    or a fresh full parse on first open.
        const parseResult = priorTree ? priorTree.withText(source, { file: uri }) : parse(source, { file: uri })
        allDiags.push(...parseResult.diagnostics)

        // 2. Build or reuse registry.  Rebuild when this document's `@stratum`
        //    definitions changed — the registry is otherwise frozen, so a strata
        //    edit would make incremental results diverge from a fresh compile.
        const prior = this.#elabState.get(uri)
        const strataSig = stratumSignature(parseResult.tree.program)
        if (!this.#registry || (prior !== undefined && prior.strataSig !== strataSig)) {
            this.#registry = buildRegistry(parseResult.tree)
        }
        const registry = this.#registry

        // 3. Elaborate — reuse the prior compile's per-element elaboration for
        //    unchanged elements when the parse was incremental and the registry is
        //    unchanged (incremental semantics E1b); otherwise elaborate fresh.
        //    Elaboration is element-local, so the spliced result is byte-identical
        //    to a full elaborate().
        const extents = parseResult.tree._extents
        let elabTree: SyntaxTree
        let elabGroups: ElabGroup[] | undefined
        let elabReused = false   // whether the prefix elaboration was reused (E1b)
        if (extents !== undefined) {
            const canReuse = parseResult._elementReuse !== undefined
                && prior !== undefined && prior.strataSig === strataSig
            const elab = canReuse
                ? incrementalElaborate(extents, parseResult._elementReuse!, prior!.groups, registry)
                : elaborateGroupsFull(extents, registry)
            allDiags.push(...elabErrorsToDiagnostics(elab.errors))
            elabTree = new SyntaxTree(elab.program, source, uri)
            elabGroups = elab.groups
            elabReused = canReuse
        } else {
            // No extents (e.g. a parse error produced a minimal tree) — full
            // elaborate, no per-element cache.
            const elabResult = elaborate(parseResult.tree, registry)
            allDiags.push(...elabResult.diagnostics)
            elabTree = elabResult.tree
            elabGroups = undefined
        }

        // 4. Typecheck — pass cross-document symbols so references to definitions
        //    in other open Workspace documents don't produce "unbound identifier"
        //    errors and resolve to their correct types (CaaS-2g).  External
        //    symbols are scoped to this document's project + dependency closure
        //    (CaaS tracker 3a); the project's compile target is threaded through
        //    so portability diagnostics fire for `wasm-gc` projects.
        //
        //    Incremental type-check (E2): when the prefix elaboration was reused
        //    and the cross-doc/target inputs are unchanged, replay the unchanged
        //    prefix's type results and re-check only the suffix — byte-identical
        //    to a full check.  `typecheck()` stays the oracle: a discard-on-
        //    mismatch tripwire under SIGIL_INCREMENTAL_VERIFY, and the fallback
        //    whenever the per-group engine can't apply.
        const project = this.#docToProject.get(uri)
        const externalSymbols = this.#buildExternalSymbols(uri)
        const externalSig = externalSymbolsSignature(externalSymbols)
        const target = project?.target

        // Parameter-type inference (ADR-0020: signatures are optional) is a
        // WHOLE-PROGRAM analysis — an unannotated @fn param's type is read off
        // its call sites, which may live in elements the per-group incremental
        // engine would replay from cache without re-examining.  When the document
        // has any such function, fall back to the full `typecheck()` oracle (which
        // runs the inference pre-pass) instead of the per-group engine, so the LSP
        // sees inferred types rather than a spurious "could not infer" (E0015).
        const needsParamInference = programNeedsParamInference(elabTree.program)

        let model: SemanticModel
        let typeCache: TypeGroupCache[] | undefined
        let preRegSig: string | undefined
        if (elabGroups !== undefined && !needsParamInference) {
            const reuseType = elabReused
                && prior !== undefined
                && prior.externalSig === externalSig
                && prior.target === target
                && parseResult._elementReuse !== undefined
            const priorType: PriorTypeState | undefined = reuseType
                ? { reuse: parseResult._elementReuse!, cache: prior!.typeCache, preRegSig: prior!.preRegSig }
                : undefined
            const result = incrementalTypecheck(
                elabTree.program, elabGroups, source, uri, registry,
                { externalSymbols, target }, priorType,
            )
            model = result.model
            typeCache = result.cache
            preRegSig = result.preRegSig
            allDiags.push(...result.diagnostics)
            this._lastTypecheckReuse = { reused: result.reusedGroups, total: result.totalGroups }

            if (this.#verifyIncremental) {
                this.#verifyTypecheckAgainstOracle(uri, source, elabTree, registry, externalSymbols, target, result)
            }
        } else {
            // Full oracle path — taken when no per-group cache is available (a
            // parse-error tree) OR when the document needs whole-program parameter
            // inference (`needsParamInference`).  `typecheck()` runs the inference
            // pre-pass and back-fills inferred parameter types.
            const checkResult = typecheck(elabTree, registry, { externalSymbols, target })
            model = checkResult.model
            allDiags.push(...checkResult.diagnostics)
        }

        // Cache (or clear) this document's per-element elaboration + type results.
        if (elabGroups !== undefined && typeCache !== undefined && preRegSig !== undefined) {
            this.#elabState.set(uri, { strataSig, groups: elabGroups, typeCache, preRegSig, externalSig, target })
        } else {
            this.#elabState.delete(uri)
        }

        return {
            uri,
            source,
            version,
            projectName: project?.name,
            tree: parseResult.tree,
            elabTree,
            model,
            diagnostics: allDiags,
        }
    }

    /** Compare the incremental type-check against a full oracle run and warn on any
     *  divergence (the model already returned is the incremental one; this is a
     *  CI/canary tripwire, not a production fallback).
     *
     *  Two env vars enable it, with a deliberate difference:
     *   - `SIGIL_INCREMENTAL_VERIFY=1` also engages the PARSE-layer tripwire, which
     *     discards an incremental parse on any node mismatch — and a prior typecheck
     *     dirties reused parse nodes, so reuse is effectively OFF.  This verifies the
     *     engine's full-capture path == oracle.
     *   - `SIGIL_E2_VERIFY=1` engages ONLY this semantic tripwire, leaving parse +
     *     elaboration reuse ON — so it verifies the prefix-REUSE path == oracle.
     *  The incremental≡fresh equivalence property suite verifies reuse vs a fresh
     *  Workspace independently of either flag. */
    readonly #verifyIncremental = typeof process !== 'undefined'
        && (process.env?.SIGIL_INCREMENTAL_VERIFY === '1' || process.env?.SIGIL_E2_VERIFY === '1')

    #verifyTypecheckAgainstOracle(
        uri: string,
        source: string,
        elabTree: SyntaxTree,
        registry: ElaboratorRegistry,
        externalSymbols: ReadonlyMap<string, SiliconType>,
        target: LowerTarget | undefined,
        incremental: { model: SemanticModel; diagnostics: Diagnostic[] },
    ): void {
        // Build the oracle from an INDEPENDENT fresh parse+elaborate of the same
        // source, so it cannot mutate the live tree's shared nodes (a tripwire
        // must observe, not perturb).  Its diagnostics + symbols + per-node types
        // must equal the incremental result's.
        const oracleTree = elaborate(parse(source, { file: uri }).tree, registry).tree
        const oracle = typecheck(oracleTree, registry, { externalSymbols, target })
        const digest = (model: SemanticModel, root: any, diags: Diagnostic[]): string => {
            const syms = [...model.allSymbols]
                .map(s => `${s.name}|${s.kind}|${s.displayString}|${s.definitionSpan?.line ?? '-'}:${s.definitionSpan?.col ?? '-'}|${s.isImplicitlyDeclared}`)
                .sort().join('\n')
            const d = diags.map(x => `${x.code}@${x.span.line}:${x.span.col}+${x.span.length}:${x.message}`).sort().join('\n')
            const types: string[] = []
            const walk = (n: any): void => {
                if (n === null || typeof n !== 'object') return
                const t = model.typeOf(n)
                types.push(t ? JSON.stringify(t) : '-')
                for (const c of astChildren(n)) walk(c)
            }
            walk(root)
            return `SYMS\n${syms}\nDIAGS\n${d}\nTYPES\n${types.join(',')}`
        }
        const incDigest = digest(incremental.model, elabTree.program, incremental.diagnostics)
        const oracleDigest = digest(oracle.model, oracleTree.program, oracle.diagnostics)
        if (incDigest !== oracleDigest) {
            // eslint-disable-next-line no-console
            console.error(`[SIGIL_INCREMENTAL_VERIFY] incremental type-check diverged from oracle for ${uri}`)
        }
    }

    #emit(event: DocumentChangeEvent): void {
        for (const listener of this.#listeners) {
            listener(event)
        }
    }

    /**
     * Build a map of `name → SiliconType` from the documents *visible* to
     * `currentUri` (excluding itself).  Passed to the typechecker as
     * `externalSymbols` so cross-document references resolve correctly
     * (CaaS-2g), scoped per-project (CaaS tracker 3a).
     */
    #buildExternalSymbols(currentUri: string): ReadonlyMap<string, SiliconType> {
        const visible = this.#visibleUris(currentUri)
        const ext = new Map<string, SiliconType>()
        for (const [uri, doc] of this.#docs) {
            if (uri === currentUri) continue
            if (visible && !visible.has(uri)) continue
            const module = moduleOfUri(uri)
            for (const sym of doc.model.allSymbols) {
                if (!sym.type) continue
                if (!ext.has(sym.name)) ext.set(sym.name, sym.type)
                // ADR-0024: also expose the module-qualified spelling so a
                // cross-module `mod::name` reference type-resolves (and does
                // not raise a spurious "unbound" diagnostic).
                if (module) {
                    const qualified = `${module}::${sym.name}`
                    if (!ext.has(qualified)) ext.set(qualified, sym.type)
                }
            }
        }
        // CaaS tracker 3c — metadata references.  Open-document symbols take
        // precedence (added first), so a local definition shadows a library one.
        const addRef = (ref: MetadataReference): void => {
            for (const ms of ref.symbols.values()) {
                if (!ext.has(ms.name)) ext.set(ms.name, ms.type)
            }
        }
        for (const ref of this.#references.values()) addRef(ref)          // global
        const owner = this.#docToProject.get(currentUri)                  // project-scoped
        if (owner) {
            for (const project of owner._depClosure()) {
                for (const ref of project.references) addRef(ref)
            }
        }
        return ext
    }

    /**
     * Whether a symbol-index entry (by its source URI — a document URI or a
     * `metadata:<ref>` URI) is visible to `currentUri` given project scoping
     * (CaaS tracker 3a/3c).  With no projects, everything is visible.
     */
    #isEntryVisible(entryUri: string, currentUri: string): boolean {
        if (entryUri.startsWith('metadata:')) {
            const refName = entryUri.slice('metadata:'.length)
            if (this.#references.has(refName)) return true   // workspace-global reference
            const owner = this.#docToProject.get(currentUri)
            if (!owner) return false
            for (const project of owner._depClosure()) {
                if (project.references.some(r => r.name === refName)) return true
            }
            return false
        }
        const visible = this.#visibleUris(currentUri)
        return visible === undefined || visible.has(entryUri)
    }

    /** Add a reference's synthesized symbols to the (global) navigation index. */
    #addReferenceToIndex(ref: MetadataReference): void {
        for (const sym of ref.caasSymbols()) {
            const existing = this.#symbolIndex.get(sym.name)
            if (existing) existing.push({ uri: ref.uri, symbol: sym })
            else this.#symbolIndex.set(sym.name, [{ uri: ref.uri, symbol: sym }])
        }
    }

    /** Drop a reference's symbols from the navigation index (by its synthetic URI). */
    #removeReferenceFromIndex(name: string): void {
        const uri = `metadata:${name}`
        for (const [n, entries] of this.#symbolIndex) {
            const filtered = entries.filter(e => e.uri !== uri)
            if (filtered.length === 0) this.#symbolIndex.delete(n)
            else if (filtered.length !== entries.length) this.#symbolIndex.set(n, filtered)
        }
    }

    /**
     * The set of document URIs whose symbols are visible to `currentUri` for
     * cross-document type checking, or `undefined` when no projects exist — the
     * legacy flat behavior where every document sees every other.
     *
     * With at least one project:
     *   - A document in project P sees P plus P's transitive dependency closure.
     *   - An unassigned document sees only other unassigned documents.
     *
     * Visibility follows dependency direction: if B depends on A, B's documents
     * see A's symbols but not vice versa.
     */
    #visibleUris(currentUri: string): Set<string> | undefined {
        if (this.#projects.size === 0) return undefined

        const owner = this.#docToProject.get(currentUri)
        const set = new Set<string>()

        // Unassigned document — only other unassigned documents are visible.
        if (!owner) {
            for (const uri of this.#docs.keys()) {
                if (!this.#docToProject.has(uri)) set.add(uri)
            }
            return set
        }

        // Assigned document — its project plus the transitive dependency closure.
        const closure = owner._depClosure()
        for (const [uri, project] of this.#docToProject) {
            if (closure.has(project)) set.add(uri)
        }
        return set
    }

    /** Rebuild index entries for one document after a compile. */
    #updateSymbolIndex(uri: string, doc: Document): void {
        // Drop stale entries for this URI from every bucket.
        for (const [name, entries] of this.#symbolIndex) {
            const filtered = entries.filter(e => e.uri !== uri)
            if (filtered.length === 0) {
                this.#symbolIndex.delete(name)
            } else if (filtered.length !== entries.length) {
                this.#symbolIndex.set(name, filtered)
            }
        }
        // Re-add all symbols from the freshly compiled document.
        for (const sym of doc.model.allSymbols) {
            const existing = this.#symbolIndex.get(sym.name)
            if (existing) {
                existing.push({ uri, symbol: sym })
            } else {
                this.#symbolIndex.set(sym.name, [{ uri, symbol: sym }])
            }
        }
    }

    /** Remove all index entries for a closed document. */
    #removeFromSymbolIndex(uri: string): void {
        for (const [name, entries] of this.#symbolIndex) {
            const filtered = entries.filter(e => e.uri !== uri)
            if (filtered.length === 0) {
                this.#symbolIndex.delete(name)
            } else if (filtered.length !== entries.length) {
                this.#symbolIndex.set(name, filtered)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Project (CaaS tracker 3a)
// ---------------------------------------------------------------------------

/**
 * A named group of documents within a {@link Workspace}.
 *
 * Projects partition an otherwise-flat workspace into independently-scoped
 * units, each with its own compile target and a set of dependency edges to
 * other projects.  Cross-document type checking is scoped to a document's own
 * project plus the transitive closure of that project's dependencies: a symbol
 * defined in project A is visible to project B only if B depends — directly or
 * transitively — on A.
 *
 * Obtain one via {@link Workspace.addProject}; never construct it directly.
 *
 *   const core = ws.addProject('core')
 *   const app  = ws.addProject('app')
 *   app.addDependency(core)
 *   core.addDocument('core/math.si', '@fn add x, y := { x + y };')
 *   app.addDocument('app/main.si',  '@let r := &add 1, 2;')  // resolves `add`
 *
 * @public — Silicon 1.0 stable.
 */
export class Project {
    /** The project name — unique within its Workspace. */
    readonly name: string
    /** Compile target applied to every document in this project. */
    readonly target: LowerTarget

    readonly #ws: Workspace
    readonly #uris = new Set<string>()
    readonly #deps = new Set<Project>()
    readonly #references = new Map<string, MetadataReference>()

    /** @internal Use {@link Workspace.addProject}, not this constructor. */
    constructor(ws: Workspace, name: string, target: LowerTarget) {
        this.#ws = ws
        this.name = name
        this.target = target
    }

    /**
     * Open `source` as a new document and add it to this project.
     *
     * Delegates to the parent {@link Workspace} — all compilation phases run,
     * the workspace symbol index updates, and an `'opened'` change event fires.
     * Project membership is recorded before compilation so cross-document
     * scoping is correct on the first pass.
     *
     * Throws if a document with `uri` is already open anywhere in the workspace.
     */
    addDocument(uri: string, source: string): Document {
        return this.#ws._openInProject(uri, source, this)
    }

    /**
     * Add a dependency edge to `other`, making every symbol defined in `other`
     * (and `other`'s own transitive dependencies) visible to this project's
     * documents during cross-document type checking.
     *
     * Idempotent.  Cycles and self-dependencies are tolerated — the visibility
     * closure walk is cycle-safe.  Note that already-compiled documents are not
     * automatically re-checked; edit a document to pick up newly-visible symbols.
     */
    addDependency(other: Project): void {
        this.#deps.add(other)
    }

    /** The direct dependency edges added via {@link addDependency}. */
    get dependencies(): readonly Project[] {
        return [...this.#deps]
    }

    /**
     * Add a metadata reference scoped to this project (CaaS tracker 3c) — a
     * precompiled library's symbols become available to this project's documents
     * and to any project that depends on it, but not workspace-wide.  Its symbols
     * are also added to the global navigation index (hover / completion /
     * go-to-definition are workspace-global).  Returns the loaded reference.
     */
    addReference(manifest: SymbolManifest): MetadataReference {
        const ref = new MetadataReference(manifest)
        this.#references.set(ref.name, ref)
        this.#ws._indexReference(ref)
        return ref
    }

    /** The metadata references attached to this project. */
    get references(): readonly MetadataReference[] {
        return [...this.#references.values()]
    }

    /** URIs of every document currently in this project. */
    get documentUris(): readonly string[] {
        return [...this.#uris]
    }

    /** The compiled documents currently in this project. */
    get documents(): Document[] {
        const out: Document[] = []
        for (const uri of this.#uris) {
            const doc = this.#ws.getDocument(uri)
            if (doc) out.push(doc)
        }
        return out
    }

    /** @internal Track `uri` as a member of this project. */
    _trackUri(uri: string): void {
        this.#uris.add(uri)
    }

    /** @internal Stop tracking `uri` (the document was closed). */
    _untrackUri(uri: string): void {
        this.#uris.delete(uri)
    }

    /**
     * @internal The transitive dependency closure including `this`.  Cycle-safe
     * via a visited set.  Used by the Workspace to compute cross-document
     * symbol visibility.
     */
    _depClosure(): Set<Project> {
        const result = new Set<Project>()
        const stack: Project[] = [this]
        while (stack.length > 0) {
            const project = stack.pop()!
            if (result.has(project)) continue
            result.add(project)
            for (const dep of project.#deps) stack.push(dep)
        }
        return result
    }
}

// ---------------------------------------------------------------------------
// Helpers — SyntaxNode-based position + name lookup
// ---------------------------------------------------------------------------

/**
 * Walk the elaborated SyntaxNode tree of `doc` looking for a `Namespace`
 * node whose span contains `(line, col)`.  Returns the last path segment
 * (the simple identifier name) on a hit, or `undefined`.
 *
 * Used as a cross-document fallback when `SemanticModel.symbolAtPosition`
 * returns nothing (the typechecker didn't have visibility into the definition).
 */
function namespaceNameAtPosition(doc: Document, line: number, col: number): string | undefined {
    return namespacePathAtPosition(doc, line, col)?.at(-1)
}

/**
 * Like {@link namespaceNameAtPosition} but returns the full `Namespace` path
 * (`['math','square']` for `math::square`) so a caller can disambiguate a
 * cross-module reference by its module qualifier (ADR-0024).
 */
function namespacePathAtPosition(doc: Document, line: number, col: number): string[] | undefined {
    for (const node of doc.elabTree.root.descendantsOfKind('Namespace')) {
        const span = node.span   // SourceRange | undefined
        if (!span) continue
        if (!rangeContainsPos(span, line, col)) continue
        const path: string[] = (node._node as any).path ?? []
        return path
    }
    return undefined
}

/**
 * The module a document belongs to under ADR-0024's directory=module rule: the
 * base name of the file's containing directory (`…/math/ops.si` → `math`).
 * Returns `''` for metadata/synthetic URIs and unparseable inputs.
 */
function moduleOfUri(uri: string): string {
    const noFile = uri.replace(/\/[^/]*$/, '')          // drop the filename segment
    if (noFile === uri) return ''                       // no '/', e.g. metadata:<name>
    const seg = noFile.replace(/^.*\//, '')             // last directory segment
    return seg
}

/**
 * Scan the elaborated SyntaxNode tree of `doc` for every `Namespace` node
 * whose last path segment matches `name`.  Returns a `SourceSpan` for each
 * hit, tagged with `doc.uri` as the file.
 *
 * Best-effort: may include references to a same-named but distinct symbol
 * (e.g. a local variable that shadows a cross-file function).
 */
function namespaceScanForName(doc: Document, name: string): SourceSpan[] {
    const spans: SourceSpan[] = []
    for (const node of doc.elabTree.root.descendantsOfKind('Namespace')) {
        const path: string[] = (node._node as any).path ?? []
        if (path.at(-1) !== name) continue
        const span = node.span
        if (!span) continue
        spans.push({
            file: doc.uri,
            line: span.startLine,
            col:  span.startCol,
            // endCol is exclusive; length is the number of characters.
            length: span.endLine === span.startLine
                ? span.endCol - span.startCol
                : name.length,   // multi-line namespace (shouldn't occur in practice)
        })
    }
    return spans
}

/** True when the 1-based `(line, col)` falls inside `range` (endCol exclusive). */
function rangeContainsPos(range: SourceRange, line: number, col: number): boolean {
    if (line < range.startLine || line > range.endLine) return false
    if (line === range.startLine && col < range.startCol) return false
    if (line === range.endLine   && col >= range.endCol)  return false
    return true
}

/** Convert a SourceSpan to a SourceRange. */
function spanToRange(span: SourceSpan): SourceRange {
    return {
        startLine: span.line,
        startCol:  span.col,
        endLine:   span.line,
        endCol:    span.col + span.length,
    }
}

// ---------------------------------------------------------------------------
// Helpers — doc comment extraction
// ---------------------------------------------------------------------------

/**
 * Return the attached signature text (e.g. `\\ add (Int, Int) → Int`) that
 * precedes the definition of `name` in the document's source text, or
 * `undefined` if none exists.
 *
 * The `\\` signature line is Silicon's closest equivalent to a doc comment —
 * it provides the human-readable type annotation for a definition.
 *
 * Note: the `DocComment` AST node (`##` prefix) is not yet emitted by the
 * handwritten parser.  This function returns `undefined` until that feature
 * is implemented.  Callers receive `undefined` and should skip the
 * `docComment` field rather than showing an empty string.
 */
function docCommentForName(_doc: Document, _name: string): string | undefined {
    return undefined
}

// ---------------------------------------------------------------------------
// Helpers — signature help
// ---------------------------------------------------------------------------

/**
 * Detect whether the cursor at `(line, col)` is inside a function call
 * argument list by scanning the source text backward from the cursor.
 *
 * FunctionCall AST nodes do not record source spans in the handwritten parser,
 * so we use a text-based heuristic instead:
 *   - Scan backward past whitespace and argument expressions.
 *   - Track brace/bracket depth so nested calls don't confuse the counter.
 *   - When we hit `&name` at depth 0, we've found the callee.
 *   - The number of commas encountered at depth 0 is the active parameter index.
 *
 * Returns `undefined` if no function call start is found before a `;` or the
 * beginning of the line.
 */
function functionCallAtPosition(
    doc: Document,
    line: number,
    col: number,
): { calleeName: string; activeParameter: number } | undefined {
    const lines = doc.source.split('\n')
    const lineText = lines[line - 1] ?? ''

    let depth = 0   // nesting depth inside {}/()
    let commas = 0  // commas at depth 0 before the cursor
    let i = col - 2  // 0-based index, start one char before cursor

    while (i >= 0) {
        const ch = lineText[i]
        if (ch === '}' || ch === ')') { depth++; i--; continue }
        if (ch === '{' || ch === '(') {
            if (depth > 0) { depth--; i--; continue }
            // ADR-0020: parenthesized call — `name(args)`. Scan back for identifier.
            if (ch === '(') {
                let j = i - 1
                while (j >= 0 && /[a-zA-Z0-9_:]/.test(lineText[j])) j--
                const ident = lineText.slice(j + 1, i)
                if (ident.length > 0 && /^[a-zA-Z_]/.test(ident)) {
                    return { calleeName: ident.replace(/^.*::/, ''), activeParameter: commas }
                }
            }
            break
        }
        if (ch === ';') break
        if (ch === ',' && depth === 0) { commas++; i--; continue }
        if (ch === '&' && depth === 0) {
            const rest = lineText.slice(i + 1)
            const m = rest.match(/^([a-zA-Z_][a-zA-Z0-9_]*)/)
            if (m) return { calleeName: m[1], activeParameter: commas }
            break
        }
        i--
    }
    return undefined
}

/**
 * Look up the name of the `i`-th non-literal parameter of function `fnName`
 * in `doc`'s elaborated tree.
 *
 * The handwritten parser produces a flat `program.elements` array where each
 * entry is a `Definition` directly (not wrapped in Element/Item/Statement).
 */
function paramNameForPosition(doc: Document, fnName: string, i: number): string | undefined {
    const elements: any[] = (doc.elabTree as any).program?.elements ?? []
    for (const el of elements) {
        // Flat shape: element IS the Definition.
        const def = el?.type === 'Definition' ? el : undefined
        if (!def) continue
        if (def.name?.name !== fnName) continue
        const params: any[] = (def.params ?? []).filter((p: any) => !p.isLiteral)
        return params[i]?.name ?? undefined
    }
    return undefined
}

// ---------------------------------------------------------------------------
// Helpers — formatting
// ---------------------------------------------------------------------------

/** Silicon built-in keywords offered as completion items. */
// ADR-0020 surface keywords offered as IDE completions. The retired forms
// (`@global`/`@local`/`@var`/`@let`/`@struct`/`@type_sum`/`@extern{}`) are NOT
// listed — they no longer parse. Values are bare (`x := v`) or `@mut`; structs and
// sums are `@type … := { … } / $A | $B`; externals are `\\ @extern …` sig lines.
const SILICON_KEYWORDS = [
    '@fn', '@mut', '@type', '@enum', '@extern', '@export', '@if', '@loop',
    '@match', '@return', '@break', '@continue', '@defer', '@try', '@use',
]

/**
 * Normalize whitespace in a Silicon source snippet without a trivia layer.
 *
 * Rules applied (string-literal contents are preserved):
 *   - Collapse runs of spaces/tabs to a single space
 *   - No space before `,` or `;`
 *   - One space after `,` and `;` when not at end of line
 *   - One space before and after `:=`
 *   - One space after `{` when followed by non-whitespace
 *   - One space before `}` when preceded by non-whitespace
 *   - Strip trailing whitespace on each line
 *   - Single blank line between definitions (lines starting with `@`)
 *
 * This is lossy — it does not preserve deviations from the canonical style.
 * Full fidelity requires a trivia layer (CaaS tracker item 2e).
 */
function normalizeSource(src: string): string {
    // Split into tokens preserving string literals.
    const parts: string[] = []
    let i = 0
    while (i < src.length) {
        if (src[i] === '"' || src[i] === "'") {
            const q = src[i]
            let j = i + 1
            while (j < src.length && src[j] !== q) {
                if (src[j] === '\\') j++
                j++
            }
            parts.push(src.slice(i, j + 1))
            i = j + 1
        } else {
            parts.push(src[i])
            i++
        }
    }

    let out = parts.join('')

    // Collapse whitespace (not inside strings — already extracted).
    out = out.replace(/[ \t]+/g, ' ')

    // Spacing around :=
    out = out.replace(/\s*:=\s*/g, ' := ')

    // Spacing around commas
    out = out.replace(/\s*,\s*/g, ', ')

    // No space before semicolons
    out = out.replace(/\s*;/g, ';')

    // Space after { if non-empty content follows
    out = out.replace(/\{(?=[^\s}])/g, '{ ')

    // Space before } if non-whitespace precedes
    out = out.replace(/(?<=[^\s{])\}/g, ' }')

    // Strip trailing whitespace per line
    out = out.split('\n').map(l => l.trimEnd()).join('\n')

    // Single blank line between top-level definitions
    out = out.replace(/\n{3,}/g, '\n\n')

    return out
}

/** Build a single whole-file replacement TextEdit if the source changed. */
function formatSource(source: string, file: string): TextEdit[] {
    const normalized = normalizeSource(source)
    if (normalized === source) return []
    const lines = source.split('\n')
    return [{
        span: {
            file,
            line:   1,
            col:    1,
            length: source.length,
        },
        newText: normalized,
    }]
}
