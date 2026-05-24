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
    readonly allDiagnostics: readonly Diagnostic[]

    constructor(opts: SemanticModelOpts) {
        this.#types = opts.types
        this.#nodeToSymbolName = opts.nodeToSymbolName ?? new WeakMap()
        this.#symbols = opts.symbols ?? new Map()
        this.#symbolToNodes = opts.symbolToNodes ?? new Map()
        this.allDiagnostics = opts.diagnostics ?? []
    }

    // ── type queries ─────────────────────────────────────────────────────────

    /** Inferred SiliconType for `node`, or undefined if none was recorded. */
    typeOf(node: object): SiliconType | undefined {
        return this.#types.get(node)
    }

    // ── symbol queries ────────────────────────────────────────────────────────

    /**
     * The Symbol that `node` resolves to, if `node` is a Namespace reference
     * or any node whose identity was recorded during typechecking.
     */
    symbolAt(node: object): Symbol | undefined {
        const name = this.#nodeToSymbolName.get(node)
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
    /** All type-phase diagnostics. */
    diagnostics?: readonly Diagnostic[]
}
