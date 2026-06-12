// SPDX-License-Identifier: MIT
/**
 * SemanticModel — queryable semantic information over a typechecked tree.
 *
 * CaaS-2: authoritative type map (WeakMap<node, SiliconType>).
 * CaaS-3: symbol resolution, diagnostic range queries, reference tracking.
 *
 * The typechecker builds these maps and passes them here.  The lowerer and
 * other consumers query via SemanticModel rather than reading `node.inferredType`
 * or `node.hook` directly.  The legacy field stamps remain for backward compat.
 */

import type { SiliconType } from '../types/types'
import type { Diagnostic, SourceSpan } from '../errors/diagnostic'
import { spanFromLocation } from '../errors/diagnostic'
import type { SourceLocation } from './astNodes'
import type { BindingIndex, BindingInfo } from './binder'

// ---------------------------------------------------------------------------
// Type display
// ---------------------------------------------------------------------------

/** Format a SiliconType for human display (e.g. in hover tooltips). */
export function typeDisplayString(type: SiliconType | undefined): string {
    if (!type) return '?'
    switch (type.kind) {
        case 'Int':       return 'Int'
        case 'Int64':     return 'Int64'
        case 'Float':     return 'Float'
        case 'String':    return 'String'
        case 'JSString':  return 'JSString'
        case 'CharCodeArray': return 'CharCodeArray'
        case 'Bool':      return 'Bool'
        case 'UInt8':     return 'UInt8'
        case 'UInt16':    return 'UInt16'
        case 'UInt32':    return 'UInt32'
        case 'UInt64':    return 'UInt64'
        case 'Void':      return 'Void'
        case 'Unknown':   return '?'
        case 'Variable':  return type.name
        case 'Distinct':  return type.name
        case 'Sum':       return type.name
        case 'Array':     return `Array[${typeDisplayString(type.element)}]`
        case 'Vec':       return `Vec[${typeDisplayString(type.element)}]`
        case 'Function': {
            const params = type.params.map(typeDisplayString).join(', ')
            return `${params} → ${typeDisplayString(type.result)}`
        }
    }
}

