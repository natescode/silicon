/**
 * Silicon Parser
 *
 * Converts Silicon source code into an Ohm parse tree using the grammar defined
 * in src/grammar/silicon-official.ohm.
 *
 * This module handles the first stage of the compilation pipeline. It validates
 * that input conforms to the Silicon grammar and produces a parse tree that
 * subsequent stages can operate on.
 *
 * @throws {Error} If the input does not match the Silicon grammar
 *
 * @example
 *   const match = parse('@fn add x, y = x + y;')
 *   // Returns Ohm Match object representing the parse tree
 */

import siliconGrammar from '../grammar/SiliconGrammar'

/**
 * Parse Silicon source code into a parse tree
 *
 * @param sourceCode - The Silicon source code to parse
 * @returns Ohm Match object representing the parse tree
 * @throws {Error} If parsing fails with a grammar error message
 */
export default function parse(sourceCode: string) {
  const match = siliconGrammar.match(sourceCode)
  if (!match.succeeded()) {
    throw new Error(`Parse error: ${match.message}`)
  }
  return match
}