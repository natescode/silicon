// SPDX-License-Identifier: MIT
/**
 * SyntaxNode — walkable public wrapper around Silicon AST nodes.
 *
 * Every node in the tree (structural and leaf alike) is wrapped by this class.
 * Obtain the root via `SyntaxTree.root` and traverse with `children()`,
 * `descendants()`, and `ancestors()`.
 *
 * Silicon difference from Roslyn: there is no separate SyntaxToken type.
 * Silicon's lexical leaves are already typed AST nodes (IntLiteral, Namespace,
 * GenericParams, …).  Leaf nodes simply return an empty `children()` array.
 *
 * @public — Silicon 1.0 stable.
 */

import type { SourceRange } from '../ast/semanticModel'

// ---------------------------------------------------------------------------
// Trivia (2e)
// ---------------------------------------------------------------------------

/**
 * A single unit of trivia — whitespace, a line comment, or a signature line —
 * that lives between two adjacent syntax nodes.
 *
 * Silicon difference from Roslyn: there is no parser-level trivia channel yet.
 * Trivia is computed lazily from the source text using span information.
 * Whitespace inside string literals is never exposed as trivia.
 *
 * @public — Silicon 1.0 stable.
 */
export interface TriviaItem {
    /** The trivia kind. */
    readonly kind: 'whitespace' | 'newline' | 'lineComment' | 'sigLine'
    /** The raw text of this trivia unit. */
    readonly text: string
}

/**
 * Parse a raw gap string (text between two syntax nodes) into trivia items.
 * Handles:
 *   - `\n`, `\r\n`         → `newline`
 *   - runs of spaces/tabs  → `whitespace`
 *   - `## …` to end-of-line → `lineComment`
 *   - `\\ …` to end-of-line → `sigLine`
 */
function parseTrivia(gap: string): TriviaItem[] {
    const items: TriviaItem[] = []
    let i = 0
    while (i < gap.length) {
        const ch = gap[i]
        if (ch === '\r' && gap[i + 1] === '\n') {
            items.push({ kind: 'newline', text: '\r\n' }); i += 2; continue
        }
        if (ch === '\n') {
            items.push({ kind: 'newline', text: '\n' }); i++; continue
        }
        if (ch === ' ' || ch === '\t') {
            let j = i + 1
            while (j < gap.length && (gap[j] === ' ' || gap[j] === '\t')) j++
            items.push({ kind: 'whitespace', text: gap.slice(i, j) }); i = j; continue
        }
        if (ch === '#' && gap[i + 1] === '#') {
            let j = i + 2
            while (j < gap.length && gap[j] !== '\n' && gap[j] !== '\r') j++
            items.push({ kind: 'lineComment', text: gap.slice(i, j) }); i = j; continue
        }
        if (ch === '\\' && gap[i + 1] === '\\') {
            let j = i + 2
            while (j < gap.length && gap[j] !== '\n' && gap[j] !== '\r') j++
            items.push({ kind: 'sigLine', text: gap.slice(i, j) }); i = j; continue
        }
        // Anything else — treat as whitespace to avoid infinite loops.
        items.push({ kind: 'whitespace', text: ch }); i++
    }
    return items
}

// ---------------------------------------------------------------------------
// SyntaxNode
// ---------------------------------------------------------------------------

export class SyntaxNode {
    /**
     * Node type discriminant — 'Definition', 'FunctionCall', 'IntLiteral', etc.
     * Matches the `type` field of the underlying AST node.
     */
    readonly kind: string

    /**
     * Source span of this node, if location info was recorded by the parser.
     * Coordinates are 1-based, matching editor conventions.
     */
    readonly span: SourceRange | undefined

    /**
     * The parent of this node.  Undefined for the root `SyntaxNode`.
     *
     * Parents are set lazily: they are only populated once `children()` is
     * called on the parent, so the root's immediate children won't have a
     * parent until `root.children()` is first accessed.
     */
    readonly parent: SyntaxNode | undefined

    /**
     * The raw underlying AST node.
     * @internal Not stable — shape may change between releases.
     */
    readonly _node: object

    #children?: readonly SyntaxNode[]

    constructor(node: object, parent?: SyntaxNode) {
        this._node = node
        this.parent = parent
        const n = node as any
        this.kind = typeof n.type === 'string' ? n.type : '(unknown)'
        this.span = locationToRange(n.sourceLocation)
    }

    // ── child navigation ──────────────────────────────────────────────────────

    /** Direct child nodes.  Empty for leaf nodes. */
    children(): readonly SyntaxNode[] {
        if (!this.#children) {
            this.#children = childAstObjects(this._node).map(ch => new SyntaxNode(ch, this))
        }
        return this.#children
    }

    /** True when this node has no child syntax nodes. */
    get isLeaf(): boolean {
        return this.children().length === 0
    }

    // ── traversal ─────────────────────────────────────────────────────────────

    /** All descendant nodes in depth-first pre-order. */
    *descendants(): Generator<SyntaxNode> {
        for (const child of this.children()) {
            yield child
            yield* child.descendants()
        }
    }

    /** Ancestor nodes from immediate parent to root. */
    *ancestors(): Generator<SyntaxNode> {
        let cur: SyntaxNode | undefined = this.parent
        while (cur) {
            yield cur
            cur = cur.parent
        }
    }

    // ── convenience filters ───────────────────────────────────────────────────

    /** All descendants whose `kind` matches. */
    *descendantsOfKind(kind: string): Generator<SyntaxNode> {
        for (const node of this.descendants()) {
            if (node.kind === kind) yield node
        }
    }

    /** First descendant whose `kind` matches, or undefined. */
    firstDescendantOfKind(kind: string): SyntaxNode | undefined {
        for (const node of this.descendants()) {
            if (node.kind === kind) return node
        }
        return undefined
    }

