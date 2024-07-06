console.log("Silicon v2024.01");
import * as ohm from 'ohm-js'

import siliconGrammar from './SiliconGrammar';
import addEvalSemantics from './eval';
const evalSemantics = addEvalSemantics(siliconGrammar);

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
  result = evalSemantics(match).eval();  // Evaluate the expression.
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