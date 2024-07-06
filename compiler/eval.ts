import * as ohm from 'ohm-js'
export default function addEvalSemantics(siliconGrammar: ohm.Grammar) {
    return siliconGrammar.createSemantics().addOperation('eval', {
        Program(sourceElements) {
            return sourceElements.children.map(sourceElement => sourceElement.eval())
        },
        SourceElement_sourceExp(exp, sc) {
            return exp.eval()
        },
        EXP_binaryExp(left, binop, right) {
            let lvalue = left.eval()
            let rvalue = right.eval()
            if (binop.sourceString === '++') return `'${lvalue + rvalue}'`
            if (binop.sourceString === '+') return lvalue + rvalue
            if (binop.sourceString === '-') return lvalue - rvalue
            if (binop.sourceString === '*') return lvalue * rvalue
            if (binop.sourceString === '/') return lvalue / rvalue
        },
        EXP_expr(expr) {
            return expr.eval()
        },
        EXP_letEXP(_let, identifier, eq, exp) {
            return exp.eval()
        },
        EXPR_lit(literal) {
            return literal.eval()
        },
        EXPR_paren(lparen, exp, rparen) {
            return exp.eval()
        },
        intLiteral(firstDigit, _, remaining) {
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