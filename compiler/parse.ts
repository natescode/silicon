import * as ohm from 'ohm-js'
export default function addEvalSemantics(siliconGrammar: ohm.Grammar) {
    return siliconGrammar.createSemantics().addOperation('parse', {
        Program(elements) {
            // TODO create context
            return { type: 'program', elements: elements.children.map(element => element.parse()) }
        },
        Element_Expression(exp, sc) {
            return { type: 'expression', expression: exp.parse() }
        },
        ExpressionStart_binaryExpression(left, op, right) {
            let lvalue = left.parse()
            let rvalue = right.parse()
            return {
                type: 'binary_expression',
                left: lvalue,
                op: op.sourceString,
                right: rvalue,
            }
        },
        ExpressionStart_letExpression(_let, identifier, eq, expression) {
            // TODO add identifier to context
            return {
                type: 'let_expression',
                identifier: identifier.sourceString,
                expression: expression.parse()
            }
        },
        ExpressionEnd(expr) {
            return expr.parse()
        },
        ExpressionEnd_paren(lparen, expression, rparen) {
            return { type: 'expression', expression: expression.parse() }
        },
        intLiteral(literal) {
            return { type: 'int_literal', value: literal.parse() }
        },
        decLiteral(firstDigit, _, remaining) {
            let intString = firstDigit.sourceString + remaining.sourceString.split('_').join('')
            // console.log(`intString ${intString}`)
            let intInteger = parseInt(intString, 10)
            return { type: 'int', value: intInteger }
        },
        stringLiteral(_, chars, __) {
            // return '"' + chars.children.map(c => c.sourceString).join('') + '"'
            return chars.children.map(c => c.sourceString).join('')
        },
        binLiteral(_0b, firstDigit, _, remaining) {
            let intString = _0b.sourceString + firstDigit.sourceString + remaining.sourceString.split('_').join('')
            let intInteger = parseInt(intString)
            return { type: 'int', value: intInteger }
        },
        hexLiteral(_0x, firstDigit, _, remaining) {
            let intString = _0x.sourceString + firstDigit.sourceString + remaining.sourceString.split('_').join('')
            let intInteger = parseInt(intString)
            return { type: 'int', value: intInteger }
        },
        octLiteral(_0c, firstDigit, _, remaining) {
            let intString = firstDigit.sourceString + remaining.sourceString.split('_').join('')
            let intInteger = parseInt(intString, 8)
            return { type: 'int', value: intInteger }
        },
        floatLiteral(firstDigit, _, secondDigit, dot, decimalDigits) {
            let floatString = firstDigit.sourceString + secondDigit.sourceString + dot.sourceString + decimalDigits.sourceString
            return { type: 'float', value: parseFloat(floatString) }
        },
        booleanLiteral(v) {
            if (v.sourceString === "@true") {
                return {
                    type: 'boolean', value: true
                }
            }
            if (v.sourceString === "@false") {
                return { type: 'boolean', value: false }
            }
            throw new Error("invalid boolean literal value")
        },
        keyword(at, word) {
            return {
                type: 'keyword',
                value: word.sourceString.toLowerCase()
            }
        },
        identifier_discard(discard) {
            return {
                type: 'discard'
            }
        },
        identifier_pub(start, end) {
            return {
                type: 'identifier',
                value: start.sourceString + end.children.map(c => c.sourceString).join('')
            }
        },
        identifier_priv(underscore, name) {
            return {
                type: 'identifier',
                value: underscore.sourceString + name.children.map(c => c.sourceString).join('')
            }
        },
        discard(discard) {
            // "_" character
            return discard.sourceString
        }

    });
}