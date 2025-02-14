// The parse() function uses Ohm to produce a match object for a given
// source code program, using the grammar in the file silicon.ohm.

// import * as fs from "node:fs"
import * as ohm from "ohm-js"
const file = Bun.file("src/silicon.ohm")
const grammar = ohm.grammar(file.toString())

// Returns the Ohm match if successful, otherwise throws an error
export default function parse(sourceCode: string) {
    const match = grammar.match(sourceCode)
    if (!match.succeeded()) throw new Error(match.message)
    return match
}