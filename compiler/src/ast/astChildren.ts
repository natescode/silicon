// SPDX-License-Identifier: MIT
/**
 * astChildren — the single definition of "the structural child AST nodes of a
 * node", keyed on the node's `type` field.
 *
 * Shared by the `SyntaxNode` red-tree wrapper (`src/caas/syntaxNode.ts`), the
 * position table (`src/ast/positionTable.ts`), and the parser's relativize pass
 * (CaaS tracker 3b/M3) so all three agree on tree shape.
 *
 * Leaf nodes return an empty array.
 */

/** Return the direct AST child objects of `node`, keyed on the `type` field. */
export function astChildren(node: object): readonly object[] {
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
