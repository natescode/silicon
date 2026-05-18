#!/usr/bin/env bun
/**
 * scripts/build-boot.ts — compile boot/main.si to boot.wasm.
 *
 * Pipeline:
 *   1. Resolve @use chain from boot/main.si.
 *   2. Run the Stage 0 compiler with --target=wasix (so _start is exported).
 *   3. Assemble WAT to WASM via wabt.
 *   4. Write boot.wat + boot.wasm.
 *
 * Usage:
 *   bun run scripts/build-boot.ts                    # builds boot/main.si
 *   bun run scripts/build-boot.ts <path-to-main.si>  # builds a custom entry
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import parse from '../src/parser'
import { addToAstSemantics, type Program } from '../src/ast'
import { compileToWat } from '../src/codegen'
import { watToWasm } from '../src/codegen/toWasm'
import { elaborate, buildStrataRegistry } from '../src/elaborator'
import { typecheck, formatTypeError } from '../src/types'
import { siliconGrammar } from '../src/grammar'
import { loadModules } from '../src/modules'
import { resolveUses } from '../src/modules/useResolver'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..')
const DEFAULT_ENTRY = path.join(PROJECT_ROOT, 'boot', 'main.si')

async function build(entryPath: string): Promise<void> {
    const entryAbs = path.resolve(entryPath)
    const raw = await fs.readFile(entryAbs, 'utf-8')
    const { source, visited } = resolveUses(raw, entryAbs)

    console.log(`Compiling ${path.relative(PROJECT_ROOT, entryAbs)}`)
    for (const v of visited) {
        if (v !== entryAbs) console.log(`  ↳ @use ${path.relative(PROJECT_ROOT, v)}`)
    }

    const match = parse(source)
    const ast = addToAstSemantics(siliconGrammar)(match).toAst() as Program
    const moduleRegistry = loadModules(PROJECT_ROOT)
    const registry = buildStrataRegistry(ast)
    const { program: elab, errors: elabErrors } = elaborate(ast, registry)
    if (elabErrors.length > 0) {
        console.error('elab errors:')
        for (const e of elabErrors) console.error('  ' + e.message)
        process.exit(1)
    }
    const { program: typed, errors: typeErrors, functions } = typecheck(elab, registry, moduleRegistry)
    if (typeErrors.length > 0) {
        console.error('type errors:')
        for (const e of typeErrors) console.error('  ' + formatTypeError(e))
        process.exit(1)
    }
    const wat = compileToWat(typed, registry, functions, moduleRegistry, { target: 'wasix' })
    const outDir = path.join(PROJECT_ROOT, 'wasm-bin')
    await fs.mkdir(outDir, { recursive: true })
    const watPath = path.join(outDir, 'boot.wat')
    await fs.writeFile(watPath, wat)
    console.log(`  → ${path.relative(PROJECT_ROOT, watPath)}`)

    const binary = await watToWasm(wat)
    const wasmPath = path.join(outDir, 'boot.wasm')
    await fs.writeFile(wasmPath, binary)
    console.log(`  → ${path.relative(PROJECT_ROOT, wasmPath)} (${binary.byteLength} bytes)`)
    console.log(`\nRun with: wasmtime ${path.relative(PROJECT_ROOT, wasmPath)}`)
}

const entry = process.argv[2] ?? DEFAULT_ENTRY
await build(entry)
