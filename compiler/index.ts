console.log("Silicon v2024.01");
import { toAST } from 'ohm-js/extras'
import siliconGrammar from './SiliconGrammar';
import addEvalSemantics from './eval';
import addCompileSemantics from './compile';
// const evalSemantics = addEvalSemantics(siliconGrammar);
const compileSemantics = addCompileSemantics(siliconGrammar)
// TESTS
// let sourceCode = '5 - 1 + 2 * 3 / 2;'
// let sourceCode = '"hello, " + "world!";'
// let sourceCode = '5 - 1 + (2 * 3) / 2;'
// let sourceCode = '0x10 + 0x11;'
// let sourceCode = '1.2 + 1.8;'
// let sourceCode = "'hello, ' ++ 'world!';";
let result;
// let sourceCode = `1 + (@let x = 2);`
// let sourceCode = `5 + 4 - (3 * 2);`
// let sourceCode = `5 + 4 - 3 * 2;`
// let sourceCode = `@fn add:i32 = 1 + 2;`
// let sourceCode = `@fn add:i32 = 1 + 2; @let foo = 7;`
// let sourceCode = `@let age:i32 = 33;age;`
// let sourceCode = `@fn add:i32 a:i32,b:i32 = a + b;`
// let sourceCode = `@fn foo:i32 = @when 1, { 2 }, { 99 };`
let sourceCode = `&@loop 1..4, @fn foo:i32 index:i32, value:i32 = 1;;`

// let sourceCode = `1 + 2;`
const match = siliconGrammar.match(sourceCode);
// if (match.succeeded()) {
//   result = evalSemantics(match).eval();  // Evaluate the expression.
// } else {
//   result = match.message;  // Extract the error message.
// }
// console.log(`Result = ${result}`)


// TODO covert match tree to AST
const ast = toAST(match, {
  Program: { type: 'program', statements: 0 },
  // SourceElement_sourceExp: { type: 'source_element', exp: 0 },
  ExpressionStart_binaryExpression: { type: 'binary_exp', left: 0, op: 1, right: 2 },
  ExpressionStart_letExpression: { type: 'let_exp', _let: 0, id: 1, eq: 2, exp: 3 },
  ExpressionEnd: { type: 'expression', exp: 0 },
  // ExpressionEnd: { type: 'expr_literal', value: 0 },
  // EXPR_paren: { type: 'paren_exp', lparen: 0, exp: 1, rparen: 2 },
  binOp: { type: 'operator', op: 0 },
  keyword: { type: 'keyword', at: 0, id: 1 },
  literal: { type: 'literal', exp: 0 },
  literal_str: { type: 'string_literal', value: 0 },
  literal_integer: { type: 'integer_literal', value: 0 },
  binLiteral: { type: 'binary_literal', value: 0 },
  hexLiteral: { type: 'hexadecimal_literal', value: 0 },
  octLiteral: { type: 'octal_literal', value: 0 },
  floatLiteral: { type: 'float_literal', value: 0 },
  intLiteral: { type: 'integer_literal', value: 0 },
  literal_bln: { type: 'boolean_literal', value: 0 },
  identifier_discard: { type: 'discard', id: 0 },
  identifier_pub: { type: 'identifier', id: 0 },
  identifier_priv: { type: 'identifier', id: 0 },
  bit: { type: 'bit', value: 0 },
  discard: { type: 'discard_identifier', id: 0 },
})

Bun.write('ast.json', JSON.stringify(ast))

console.log(`AST
  ${JSON.stringify(ast)}`)

// output result of eval
// let sc = sourceCode.slice(0, -1)
// console.log(`${sc} = ${result}`)

const compileResults = compileSemantics(match).compile();  // Compile the expression.
Bun.write('main.wat', compileResults)