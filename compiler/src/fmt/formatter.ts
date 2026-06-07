// SPDX-License-Identifier: MIT
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
    const kw = def.keyword
    const name = def.name.name
    const generics = def.generics && def.generics.params.length > 0
        ? '[' + def.generics.params.join(', ') + ']'
        : ''

    // @struct Name f T, g U  ->  @type Name := { f T, g U }  (space-separated fields)
    if (kw === '@struct') {
        const fields = def.params.map(formatFieldSpace).join(', ')
        return '@type ' + name + generics + ' := { ' + fields + ' }'
    }
    // @enum / @type (@type_sum folds into @type) — keep the keyword, RHS as-is.
    if (kw === '@enum') {
        return '@enum ' + name + generics + (def.binding ? ' := ' + formatBinding(def.binding, depth) : '')
    }
    if (kw === '@type' || kw === '@type_sum') {
        return '@type ' + name + generics + (def.binding ? ' := ' + formatBinding(def.binding, depth) : '')
    }
    // @extern  ->  body-less `\\ @extern name (Types) -> Ret;` signature line.
    if (kw === '@extern') {
        const ptypes = def.params.map(p => p.typeAnnotation ? typeExprSource(p.typeAnnotation) : '_')
        let sig = '\\\\ @extern ' + name + generics + ' (' + ptypes.join(', ') + ')'
        if (def.name.typeAnnotation) sig += ' -> ' + typeExprSource(def.name.typeAnnotation)
        return sig
    }

    // Value / function bindings. ADR-0020: bare = immutable value, `@mut` = mutable,
    // `@fn` = function. The parsed `immutable` flag (bare ⇒ true, `@mut` ⇒ false)
    // decides bare vs `@mut`; `@global`/`@let` are always bare.
    const prefix =
        kw === '@fn'     ? '@fn ' :
        kw === '@global' ? '' :
        kw === '@let'    ? '' :
        kw === '@local'  ? ((def as { immutable?: boolean }).immutable === false ? '@mut ' : '') :
        kw === '@var'    ? '@mut ' :
        kw + ' '   // unknown keyword — keep verbatim

    let defLine = prefix + name + generics
    if (def.params.length > 0) {
        defLine += ' ' + def.params.map(p => formatParam(p, depth)).join(', ')
    }
    if (def.binding) {
        defLine += ' := ' + formatBinding(def.binding, depth)
    }

    // Types live on a reconstructed `\\` signature line — never inline.
    const retType = def.name.typeAnnotation ? typeExprSource(def.name.typeAnnotation) : ''
    const paramTypes = def.params.map(p => p.typeAnnotation ? typeExprSource(p.typeAnnotation) : null)
    const hasTypeInfo = retType !== '' || paramTypes.some(t => t !== null)
    if (hasTypeInfo) {
        let sig: string
        if (def.params.length > 0) {
            sig = '\\\\ ' + name + generics + ' (' + paramTypes.map(t => t ?? '_').join(', ') + ')'
            if (retType) sig += ' -> ' + retType
        } else {
            sig = '\\\\ ' + name + generics + ' ' + (retType || '_')   // typed value binding
        }
        return sig + '\n' + ind(depth) + defLine
    }
    return defLine
}

// struct field / variant payload — `name Type` (space-separated, no colon).
function formatFieldSpace(p: Parameter): string {
    return p.name + (p.typeAnnotation ? ' ' + typeExprSource(p.typeAnnotation) : '')
}

function formatParam(p: Parameter, depth: number): string {
    // Bare param name in the def line; its type (if any) rides the `\\` sig line.
    if (p.isLiteral && p.value) return formatNode(p.value, depth)
    return p.name
}

function formatBinding(b: Binding, depth: number): string {
    return formatNode(b.expression as any, depth)
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

function formatBinOp(b: BinaryOp, depth: number): string {
    // ADR-0020: calls are always parenthesised (`f(x)`), so `f(x) + y` is
    // unambiguous — no call-operand parens needed. A BinaryOp right operand was
    // parenthesised in the source (Silicon has no operator precedence), so it
    // gets its grouping parens restored.
    const leftStr = formatNode(b.left as any, depth)
    const right: any = b.right
    const rightStr = right.type === 'BinaryOp'
        ? '(' + formatNode(right, depth) + ')'
        : formatNode(right, depth)
    return leftStr + ' ' + b.operator + ' ' + rightStr
}

function formatFunctionCall(fc: FunctionCall, depth: number): string {
    const name = typeof fc.name === 'string'
        ? fc.name
        : formatNamespace(fc.name as Namespace)
    return name + '(' + fc.args.map(a => formatNode(a as any, depth)).join(', ') + ')'
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
    return ti.name + (ti.typeAnnotation ? ' ' + typeExprSource(ti.typeAnnotation) : '')
}

// A type rendered as Silicon source: `Int`, `Option[T]`, or a function type
// `(A, B) -> C`. No leading ':' — ADR-0020 type syntax is positional/space-based.
function typeExprSource(ta: TypeAnnotation): string {
    if (!ta) return ''
    if (ta.typename === '$fn') {
        const ps = (ta.fnParams || []).map(p => typeExprSource(p.typeAnnotation!)).join(', ')
        const ret = ta.fnReturn ? typeExprSource(ta.fnReturn.typeAnnotation!) : ''
        return '(' + ps + ')' + (ret ? ' -> ' + ret : '')
    }
    let out = ta.typename
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
