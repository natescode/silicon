console.log("Silicon v2024.01");
import * as ohm from 'ohm-js'
import type { SiliconGrammar, SiliconActionDict, SiliconSemantics } from './src/silicon-simple.ohm-bundle.js'
// An Ohm grammar for arithmetic expressions.
// Syntax reference: https://github.com/harc/ohm/blob/master/doc/syntax-reference.md
const grammarSource = Bun.file('./src/silicon-simple.ohm')

const _grammarSource = String.raw`
Silicon {
	Program   = SourceElement*
	SourceElement =
			| EXP ";" --sourceExp
	EXP = 	| EXP binOp literal --binaryExp
			// | "@let" identifier Assign? --letExp
            // | BlockLiteral --block
            | literal --lit
	binOp =
			| "++" 
			| "+" 
			| "-" 
      | "*" 
			| "/" 
            // | "..." 
            // | ".." 
            // | "|>"
            // | keyword 			
    keyword = "@" identifier
	literal = stringLiteral | numericLiteral | booleanLiteral
		stringLiteral = "\"" stringChar*  "\""
			stringChar = ~("\"" | "\\" | lineTerminator) any
				lineTerminator = "\n" | "\r" | "\u2028" | "\u2029"
    	// BlockLiteral = "{" ListOf<EXP,";"> ";"? "}"
		numericLiteral = | binLiteral | hexLiteral | octLiteral | floatLiteral | intLiteral
			binLiteral = "0b" bit+ ("_" bit+)*
				bit = "0" | "1"
			hexLiteral = "0x" hexDigit+ ("_" hexDigit+)*
			octLiteral = "0c" octDigit+ ("_" octDigit+)*
				octDigit = "0".."7"
			floatLiteral = digit+ ("_" digit+)* "." digit+
			intLiteral = digit+ ("_" digit+)*
		booleanLiteral = "@true" | "@false"
	identifier = 
    	| discard -- discard
    	| letter+ ("_" | alnum)* -- pub
    	| "_" identifier+ -- priv
    	discard = "_"
    // Assign = "=" EXP
	space := whitespace | lineTerminator
	whitespace = "\t"
			| "\x0B"    -- verticalTab
			| "\x0C"    -- formFeed
			| " "
			| "\u00A0"  -- noBreakSpace
			| "\uFEFF"  -- byteOrderMark
			| unicodeSpaceSeparator
	unicodeSpaceSeparator = "\u2000".."\u200B" | "\u3000"
}
`;

// let x:si.SiliconGrammar
// Instantiate the grammar defined above.
const g = ohm.grammar(await grammarSource.text());

// Define an operation named 'eval' which evaluates the expression.
// See https://github.com/cdglabs/ohm/blob/master/doc/api-reference.md#semantics
const semantics = g.createSemantics().addOperation('eval', {
  Program(sourceElements) {
    return sourceElements.children.map(sourceElement => sourceElement.eval())
  },
  SourceElement_sourceExp(exp, sc) {
    return exp.eval()
  },
  EXP_binaryExp(exp, binop, lit) {
    let val = exp.eval()
    let litVal = lit.eval()
    if (binop.sourceString === '++') return val + litVal
    if (binop.sourceString === '+') return val + litVal
    if (binop.sourceString === '-') return val - litVal
    if (binop.sourceString === '*') return val * litVal
    if (binop.sourceString === '/') return val / litVal
    // switch (binop.eval()) {
    //   // case '++': return val + litVal
    //   case '+': return val + litVal
    //   // case '-': return val - litVal
    //   // case '*': return val * litVal
    //   // case '/': return val / litVal
    //   // case '...': return 0
    //   // case '..': return 0
    //   // case '|>': return 0
    //   default: {
    //     console.log('keyword. todo')
    //     // return "keyword"
    //   }
    // }
  },
  // EXP_letExp(letkeyword, identifier, assign) {

  // },
  // EXP_block(blockLiteral) {
  //   return blockLiteral.eval()
  // },
  EXP_lit(literal) {
    return literal.eval()
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
  booleanLiteral(v) {
    if (v.sourceString === "@true") return true
    if (v.sourceString === "@false") return true
    throw new Error("invalid boolean literal value")
  },
  keyword(at, word) {
    return word.sourceString
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
let sourceCode = '1 + 5 - 2 * 3 - 4;'
// let sourceCode = '"hello, " + "world!";'
const m = g.match(sourceCode);
if (m.succeeded()) {
  result = semantics(m).eval();  // Evaluate the expression.
} else {
  result = m.message;  // Extract the error message.
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
