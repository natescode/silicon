import * as ohm from 'ohm-js'
export default function addEvalSemantics(siliconGrammar: ohm.Grammar) {
    return siliconGrammar.createSemantics().addOperation('eval', {
        Program(elements) {
            return elements.children.map(element => element.eval())
        },
        Element_Expression(exp, sc) {
            return exp.eval()
        },
        Element_Func(fn, nameType, eq, expr) {
            return expr.eval()
        },
        ExpressionStart_binaryExpression(left, binop, right) {
            let lvalue = left.eval()
            let rvalue = right.eval()
            if (binop.sourceString === '++') return `'${lvalue + rvalue}'`
            if (binop.sourceString === '+') return lvalue + rvalue
            if (binop.sourceString === '-') return lvalue - rvalue
            if (binop.sourceString === '*') return lvalue * rvalue
            if (binop.sourceString === '/') return lvalue / rvalue
        },
        ExpressionStart_letExpression(_let, identifier, eq, exp) {
            return exp.eval()
        },
        ExpressionEnd(expr) {
            return expr.eval()
        },
        ExpressionEnd_paren(lparen, expression, rparen) {
            return expression.eval()
        },
        // literal_str(str) {
        //     return str.eval()
        // },
        // literal_bool(bool) {
        //     return bool.eval()
        // },
        // literal_float(float) {
        //     return float.eval()
        // },
        // literal_integer(integer) {
        //     return integer.eval()
        // },
        intLiteral(literal) {
            return literal.eval()
        },
        decLiteral(firstDigit, _, remaining) {
            let intString = firstDigit.sourceString + remaining.sourceString.split('_').join('')
            // console.log(`intString ${intString}`)
            let intInteger = parseInt(intString, 10)
            return intInteger
        },
        stringLiteral(_, chars, __) {
            // return '"' + chars.children.map(c => c.sourceString).join('') + '"'
            return chars.children.map(c => c.sourceString).join('')
        },
        binLiteral(_0b, firstDigit, _, remaining) {
            let intString = _0b.sourceString + firstDigit.sourceString + remaining.sourceString.split('_').join('')
            let intInteger = parseInt(intString)
            return intInteger
        },
        hexLiteral(_0x, firstDigit, _, remaining) {
            let intString = _0x.sourceString + firstDigit.sourceString + remaining.sourceString.split('_').join('')
            let intInteger = parseInt(intString)
            return intInteger
        },
        octLiteral(_0c, firstDigit, _, remaining) {
            let intString = firstDigit.sourceString + remaining.sourceString.split('_').join('')
            let intInteger = parseInt(intString, 8)
            return intInteger
        },
        floatLiteral(firstDigit, _, secondDigit, dot, decimalDigits) {
            let floatString = firstDigit.sourceString + secondDigit.sourceString + dot.sourceString + decimalDigits.sourceString
            return parseFloat(floatString)
        },
        booleanLiteral(v) {
            if (v.sourceString === "@true") return true
            if (v.sourceString === "@false") return true
            throw new Error("invalid boolean literal value")
        },
        keyword(at, word) {
            return at.sourceString + word.sourceString
        },
        identifier_discard(discard) {
            return discard.sourceString
        },
        identifier_pub(start, end) {
            return start.sourceString + end.children.map(c => c.sourceString).join('')
        },
        identifier_priv(underscore, name) {
            return underscore.sourceString + name.children.map(c => c.sourceString).join('')
        },
        discard(discard) {
            // "_" character
            return discard.sourceString
        }

        // BlockLiteral(lBracket,exps,sc,rBracket){
        // }
        // Assign(eq, exp) {
        //   // todo assign
        // }
    });
}