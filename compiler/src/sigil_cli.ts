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
// Public CaaS API — the only entry point for the compile pipeline.
import { parse, buildRegistry, elaborate, typecheck, lower } from './caas/index'
import type { Diagnostic } from './errors/diagnostic'

// Legitimately internal: not yet in the CaaS API surface.
import { compileToWasm, type LowerTarget } from './codegen'
import {
    lowerToQbe, findQbe, invokeQbe, hostQbeArch, downloadAndBuildQbe, QBE_INSTALL_HINT,
    findCc, link, injectMainWrapper, defaultExePath, CC_INSTALL_HINT,
} from './codegen/qbe'
import { resolveUses } from './modules/useResolver'
import { loadModules } from './modules'
import { renderJson, renderPretty } from './errors/diagnostic'
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
  setup           Download and install the QBE native backend toolchain
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
  --native        Compile via QBE to native assembly (requires qbe; see sgl setup)
  --target=<t>    Compilation target: host (default) | wasix
  --release       Compile via the QBE native backend (alias for --native)
  --max-heap=<N>  Cap wasm memory at N 64KB pages (heap-exhaustion testing;
                  past the cap the bump allocator traps cleanly).  Default: unbounded.

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
  sgl build --native src/main.si   # QBE native backend → .s assembly
  sgl setup                         # install qbe into ~/.sgl/bin/
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
// Phase 9c-4 — parse the --max-heap=N value (positive integer page count).
// One wasm page = 64KB, so --max-heap=16 caps the heap at 1MB.
// ---------------------------------------------------------------------------

function parseMaxHeap(raw: string): number {
    const n = Number(raw)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        console.error(`sgl: --max-heap requires a positive integer page count (got '${raw}'); one wasm page = 64KB`)
        process.exit(1)
    }
    return n
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
    native: boolean
    /** Phase 9c-4: cap wasm memory at N 64KB pages.  Sets the memory
     *  section's max-pages so `memory.grow` past the cap traps via the
     *  bump allocator's `unreachable`.  Default: unbounded. */
    maxHeapPages?: number
}

function emitDiagnostics(diags: readonly Diagnostic[], opts: CompileOptions): never {
    const rendered = opts.pretty ? renderPretty(diags as Diagnostic[]) : renderJson(diags as Diagnostic[])
    process.stderr.write(rendered + '\n')
    process.exit(1)
}

