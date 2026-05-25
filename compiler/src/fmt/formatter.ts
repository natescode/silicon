/**
 * Silicon source formatter — produces canonical Silicon from the AST.
 *
 * Limitations:
 *   - Single-line `#` comments are stripped by the grammar (treated as
 *     whitespace) and cannot be preserved. `##` DocComments are preserved.
 *   - `.` field-access separators are normalised to `::` (both forms are
 *     semantically identical in Silicon; the lowerer decides at compile time
 *     whether a path resolves to a struct field or a module member).
 *   - Parentheses in binary-op right operands are reconstructed: any BinaryOp
 *     that appears as the right operand of another BinaryOp was originally
 *     parenthesised and gets parens added back.
 */

import type {
    Program, Assignment, Definition, BinaryOp,
    FunctionCall, Block, Namespace, TypedIdentifier,
    TypeAnnotation, TypeArg, Parameter,
    VariantDecl, DocComment, Binding, KeyValuePair,
    StringLiteral, IntLiteral, FloatLiteral, BooleanLiteral,
    ArrayLiteral, ObjectLiteral, TupleLiteral,
} from '../ast/astNodes'

const IND = '    ' // 4-space canonical indentation

function ind(depth: number): string {
    return IND.repeat(depth)
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function formatProgram(program: Program): string {
    const parts: string[] = []
    for (let i = 0; i < program.elements.length; i++) {
        const el: any = program.elements[i]
        // Blank line before each top-level Definition (except the first element)
        if (i > 0 && el.type === 'Definition') parts.push('')
        parts.push(formatTopElement(el, 0))
    }
    return parts.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Element / item dispatch
// ---------------------------------------------------------------------------

function formatTopElement(node: any, depth: number): string {
    if (node.type === 'DocComment') {
        return ind(depth) + '##' + (node as DocComment).content
    }
    return ind(depth) + formatNode(node, depth) + ';'
}

function formatBlockItem(node: any, depth: number): string {
    return ind(depth) + formatNode(node, depth) + ';'
}

// ---------------------------------------------------------------------------
// Generic node dispatcher — handles every concrete node type
// ---------------------------------------------------------------------------

function formatNode(node: any, depth: number): string {
    if (!node) return ''
    switch (node.type) {
        case 'Assignment':      return formatAssignment(node, depth)
        case 'Definition':      return formatDefinition(node, depth)
        case 'BinaryOp':        return formatBinOp(node, depth)
        case 'FunctionCall':    return formatFunctionCall(node, depth)
        case 'Block':           return formatBlock(node, depth)
        case 'Namespace':       return formatNamespace(node)
        case 'VariantDecl':     return formatVariantDecl(node)
        case 'StringLiteral':   return "'" + (node as StringLiteral).value + "'"
        case 'IntLiteral':      return (node as IntLiteral).value
        case 'FloatLiteral':    return (node as FloatLiteral).value
        case 'BooleanLiteral':  return (node as BooleanLiteral).value ? '@true' : '@false'
        case 'ArrayLiteral':    return formatArrayLiteral(node, depth)
        case 'ObjectLiteral':   return formatObjectLiteral(node, depth)
        case 'TupleLiteral':    return formatTupleLiteral(node, depth)
        // Defensive unwrappers for wrapper nodes (should already be stripped)
        case 'Literal':         return formatNode(node.value, depth)
        case 'Binding':         return formatNode((node as Binding).expression, depth)
        case 'ExpressionStart': return formatNode(node.value, depth)
        case 'ExpressionEnd':   return formatNode(node.value, depth)
        case 'Statement':       return formatNode(node.value, depth)
        case 'Item':            return formatNode(node.value, depth)
        case 'Element':
            return node.kind === 'docComment'
                ? '##' + (node.value as DocComment).content
                : formatNode(node.value, depth)
        default: return ''
    }
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

function formatAssignment(a: Assignment, depth: number): string {
    return formatNamespace(a.target) + ' = ' + formatNode(a.value as any, depth)
}

function formatDefinition(def: Definition, depth: number): string {
    let out = def.keyword + ' ' + formatTypedId(def.name)
    if (def.generics && def.generics.params.length > 0) {
        out += '[' + def.generics.params.join(', ') + ']'
    }
    if (def.params.length > 0) {
        out += ' ' + def.params.map(p => formatParam(p, depth)).join(', ')
    }
    if (def.binding) {
        out += ' := ' + formatBinding(def.binding, depth)
    }
    return out
}

function formatParam(p: Parameter, depth: number): string {
    if (p.isLiteral && p.value) return formatNode(p.value, depth)
    let out = p.name
    if (p.typeAnnotation) out += formatTypeAnnotation(p.typeAnnotation)
    return out
}

function formatBinding(b: Binding, depth: number): string {
    return formatNode(b.expression as any, depth)
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

function formatBinOp(b: BinaryOp, depth: number): string {
    const left: any = b.left
    // A FunctionCall with args as left operand would re-parse as consuming the
    // operator and right side as its own arguments — add parens to prevent this.
    // (`&f x + y` re-parses as `f(x+y)`, not `f(x) + y`)
    const leftNeedsParens = left.type === 'FunctionCall' && (left as FunctionCall).args.length > 0
    const leftStr = leftNeedsParens
        ? '(' + formatFunctionCall(left, depth) + ')'
        : formatNode(left, depth)

    const right: any = b.right
    // A BinaryOp right operand was parenthesised in the original.
    // A FunctionCall-with-args right operand would consume a subsequent binary
    // operator's tokens as its own args — add parens to prevent this too.
    const rightNeedsParens =
        right.type === 'BinaryOp' ||
        (right.type === 'FunctionCall' && (right as FunctionCall).args.length > 0)
    const rightStr = rightNeedsParens
        ? '(' + formatNode(right, depth) + ')'
        : formatNode(right, depth)

    return leftStr + ' ' + b.operator + ' ' + rightStr
}

function formatFunctionCall(fc: FunctionCall, depth: number): string {
    const name = typeof fc.name === 'string'
        ? fc.name
        : formatNamespace(fc.name as Namespace)
    const prefix = '&' + name
    if (fc.args.length === 0) return prefix
    return prefix + ' ' + fc.args.map(a => formatNode(a as any, depth)).join(', ')
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function formatBlock(b: Block, depth: number): string {
    if (b.items.length === 0 && !b.trailing) return '{}'
    const inner = depth + 1
    const lines: string[] = ['{']
    for (const item of b.items) {
        lines.push(formatBlockItem(item as any, inner))
    }
    if (b.trailing) {
        lines.push(ind(inner) + formatNode(b.trailing as any, inner))
    }
    lines.push(ind(depth) + '}')
    return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Structural nodes
// ---------------------------------------------------------------------------

function formatNamespace(ns: Namespace): string {
    return ns.path.join('::')
}

function formatTypedId(ti: TypedIdentifier): string {
    let out = ti.name
    if (ti.typeAnnotation) out += formatTypeAnnotation(ti.typeAnnotation)
    return out
}

function formatTypeAnnotation(ta: TypeAnnotation): string {
    if (ta.typename === '$fn') {
        let out = ':$fn ' + formatTypedId(ta.fnReturn!)
        if (ta.fnParams && ta.fnParams.length > 0) {
            out += ' ' + ta.fnParams.map(formatTypedId).join(', ')
        }
        return out
    }
    let out = ':' + ta.typename
    if (ta.typeArgs && ta.typeArgs.length > 0) {
        out += '[' + ta.typeArgs.map(formatTypeArg).join(', ') + ']'
    }
    return out
}

function formatTypeArg(ta: TypeArg): string {
    let out = ta.name
    if (ta.args && ta.args.length > 0) {
        out += '[' + ta.args.map(formatTypeArg).join(', ') + ']'
    }
    return out
}

function formatVariantDecl(vd: VariantDecl): string {
    let out = '$' + vd.name
    if (vd.fields.length > 0) out += ' ' + vd.fields.map(formatTypedId).join(', ')
    return out
}

// ---------------------------------------------------------------------------
// Compound literals
// ---------------------------------------------------------------------------

function formatArrayLiteral(a: ArrayLiteral, depth: number): string {
    return '$[' + a.elements.map(e => formatNode(e as any, depth)).join(', ') + ']'
}

function formatObjectLiteral(o: ObjectLiteral, depth: number): string {
    return '${' + o.properties.map(kv => formatKVPair(kv, depth)).join(', ') + '}'
}

function formatTupleLiteral(t: TupleLiteral, depth: number): string {
    return '$(' + t.elements.map(e => formatNode(e as any, depth)).join(', ') + ')'
}

function formatKVPair(kv: KeyValuePair, depth: number): string {
    return formatTypedId(kv.key) + '=' + formatNode(kv.value as any, depth)
}
