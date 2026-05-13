#! /usr/bin/env bun

import * as fs from "node:fs/promises"
import parse from './parser'
import { addToAstSemantics, type ASTNode, type Program } from './ast'
import { compileToWat } from './codegen'
import { elaborate, buildStrataRegistry } from './elaborator'
import { typecheck, formatTypeError } from './types'
import { siliconGrammar } from './grammar'

const help = `Sigil: the Official Silicon compiler

Usage: sgl [--strata <file.si>]... <main.si>

Compiles a Silicon (.si) source file to WebAssembly text format (WAT).
External strata libraries can be loaded with --strata before the main file.

Flags:
  --strata <file>   Load strata definitions from <file> before compiling.
                    May be specified multiple times.

Output files (written to current directory):
  main.wat   WebAssembly text format (assemble with wat2wasm)
  ast.json   Type-annotated AST (for debugging)

Examples:
  sgl main.si
  sgl --strata ops.si main.si
  sgl --strata lib/math.si --strata lib/strings.si main.si
`

async function compileFile(filename: string, strataFiles: string[]) {
    const source = await fs.readFile(filename, 'utf-8')

    // Load extra strata sources from --strata files.
    const extraSources: string[] = await Promise.all(
        strataFiles.map(f => fs.readFile(f, 'utf-8'))
    )

    const match = parse(source)
    const ast: ASTNode = addToAstSemantics(siliconGrammar)(match).toAst()
    const registry = buildStrataRegistry(ast as Program, extraSources)
    const { program: elaboratedAST } = elaborate(ast as Program, registry)
    const { program: typedAST, errors: typeErrors, functions } = typecheck(elaboratedAST, registry)

    if (typeErrors.length > 0) {
        console.error('Type errors:')
        for (const err of typeErrors) {
            console.error('  ' + formatTypeError(err))
        }
        process.exit(1)
    }

    const wat: string = compileToWat(typedAST, registry, functions)

    await Bun.write('ast.json', JSON.stringify(typedAST, null, 2))
    await Bun.write('main.wat', wat)

    console.log(`Compiled ${filename} → main.wat`)
}

// Parse CLI args: collect --strata flags and the positional main file.
const args = process.argv.slice(2)
const strataFiles: string[] = []
let mainFile: string | undefined

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--strata') {
        const next = args[++i]
        if (!next) { console.error('--strata requires a file argument'); process.exit(1) }
        strataFiles.push(next)
    } else if (!mainFile) {
        mainFile = args[i]
    } else {
        console.error(`Unexpected argument: ${args[i]}`); process.exit(1)
    }
}

if (!mainFile) {
    console.log(help)
    process.exit(0)
}

try {
    await compileFile(mainFile, strataFiles)
} catch (e) {
    console.error(`\x1b[31mError: ${e}\x1b[39m`)
    process.exit(1)
}
