console.log("Silicon v2024.01");
import * as ohm from 'ohm-js'
import type { SiliconGrammar, SiliconActionDict, SiliconSemantics } from './src/silicon-simple.ohm-bundle.js'
// An Ohm grammar for arithmetic expressions.
// Syntax reference: https://github.com/harc/ohm/blob/master/doc/syntax-reference.md
const grammarSource = Bun.file('./src/silicon-simple.ohm')
// Instantiate the grammar defined in ./src/silicon-simple.ohm
const siliconGrammar = ohm.grammar(await grammarSource.text());

// Define an operation named 'eval' which evaluates the expression.
// See https://github.com/cdglabs/ohm/blob/master/doc/api-reference.md#semantics
const siliconSemantics = siliconGrammar.createSemantics().addOperation('eval', {
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

let result;
// let sourceCode = '5 - 1 + 2 * 3 / 2;'
// let sourceCode = '"hello, " + "world!";'
// let sourceCode = '5 - 1 + (2 * 3) / 2;'
// let sourceCode = '0x10 + 0x11;'
// let sourceCode = '1.2 + 1.8;'
// let sourceCode = "'hello, ' ++ 'world!';";
let sourceCode = `1 + (@let x = 2);`
const match = siliconGrammar.match(sourceCode);
if (match.succeeded()) {
  result = siliconSemantics(match).eval();  // Evaluate the expression.
} else {
  result = match.message;  // Extract the error message.
}
let sc = sourceCode.slice(0, -1)
console.log(`${sc} = ${result}`)

// TODO move 9 above into this method
// function parseExpression(input: string, grammar: SiliconGrammar): ohm.MatchResult {
//   const matchResult = grammar.match(input);
//   if (matchResult.succeeded()) {
//     console.log('Parsing succeeded!')
//   } else {
//     console.error('Parsing failed :-(')
//   }
//   return matchResult;
// }