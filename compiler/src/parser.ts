import siliconGrammar from "./SiliconGrammar";

/// <reference path="../node_modules/@types/ohm-js/index.d.ts" />
/// Use Ohm's match function to parse the source code string according to
/// the Silicon grammar. If parsing fails, throw an error with the parse
/// failure message. If parsing succeeds, return the Ohm Match object.
export default function parse(sourceCode: string) {
  const match = siliconGrammar.match(sourceCode);
  if (!match.succeeded()) {
    throw new Error(`Failed to parse Silicon code: ${match.message}`);
  }
  return match;
}