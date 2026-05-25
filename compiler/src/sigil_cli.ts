#! /usr/bin/env bun
/**
 * sgl — The Silicon compiler CLI
 *
 * Subcommands:
 *   sgl init [name]          scaffold a new Silicon project
 *   sgl build [flags] [file] compile to .wasm/.wat
 *   sgl run   [flags] [file] compile and execute
 *   sgl check [flags] [file] typecheck only (no output)
 *   sgl test  [file]         run @@test-annotated functions (Phase 7)
 *   sgl eval                 interactive REPL (Phase 7)
 *   sgl add   <pkg>          add a dependency (Phase 7)
 *   sgl fmt   [file]         format source (Phase 7)
 *   sgl help                 show this help
 */

import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { spawnSync } from 'node:child_process'
import parse from './parser'
import { addToAstSemantics, type ASTNode, type Program } from './ast'
import { compileToWat, compileToWasm, type LowerTarget } from './codegen'
import { elaborate, buildStrataRegistry } from './elaborator'
import { typecheck, formatTypeError } from './types'
import { siliconGrammar } from './grammar'
import { resolveUses } from './modules/useResolver'
import { loadModules } from './modules'
import {
    toDiagnostic, parseDiagnostic, renderJson, renderPretty, type Diagnostic
} from './errors/diagnostic'
import { formatProgram } from './fmt/formatter'

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP = `sgl — The Silicon compiler

Usage: sgl <command> [flags] [file]

Commands:
  init [name]     Scaffold a new Silicon project in <name>/ (default: .)
  build [file]    Compile to .wasm (default) or .wat
  run   [file]    Compile and execute via wasmtime
  check [file]    Typecheck only; print diagnostics, no output file
  test  [file]    Run @@test-annotated functions (requires Phase 7)
  eval            Interactive REPL (requires Phase 7)
  add   <pkg>     Add a package dependency (requires package registry)
  fmt   [file]    Format Silicon source files (normalises whitespace + style)
  help            Show this help

Global flags:
  --pretty        Human-readable diagnostics instead of JSON
  --strata <f>    Load extra strata from <f> (may repeat)

Build / run flags:
  --wat           Emit .wat text instead of .wasm binary
  --target=<t>    Compilation target: host (default) | wasix
  --release       Optimise (run only; reserved for Phase 8 native backend)

Format flags (sgl fmt only):
  --check         Exit 1 if formatted output differs from the input file
  --stdout        Print formatted output to stdout; do not modify the file

File resolution:
  If no file is given, sgl reads sgl.toml in the current directory and uses
  the entry point declared under [package] entry = "...".

Examples:
  sgl init my-app
  sgl build src/main.si
  sgl run   src/main.si
  sgl check src/main.si
  sgl run   --wat src/main.si
`

// ---------------------------------------------------------------------------
// sgl.toml — minimal TOML reader (section + key = "value" only)
// ---------------------------------------------------------------------------

interface SglToml {
    package: {
        name?: string
        version?: string
        entry?: string
    }
    dependencies: Record<string, string>
}

function readSglToml(dir: string): SglToml | null {
    const tomlPath = path.join(dir, 'sgl.toml')
    if (!fs.existsSync(tomlPath)) return null
    const text = fs.readFileSync(tomlPath, 'utf-8')
    const result: SglToml = { package: {}, dependencies: {} }
    let section = ''
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) continue
        const secMatch = line.match(/^\[([a-zA-Z0-9_.-]+)\]$/)
        if (secMatch) { section = secMatch[1]; continue }
        const kvMatch = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*"([^"]*)"$/)
        if (!kvMatch) continue
        const [, key, val] = kvMatch
        if (section === 'package') {
            (result.package as any)[key] = val
        } else if (section === 'dependencies') {
            result.dependencies[key] = val
        }
    }
    return result
}

// ---------------------------------------------------------------------------
// Resolve the entry-point file from args + sgl.toml
// ---------------------------------------------------------------------------

function resolveEntry(positional: string | undefined, cwd: string): string {
    if (positional) return path.resolve(positional)
    const toml = readSglToml(cwd)
    if (toml?.package.entry) return path.resolve(cwd, toml.package.entry)
    // Fall back to src/main.si
    const fallback = path.join(cwd, 'src', 'main.si')
    if (fs.existsSync(fallback)) return fallback
    console.error('sgl: no source file given and no sgl.toml found')
    console.error('  Run `sgl init` to scaffold a project, or pass a .si file.')
    process.exit(1)
}

