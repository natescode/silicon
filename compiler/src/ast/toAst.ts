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
import { ASTFactory, type TypedIdentifier, type SourceLocation } from './astNodes'

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
            const elementList = elements.children.map((el: any) => el.toAst())
            return ASTFactory.program(elementList)
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

        Definition(kw, typedId, generics, params, binding) {
            const keyword = kw.toAst()
            const name = typedId.toAst()
            const genericParams = generics.children.length > 0
                ? generics.children[0].toAst()
                : undefined
            const paramList = params.toAst() as any[]
            const bindingAst = binding.children.length > 0 ? binding.children[0].toAst() : undefined
            const node = ASTFactory.definition(keyword, name, paramList, genericParams, bindingAst)
            // Stamp just the identifier's span (typedId.children[0] = identifier, children[1] = type?).
            node.sourceLocation = locFrom(typedId.children[0])
            return node
        },

        // Phase 5 parens-optional-grouping: both alternatives flatten to the
        // same ParamLiteral[] shape so Definition / sigilFnType / future
        // consumers don't need to know which form the user wrote.
        Params_paren(_lp, list, _rp) {
            return list.asIteration().children.map((p: any) => p.toAst())
        },

        Params_bare(list) {
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

        KeyValuePair(typedId, _eq, exp) {
            const key = typedId.toAst()
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

        typedIdentifier(ident, type) {
            const name = ident.sourceString
            // `type` here is the iteration node for `type?`. Ohm v16 has no
            // default `_iter` action, so we must descend into its children
            // explicitly rather than calling `.toAst()` on the iter wrapper.
            const typeAnnotation = type.children.length > 0
                ? type.children[0].toAst()
                : undefined
            return ASTFactory.typedIdentifier(name, typeAnnotation)
        },

        type_simple(_colon, ident, typeArgsOpt) {
            // typeArgsOpt is the iter for `typeArgs?`. Descend into the single
            // child if present (Ohm v16 has no default `_iter` action).
            const typeArgs = typeArgsOpt.children.length > 0
                ? typeArgsOpt.children[0].toAst()
                : undefined
            return ASTFactory.typeAnnotation(ident.sourceString, typeArgs)
        },

        type_fn(_colon, sigil) {
            return sigil.toAst()
        },

        // Phase 5 — sigil function-type `$fn _:R _:T1, _:T2`.  The structure
        // mirrors a function definition exactly: a return-type slot
        // (typedIdentifier) plus an optional comma-separated param list.
        // Left-factored shape (LL(1)-friendly): a common prefix
        // ("$" name retSlot) followed by an optional tail that branches
        // into paren-form (empty or with params) or bare params.  All
        // four surface forms produce the same TypeAnnotation shape so
        // downstream code is form-agnostic.
        sigilFnType(_dollar, ident, _ws1, retSlot, tailOpt) {
            const fnReturn = retSlot.toAst() as TypedIdentifier
            const fnParams = tailOpt.children.length > 0
                ? tailOpt.children[0].toAst() as TypedIdentifier[]
                : []
            const ann = ASTFactory.fnTypeAnnotation(fnReturn, fnParams)
            ann.typename = `$${ident.sourceString}`
            return ann
        },
        sigilFnTail(_ws, body) {
            return body.toAst()
        },
        sigilFnTailBody_paren(parenForm) {
            return parenForm.toAst()
        },
        sigilFnTailBody_bare(params) {
            return params.toAst()
        },
        sigilFnParenForm_empty(_lp, _ws, _rp) {
            return [] as TypedIdentifier[]
        },
        sigilFnParenForm_params(_lp, params, _rp) {
            return params.toAst()
        },

        sigilFnParams(first, _ws1, _commas, _ws2, rest) {
            const items: TypedIdentifier[] = [first.toAst()]
            for (const r of rest.children) items.push(r.toAst())
            return items
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

        ParamLiteral_typedId(typedId) {
            const ti = typedId.toAst()
            return ASTFactory.parameter(ti.name, ti.typeAnnotation)
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
