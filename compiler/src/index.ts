console.log("Silicon v2024.01");
import { toAST } from 'ohm-js/extras'
import siliconGrammar from './SiliconGrammar';
// import addEvalSemantics from './eval';
import addCompileSemantics from './compile';
import addToAstSemantics from './toAst';
// const evalSemantics = addEvalSemantics(siliconGrammar);
const compileSemantics = addCompileSemantics(siliconGrammar)
const astSemantics = addToAstSemantics(siliconGrammar)
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


// TODO covert match tree to AST with type annotations
const ast = astSemantics(match).toAst()

Bun.write('ast.json', JSON.stringify(ast, null, 2))

console.log(`AST
  ${JSON.stringify(ast, null, 2)}`)

// output result of eval
// let sc = sourceCode.slice(0, -1)
// console.log(`${sc} = ${result}`)

const compileResults = compileSemantics(match).compile();  // Compile the expression.
Bun.write('main.wat', compileResults)