#! /usr/bin/env bun

import * as fs from "node:fs/promises"
import parse from './parser'
import { addToAstSemantics, type ASTNode, type Program } from './ast'
import { addCompileSemantics } from './codegen'
import { elaborate } from './elaborator'
import { typecheck, formatTypeError } from './types'
import { siliconGrammar } from './grammar'

const help = `Sigil: the Official Silicon compiler

Usage: sgl <filename>

Compiles a Silicon (.sgl) source file to WebAssembly text format (WAT).

Output files (written to current directory):
  main.wat   WebAssembly text format (assemble with wat2wasm)
  ast.json   Type-annotated AST (for debugging)
`

async function compileFile(filename: string) {
    const source = await fs.readFile(filename, 'utf-8')

    const match = parse(source)
    const ast: ASTNode = addToAstSemantics(siliconGrammar)(match).toAst()
    const elaboratedAST = elaborate(ast as Program)
    const { program: typedAST, errors: typeErrors } = typecheck(elaboratedAST)

    if (typeErrors.length > 0) {
        console.error('Type errors:')
        for (const err of typeErrors) {
            console.error('  ' + formatTypeError(err))
        }
        process.exit(1)
    }

    const wat: string = addCompileSemantics(siliconGrammar)(match).compile()

    await Bun.write('ast.json', JSON.stringify(typedAST, null, 2))
    await Bun.write('main.wat', wat)

    console.log(`Compiled ${filename} → main.wat`)
}

if (process.argv.length < 3) {
    console.log(help)
    process.exit(0)
}

try {
    await compileFile(process.argv[2])
} catch (e) {
    console.error(`[31mError: ${e}[39m`)
    process.exit(1)
}
