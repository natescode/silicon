// SPDX-License-Identifier: MIT
/**
 * Parse Tree to AST Transformation
 *
 * This module converts the raw parse tree produced by Ohm into a strongly-typed
 * Abstract Syntax Tree (AST). This is stage 2 of the compilation pipeline.
 *
 * Architecture:
 * - Implements Ohm's semantic action pattern
 * - One semantic action per grammar rule
 * - Uses ASTFactory to ensure type safety and consistency
 * - Preserves all semantic information needed for later compilation stages
 *
 * The resulting AST is:
 * - Strongly typed with full TypeScript support
 * - Free of parse tree cruft (tokens, whitespace, etc.)
 * - Optimized for downstream transformations
 *
 * @example
 *   const astSemantics = addToAstSemantics(grammar)
 *   const ast = astSemantics(match).toAst()
 *
 * @see astNodes.ts - Type definitions for all AST nodes
 */

import * as ohm from 'ohm-js'
import { ASTFactory, type TypedIdentifier, type TypeAnnotation, type SourceLocation } from './astNodes'

/** Extract a SourceLocation from an Ohm CST node's source interval. */
function locFrom(ohmNode: any): SourceLocation | undefined {
    try {
        const src = ohmNode?.source
        if (!src) return undefined
        const start = src.getLineAndColumn()
        const end = src.collapsedRight().getLineAndColumn()
        return {
            startLine:   start.lineNum,
            startColumn: start.colNum,
            endLine:     end.lineNum,
            endColumn:   end.colNum,
        }
    } catch {
        return undefined
    }
}

/**
 * Create semantic actions for transforming parse trees to AST
 *
 * @param siliconGrammar - The compiled Ohm grammar
 * @returns Ohm semantics object with 'toAst' operation
 */
