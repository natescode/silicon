import * as ohm from 'ohm-js'

/*
These are the semantics for compiling Silicon into Web Assembly. This version
compiles to WAT (Web Assembly text format). Tools like Wat2Wasm.
Mac:
    #install
    brew install wabt
    #convert WAT to WASM
    wat2wasm main.wat -o main.wasm
*/
export default function addCompileSemantics(siliconGrammar: ohm.Grammar) {
    return siliconGrammar.createSemantics().addOperation('compile', {
        Program(elements) {
            const body_wat = elements.children.map(element => element.compile())
            const program_wat = `
            (module
                (func (export "main") (result i32)
                ${body_wat} 
                )
            )`
            return program_wat
        },
        Element_Expression(exp, sc) {
            return exp.compile()
        },
        ExpressionStart_binaryExpression(left, binop, right) {
            let lvalue = left.compile()
            let rvalue = right.compile()
            if (binop.sourceString === '++') return `'${lvalue + rvalue}'`
            if (binop.sourceString === '+') return `
            ${lvalue}
            ${rvalue}
            i32.add
            `
            if (binop.sourceString === '-') return `
            ${lvalue}
            ${rvalue}
            i32.sub
            `
            if (binop.sourceString === '*') return `
            ${lvalue}
            ${rvalue}
            i32.mul
            `
            if (binop.sourceString === '/') return `
            ${lvalue}
            ${rvalue}
            i32.div_s
            `
        },
        ExpressionStart_letExpression(_let, identifier, eq, exp) {
            return exp.compile()
        },
        ExpressionEnd(expr) {
            return expr.compile()
        },
        ExpressionEnd_paren(lparen, expression, rparen) {
            return expression.compile()
        },
        // literal_str(str) {
        //     return str.compile()
        // },
        // literal_bool(bool) {
        //     return bool.compile()
        // },
        // literal_float(float) {
        //     return float.compile()
        // },
        // literal_integer(integer) {
        //     return integer.compile()
        // },
        intLiteral(literal) {
            return literal.compile()
        },
        decLiteral(firstDigit, _, remaining) {
            let intString = firstDigit.sourceString + remaining.sourceString.split('_').join('')
            // console.log(`intString ${intString}`)
            let intInteger = parseInt(intString, 10)
            return "i32.const " + intInteger
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
            return "f32.const " + parseFloat(floatString)
        },
        booleanLiteral(v) {
            if (v.sourceString === "@true") return 'i32.const 1';
            if (v.sourceString === "@false") return 'i32.const 0';
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