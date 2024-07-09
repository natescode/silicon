import * as ohm from 'ohm-js'
export default function addParseSemantics(siliconGrammar: ohm.Grammar) {
    return siliconGrammar.createSemantics().addOperation('parse', {
        Program(sourceElements) {
            return sourceElements.children.map(sourceElement => sourceElement.eval())
        },
        SourceElement_sourceExp(exp, sc) {
            return exp.parse()
        },
        EXP_binaryExp(left, binop, right) {
            // TODO return binaryEXP Node
            // TODO lookup operator function?
            return {
                left,
                operator: binop,
                right
            }
        },
        EXP_expr(expr) {
            return {
                type: 'exp',
                value: expr.eval()
            }
        },
        EXP_letEXP(_let, identifier, eq, exp) {
            // TODO add identifier to context
            // return exp.eval()
        },
        EXPR_lit(literal) {
            return {
                literal: literal.sourceString
            }
            // return literal.eval()
        },
        EXPR_paren(lparen, exp, rparen) {
            return {
                type: 'EXPR_paren',
                lparen,
                exp: exp.eval(),
                rparen
            }
        },
        intLiteral(firstDigit, _, remaining) {
            let intString = firstDigit.sourceString + remaining.sourceString.split('_').join('')
            let intInteger = parseInt(intString, 10)
            return {
                literal: intInteger
            }
        },
        stringLiteral(_, chars, __) {
            return {
                literal: chars.children.map(c => c.sourceString).join('')
            }
        },
        binLiteral(_0b, firstDigit, _, remaining) {
            let intString = _0b.sourceString + firstDigit.sourceString + remaining.sourceString.split('_').join('')
            let intInteger = parseInt(intString)
            return {
                literal: intString,
                value: intInteger
            }
        },
        hexLiteral(_0x, firstDigit, _, remaining) {
            let intString = _0x.sourceString + firstDigit.sourceString + remaining.sourceString.split('_').join('')
            let intInteger = parseInt(intString)
            return {
                literal: intString,
                value: intInteger
            }
        },
        octLiteral(_0c, firstDigit, _, remaining) {
            let intString = firstDigit.sourceString + remaining.sourceString.split('_').join('')
            let intInteger = parseInt(intString, 8)
            return {
                type: 'octal',
                literal: intString,
                value: intInteger
            }
        },
        floatLiteral(firstDigit, _, secondDigit, dot, decimalDigits) {
            let floatString = firstDigit.sourceString + secondDigit.sourceString + dot.sourceString + decimalDigits.sourceString
            return {
                type: 'float',
                literal: floatString,
            }
        },
        booleanLiteral(v) {
            if (v.sourceString === "@true") return { type: 'boolean', literal: '@true', value: true }
            if (v.sourceString === "@false") return { type: 'boolean', literal: '@false', value: false }
            throw new Error("invalid boolean literal value")
        },
        keyword(at, word) {
            // TODO validate keyword
            return {
                type: 'keyword',
                literal: at.sourceString + word.sourceString
            }
        },
        identifier_discard(discard) {
            return {
                type: 'discard',
                literal: discard.sourceString
            }
        },
        identifier_pub(start, end) {
            return {
                type: 'identifier',
                literal: start.sourceString + end.children.map(c => c.sourceString).join('')
            }
        },
        identifier_priv(underscore, name) {
            return {
                type: 'identifier',
                literal: underscore.sourceString + name.children.map(c => c.sourceString).join('')
            }
        },
        discard(discard) {
            return {
                type: 'discard',
                literal: discard.sourceString
            }
        }
    });
}