// ---------------------------------------------------------------------------
// Shared compile pipeline
// ---------------------------------------------------------------------------

interface CompileOptions {
    strataFiles: string[]
    target: LowerTarget
    pretty: boolean
    wat: boolean
}

async function compileFile(
    filename: string,
    opts: CompileOptions,
): Promise<{ wat: string; binary: Uint8Array }> {
    const rawSource = await fsp.readFile(filename, 'utf-8')
    const entryAbs = path.resolve(filename)
    const { source } = resolveUses(rawSource, entryAbs)

    const extraSources: string[] = await Promise.all(
        opts.strataFiles.map(f => fsp.readFile(f, 'utf-8'))
    )

    function emitDiagnostics(diags: Diagnostic[]): never {
        const rendered = opts.pretty ? renderPretty(diags) : renderJson(diags)
        process.stderr.write(rendered + '\n')
        process.exit(1)
    }

    let match
    try { match = parse(source) }
    catch (err) { emitDiagnostics([parseDiagnostic(err as Error, entryAbs)]) }

    const ast: ASTNode = addToAstSemantics(siliconGrammar)(match!).toAst()
    const registry = buildStrataRegistry(ast as Program, extraSources)
    const { program: elaboratedAST } = elaborate(ast as Program, registry)
    const moduleRegistry = loadModules(path.dirname(entryAbs))
    const { program: typedAST, errors: typeErrors, functions, semanticModel } =
        typecheck(elaboratedAST, registry, moduleRegistry)

    if (typeErrors.length > 0) {
        emitDiagnostics(typeErrors.map(e => toDiagnostic(e, entryAbs)))
    }

    const lowOpts = { target: opts.target }
    const wat = compileToWat(typedAST, registry, functions, moduleRegistry, lowOpts, semanticModel)
    const binary = compileToWasm(typedAST, registry, functions, moduleRegistry, lowOpts)
    return { wat, binary }
}

// ---------------------------------------------------------------------------
// sgl init
// ---------------------------------------------------------------------------

const HELLO_WORLD_SI = `# src/main.si — Silicon Hello World
# Compile:  sgl build
# Run:      sgl run

@fn write_bytes:Int fd:Int, ptr:Int, len:Int := {
    @local iovs := &scratch_alloc 8;
    &WASM::i32_store iovs, ptr;
    &WASM::i32_store (iovs + 4), len;
    @local nwritten := &scratch_alloc 4;
    &wasi_snapshot_preview1::fd_write fd, iovs, 1, nwritten
};

@fn write_str:Int fd:Int, s:String := {
    &write_bytes fd, ((&str_ptr s) + 4), (&str_len s)
};

@fn write_nl:Int fd:Int := {
    @local buf := &scratch_alloc 4;
    &WASM::i32_store8 buf, 10;
    &write_bytes fd, buf, 1
};

&write_str 1, 'Hello, Silicon!';
&write_nl 1;
`

function tomlTemplate(name: string): string {
    return `[package]
name    = "${name}"
version = "0.1.0"
entry   = "src/main.si"

[dependencies]
`
}

async function cmdInit(args: string[]): Promise<void> {
    const projectDir = args[0] ? path.resolve(args[0]) : process.cwd()
    const name = path.basename(projectDir)

    if (args[0]) {
        await fsp.mkdir(projectDir, { recursive: true })
    }
    await fsp.mkdir(path.join(projectDir, 'src'), { recursive: true })

    const tomlPath = path.join(projectDir, 'sgl.toml')
    const mainPath = path.join(projectDir, 'src', 'main.si')

    if (fs.existsSync(tomlPath)) {
        console.log(`sgl: ${tomlPath} already exists — skipping`)
    } else {
        await fsp.writeFile(tomlPath, tomlTemplate(name))
        console.log(`  created  sgl.toml`)
    }

    if (fs.existsSync(mainPath)) {
        console.log(`sgl: ${mainPath} already exists — skipping`)
    } else {
        await fsp.writeFile(mainPath, HELLO_WORLD_SI)
        console.log(`  created  src/main.si`)
    }

    console.log(`\nProject '${name}' ready.  Run:  sgl run`)
}

