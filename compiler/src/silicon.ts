#! /usr/bin/env bun

import * as fs from "node:fs/promises"
// import stringify from "graph-stringify"
import { compile } from "./compiler"

const help = `Sigil: the Official Silicon compiler 

--- Version 2024.01 ---

Syntax: sgl <filename> <outputType>

Prints to stdout according to <outputType>, which must be one of:

  parsed     a message that the program was matched ok by the grammar
  analyzed   the statically analyzed representation
  optimized  the optimized semantically analyzed representation
  es         the translation to JavaScript
  ts         the translation to TypeScript
  wab        the translation to WebAssembly binary
  wat        the translation to WebAssembly text
`
async function compileFromFile(filename: string, outputType: string) {
    try {
        const buffer = await fs.readFile(filename)
        const compiled = compile(buffer.toString(), outputType)
        console.log(stringify(compiled, "kind") || compiled)
    } catch (e) {
        console.error(`\u001b[31m${e}\u001b[39m`)
        process.exitCode = 1
    }
}

if (process.argv.length !== 4) {
    console.log(help)
} else {
    compileFromFile(process.argv[2], process.argv[3])
}