async function compileFile(
    filename: string,
    opts: CompileOptions,
): Promise<{ wat: string; binary: Uint8Array }> {
    const rawSource = await fsp.readFile(filename, 'utf-8')
    const entryAbs  = path.resolve(filename)
    const { source } = resolveUses(rawSource, entryAbs)
    const extraSources: string[] = await Promise.all(
        opts.strataFiles.map(f => fsp.readFile(f, 'utf-8'))
    )
    const moduleReg = loadModules(path.dirname(entryAbs))

    // ── CaaS pipeline ──────────────────────────────────────────────────────
    const { tree, diagnostics: parseErrs } = parse(source, { file: entryAbs })
    if (parseErrs.length) emitDiagnostics(parseErrs, opts)

    const registry = buildRegistry(tree, extraSources)
    const { tree: elab, registry: reg, diagnostics: elabErrs } = elaborate(tree, registry)
    if (elabErrs.length) emitDiagnostics(elabErrs, opts)

    const { tree: checked, model, _functions, diagnostics: typeErrs } =
        typecheck(elab, reg, { moduleRegistry: moduleReg })
    if (typeErrs.length) emitDiagnostics(typeErrs, opts)

    const { wat, diagnostics: lowerErrs } =
        lower(checked, reg, model, { target: opts.target, moduleRegistry: moduleReg, _functions, maxHeapPages: opts.maxHeapPages })
    if (lowerErrs.length) emitDiagnostics(lowerErrs, opts)

    // Binary emit is not yet in the CaaS API — use the internal path.
    const binary = compileToWasm(
        checked.program, reg, _functions, moduleReg, { target: opts.target, maxHeapPages: opts.maxHeapPages },
    )
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

    // Native backend: Silicon → QBE IR → assembly via qbe
    if (opts.native) {
        await cmdBuildNative(entry, opts)
        return
    }

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

/**
 * Shared front-end: parse + elaborate + typecheck + QBE IR lowering.
 * Returns QBE IR text with a main wrapper injected when needed.
 */
async function compileToQbeIr(entry: string, opts: CompileOptions): Promise<string> {
    const rawSource = await fsp.readFile(entry, 'utf-8')
    const entryAbs  = path.resolve(entry)
    const { source } = resolveUses(rawSource, entryAbs)
    const extraSources: string[] = await Promise.all(
        opts.strataFiles.map(f => fsp.readFile(f, 'utf-8'))
    )
    const moduleReg = loadModules(path.dirname(entryAbs))

    // ── CaaS pipeline ──────────────────────────────────────────────────────
    const { tree, diagnostics: parseErrs } = parse(source, { file: entryAbs })
    if (parseErrs.length) emitDiagnostics(parseErrs, opts)

    const registry = buildRegistry(tree, extraSources)
    const { tree: elab, registry: reg, diagnostics: elabErrs } = elaborate(tree, registry)
    if (elabErrs.length) emitDiagnostics(elabErrs, opts)

    const { tree: checked, _functions, diagnostics: typeErrs } =
        typecheck(elab, reg, { moduleRegistry: moduleReg })
    if (typeErrs.length) emitDiagnostics(typeErrs, opts)

    // QBE lowering is not yet in the CaaS API — use the internal path.
    return injectMainWrapper(lowerToQbe(checked.program, reg, _functions))
}

/**
 * Native build pipeline (stories 8-7 + 8-8):
 *   Silicon → QBE IR → assembly (.s) → native executable via cc
 */
async function cmdBuildNative(entry: string, opts: CompileOptions): Promise<void> {
    const qbeBin = findQbe()
    if (!qbeBin) { console.error(QBE_INSTALL_HINT); process.exit(1) }
    const ccBin = findCc()
    if (!ccBin)  { console.error(CC_INSTALL_HINT);  process.exit(1) }

    const qbeIr  = await compileToQbeIr(entry, opts)
    const asmOut = invokeQbe(qbeBin, qbeIr, hostQbeArch())

    const stem    = path.basename(entry, '.si')
    const asmPath = stem + '.s'
    const exePath = defaultExePath(entry)

    await fsp.writeFile(asmPath, asmOut)
    link(ccBin, asmPath, exePath)
    // Remove the intermediate .s unless --save-temps is requested (future flag)
    try { fs.unlinkSync(asmPath) } catch { /* best-effort */ }

    console.log(`Compiled ${entry} → ${exePath}`)
}

// ---------------------------------------------------------------------------
// sgl setup — install qbe toolchain
// ---------------------------------------------------------------------------

async function cmdSetup(): Promise<void> {
    const existing = findQbe()
    if (existing) {
        console.log(`qbe already available at: ${existing}`)
        console.log('Nothing to do.')
        return
    }
    try {
        await downloadAndBuildQbe(msg => console.log(`  ${msg}`))
        console.log('\nsgl setup complete. Run `sgl build --native` to use the native backend.')
    } catch (e: any) {
        console.error(`\nsgl setup failed: ${e.message}`)
        console.error(QBE_INSTALL_HINT)
        process.exit(1)
    }
}

// ---------------------------------------------------------------------------
// sgl run
// ---------------------------------------------------------------------------

async function cmdRun(positional: string | undefined, opts: CompileOptions): Promise<void> {
    const entry = resolveEntry(positional, process.cwd())

    // Native backend: compile to a temp executable and run it directly.
    if (opts.native) {
        await cmdRunNative(entry, opts)
        return
    }

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

async function cmdRunNative(entry: string, opts: CompileOptions): Promise<void> {
    const qbeBin = findQbe()
    if (!qbeBin) { console.error(QBE_INSTALL_HINT); process.exit(1) }
    const ccBin = findCc()
    if (!ccBin)  { console.error(CC_INSTALL_HINT);  process.exit(1) }

    const qbeIr  = await compileToQbeIr(entry, opts)
    const asmOut = invokeQbe(qbeBin, qbeIr, hostQbeArch())

    const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'sgl-run-'))
    const asmPath = path.join(tmpDir, 'prog.s')
    const exePath = path.join(tmpDir, os.platform() === 'win32' ? 'prog.exe' : 'prog')
    try {
        fs.writeFileSync(asmPath, asmOut)
        link(ccBin, asmPath, exePath)
        const result = spawnSync(exePath, [], { stdio: 'inherit' })
        process.exit(result.status ?? 0)
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
}

// ---------------------------------------------------------------------------
// sgl check
// ---------------------------------------------------------------------------

async function cmdCheck(positional: string | undefined, opts: CompileOptions): Promise<void> {
    const entry     = resolveEntry(positional, process.cwd())
    const rawSource = await fsp.readFile(entry, 'utf-8')
    const entryAbs  = path.resolve(entry)
    const { source } = resolveUses(rawSource, entryAbs)
    const extraSources: string[] = await Promise.all(
        opts.strataFiles.map(f => fsp.readFile(f, 'utf-8'))
    )
    const moduleReg = loadModules(path.dirname(entryAbs))

    // ── CaaS pipeline ──────────────────────────────────────────────────────
    const { tree, diagnostics: parseErrs } = parse(source, { file: entryAbs })
    if (parseErrs.length) emitDiagnostics(parseErrs, opts)

    const registry = buildRegistry(tree, extraSources)
    const { tree: elab, registry: reg, diagnostics: elabErrs } = elaborate(tree, registry)
    if (elabErrs.length) emitDiagnostics(elabErrs, opts)

    const { diagnostics: typeErrs } = typecheck(elab, reg, { moduleRegistry: moduleReg })
    if (typeErrs.length) emitDiagnostics(typeErrs, opts)

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

    const { tree, diagnostics: parseErrs } = parse(source, { file: entryAbs })
    if (parseErrs.length) emitDiagnostics(parseErrs, opts)

    const formatted = formatProgram(tree.program as any)

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
let native  = false
let target: LowerTarget = 'host'
let pretty = false
let fmtCheck = false
let fmtStdout = false
let maxHeapPages: number | undefined = undefined

for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === '--strata') {
        const next = rest[++i]
        if (!next) { console.error('--strata requires a file argument'); process.exit(1) }
        strataFiles.push(next)
    } else if (arg === '--wat') {
        emitWat = true
    } else if (arg === '--native') {
        native = true
    } else if (arg === '--wasm') {
        // no-op: .wasm is default
    } else if (arg === '--pretty') {
        pretty = true
    } else if (arg === '--release') {
        native = true  // release mode uses the QBE native backend
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
    } else if (arg === '--max-heap') {
        const next = rest[++i]
        if (!next) { console.error('--max-heap requires a page count'); process.exit(1) }
        maxHeapPages = parseMaxHeap(next)
    } else if (arg.startsWith('--max-heap=')) {
        maxHeapPages = parseMaxHeap(arg.slice('--max-heap='.length))
    } else if (!arg.startsWith('--')) {
        positional = arg
    } else {
        console.error(`sgl: unknown flag '${arg}'`)
        process.exit(1)
    }
}

const opts: CompileOptions = { strataFiles, target, pretty, wat: emitWat, native, maxHeapPages }

try {
    switch (subcommand) {
        case 'init':
            await cmdInit(rest.filter(a => !a.startsWith('-')))
            break
        case 'setup':
            await cmdSetup()
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
