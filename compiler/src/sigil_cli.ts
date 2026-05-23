#! /usr/bin/env bun

import * as fs from "node:fs/promises"
import * as path from "node:path"
import parse from './parser'
import { addToAstSemantics, type ASTNode, type Program } from './ast'
import { compileToWat, compileToWasm, type LowerTarget } from './codegen'
import { elaborate, buildStrataRegistry } from './elaborator'
import { typecheck, formatTypeError } from './types'
import { siliconGrammar } from './grammar'
import { resolveUses } from './modules/useResolver'
import { toDiagnostic, parseDiagnostic, renderJson, renderPretty, type Diagnostic } from './errors/diagnostic'

const help = `Sigil: the Official Silicon compiler

Usage: sgl [--strata <file.si>]... [--wat] [--target=<t>] <main.si>

Compiles a Silicon (.si) source file to a WebAssembly binary (main.wasm).
Pass --wat to emit WebAssembly text format (main.wat) instead.  External
strata libraries can be loaded with --strata before the main file.

Flags:
  --strata <file>     Load strata definitions from <file> before compiling.
                      May be specified multiple times.
  --wat               Emit main.wat (WebAssembly text) instead of main.wasm.
  --wasm              Deprecated; .wasm is the default output now.  Accepted
                      as a no-op so older invocations still work.
  --target=<t>        Compilation target. One of:
                        host   (default) — host-embed runner
                        wasix          — Wasmer-WASIX runtime; the module
                                         exports _start so 'wasmer run' picks
                                         it up automatically.
  --pretty            Render diagnostics in the human format instead of JSON.

Diagnostics:
  Errors are emitted as structured Diagnostic records (see
  src/errors/diagnostic.ts).  Default format is JSON for tool-friendliness;
  pass --pretty for the disposable human renderer (Stage 1 will replace it).

Source includes:
  @use 'helper.si';   inside a .si file, includes helper.si (relative to
                      the including file). Cycle-checked; each file is
                      emitted at most once.  See docs/use-includes.md.

Output files (written to current directory):
  main.wasm  WebAssembly binary (default).
  main.wat   WebAssembly text format (only with --wat).
  ast.json   Type-annotated AST (for debugging).

Examples:
  sgl main.si
  sgl --wat main.si
  sgl --target=wasix main.si
  sgl --strata ops.si main.si
  sgl --strata lib/math.si --strata lib/strings.si main.si
`

async function compileFile(
    filename: string,
    strataFiles: string[],
    emitWat: boolean,
    target: LowerTarget,
    pretty: boolean,
) {
    const rawSource = await fs.readFile(filename, 'utf-8')
    const entryAbs = path.resolve(filename)
    const { source } = resolveUses(rawSource, entryAbs)

    // Load extra strata sources from --strata files.
    const extraSources: string[] = await Promise.all(
        strataFiles.map(f => fs.readFile(f, 'utf-8'))
    )

    function emitDiagnostics(diags: Diagnostic[]): never {
        const rendered = pretty ? renderPretty(diags) : renderJson(diags)
        console.error(rendered)
        process.exit(1)
    }

    let match
    try { match = parse(source) }
    catch (err) { emitDiagnostics([parseDiagnostic(err as Error, entryAbs)]) }

    const ast: ASTNode = addToAstSemantics(siliconGrammar)(match!).toAst()
    const registry = buildStrataRegistry(ast as Program, extraSources)
    const { program: elaboratedAST } = elaborate(ast as Program, registry)
    const { program: typedAST, errors: typeErrors, functions } = typecheck(elaboratedAST, registry)

    if (typeErrors.length > 0) {
        emitDiagnostics(typeErrors.map(e => toDiagnostic(e, entryAbs)))
    }

    await Bun.write('ast.json', JSON.stringify(typedAST, null, 2))

    if (emitWat) {
        const wat = compileToWat(typedAST, registry, functions, undefined, { target })
        await Bun.write('main.wat', wat)
        console.log(`Compiled ${filename} → main.wat`)
    } else {
        const binary = compileToWasm(typedAST, registry, functions, undefined, { target })
        await Bun.write('main.wasm', binary)
        console.log(`Compiled ${filename} → main.wasm (${binary.byteLength} bytes)`)
    }
}

// Parse CLI args: --strata, --wat, --target=<t>, and the positional main file.
const args = process.argv.slice(2)
const strataFiles: string[] = []
let mainFile: string | undefined
let emitWat = false
let target: LowerTarget = 'host'
let pretty = false

function parseTarget(value: string): LowerTarget {
    if (value === 'host' || value === 'wasix') return value
    console.error(`Unknown --target value: ${value} (expected one of: host, wasix)`)
    process.exit(1)
}

for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--strata') {
        const next = args[++i]
        if (!next) { console.error('--strata requires a file argument'); process.exit(1) }
        strataFiles.push(next)
    } else if (arg === '--wat') {
        emitWat = true
    } else if (arg === '--wasm') {
        // Accepted as a no-op for backwards compatibility; .wasm is the default now.
    } else if (arg === '--pretty') {
        pretty = true
    } else if (arg === '--target') {
        const next = args[++i]
        if (!next) { console.error('--target requires a value'); process.exit(1) }
        target = parseTarget(next)
    } else if (arg.startsWith('--target=')) {
        target = parseTarget(arg.slice('--target='.length))
    } else if (!mainFile) {
        mainFile = arg
    } else {
        console.error(`Unexpected argument: ${arg}`); process.exit(1)
    }
}

if (!mainFile) {
    console.log(help)
    process.exit(0)
}

try {
    await compileFile(mainFile, strataFiles, emitWat, target, pretty)
} catch (e) {
    console.error(`\x1b[31mError: ${e}\x1b[39m`)
    process.exit(1)
}