export default function addToAstSemantics(siliconGrammar: ohm.Grammar): ohm.Semantics {
    const semantics = siliconGrammar.createSemantics().addOperation('toAst', {
        Program(elements) {
            // A BlockDef (@extern/@interface) expands to an array of definitions,
            // so flatten one level here.
            const elementList = elements.children.flatMap((el: any) => {
                const r = el.toAst()
                return Array.isArray(r) ? r : [r]
            })
            return ASTFactory.program(elementList)
        },

        Element_blockDef(blockDef) {
            return blockDef.toAst()   // Definition[]
        },

        Element_item(item, _semi) {
            return item.toAst()
        },

        Element_docComment(docComment) {
            return docComment.toAst()
        },

        Item_statement(stmt) {
            return stmt.toAst()
        },

        Item_expressionStart(exp) {
            return exp.toAst()
        },

        Item(exp) {
            return exp.toAst()
        },

        DocComment(_hashhash, chars) {
            const content = chars.sourceString
            return ASTFactory.docComment(content)
        },

        docChar(char) {
            return char.sourceString
        },

        Statement_assignment(assgn) {
            return assgn.toAst()
        },

        Statement_definition(def) {
            return def.toAst()
        },

        Assignment(ns, _eq, exp) {
            const target = ns.toAst()
            const value = exp.toAst()
            return ASTFactory.assignment(target, value)
        },

        // Definition = AttachedSig? defKw identifier GenericParams? Params Binding?
        // The optional attached signature carries the function type; we
        // distribute its domain onto the (bare) params by position and its
        // range onto the name's return-type slot — producing exactly the AST
        // the old inline-type grammar produced, so nothing downstream changes.
        Definition(attachedSigOpt, kw, ident, generics, params, binding) {
            const keyword = kw.toAst()
            let genericParams = generics.children.length > 0
                ? generics.children[0].toAst()
                : undefined
            let paramList = params.toAst() as any[]
            let returnAnnotation: TypeAnnotation | undefined

            if (attachedSigOpt.children.length > 0) {
                const sig = attachedSigOpt.children[0].toAst() as { name: string; generics?: any; type: any }
                const fnType = sig.type
                if (fnType && Array.isArray(fnType.fnParams)) {
                    // Function signature: zip domain types onto params, range → return.
                    paramList = paramList.map((p: any, i: number) => {
                        const slot = fnType.fnParams[i]
                        return slot
                            ? ASTFactory.parameter(p.name, slot.typeAnnotation, p.isLiteral, p.value)
                            : p
                    })
                    returnAnnotation = fnType.fnReturn?.typeAnnotation
                } else if (fnType) {
                    // Non-function (value) signature → the binding's type.
                    returnAnnotation = fnType
                }
                if (sig.generics) genericParams = sig.generics
            }

            const name = ASTFactory.typedIdentifier(ident.sourceString, returnAnnotation)
            const bindingAst = binding.children.length > 0 ? binding.children[0].toAst() : undefined
            const node = ASTFactory.definition(keyword, name, paramList, genericParams, bindingAst)
            node.sourceLocation = locFrom(ident)
            return node
        },

        // \\ name [generics] <TypeExpr>   (attached signature; no ":")
        // `name` is kept as the raw text so namespaced extern symbols
        // (e.g. wasi_snapshot_preview1::fd_write) survive intact.
        AttachedSig(_sigil, namespace, genericsOpt, typeExpr) {
            const name = namespace.sourceString
            const generics = genericsOpt.children.length > 0 ? genericsOpt.children[0].toAst() : undefined
            const type = typeExpr.toAst()
            return { name, generics, type }
        },

        // @extern { \\ … } / @interface Name[T] { \\ … }  →  array of definitions.
        BlockDef(kw, identOpt, _generics, sigBlock) {
            const keyword = kw.toAst()
            // @interface is a declaration-only stub for now (dispatch deferred):
            // emit no definitions.  @extern expands each signature to an extern def.
            if (keyword === '@interface') return [] as any[]
            const sigs = sigBlock.toAst() as Array<{ name: string; generics?: any; type: any }>
            return sigs.map((sig) => {
                const fnType = sig.type
                const params = (fnType?.fnParams ?? []).map((slot: any, i: number) =>
                    ASTFactory.parameter('_arg' + i, slot.typeAnnotation))
                const name = ASTFactory.typedIdentifier(sig.name, fnType?.fnReturn?.typeAnnotation)
                return ASTFactory.definition(keyword, name, params, sig.generics, undefined)
            })
        },

        SignatureBlock(_lb, sigs, _rb) {
            return sigs.children.map((s: any) => s.toAst())
        },

        Params(list) {
            return list.asIteration().children.map((p: any) => p.toAst())
        },

        GenericParams(_open, params, _close) {
            const paramList = params.asIteration().children.map((p: any) => p.sourceString)
            return ASTFactory.genericParams(paramList)
        },

        ExpressionStart_binChain(left, binOps, endOps) {
            const leftExp = left.toAst();
            // binOps is iteration of BinOp
            // endOps is iteration of ExpressionEnd
            let result = leftExp;
            if (binOps.children && binOps.children.length > 0) {
                for (let i = 0; i < binOps.children.length; i++) {
                    const operator = binOps.children[i].toAst();
                    const rightExp = endOps.children[i].toAst();
                    // Build left-associative chain of binary operations
                    const binOpNode = ASTFactory.binOp(result, operator, rightExp);
                    result = binOpNode;
                }
            }
            return result;
        },

        ExpressionStart(exp) {
            return exp.toAst();
        },

        BinOp(op) {
            return op.sourceString
        },

        operatorChar(char) {
            return char.sourceString
        },

        FunctionCall(sigil, body) {
            return body.toAst()
        },

        FunctionCallBody_builtin(keyword, args) {
            const name = keyword.toAst()
            const argList = args.toAst()
            return ASTFactory.functionCall(name, true, argList)
        },

        FunctionCallBody_user(namespace, args) {
            const name = namespace.toAst()
            const argList = args.toAst()
            return ASTFactory.functionCall(name, false, argList)
        },

        Args(args) {
            return args.asIteration().children.map((arg: any) => arg.toAst())
        },

        CallArgs(_ampersand, args) {
            return args.toAst()
        },

        CallNoArgs(_lookahead) {
            return []
        },

        CallArgsOrEnd(argsOrEnd) {
            return argsOrEnd.toAst()
        },

        defKw(_at, ident) {
            return '@' + ident.sourceString
        },

        keyword(at, ident) {
            return at.sourceString + ident.sourceString
        },

        ExpressionEnd_literal(lit) {
            return lit.toAst()
        },

        ExpressionEnd_ascribe(asc) {
            return asc.toAst()
        },

        // &@as Type, expr  — compile-time type ascription.  For now the type
        // hint is dropped and the inner expression is used directly (the
        // codemod only emits this where the old @let type was redundant or for
        // the rare ambiguous case; enforcing the hint is a later refinement).
        AscribeExpr(_kw, _typeExpr, _comma, expr) {
            return expr.toAst()
        },

        ExpressionEnd_namespace(ns) {
            return ns.toAst()
        },

        ExpressionEnd_block(blk) {
            return blk.toAst()
        },

        ExpressionEnd_paren(_open, exp, _close) {
            return exp.toAst()
        },

        ExpressionEnd_variantDecl(vd) {
            return vd.toAst()
        },

        VariantDecl_declaration(_dollar, ident, fields) {
            const name = ident.sourceString
            const fieldList: any[] = fields.asIteration().children.map((f: any) => f.toAst())
            return ASTFactory.variantDecl(name, fieldList)
        },

        Binding(_colonEq, exp) {
            return ASTFactory.binding(exp.toAst())
        },

        Block(_open, items, _semis, trailing, _close) {
            const itemList = items.children.map((itemNode: any) => itemNode.toAst())
            const trailingAst = trailing.children.length > 0 ? trailing.children[0].toAst() : undefined
            return ASTFactory.block(itemList, trailingAst)
        },

        namespace(first, sepAndText, rest) {
            const parts: string[] = [first.sourceString]
            const sepAndTextStr = Array.isArray(sepAndText)
                ? sepAndText.join('')
                : (sepAndText?.sourceString || '')

            const identifierMatches = sepAndTextStr.matchAll(/(::|\.)([a-zA-Z_][a-zA-Z0-9_]*)/g)
            for (const match of identifierMatches) {
                parts.push(match[2])
            }

            const node = ASTFactory.namespace(parts)
            // Stamp span so SemanticModel can resolve references by position.
            node.sourceLocation = locFrom(this)
            return node
        },

        Literal(lit) {
            return lit.toAst()
        },

        ArrayLiteral(_bracket, elements, _close) {
            const elementList = elements.asIteration().children.map((el: any) => el.toAst())
            return ASTFactory.arrayLiteral(elementList)
        },

        ObjectLiteral(_bracket, pairs, _close) {
            const pairList = pairs.asIteration().children.map((p: any) => p.toAst())
            return ASTFactory.objectLiteral(pairList)
        },

        TupleLiteral(_bracket, elements, _close) {
            const elementList = elements.asIteration().children.map((el: any) => el.toAst())
            return ASTFactory.tupleLiteral(elementList)
        },

        KeyValuePair(ident, _eq, exp) {
            // Grammar now uses a bare identifier key (no ":"); keep the old
            // TypedIdentifier key shape so downstream object-literal code is unchanged.
            const key = ASTFactory.typedIdentifier(ident.sourceString)
            const value = exp.toAst()
            return ASTFactory.keyValuePair(key, value)
        },

        stringLiteral(_quote, chars, _closedQuote) {
            const content = chars.sourceString
            return ASTFactory.stringLiteral(content)
        },

        stringChar(char) {
            return char.sourceString
        },

        lineTerminator(term) {
            return term.sourceString
        },

        intLiteral(lit) {
            return lit.toAst()
        },

        decLiteral(digits, _seps, rest) {
            const value = digits.sourceString + (_seps.children?.length > 0 ? _seps.sourceString : '') + (rest?.sourceString ? rest.sourceString : '')
            return ASTFactory.intLiteral(value, 'decimal')
        },

        binLiteral(_prefix, bits, _seps, _rest) {
            const value = _prefix.sourceString + bits.sourceString + (_seps.children?.length > 0 ? _seps.sourceString : '') + (_rest?.sourceString ? _rest.sourceString : '')
            return ASTFactory.intLiteral(value, 'binary')
        },

        bit(b) {
            return b.sourceString
        },

        hexLiteral(_prefix, digits, _seps, _rest) {
            const value = _prefix.sourceString + digits.sourceString + (_seps.children?.length > 0 ? _seps.sourceString : '') + (_rest?.sourceString ? _rest.sourceString : '')
            return ASTFactory.intLiteral(value, 'hexadecimal')
        },

        hexDigit(d) {
            return d.sourceString
        },

        octLiteral(_prefix, digits, _seps, _rest) {
            const value = _prefix.sourceString + digits.sourceString + (_seps.children?.length > 0 ? _seps.sourceString : '') + (_rest?.sourceString ? _rest.sourceString : '')
            return ASTFactory.intLiteral(value, 'octal')
        },

        octDigit(d) {
            return d.sourceString
        },

        floatLiteral(intDigits, _intSep, _dot, fracDigits, _fracSep) {
            const intStr = intDigits.sourceString + (_intSep?.sourceString ?? '')
            const fracStr = fracDigits.sourceString + (_fracSep?.sourceString ?? '')
            const value = intStr + _dot.sourceString + fracStr
            return ASTFactory.floatLiteral(value)
        },

        booleanLiteral(lit) {
            const value = lit.sourceString === '@true'
            return ASTFactory.booleanLiteral(value)
        },

        // TypeExpr = TypeAtom TypeArrow?  —  an arrow makes it a function type
        // (built as fnTypeAnnotation, identical to the old $fn shape so the
        // typechecker needs no changes); no arrow ⇒ the atom's type (a
        // parenthesised single type is just grouping).
        TypeExpr(atom, arrowOpt) {
            const a = atom.toAst() as any
            const isGroup = a && a.__domain === true
            if (arrowOpt.children.length === 0) {
                if (isGroup) return a.types[0]   // grouping: (T) → T
                return a
            }
            const range = arrowOpt.children[0].toAst() as TypeAnnotation
            const domain: TypeAnnotation[] = isGroup ? a.types : [a]
            const fnReturn = ASTFactory.typedIdentifier('_', range)
            const fnParams = domain.map((t) => ASTFactory.typedIdentifier('_', t))
            const ann = ASTFactory.fnTypeAnnotation(fnReturn, fnParams)
            ann.typename = '$fn'
            return ann
        },

        TypeArrow(_arrow, range) {
            return range.toAst()
        },

        TypeAtom_simple(ident, typeArgsOpt) {
            const typeArgs = typeArgsOpt.children.length > 0
                ? typeArgsOpt.children[0].toAst()
                : undefined
            return ASTFactory.typeAnnotation(ident.sourceString, typeArgs)
        },

        // A parenthesised group (function domain or grouping).  Marked __domain
        // so TypeExpr can tell a domain tuple from a grouped single type.
        TypeAtom_group(_lp, list, _rp) {
            const types = list.asIteration().children.map((t: any) => t.toAst())
            return { __domain: true, types }
        },

        typeArgs(_lb, _ws1, first, _ws2, _commas, _ws3, rest, _ws4, _rb) {
            const items: any[] = [first.toAst()]
            for (const r of rest.children) items.push(r.toAst())
            return items
        },

        typeArg(ident, typeArgsOpt) {
            const args = typeArgsOpt.children.length > 0
                ? typeArgsOpt.children[0].toAst()
                : undefined
            return { type: 'TypeArg', name: ident.sourceString, args }
        },

        // ParamLiteral = identifier TypeExpr?  (juxtaposition, no ":").
        // Bare for @fn params (no TypeExpr); typed for @struct/@type fields.
        ParamLiteral_field(ident, typeExprOpt) {
            const typeAnnotation = typeExprOpt.children.length > 0
                ? typeExprOpt.children[0].toAst()
                : undefined
            return ASTFactory.parameter(ident.sourceString, typeAnnotation)
        },

        ParamLiteral_literal(lit) {
            const literalAst = lit.toAst()
            return ASTFactory.parameter('_param', undefined, true, literalAst)
        },

        identifier_discard(_underscore) {
            return '_'
        },

        identifier_normal(letter, rest) {
            return letter.sourceString + rest.sourceString
        },

        identifier_underscoreStart(underscore, rest) {
            return underscore.sourceString + rest.sourceString
        },

        // Ohm v16 requires explicit _iter action for iteration nodes with rest parameter
        _iter(...children) {
            return children.map((c: any) => c.toAst())
        },
    })

    return semantics
}
