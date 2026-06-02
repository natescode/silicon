// SPDX-License-Identifier: MIT
/**
 * SyntaxWalker and SyntaxRewriter — visitor base classes for SyntaxNode trees.
 *
 * These mirror Roslyn's CSharpSyntaxWalker / CSharpSyntaxRewriter pattern.
 *
 * SyntaxWalker
 * ------------
 * Read-only depth-first visitor.  Override `visitNode(node)` for all nodes or
 * one of the typed overrides for a specific kind.  The default implementation
 * recurses into children; override and *not* call `super` to prune a subtree.
 *
 *   class Counter extends SyntaxWalker {
 *     count = 0
 *     visitFunctionCall(node: SyntaxNode) { this.count++; super.visitFunctionCall(node) }
 *   }
 *   const c = new Counter()
 *   c.walk(tree.root)
 *   console.log(c.count)
 *
 * SyntaxRewriter
 * --------------
 * Text-edit-producing visitor.  Override `rewriteNode(node)` (or a typed
 * variant) and return a `TextEdit` to replace that node's source text, or
 * `null` to leave it unchanged.  The base implementation recurses into
 * children; the caller collects all non-null edits and applies them with
 * `applyEdits`.
 *
 * Note: Silicon's AST nodes are immutable, so SyntaxRewriter produces
 * `TextEdit[]` rather than a new SyntaxTree.  A full AST-cloning rewriter
 * (that returns a new SyntaxTree) requires parser-round-trip support and is
 * planned for a future release.
 *
 * @public — Silicon 1.0 stable.
 */

import type { SyntaxNode } from './syntaxNode'
import type { TextEdit } from './codeAction'

// ---------------------------------------------------------------------------
// SyntaxWalker
// ---------------------------------------------------------------------------

export abstract class SyntaxWalker {
    /**
     * Walk the tree rooted at `root`, calling `visitNode` (and its typed
     * overrides) for every node in depth-first pre-order.
     */
    walk(root: SyntaxNode): void {
        this.visitNode(root)
    }

    /**
     * Called for every node.  The default implementation dispatches to the
     * typed override and then recurses into children.  Override to filter or
     * prune; call `super.visitNode(node)` to recurse.
     */
    visitNode(node: SyntaxNode): void {
        this.dispatchVisit(node)
        for (const child of node.children()) {
            this.visitNode(child)
        }
    }

    // Typed overrides — override any of these to handle a specific kind.
    // The default for each is a no-op (recursion handled by visitNode above).

    visitDefinition(_node: SyntaxNode): void {}
    visitFunctionCall(_node: SyntaxNode): void {}
    visitBinaryOp(_node: SyntaxNode): void {}
    visitBlock(_node: SyntaxNode): void {}
    visitBinding(_node: SyntaxNode): void {}
    visitNamespace(_node: SyntaxNode): void {}
    visitIntLiteral(_node: SyntaxNode): void {}
    visitFloatLiteral(_node: SyntaxNode): void {}
    visitStringLiteral(_node: SyntaxNode): void {}
    visitBooleanLiteral(_node: SyntaxNode): void {}
    visitParameter(_node: SyntaxNode): void {}
    visitTypeAnnotation(_node: SyntaxNode): void {}
    visitDocComment(_node: SyntaxNode): void {}

    private dispatchVisit(node: SyntaxNode): void {
        switch (node.kind) {
            case 'Definition':     this.visitDefinition(node);     break
            case 'FunctionCall':   this.visitFunctionCall(node);   break
            case 'BinaryOp':       this.visitBinaryOp(node);       break
            case 'Block':          this.visitBlock(node);           break
            case 'Binding':        this.visitBinding(node);         break
            case 'Namespace':      this.visitNamespace(node);       break
            case 'IntLiteral':     this.visitIntLiteral(node);      break
            case 'FloatLiteral':   this.visitFloatLiteral(node);    break
            case 'StringLiteral':  this.visitStringLiteral(node);   break
            case 'BooleanLiteral': this.visitBooleanLiteral(node);  break
            case 'Parameter':      this.visitParameter(node);       break
            case 'TypeAnnotation': this.visitTypeAnnotation(node);  break
            case 'DocComment':     this.visitDocComment(node);      break
        }
    }
}

// ---------------------------------------------------------------------------
// SyntaxRewriter
// ---------------------------------------------------------------------------

/**
 * Text-edit-producing tree visitor.  Override `rewriteNode` (or a typed
 * variant) and return a `TextEdit | null`.  Call `rewrite(root, source)` to
 * collect all edits.
 *
 * The base implementation recurses into children.  If your override returns a
 * `TextEdit`, the children are **not** recursed (the edit replaces the whole
 * subtree's source).  Return `null` to recurse into children as usual.
 */
export abstract class SyntaxRewriter {
    /**
     * Collect all TextEdits produced by this rewriter for the tree rooted at
     * `root`.  `source` is the original source text — required for
     * `leadingTrivia` / `trailingTrivia` queries and for range calculations.
     *
     * The returned array is unsorted; pass it to `applyEdits` for application.
     */
    rewrite(root: SyntaxNode, _source: string): TextEdit[] {
        const edits: TextEdit[] = []
        this.#collect(root, edits)
        return edits
    }

    #collect(node: SyntaxNode, edits: TextEdit[]): void {
        const edit = this.rewriteNode(node)
        if (edit) {
            edits.push(edit)
            return  // Don't recurse — the edit covers this whole subtree.
        }
        for (const child of node.children()) {
            this.#collect(child, edits)
        }
    }

    /**
     * Called for every node.  Return a `TextEdit` to replace the node's
     * source with new text, or `null` to leave it unchanged and recurse into
     * children.
     */
    rewriteNode(node: SyntaxNode): TextEdit | null {
        return this.dispatchRewrite(node)
    }

    // Typed overrides — default to null (no edit, recurse into children).
    rewriteDefinition(_node: SyntaxNode): TextEdit | null { return null }
    rewriteFunctionCall(_node: SyntaxNode): TextEdit | null { return null }
    rewriteBinaryOp(_node: SyntaxNode): TextEdit | null { return null }
    rewriteBlock(_node: SyntaxNode): TextEdit | null { return null }
    rewriteBinding(_node: SyntaxNode): TextEdit | null { return null }
    rewriteNamespace(_node: SyntaxNode): TextEdit | null { return null }
    rewriteIntLiteral(_node: SyntaxNode): TextEdit | null { return null }
    rewriteStringLiteral(_node: SyntaxNode): TextEdit | null { return null }
    rewriteParameter(_node: SyntaxNode): TextEdit | null { return null }

    private dispatchRewrite(node: SyntaxNode): TextEdit | null {
        switch (node.kind) {
            case 'Definition':    return this.rewriteDefinition(node)
            case 'FunctionCall':  return this.rewriteFunctionCall(node)
            case 'BinaryOp':      return this.rewriteBinaryOp(node)
            case 'Block':         return this.rewriteBlock(node)
            case 'Binding':       return this.rewriteBinding(node)
            case 'Namespace':     return this.rewriteNamespace(node)
            case 'IntLiteral':    return this.rewriteIntLiteral(node)
            case 'StringLiteral': return this.rewriteStringLiteral(node)
            case 'Parameter':     return this.rewriteParameter(node)
            default:              return null
        }
    }
}