// ---------------------------------------------------------------------------
// sgl build
// ---------------------------------------------------------------------------

async function cmdBuild(positional: string | undefined, opts: CompileOptions): Promise<void> {
    const entry = resolveEntry(positional, process.cwd())
    const { wat, binary } = await compileFile(entry, opts)

    await fsp.writeFile('ast.json', JSON.stringify({}, null, 2))  // placeholder

    if (opts.wat) {
        const outPath = path.basename(entry, '.si') + '.wat'
        await fsp.writeFile(outPath, wat)
        console.log(`Compiled ${entry} → ${outPath}`)
    } else {
        const outPath = path.basename(entry, '.si') + '.wasm'
        await fsp.writeFile(outPath, binary)
        console.log(`Compiled ${entry} → ${outPath} (${binary.byteLength} bytes)`)
    }
}

// ---------------------------------------------------------------------------
// sgl run
// ---------------------------------------------------------------------------

async function cmdRun(positional: string | undefined, opts: CompileOptions): Promise<void> {
    const entry = resolveEntry(positional, process.cwd())

    // wasix target so wasmtime can invoke _start directly
    const runOpts: CompileOptions = { ...opts, target: 'wasix', wat: true }
    const { wat } = await compileFile(entry, runOpts)

    // Write WAT to a temp file and execute with wasmtime (WAT path is more reliable
    // than the direct binary emitter for programs with WASI imports)
    const tmp = path.join(os.tmpdir(), `sgl_run_${process.pid}.wat`)
    await fsp.writeFile(tmp, wat)

    // Locate wasmtime — check PATH first, then common install locations
    const wasmtimeCandidates = [
        'wasmtime',
        path.join(os.homedir(), '.wasmtime', 'bin', 'wasmtime'),
    ]
    let wasmtimeBin = wasmtimeCandidates[0]
    for (const candidate of wasmtimeCandidates) {
        const probe = spawnSync(candidate, ['--version'], { stdio: 'pipe' })
        if (probe.status === 0) { wasmtimeBin = candidate; break }
    }

    try {
        const result = spawnSync(wasmtimeBin, [tmp], { stdio: 'inherit' })
        process.exit(result.status ?? 0)
    } catch (e: any) {
        if (e.code === 'ENOENT') {
            console.error('sgl run: wasmtime not found.')
            console.error('  Install wasmtime: https://wasmtime.dev/')
            console.error('  Or compile with `sgl build` and run the binary manually.')
            process.exit(1)
        }
        throw e
    } finally {
        try { fs.unlinkSync(tmp) } catch { /* best-effort cleanup */ }
    }
}

// ---------------------------------------------------------------------------
// sgl check
// ---------------------------------------------------------------------------

async function cmdCheck(positional: string | undefined, opts: CompileOptions): Promise<void> {
    const entry = resolveEntry(positional, process.cwd())
    const rawSource = await fsp.readFile(entry, 'utf-8')
    const entryAbs = path.resolve(entry)
    const { source } = resolveUses(rawSource, entryAbs)

    const extraSources: string[] = await Promise.all(
        opts.strataFiles.map(f => fsp.readFile(f, 'utf-8'))
    )

    function emitDiagnostics(diags: Diagnostic[]): never {
        const rendered = opts.pretty ? renderPretty(diags) : renderJson(diags)
        process.stderr.write(rendered + '\n')
        process.exit(1)
    }

    let match
    try { match = parse(source) }
    catch (err) { emitDiagnostics([parseDiagnostic(err as Error, entryAbs)]) }

    const ast: ASTNode = addToAstSemantics(siliconGrammar)(match!).toAst()
    const registry = buildStrataRegistry(ast as Program, extraSources)
    const { program: elaboratedAST } = elaborate(ast as Program, registry)
    const moduleRegistry = loadModules(path.dirname(entryAbs))
    const { errors: typeErrors } = typecheck(elaboratedAST, registry, moduleRegistry)

    if (typeErrors.length > 0) {
        emitDiagnostics(typeErrors.map(e => toDiagnostic(e, entryAbs)))
    }

    console.log(`${entry}: OK`)
}

// ---------------------------------------------------------------------------
// Stub commands (Phase 7 / post-Phase-6)
// ---------------------------------------------------------------------------

function cmdTest(_args: string[]): void {
    console.error('sgl test: not yet implemented (requires Phase 7 interpreter)')
    console.error('  Track progress: docs/sigil-1.0-roadmap.md §Phase 7')
    process.exit(1)
}

