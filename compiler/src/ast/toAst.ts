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
import { ASTFactory } from './astNodes'

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

        Element_elaboration(elaboration, _semi) {
            return elaboration.toAst()
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
            const genericParams = generics.children.length > 0 ? generics.toAst() : undefined
            const paramList = params.asIteration().children.map((p: any) => p.toAst())
            const bindingAst = binding.children.length > 0 ? binding.toAst() : undefined
            return ASTFactory.definition(keyword, name, paramList, genericParams, bindingAst)
        },

        GenericParams(_open, params, _close) {
            const paramList = params.asIteration().children.map((p: any) => p.sourceString)
            return ASTFactory.genericParams(paramList)
        },

        Elaboration(_stratum, strataDef) {
            return strataDef.toAst()
        },

        strataDefinition(def) {
            return def.toAst()
        },

        operatorDefinition(name, _open, _op, _comma1, symbol, _comma2, nodeParam, _close, _eq, body) {
            const elaborationName = name.sourceString
            const operatorSymbol = symbol.toAst()
            const nodeParamName = nodeParam.sourceString
            const semanticsBody = body.toAst()
            return ASTFactory.elaboration('operator', elaborationName, 'Operator', operatorSymbol, nodeParamName, semanticsBody)
        },

        keywordDefinition(name, _open, _kw, _comma1, keywordName, _comma2, nodeParam, _close, _eq, body) {
            const elaborationName = name.sourceString
            const kwName = keywordName.toAst()
            const nodeParamName = nodeParam.sourceString
            const semanticsBody = body.toAst()
            return ASTFactory.elaboration('keyword', elaborationName, 'Keyword', kwName, nodeParamName, semanticsBody)
        },

        operatorSymbol(stringLit) {
            return stringLit.toAst()
        },

        keywordName(stringLit) {
            return stringLit.toAst()
        },

        strataBody(_open, items, _close) {
            const itemList = items.asIteration().children.map((item: any) => item.toAst())
            // strataBody contains a Block
            return ASTFactory.block(itemList)
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

        Binding(_colonEq, exp) {
            return ASTFactory.binding(exp.toAst())
        },

        Block(_open, items, _semis, _close) {
            const itemList = items.children.map((itemNode: any) => itemNode.toAst())
            return ASTFactory.block(itemList)
        },

        namespace(first, _seps, rest) {
            const parts: string[] = [first.sourceString]
            if (rest && rest.children) {
                rest.children.forEach((segment: any) => {
                    if (segment.sourceString) {
                        parts.push(segment.sourceString)
                    }
                })
            }
            return ASTFactory.namespace(parts)
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
            const typeAnnotation = type.children.length > 0 ? type.toAst() : undefined
            return ASTFactory.typedIdentifier(name, typeAnnotation)
        },

        type(_colon, ident) {
            return ASTFactory.typeAnnotation(ident.sourceString)
        },

        ParamLiteral_typedId(typedId) {
            const ti = typedId.toAst()
            return ASTFactory.parameter(ti.name, ti.typeAnnotation)
        },

        ParamLiteral_literal(lit) {
            const literalAst = lit.toAst()
            return ASTFactory.parameter('_param', undefined, true, literalAst)
        },

        identifier_normal(letter, rest) {
            return letter.sourceString + rest.sourceString
        },

        identifier_underscoreStart(underscore, rest) {
            return underscore.sourceString + rest.sourceString
        },
    })

    return semantics
}
