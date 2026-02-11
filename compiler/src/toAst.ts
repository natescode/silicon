import * as ohm from 'ohm-js'
import { ASTFactory } from './astNodes'

export default function addToAstSemantics(siliconGrammar: ohm.Grammar) {
    const semantics = siliconGrammar.createSemantics().addOperation('toAst', {
        Program(elements) {
            const elementList = elements.children.map((el: any) => el.toAst())
            return ASTFactory.program(elementList)
        },

        Element_item(item, _semi) {
            return ASTFactory.element('item', item.toAst())
        },

        Element(docComment) {
            return ASTFactory.element('docComment', docComment.toAst())
        },

        Item_statement(stmt) {
            return ASTFactory.item('statement', stmt.toAst())
        },

        Item_expressionStart(exp) {
            return ASTFactory.item('expression', exp.toAst())
        },

        Item(exp) {
            return ASTFactory.item('expression', exp.toAst())
        },

        DocComment(_hashhash, chars) {
            const content = chars.sourceString
            return ASTFactory.docComment(content)
        },

        docChar(char) {
            return char.sourceString
        },

        Statement_assignment(assgn) {
            return ASTFactory.statement('assignment', assgn.toAst())
        },

        Statement_definition(def) {
            return ASTFactory.statement('definition', def.toAst())
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

        ExpressionStart_binOp(left, op, right) {
            const leftExp = left.toAst()
            const operator = op.toAst()
            const rightExp = right.toAst()
            const binOpNode = ASTFactory.binOp(leftExp, operator, rightExp)
            return ASTFactory.expressionStart('binOp', binOpNode)
        },

        ExpressionStart_functionCall(funcCall) {
            return ASTFactory.expressionStart('functionCall', funcCall.toAst())
        },

        ExpressionStart(exp) {
            return ASTFactory.expressionStart('expressionEnd', exp.toAst())
        },

        BinOp_withReservedOp(reserved, op) {
            const first = reserved.sourceString
            const rest = op.sourceString
            return first + rest
        },

        BinOp(op) {
            return op.sourceString
        },

        ReservedOp(char) {
            return char.sourceString
        },

        operatorChar(char) {
            return char.sourceString
        },

        FunctionCall(sigil, body) {
            return body.toAst()
        },

        FunctionCallBody_builtinFunctionCall(keyword, args) {
            const name = keyword.toAst()
            const argList = args.children.length > 0 ? args.toAst() : []
            return ASTFactory.functionCall(name, true, argList)
        },

        FunctionCallBody_userFunctionCall(namespace, args) {
            const name = namespace.toAst()
            const argList = args.children.length > 0 ? args.toAst() : []
            return ASTFactory.functionCall(name, false, argList)
        },

        Args(args) {
            return args.asIteration().children.map((arg: any) => arg.toAst())
        },

        keyword(at, ident) {
            return at.sourceString + ident.sourceString
        },

        ExpressionEnd_literal(lit) {
            return ASTFactory.expressionEnd('literal', lit.toAst())
        },

        ExpressionEnd_namespace(ns) {
            return ASTFactory.expressionEnd('namespace', ns.toAst())
        },

        ExpressionEnd_block(blk) {
            return ASTFactory.expressionEnd('block', blk.toAst())
        },

        ExpressionEnd_paren(_open, exp, _close) {
            return ASTFactory.expressionEnd('paren', exp.toAst())
        },

        Binding(_colonEq, exp) {
            return ASTFactory.binding(exp.toAst())
        },

        Block(_open, items, _close) {
            const itemList = items.children.map((itemNode: any) => itemNode.toAst()[0])
            return ASTFactory.block(itemList)
        },

        namespace(first, rest) {
            const parts: string[] = [first.sourceString]
            rest.children.forEach((segment: any) => {
                parts.push(segment.children[1].sourceString)
            })
            return ASTFactory.namespace(parts)
        },

        Literal(lit) {
            return lit.toAst()
        },

        ArrayLiteral(_dollar, _open, elements, _close) {
            const elementList = elements.asIteration().children.map((el: any) => el.toAst())
            return ASTFactory.literal('array', ASTFactory.arrayLiteral(elementList))
        },

        ObjectLiteral(_dollar, _open, pairs, _close) {
            const pairList = pairs.asIteration().children.map((p: any) => p.toAst())
            return ASTFactory.literal('object', ASTFactory.objectLiteral(pairList))
        },

        TupleLiteral(_dollar, _open, elements, _close) {
            const elementList = elements.asIteration().children.map((el: any) => el.toAst())
            return ASTFactory.literal('tuple', ASTFactory.tupleLiteral(elementList))
        },

        KeyValuePair(typedId, _eq, exp) {
            const key = typedId.toAst()
            const value = exp.toAst()
            return ASTFactory.keyValuePair(key, value)
        },

        stringLiteral(_open, chars, _close) {
            const content = chars.sourceString
            return ASTFactory.literal('string', ASTFactory.stringLiteral(content))
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

        decLiteral(lit) {
            return ASTFactory.literal('int', ASTFactory.intLiteral(lit.sourceString, 'decimal'))
        },

        binLiteral(_prefix, bits, _rest) {
            return ASTFactory.literal('int', ASTFactory.intLiteral(_prefix.sourceString + bits.sourceString, 'binary'))
        },

        bit(b) {
            return b.sourceString
        },

        hexLiteral(_prefix, digits, _rest) {
            return ASTFactory.literal('int', ASTFactory.intLiteral(_prefix.sourceString + digits.sourceString, 'hexadecimal'))
        },

        hexDigit(d) {
            return d.sourceString
        },

        octLiteral(_prefix, digits, _rest) {
            return ASTFactory.literal('int', ASTFactory.intLiteral(_prefix.sourceString + digits.sourceString, 'octal'))
        },

        octDigit(d) {
            return d.sourceString
        },

        floatLiteral(intPart, _rest, fracPart) {
            const value = parseFloat(intPart.sourceString + '.' + fracPart.sourceString)
            return ASTFactory.literal('float', ASTFactory.floatLiteral(value))
        },

        booleanLiteral(lit) {
            const value = lit.sourceString === '@true'
            return ASTFactory.literal('boolean', ASTFactory.booleanLiteral(value))
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