function cmdEval(_args: string[]): void {
    console.error('sgl eval: not yet implemented (requires Phase 7 interpreter)')
    process.exit(1)
}

function cmdAdd(args: string[]): void {
    if (!args[0]) {
        console.error('sgl add: package name required')
        process.exit(1)
    }
    console.error(`sgl add: package registry not yet available`)
    console.error(`  '${args[0]}' was not added.`)
    process.exit(1)
}

async function cmdFmt(
    positional: string | undefined,
    check: boolean,
    toStdout: boolean,
    opts: CompileOptions,
): Promise<void> {
    const entry = resolveEntry(positional, process.cwd())
    const original = await fsp.readFile(entry, 'utf-8')
    const entryAbs = path.resolve(entry)
    const { source } = resolveUses(original, entryAbs)

    let match
    try { match = parse(source) }
    catch (err) {
        const diag = parseDiagnostic(err as Error, entryAbs)
        const rendered = opts.pretty ? renderPretty([diag]) : renderJson([diag])
        process.stderr.write(rendered + '\n')
        process.exit(1)
    }

    const ast = addToAstSemantics(siliconGrammar)(match!).toAst()
    const formatted = formatProgram(ast as any)

    if (check) {
        if (formatted !== original) {
            console.error(`sgl fmt: ${entry} would be reformatted`)
            process.exit(1)
        }
        console.log(`${entry}: OK`)
        return
    }

    if (toStdout) {
        process.stdout.write(formatted)
        return
    }

    await fsp.writeFile(entry, formatted, 'utf-8')
    console.log(`Formatted ${entry}`)
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseTarget(value: string): LowerTarget {
    if (value === 'host' || value === 'wasix') return value
    console.error(`sgl: unknown --target value '${value}' (expected: host | wasix)`)
    process.exit(1)
}

const argv = process.argv.slice(2)

if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(HELP)
    process.exit(0)
}

const subcommand = argv[0]
const rest = argv.slice(1)

// Parse flags from the rest of the args
const strataFiles: string[] = []
let positional: string | undefined
let emitWat = false
let target: LowerTarget = 'host'
let pretty = false
let fmtCheck = false
let fmtStdout = false

for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === '--strata') {
        const next = rest[++i]
        if (!next) { console.error('--strata requires a file argument'); process.exit(1) }
        strataFiles.push(next)
    } else if (arg === '--wat') {
        emitWat = true
    } else if (arg === '--wasm') {
        // no-op: .wasm is default
    } else if (arg === '--pretty') {
        pretty = true
    } else if (arg === '--release') {
        // Reserved for Phase 8 native backend; silently accepted for forward-compat
    } else if (arg === '--check') {
        fmtCheck = true
    } else if (arg === '--stdout') {
        fmtStdout = true
    } else if (arg === '--target') {
        const next = rest[++i]
        if (!next) { console.error('--target requires a value'); process.exit(1) }
        target = parseTarget(next)
    } else if (arg.startsWith('--target=')) {
        target = parseTarget(arg.slice('--target='.length))
    } else if (!arg.startsWith('--')) {
        positional = arg
    } else {
        console.error(`sgl: unknown flag '${arg}'`)
        process.exit(1)
    }
}

const opts: CompileOptions = { strataFiles, target, pretty, wat: emitWat }

try {
    switch (subcommand) {
        case 'init':
            await cmdInit(rest.filter(a => !a.startsWith('-')))
            break
        case 'build':
            await cmdBuild(positional, opts)
            break
        case 'run':
            await cmdRun(positional, opts)
            break
        case 'check':
            await cmdCheck(positional, opts)
            break
        case 'test':
            cmdTest(rest)
            break
        case 'eval':
            cmdEval(rest)
            break
        case 'add':
            cmdAdd(rest.filter(a => !a.startsWith('-')))
            break
        case 'fmt':
            await cmdFmt(positional, fmtCheck, fmtStdout, opts)
            break
        default:
            console.error(`sgl: unknown subcommand '${subcommand}'`)
            console.error(`  Run 'sgl help' to see available commands.`)
            process.exit(1)
    }
} catch (e) {
    console.error(`\x1b[31mError: ${e}\x1b[39m`)
    process.exit(1)
}
