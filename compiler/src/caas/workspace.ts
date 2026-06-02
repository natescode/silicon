// SPDX-License-Identifier: MIT
/**
 * Workspace — multi-document project state (CaaS-4 / CaaS-5).
 *
 * A Workspace owns a shared strata registry and a set of open Documents.
 * Each Document holds its current source, parsed SyntaxTree, elaborated tree,
 * SemanticModel, and the union of all per-phase diagnostics.
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
import type { ElaboratorRegistry } from '../elaborator/registry'
import type { SemanticModel, Symbol as CaaSSymbol, SourceRange } from '../ast/semanticModel'
import { typeDisplayString } from '../ast/semanticModel'
import type { SiliconType } from '../types/types'
import type { Diagnostic, SourceSpan } from '../errors/diagnostic'
import type { TextEdit } from './codeAction'

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

/** Result of a signature-help query (cursor is inside a function call argument list). */
export interface SignatureHelp {
    readonly name: string
    readonly parameters: readonly ParameterInfo[]
    /** 0-based index of the parameter the cursor is currently editing. */
    readonly activeParameter: number
}

/** Multi-file set of text edits — result of a rename operation. */
export type WorkspaceEdit = Map<string, TextEdit[]>

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
        const doc = this.#compile(uri, newSource, existing.version + 1)
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
        //    position, then look the name up in the workspace symbol index.
        const name = namespaceNameAtPosition(doc, line, col)
        if (!name) return undefined
        return this.#symbolIndex.get(name)?.[0]?.symbol
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
        const name = local?.name ?? namespaceNameAtPosition(doc, line, col)
        if (!name) return []
        return (this.#symbolIndex.get(name) ?? []).map(e => e.symbol)
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
    findReferences(uri: string, line: number, col: number): readonly SourceSpan[] {
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

        for (const d of this.#docs.values()) {
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
    getCompletions(uri: string, _line: number, _col: number, prefix?: string): CompletionItem[] {
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

        // Local symbols first (highest priority).
        for (const sym of doc.model.allSymbols) add(sym, doc)

        // Cross-document symbols from the workspace index.
        for (const [, entries] of this.#symbolIndex) {
            for (const entry of entries) {
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
        const result: WorkspaceEdit = new Map()

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

        // 4. Typecheck — pass cross-document symbols so references to definitions
        //    in other open Workspace documents don't produce "unbound identifier"
        //    errors and resolve to their correct types (CaaS-2g).
        const externalSymbols = this.#buildExternalSymbols(uri)
        const checkResult = typecheck(elabResult.tree, elabResult.registry, { externalSymbols })
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

    /**
     * Build a map of `name → SiliconType` from all open documents *except*
     * `currentUri`.  Passed to the typechecker as `externalSymbols` so
     * cross-document references resolve correctly (CaaS-2g).
     */
    #buildExternalSymbols(currentUri: string): ReadonlyMap<string, SiliconType> {
        const ext = new Map<string, SiliconType>()
        for (const [uri, doc] of this.#docs) {
            if (uri === currentUri) continue
            for (const sym of doc.model.allSymbols) {
                if (sym.type && !ext.has(sym.name)) {
                    ext.set(sym.name, sym.type)
                }
            }
        }
        return ext
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
    for (const node of doc.elabTree.root.descendantsOfKind('Namespace')) {
        const span = node.span   // SourceRange | undefined
        if (!span) continue
        if (!rangeContainsPos(span, line, col)) continue
        const path: string[] = (node._node as any).path ?? []
        return path.at(-1)
    }
    return undefined
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
const SILICON_KEYWORDS = [
    '@fn', '@let', '@var', '@type', '@enum', '@extern', '@if', '@loop',
    '@match', '@return', '@break', '@continue', '@struct', '@use',
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
