import * as ohm from 'ohm-js'
import { IndentStyle } from 'typescript';

/*
These are the semantics for compiling Silicon into Web Assembly. This version
c[semantics wrapper for Silicon]ompiles to WAT (Web Assembly text format). Tools like Wat2Wasm.
Mac:
    #install
    brew install wabt
    #convert WAT to WASM
    wat2wasm main.wat -o main.wasm
*/
export default function addCompileSemantics(siliconGrammar: ohm.Grammar) {
    return siliconGrammar.createSemantics().addOperation('compile', {
        Program(elements) {
            const body_wat = elements.children.map(element => element.compile()).join("\n")
            // const program_wat = `(module
            //     (func $main (export "main") (result i32)
            //         ${body_wat} 
            //         return
            //     )
            // )`
            const program_wat = body_wat
            return program_wat
        },
        Element_Expression(exp, sc) {
            return exp.compile()
        },
        Element_Func(funcdef, sc) {
            const [fn, nameType, params, assign] = funcdef.children;
            const [_eq, expr] = assign.children[0].children

            const paramsCode = params.compile()

            var funcName = nameType.sourceString.split(':')[0]
            return `
                (func \$${funcName} (export "${funcName}")
                ${params.sourceString != "" ? paramsCode : ''}
                (result ${nameType.sourceString.split(':')[1]})
                    ${expr.compile()}
                    return
                )
                `
        },
        ExpressionStart_binaryExpression(left, binop, right) {
            let lvalue = left.compile()
            let rvalue = right.compile()

            if (binop.sourceString === '++') return `'${lvalue + rvalue}'`

            if (binop.sourceString === '+') return `
        ${lvalue}
        ${rvalue}
        i32.add`

            if (binop.sourceString === '-') return `${lvalue}
        ${rvalue}
        i32.sub`

            if (binop.sourceString === '*') return `${lvalue}
        ${rvalue}
        i32.mul`

            if (binop.sourceString === '/') return `${lvalue}
        ${rvalue}
        i32.div_s`

            if (binop.sourceString === '..') {
                return `$`
            }


        },
        ExpressionStart_letExpression(_let, identtype, eq, exp) {
            let [identifier, _type] = identtype.sourceString.split(":")

            return `local \$${identifier} ${_type}
            local.set \$${identifier} ${exp.compile()}
            `
        },
        ExpressionStart_whenExpression($when, cond, _c1, _lbrace1, $then, _rbrace1, _c2, _lbrace2, $else, _rbrace2) {
            return `${cond.compile()}
            (if (result i32)
                (then ${$then.compile()})
                (else ${$else.compile()})
            )
            `
        },
        ExpressionStart_Loop(_loop, start, _dotdot, stop, _comma, func) {

            let funcString = func.compile()
            let funcName = func.children[0].children[1].sourceString.split(':')[0]
            let loop = `
    ;; Loop from start to stop

    ;; initialize $index 
    (local $index i32)
    i32.const 0
    local.set $index

    ;; initialize value
    (local $value i32)
    local.get ${start}
    local.set $value

    ;; loop from start to stop
    (loop $loop

      ;; Call inline function with index & value as arguments
      (call \$${funcName} (local.get $index) (local.get $value))

      ;; Increment value
      local.get $value
      i32.const 1
      i32.add
      local.set $value

      ;; Increment index
      local.get $index
      i32.const 1
      i32.add
      local.set $index
      
      ;; Check if we are under $stop value
      local.get $value
      i32.const ${stop}
      i32.le_u
      br_if $loop
    )
`

            return `${funcString}
            ${loop}`
        },
        ExpressionEnd(expr) {
            return expr.compile()
        },
        ExpressionEnd_paren(lparen, expression, rparen) {
            return expression.compile()
        },
        variable(identifier) {
            return `(local.get \$${identifier.sourceString})`
        },
        Params(_params) {
            const result = _params.sourceString.split(',').map((param) => "(param $" + param.split(':').join(' ')).join(')') + ")"
            // const result = _params.asIteration().children.map((param)=>param)
            return result
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