/** Format a Symbol for hover/completion display. */
export function symbolDisplayString(sym: Symbol): string {
    const t = sym.type
    switch (sym.kind) {
        case 'function': {
            if (t?.kind === 'Function') {
                const params = t.params.map(typeDisplayString).join(', ')
                return `(fn ${sym.name}) ${params} → ${typeDisplayString(t.result)}`
            }
            return `(fn ${sym.name})`
        }
        case 'variable':  return `(let ${sym.name}) ${typeDisplayString(t)}`
        case 'parameter': return `(param ${sym.name}) ${typeDisplayString(t)}`
        case 'type':      return `(type ${sym.name})`
        case 'stratum':   return `(stratum ${sym.name})`
    }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SymbolKind = 'function' | 'variable' | 'type' | 'parameter' | 'stratum'

/** A definition site — a name introduced by @let, @fn, @type, @var, etc. */
export interface Symbol {
    readonly name: string
    readonly kind: SymbolKind
    readonly definitionNode: object  // Definition AST node
    readonly type: SiliconType | undefined
    /** Source span of the definition's name identifier, if location info is available. */
    readonly definitionSpan?: SourceSpan
    /**
     * All declaration sites for this symbol (Roslyn 2d parity).
     *
     * Currently equivalent to `definitionSpan ? [definitionSpan] : []`.
     * Will grow to include multiple sites when partial definitions are
     * supported (not yet in Silicon).
     */
    readonly locations: readonly SourceSpan[]
    /**
     * The enclosing symbol, if any (Roslyn 2c parity).
     *
     * `undefined` for top-level definitions.  Will point to the enclosing
     * function for parameter symbols once parameters are added to the symbol
     * table (a planned typechecker enhancement).
     */
    readonly containingSymbol?: Symbol
    /** Human-readable type signature, e.g. "(fn add) Int, Int → Int". */
    readonly displayString: string
    /**
     * True for compiler-synthesized symbols with no user-written declaration —
     * e.g. the constructor functions generated for `@type` sum variants
     * (Roslyn `ISymbol.IsImplicitlyDeclared`, CaaS tracker 4a).  `false` for
     * everything the user wrote.
     */
    readonly isImplicitlyDeclared: boolean
}

/** A half-open [start, end) line/col range for diagnostic queries. */
export interface SourceRange {
    readonly startLine: number
    readonly startCol: number
    readonly endLine: number
    readonly endCol: number
}

// ---------------------------------------------------------------------------
// SemanticModel
// ---------------------------------------------------------------------------

export class SemanticModel {
    readonly #types: WeakMap<object, SiliconType>
    readonly #nodeToSymbolName: WeakMap<object, string>
    readonly #symbols: ReadonlyMap<string, Symbol>
    readonly #symbolToNodes: ReadonlyMap<string, readonly object[]>
    readonly #symbolToSpans: ReadonlyMap<string, readonly SourceSpan[]>
    readonly #bindings: BindingIndex | undefined
    /** Stable Symbol per local binding (S1) — built lazily on first query. */
    readonly #bindingSymbols = new Map<BindingInfo, Symbol>()
    readonly allDiagnostics: readonly Diagnostic[]

    constructor(opts: SemanticModelOpts) {
        this.#types = opts.types
        this.#nodeToSymbolName = opts.nodeToSymbolName ?? new WeakMap()
        this.#symbols = opts.symbols ?? new Map()
        this.#symbolToNodes = opts.symbolToNodes ?? new Map()
        this.#symbolToSpans = opts.symbolToSpans ?? new Map()
        this.#bindings = opts.bindings
        this.allDiagnostics = opts.diagnostics ?? []
    }

    // ── type queries ─────────────────────────────────────────────────────────

    /**
     * Inferred SiliconType for `node`, or undefined if none was recorded.
     *
     * Accepts either a raw AST node or a `SyntaxNode` (which wraps the raw
     * node in `._node`).  Passing a `SyntaxNode` from `SyntaxTree.root` is
     * the recommended pattern for CaaS consumers.
     */
    typeOf(node: object): SiliconType | undefined {
        return this.#types.get(unwrap(node))
    }

    // ── symbol queries ────────────────────────────────────────────────────────

    /**
     * The Symbol that `node` resolves to, if `node` is a Namespace reference
     * or any node whose identity was recorded during typechecking.
     *
     * Accepts either a raw AST node or a `SyntaxNode`.
     */
    symbolAt(node: object): Symbol | undefined {
        const name = this.#nodeToSymbolName.get(unwrap(node))
        if (!name) return undefined
        return this.#symbols.get(name)
    }

    /** Look up a symbol by its declared name. */
    symbolNamed(name: string): Symbol | undefined {
        return this.#symbols.get(name)
    }

    /** All symbols defined in this tree. */
    get allSymbols(): IterableIterator<Symbol> {
        return this.#symbols.values()
    }

    // ── reference queries ─────────────────────────────────────────────────────

    /** All AST nodes that reference `symbol`. */
    referencesTo(symbol: Symbol): readonly object[] {
        return this.#symbolToNodes.get(symbol.name) ?? []
    }

    /**
     * All source spans where `symbol` is referenced (call sites, uses).
     * Returns an empty array when location info was not recorded (e.g. in
     * unit-test ASTs built without going through the Ohm parser).
     */
    referenceSpans(symbol: Symbol): readonly SourceSpan[] {
        return this.#symbolToSpans.get(symbol.name) ?? []
    }

    /**
     * All source spans where any symbol named `name` is referenced.
     *
     * Equivalent to `referenceSpans(symbolNamed(name)!)` but works without
     * having a Symbol object in hand — useful for cross-document aggregation
     * where the defining document is different from the queried one.
     */
    referenceSpansForName(name: string): readonly SourceSpan[] {
        return this.#symbolToSpans.get(name) ?? []
    }

    /**
     * Find the symbol whose definition or a reference occupies `(line, col)`.
     *
     * Searches definition spans first, then all reference spans.  Both are
     * 1-based (matching Ohm's `getLineAndColumn()` output).
     *
     * Returns `undefined` when no span covers the position, or when location
     * info was not recorded (pre-Ohm ASTs in unit tests).
     */
    symbolAtPosition(line: number, col: number): Symbol | undefined {
        // S1 — local bindings FIRST: a position on a parameter / local /
        // pattern field must resolve to that binding, not to a same-named
        // top-level symbol via the name-keyed reference spans below.
        const binding = this.#bindings?.bindingAtPosition(line, col)
        if (binding) return this.#symbolForBinding(binding)
        // Check definition sites.
        for (const sym of this.#symbols.values()) {
            if (sym.definitionSpan && spanContainsPos(sym.definitionSpan, line, col)) {
                return sym
            }
        }
        // Check reference sites.
        for (const [name, spans] of this.#symbolToSpans) {
            for (const span of spans) {
                if (spanContainsPos(span, line, col)) {
                    return this.#symbols.get(name)
                }
            }
        }
        return undefined
    }

    // ── binding identity (S1) ────────────────────────────────────────────────

    /**
     * When `symbol` is a *local binding* (parameter, local, or `@match`
     * pattern field — i.e. it came from `symbolAtPosition` over a binding
     * occurrence), return the spans of every USE of that binding, all within
     * this document (mirrors {@link referenceSpans} semantics: the definition
     * span is on `symbol.definitionSpan`, not in the list).  Returns
     * `undefined` for top-level symbols — callers fall back to the
     * cross-document name-keyed aggregation for those.
     */
    localBindingSpans(symbol: Symbol): readonly SourceSpan[] | undefined {
        for (const [binding, sym] of this.#bindingSymbols) {
            if (sym === symbol) return binding.referenceSpans
        }
        return undefined
    }

    /**
     * True when the occurrence of `name` at `span` resolved to a local
     * binding (S1) — an AST-level name scan must not attribute it to a
     * top-level symbol of the same name.
     */
    isLocalOccurrence(name: string, span: SourceSpan): boolean {
        return this.#bindings?.isLocalOccurrence(name, span) ?? false
    }

    /**
     * Like {@link referenceSpansForName}, minus the occurrences that resolved
     * to a LOCAL binding of the same name (S1).  This is the span set a
     * top-level rename/find-references must use, so a shadowing parameter or
     * local `x` is never rewritten by a rename of top-level `x`.
     */
    unshadowedReferenceSpansForName(name: string): readonly SourceSpan[] {
        const spans = this.#symbolToSpans.get(name) ?? []
        const idx = this.#bindings
        if (!idx) return spans
        return spans.filter(s => !idx.isLocalOccurrence(name, s))
    }

    /** Build (once) the Symbol surface over a local binding. */
    #symbolForBinding(b: BindingInfo): Symbol {
        const cached = this.#bindingSymbols.get(b)
        if (cached) return cached
        const containing = b.container ? this.#symbols.get(b.container) : undefined
        // A parameter's type lives on the containing function's signature; a
        // local's was stamped on its Definition node by the typechecker.
        let type: SiliconType | undefined
        if (b.kind === 'parameter' && b.paramIndex !== undefined
            && containing?.type?.kind === 'Function') {
            type = containing.type.params[b.paramIndex]
        } else {
            type = this.#types.get(b.node)
        }
        const partial = {
            name: b.name,
            kind: b.kind,
            definitionNode: b.node,
            type,
            definitionSpan: b.definitionSpan,
            locations: b.definitionSpan ? [b.definitionSpan] : [],
            containingSymbol: containing,
            isImplicitlyDeclared: false,
        }
        const sym: Symbol = { ...partial, displayString: symbolDisplayString(partial as Symbol) }
        this.#bindingSymbols.set(b, sym)
        return sym
    }

    // ── diagnostic queries ────────────────────────────────────────────────────

    /**
     * All diagnostics whose span overlaps the given source range.
     * Pass `undefined` to get all diagnostics.
     */
    diagnosticsIn(range?: SourceRange): readonly Diagnostic[] {
        if (!range) return this.allDiagnostics
        return this.allDiagnostics.filter(d => spanOverlaps(d.span, range))
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Unwrap a SyntaxNode to its raw AST node, or return the node unchanged.
 * Avoids a circular import between ast/ and caas/ by duck-typing on `_node`.
 */
function unwrap(node: object): object {
    return '_node' in node ? (node as { _node: object })._node : node
}

/** True when the 1-based `(line, col)` cursor falls inside `span`. */
function spanContainsPos(span: SourceSpan, line: number, col: number): boolean {
    if (span.length === 0) return false
    if (span.line !== line) return false
    return col >= span.col && col < span.col + span.length
}

function spanOverlaps(span: SourceSpan, range: SourceRange): boolean {
    const spanEnd = { line: span.line, col: span.col + span.length }
    // Treat the span as [span.line:span.col, spanEnd.line:spanEnd.col).
    // Overlaps unless entirely before or entirely after the range.
    if (span.line < range.startLine) return false
    if (span.line === range.startLine && span.col < range.startCol) return false
    if (spanEnd.line > range.endLine) return false
    if (spanEnd.line === range.endLine && spanEnd.col > range.endCol) return false
    return true
}

// ---------------------------------------------------------------------------
// Construction opts (passed from typechecker)
// ---------------------------------------------------------------------------

export interface SemanticModelOpts {
    types: WeakMap<object, SiliconType>
    /** Namespace node → resolved symbol name (for symbolAt). */
    nodeToSymbolName?: WeakMap<object, string>
    /** Symbol name → Symbol object (for symbolNamed, symbolAt). */
    symbols?: ReadonlyMap<string, Symbol>
    /** Symbol name → all reference nodes (for referencesTo). */
    symbolToNodes?: ReadonlyMap<string, readonly object[]>
    /** Symbol name → source spans of all references (for referenceSpans, symbolAtPosition). */
    symbolToSpans?: ReadonlyMap<string, readonly SourceSpan[]>
    /** Lexical binding identity for locals/params (S1) — see `ast/binder.ts`. */
    bindings?: BindingIndex
    /** All type-phase diagnostics. */
    diagnostics?: readonly Diagnostic[]
}