    // ── trivia ────────────────────────────────────────────────────────────────

    /**
     * Trivia items that appear in the source text immediately **before** this
     * node's span starts.
     *
     * Computed from the gap between the end of the previous sibling (or the
     * parent's span start when this is the first child) and this node's span
     * start.  Requires the full source text of the containing tree.
     *
     * Returns an empty array when span information is not available.
     */
    leadingTrivia(source: string): readonly TriviaItem[] {
        if (!this.span) return []
        const nodeStart = lineColToOffset(source, this.span.startLine, this.span.startCol)
        if (nodeStart === 0) return []

        // Find the end of the nearest preceding sibling span, or parent span start.
        let prevEnd = 0
        if (this.parent?.span) {
            prevEnd = lineColToOffset(source, this.parent.span.startLine, this.parent.span.startCol)
        }
        if (this.parent) {
            const siblings = this.parent.children()
            const idx = siblings.indexOf(this)
            if (idx > 0) {
                const prev = siblings[idx - 1]
                if (prev.span) {
                    prevEnd = lineColToOffset(source, prev.span.endLine, prev.span.endCol)
                }
            }
        }
        if (prevEnd >= nodeStart) return []
        return parseTrivia(source.slice(prevEnd, nodeStart))
    }

    /**
     * Trivia items that appear in the source text immediately **after** this
     * node's span ends.
     *
     * Computed from the gap between this node's span end and the start of the
     * next sibling (or the parent's span end when this is the last child).
     * Requires the full source text of the containing tree.
     *
     * Returns an empty array when span information is not available.
     */
    trailingTrivia(source: string): readonly TriviaItem[] {
        if (!this.span) return []
        const nodeEnd = lineColToOffset(source, this.span.endLine, this.span.endCol)

        // Find the start of the next sibling span, or parent span end.
        let nextStart = source.length
        if (this.parent) {
            const siblings = this.parent.children()
            const idx = siblings.indexOf(this)
            if (idx < siblings.length - 1) {
                const next = siblings[idx + 1]
                if (next.span) {
                    nextStart = lineColToOffset(source, next.span.startLine, next.span.startCol)
                }
            } else if (this.parent.span) {
                nextStart = lineColToOffset(source, this.parent.span.endLine, this.parent.span.endCol)
            }
        }
        if (nodeEnd >= nextStart) return []
        return parseTrivia(source.slice(nodeEnd, nextStart))
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function locationToRange(loc: any): SourceRange | undefined {
    if (!loc) return undefined
    return {
        startLine: loc.startLine,
        startCol: loc.startColumn,
        endLine: loc.endLine,
        endCol: loc.endColumn,
    }
}

/** Return the direct AST child objects of `node`, keyed on the `type` field. */
function childAstObjects(node: object): readonly object[] {
    const n = node as any
    switch (n.type) {
        case 'Program':
            return n.elements ?? []

        // Envelope nodes — a single `value` child:
        case 'Element':
        case 'Item':
        case 'Statement':
        case 'ExpressionStart':
        case 'ExpressionEnd':
        case 'Literal':
            return compact([n.value])

        case 'Assignment':
            return compact([n.target, n.value])

        case 'Definition': {
            const ch: object[] = compact([n.name])
            if (n.generics) ch.push(n.generics)
            if (n.params) ch.push(...(n.params as object[]))
            if (n.binding) ch.push(n.binding)
            return ch
        }

        case 'BinaryOp':
            return compact([n.left, n.right])

        case 'FunctionCall': {
            const ch: object[] = []
            if (n.name && typeof n.name === 'object') ch.push(n.name)
            if (n.args) ch.push(...(n.args as object[]))
            return ch
        }

        case 'ArrayLiteral':
        case 'TupleLiteral':
            return (n.elements as object[]) ?? []

        case 'ObjectLiteral':
            return (n.properties as object[]) ?? []

        case 'KeyValuePair':
            return compact([n.key, n.value])

        case 'Block': {
            const ch: object[] = [...((n.items as object[]) ?? [])]
            if (n.trailing) ch.push(n.trailing)
            return ch
        }

        case 'Binding':
            return compact([n.expression])

        case 'Ascription':
            return compact([n.expression, n.typeAnnotation])

        case 'TypedIdentifier':
            return compact([n.typeAnnotation])

        case 'VariantDecl':
            return (n.fields as object[]) ?? []

        case 'Parameter':
            return compact([n.typeAnnotation, n.value])

        case 'TypeAnnotation': {
            const ch: object[] = []
            if (n.typeArgs) ch.push(...(n.typeArgs as object[]))
            if (n.fnReturn) ch.push(n.fnReturn)
            if (n.fnParams) ch.push(...(n.fnParams as object[]))
            return ch
        }

        case 'TypeArg':
            return (n.args as object[]) ?? []

        // Leaves — no child nodes:
        case 'StringLiteral':
        case 'IntLiteral':
        case 'FloatLiteral':
        case 'BooleanLiteral':
        case 'Namespace':
        case 'GenericParams':
        case 'DocComment':
        default:
            return []
    }
}

function compact<T>(arr: (T | undefined | null | false | 0)[]): T[] {
    return arr.filter(Boolean) as T[]
}

/**
 * Convert a 1-based (line, col) position to a 0-based character offset in
 * `source`.  Used by the trivia helpers.
 */
function lineColToOffset(source: string, line: number, col: number): number {
    let offset = 0
    let ln = 1
    while (ln < line && offset < source.length) {
        if (source[offset] === '\r' && source[offset + 1] === '\n') { offset += 2 }
        else if (source[offset] === '\n' || source[offset] === '\r') { offset++ }
        else { offset++; continue }
        ln++
    }
    return offset + (col - 1)
}
