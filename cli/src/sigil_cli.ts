#! /usr/bin/env bun
// SPDX-License-Identifier: MIT
/**
 * sgl — The Silicon compiler CLI
 *
 * Subcommands:
 *   sgl init [name]          scaffold a new Silicon project
 *   sgl build [flags] [file] compile to .wasm/.wat
 *   sgl run   [flags] [file] compile and execute
 *   sgl check [flags] [file] typecheck only (no output)
 *   sgl update [flags]      update the curl-installed sgl binary
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
// Compiler public API — the CLI is a thin consumer of @silicon/compiler.
import {
    parse, compile, check,
    resolveUses, loadModules,
    renderJson, renderPretty, formatProgram,
    type LowerTarget, type Diagnostic,
} from '@silicon/compiler'
// Front-end + QBE IR (pure) comes from the compiler; the toolchain drivers
// that shell out to qbe / cc are CLI-local host orchestration.
import { compileToQbe } from '@silicon/compiler/native'
import { findQbe, invokeQbe, hostQbeArch, downloadAndBuildQbe, QBE_INSTALL_HINT } from './native/backend'
import { findCc, link, defaultExePath, CC_INSTALL_HINT } from './native/linker'
import { cmdUpdate } from './update'
import cliPackage from '../package.json' with { type: 'json' }

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
  update          Update the curl-installed sgl binary from GitHub Releases
  test  [file]    Run @@test-annotated functions (requires Phase 7)
  eval            Interactive REPL (requires Phase 7)
  add   <pkg>     Add a dependency (1.0: --path <local> only; registry pending)
  resolve         Generate sgl.lock from sgl.toml (stub at 1.0)
  fmt   [file]    Format Silicon source files (normalises whitespace + style)
  help            Show this help
  version         Print the sgl version (also --version, -v)

Global flags:
  --pretty        Human-readable diagnostics instead of JSON
  --strata <f>    Load extra strata from <f> (may repeat)

Build / run flags:
  --wat           Emit .wat text instead of .wasm binary
  --native        Compile via QBE to native assembly (requires qbe; see sgl setup)
  --target=<t>    Compilation target: host (default) | wasix | wasm-gc
                  host / wasix use the linear-memory bump allocator.
                  wasm-gc opts into managed references via the engine GC
                  (ADR 0009).  Mvp-only primitives (&alloc, &@with_arena,
                  raw &heap_*, Rc introspection) are rejected at typecheck;
                  lifecycle primitives (@with_arena, Rc) compile to no-ops.
  --release       Compile via the QBE native backend (alias for --native)
  -l<lib> -L<dir> Pass cc-style linker flags to the native link step
                  (e.g. -lraylib -lm).  --native only.
  --link <arg>    Pass an arbitrary argument to the linker (may repeat).
  --emit-qbe      Emit QBE IR text (.qbe) and stop; no assemble/link (no qbe needed).
  --save-temps    Keep the intermediate .qbe and .s from a --native build.
  --max-heap=<N>  Cap wasm memory at N 64KB pages (heap-exhaustion testing;
                  past the cap the bump allocator traps cleanly).  Default: unbounded.

Format flags (sgl fmt only):
  --check         Exit 1 if formatted output differs from the input file
  --stdout        Print formatted output to stdout; do not modify the file

Update flags (sgl update only):
  --check         Report whether a newer stable release exists; do not install
  --force         Reinstall even when the current version equals latest
  --version <v>   Install a specific release tag, e.g. v1.0.0

File resolution:
  If no file is given, sgl reads sgl.toml in the current directory and uses
  the entry point declared under [package] entry = "...".

sgl.toml [native] section (default native linker inputs):
  [native]
  libs      = ["raylib", "m"]      # → -lraylib -lm
  link-args = ["-L/opt/lib"]       # raw cc/ld args

Examples:
  sgl init my-app
  sgl build src/main.si
  sgl run   src/main.si
  sgl check src/main.si
  sgl build --native src/main.si              # QBE native backend → native exe
  sgl build --native game.si -lraylib -lm     # link extra libraries
  sgl build --emit-qbe game.si                # dump QBE IR to game.qbe
  sgl setup                                    # install qbe into ~/.sgl/bin/
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
    /** Phase 9d-4 — `[build]` section.  CLI flags win over toml. */
    build: {
        /** `target = "wasm-gc"` opts into ADR 0009's GC target by default. */
        target?: string
        /** `platform = "bun"` / `"web"` selects a JS host (enables JS String
         *  Builtins + the externref `JSString` type; `sgl run` executes under
         *  Bun instead of wasmtime).  Default `"native"`. */
        platform?: string
    }
    /** `[native]` section — default linker inputs for the QBE native backend.
     *  `libs = ["raylib", "m"]` → `-lraylib -lm`; `link-args = [...]` is raw.
     *  CLI `-l`/`-L`/`--link` flags are appended on top of these. */
    native: {
        libs?: string[]
        linkArgs?: string[]
    }
    dependencies: Record<string, string>
}

function readSglToml(dir: string): SglToml | null {
    const tomlPath = path.join(dir, 'sgl.toml')
    if (!fs.existsSync(tomlPath)) return null
    const text = fs.readFileSync(tomlPath, 'utf-8')
    const result: SglToml = { package: {}, build: {}, native: {}, dependencies: {} }
    let section = ''
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) continue
        const secMatch = line.match(/^\[([a-zA-Z0-9_.-]+)\]$/)
        if (secMatch) { section = secMatch[1]; continue }

        // [native] array values:  libs = ["raylib", "m"]  /  link-args = ["-L/x"]
        // (single-line arrays only — this is a minimal reader, not full TOML).
        if (section === 'native') {
            const arrMatch = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*\[(.*)\]\s*$/)
            if (arrMatch) {
                const items = [...arrMatch[2].matchAll(/"([^"]*)"/g)].map(m => m[1])
                if (arrMatch[1] === 'libs')           result.native.libs = items
                else if (arrMatch[1] === 'link-args') result.native.linkArgs = items
                continue
            }
        }

        const kvMatch = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*"([^"]*)"$/)
        if (!kvMatch) continue
        const [, key, val] = kvMatch
        if (section === 'package') {
            (result.package as any)[key] = val
        } else if (section === 'build') {
            (result.build as any)[key] = val
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
    /** Host platform.  `web`/`bun` enable JS String Builtins; `bun` makes
     *  `sgl run` execute in-process under Bun.  Default `native`. */
    platform: Platform
    pretty: boolean
    wat: boolean
    native: boolean
    /** Extra linker arguments for the native backend (`-l`, `-L`, `--link`,
     *  plus sgl.toml `[native] libs`).  Passed to `cc` as `LinkOptions.extraArgs`.
     *  Ignored by wasm. */
    linkArgs?: string[]
    /** Emit QBE IR text (`.qbe`) and stop — no assemble/link. */
    emitQbe?: boolean
    /** Keep intermediate `.qbe` / `.s` files from a `--native` build. */
    saveTemps?: boolean
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
    const { source } = resolveUses(rawSource, entryAbs, { target: opts.target })
    const extraSources: string[] = await Promise.all(
        opts.strataFiles.map(f => fsp.readFile(f, 'utf-8'))
    )
    const moduleReg = loadModules(path.dirname(entryAbs))

    const result = compile(source, {
        file: entryAbs, extraSources, moduleRegistry: moduleReg,
        target: opts.target, platform: opts.platform,
        maxHeapPages: opts.maxHeapPages, emitBinary: true,
    })
    if (result.diagnostics.length) emitDiagnostics(result.diagnostics, opts)
    return { wat: result.wat, binary: result.binary! }
}

// ---------------------------------------------------------------------------
// sgl init
// ---------------------------------------------------------------------------

const HELLO_WORLD_SI = `# src/main.si — Silicon Hello World
# Compile:  sgl build
# Run:      sgl run

\\\\ write_bytes (Int, Int, Int) -> Int
@fn write_bytes fd, ptr, len := {
    @local iovs := &scratch_alloc 8;
    &WASM::i32_store iovs, ptr;
    &WASM::i32_store (iovs + 4), len;
    @local nwritten := &scratch_alloc 4;
    &wasi_snapshot_preview1::fd_write fd, iovs, 1, nwritten
};

\\\\ write_str (Int, String) -> Int
@fn write_str fd, s := {
    &write_bytes fd, ((&str_ptr s) + 4), (&str_len s)
};

\\\\ write_nl (Int) -> Int
@fn write_nl fd := {
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

    // --emit-qbe: dump the QBE IR text (front-end + lowering only, no qbe binary).
    if (opts.emitQbe) {
        const qbeIr = await compileToQbeIr(entry, opts)
        const outPath = path.basename(entry, '.si') + '.qbe'
        await fsp.writeFile(outPath, qbeIr)
        console.log(`Compiled ${entry} → ${outPath}`)
        return
    }

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
    const { source } = resolveUses(rawSource, entryAbs, { target: opts.target })
    const extraSources: string[] = await Promise.all(
        opts.strataFiles.map(f => fsp.readFile(f, 'utf-8'))
    )
    const moduleReg = loadModules(path.dirname(entryAbs))

    const result = compileToQbe(source, {
        file: entryAbs, extraSources, moduleRegistry: moduleReg, target: opts.target,
    })
    if (result.diagnostics.length) emitDiagnostics(result.diagnostics, opts)
    return result.qbeIr
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

    if (opts.saveTemps) await fsp.writeFile(stem + '.qbe', qbeIr)
    await fsp.writeFile(asmPath, asmOut)
    link(ccBin, asmPath, exePath, { extraArgs: opts.linkArgs })
    // Remove the intermediate .s unless --save-temps keeps it for inspection.
    if (!opts.saveTemps) { try { fs.unlinkSync(asmPath) } catch { /* best-effort */ } }

    console.log(`Compiled ${entry} → ${exePath}`)
    if (opts.saveTemps) console.log(`Kept ${stem}.qbe and ${asmPath}`)
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

    // Web/bun platform: instantiate under Bun's WebAssembly with the JS String
    // Builtins opt-in (wasmtime can't provide them).  No WASI; the linear-memory
    // `host` model + the exported `_start` run in-process.
    if (opts.platform === 'bun' || opts.platform === 'web') {
        const { runUnderBun } = await import('./host/js-host')
        const { binary } = await compileFile(entry, { ...opts, target: 'host' })
        process.exit(await runUnderBun(binary))
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
            console.error('sgl run: wasmtime not found on PATH or in ~/.wasmtime/bin.')
            console.error('  Install:  curl https://wasmtime.dev/install.sh -sSf | bash')
            console.error('  Or:       brew install wasmtime')
            console.error('  Or skip wasmtime entirely with `sgl run --release` (native via QBE).')
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
        link(ccBin, asmPath, exePath, { extraArgs: opts.linkArgs })
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
    const { source } = resolveUses(rawSource, entryAbs, { target: opts.target })
    const extraSources: string[] = await Promise.all(
        opts.strataFiles.map(f => fsp.readFile(f, 'utf-8'))
    )
    const moduleReg = loadModules(path.dirname(entryAbs))

    const { diagnostics } = check(source, {
        file: entryAbs, extraSources, moduleRegistry: moduleReg, target: opts.target,
    })
    if (diagnostics.length) emitDiagnostics(diagnostics, opts)

    console.log(`${entry}: OK`)
}

// ---------------------------------------------------------------------------
// Stub commands (Phase 7 / post-Phase-6)
// ---------------------------------------------------------------------------

function cmdTest(_args: string[]): void {
    console.error('sgl test: not yet implemented (requires Phase 7 interpreter)')
    console.error('  Track progress: docs/v1.1-user-stories.html §Phase 7')
    process.exit(1)
}

function cmdEval(_args: string[]): void {
    console.error('sgl eval: not yet implemented (requires Phase 7 interpreter)')
    process.exit(1)
}

/**
 * Story 6b-11 — `sgl add <name> --path <local>` records a local-path
 * dependency in sgl.toml.  Git / registry sources are tracked under
 * 6b-12 + 6b-13 and surface here once landed.
 *
 * At 1.0, registry packages return a not-yet-available error and direct
 * the user to the local-path form.
 */
function cmdAdd(args: string[]): void {
    // Split args from flags.  `--path <dir>` is the only flag accepted at 1.0.
    const positional: string[] = []
    let localPath: string | undefined
    for (let i = 0; i < args.length; i++) {
        const a = args[i]
        if (a === '--path') {
            localPath = args[++i]
            if (!localPath) {
                console.error('sgl add: --path requires a directory argument')
                process.exit(1)
            }
        } else if (a.startsWith('--path=')) {
            localPath = a.slice('--path='.length)
        } else {
            positional.push(a)
        }
    }

    const name = positional[0]
    if (!name) {
        console.error('sgl add: package name required')
        console.error('  Usage:  sgl add <name> --path <local-dir>')
        process.exit(1)
    }

    if (!localPath) {
        console.error(`sgl add: registry-backed packages are not yet available (story 6b-12).`)
        console.error(`  At 1.0, add dependencies by path:`)
        console.error(`    sgl add ${name} --path ../path/to/${name}`)
        process.exit(1)
    }

    const cwd = process.cwd()
    const tomlPath = path.join(cwd, 'sgl.toml')
    if (!fs.existsSync(tomlPath)) {
        console.error('sgl add: no sgl.toml found in current directory')
        console.error("  Run 'sgl init <name>' first, or cd into an existing project.")
        process.exit(1)
    }

    // Resolve the path to a project-rooted form for stability across machines.
    const absLocal = path.isAbsolute(localPath) ? localPath : path.resolve(cwd, localPath)
    if (!fs.existsSync(absLocal)) {
        console.error(`sgl add: --path '${localPath}' does not exist (resolved to ${absLocal})`)
        process.exit(1)
    }
    const relativeLocal = path.relative(cwd, absLocal) || '.'

    // Append (or update) the [dependencies] entry.  We rewrite the file
    // line by line so existing formatting / comments survive.
    const text = fs.readFileSync(tomlPath, 'utf-8')
    const lines = text.split('\n')
    let inDeps = false
    let depSectionStart = -1
    let existingLineIdx = -1
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim()
        const secMatch = trimmed.match(/^\[([a-zA-Z0-9_.-]+)\]$/)
        if (secMatch) {
            if (secMatch[1] === 'dependencies') {
                inDeps = true
                depSectionStart = i
            } else if (inDeps) {
                inDeps = false  // section ended
            }
            continue
        }
        if (inDeps) {
            const kvMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=\s*"[^"]*"$/)
            if (kvMatch && kvMatch[1] === name) existingLineIdx = i
        }
    }

    const newLine = `${name} = "path:${relativeLocal}"`
    if (existingLineIdx >= 0) {
        lines[existingLineIdx] = newLine
        console.log(`updated ${name} → path:${relativeLocal}`)
    } else if (depSectionStart >= 0) {
        // Insert at the end of the dependencies section.  Walk to the next
        // section header or EOF and insert right before it.
        let insertAt = lines.length
        for (let i = depSectionStart + 1; i < lines.length; i++) {
            if (lines[i].trim().match(/^\[/)) { insertAt = i; break }
        }
        // Trim trailing blank lines within the section to keep formatting tight.
        while (insertAt > depSectionStart + 1 && lines[insertAt - 1].trim() === '') insertAt--
        lines.splice(insertAt, 0, newLine)
        console.log(`added ${name} → path:${relativeLocal}`)
    } else {
        // No [dependencies] section — append one at EOF.
        if (lines[lines.length - 1] !== '') lines.push('')
        lines.push('[dependencies]', newLine)
        console.log(`added ${name} → path:${relativeLocal} (new [dependencies] section)`)
    }

    fs.writeFileSync(tomlPath, lines.join('\n'), 'utf-8')
}

/**
 * Story 6b-13 — `sgl resolve` stub.  Generates a v1 sgl.lock from the
 * current sgl.toml.  At 1.0 this writes the lockfile header + the root
 * package + any path: dependencies; git / registry sources are a v1.x
 * resolver concern.  Format documented in docs/lockfile-format.md.
 */
function cmdResolve(_args: string[]): void {
    const cwd = process.cwd()
    const toml = readSglToml(cwd)
    if (!toml) {
        console.error('sgl resolve: no sgl.toml found in current directory')
        process.exit(1)
    }

    const name = toml.package.name ?? path.basename(cwd)
    const version = toml.package.version ?? '0.0.0'
    const depNames = Object.keys(toml.dependencies).sort()

    const lines: string[] = []
    lines.push('# sgl.lock — generated by `sgl resolve`.  DO NOT edit by hand.')
    lines.push('# Edit sgl.toml instead and re-run `sgl resolve`.')
    lines.push('')
    lines.push('version = 1')
    lines.push('')

    // Root package.
    lines.push('[[package]]')
    lines.push(`name = "${name}"`)
    lines.push(`version = "${version}"`)
    if (depNames.length > 0) {
        const list = depNames.map(d => `"${d}"`).join(', ')
        lines.push(`dependencies = [${list}]`)
    }

    // Path dependencies — at 1.0 we record source verbatim and don't
    // recursively walk pointee sgl.toml files.  v1.x resolver fills in
    // version + nested deps + sha256 for git/registry sources.
    for (const dep of depNames) {
        const source = toml.dependencies[dep]
        lines.push('')
        lines.push('[[package]]')
        lines.push(`name = "${dep}"`)
        lines.push('version = "0.0.0"  # v1.x resolver fills in from pointee sgl.toml')
        lines.push(`source = "${source}"`)
    }
    lines.push('')

    const lockPath = path.join(cwd, 'sgl.lock')
    fs.writeFileSync(lockPath, lines.join('\n'), 'utf-8')
    console.log(`wrote ${lockPath} (${depNames.length} dependency${depNames.length === 1 ? '' : 'ies'})`)
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
    const { source } = resolveUses(original, entryAbs, { target: opts.target })

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

function parseTarget(value: string, source: '--target' | 'sgl.toml [build] target' = '--target'): LowerTarget {
    if (value === 'host' || value === 'wasix' || value === 'wasm-gc') return value
    console.error(`sgl: unknown ${source} value '${value}' (expected: host | wasix | wasm-gc)`)
    process.exit(1)
}

/** Host platform — orthogonal to the wasm memory-model `target`.  `web`/`bun`
 *  are JS hosts that provide the `wasm:js-string` builtins; `sgl run` executes a
 *  bun-platform module in-process under Bun's WebAssembly. */
export type Platform = 'native' | 'web' | 'bun'
function parsePlatform(value: string, source: '--platform' | 'sgl.toml [build] platform' = '--platform'): Platform {
    if (value === 'native' || value === 'web' || value === 'bun') return value
    console.error(`sgl: unknown ${source} value '${value}' (expected: native | web | bun)`)
    process.exit(1)
}

const SGL_VERSION = cliPackage.version

const argv = process.argv.slice(2)

if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version') {
    process.stdout.write(`sgl ${SGL_VERSION}\n`)
    process.exit(0)
}

if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(HELP)
    process.exit(0)
}

const subcommand = argv[0]
const rest = argv.slice(1)

if (subcommand === 'update') {
    try {
        await cmdUpdate({ currentVersion: SGL_VERSION, args: rest })
        process.exit(0)
    } catch (e) {
        console.error(`\x1b[31mError: ${e}\x1b[39m`)
        process.exit(1)
    }
}

// Parse flags from the rest of the args
const strataFiles: string[] = []
let positional: string | undefined
let emitWat = false
let native  = false
// Phase 9d-4: `target` defaults to whatever sgl.toml's `[build] target`
// declares (if present); CLI `--target=…` overrides toml.  Read toml
// upfront so the resolved default is in place before arg parsing.
const tomlForTarget = readSglToml(process.cwd())
let target: LowerTarget = tomlForTarget?.build.target
    ? parseTarget(tomlForTarget.build.target, 'sgl.toml [build] target')
    : 'host'
let platform: Platform = tomlForTarget?.build.platform
    ? parsePlatform(tomlForTarget.build.platform, 'sgl.toml [build] platform')
    : 'native'
let pretty = false
let fmtCheck = false
let fmtStdout = false
let maxHeapPages: number | undefined = undefined
const linkArgs: string[] = []
let emitQbe = false
let saveTemps = false

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
    } else if (arg === '--platform') {
        const next = rest[++i]
        if (!next) { console.error('--platform requires a value'); process.exit(1) }
        platform = parsePlatform(next)
    } else if (arg.startsWith('--platform=')) {
        platform = parsePlatform(arg.slice('--platform='.length))
    } else if (arg === '--max-heap') {
        const next = rest[++i]
        if (!next) { console.error('--max-heap requires a page count'); process.exit(1) }
        maxHeapPages = parseMaxHeap(next)
    } else if (arg.startsWith('--max-heap=')) {
        maxHeapPages = parseMaxHeap(arg.slice('--max-heap='.length))
    } else if (arg === '--emit-qbe') {
        emitQbe = true
    } else if (arg === '--save-temps') {
        saveTemps = true
    } else if (arg === '--link') {
        const next = rest[++i]
        if (!next) { console.error('--link requires a linker argument'); process.exit(1) }
        linkArgs.push(next)
    } else if (arg.startsWith('--link=')) {
        linkArgs.push(arg.slice('--link='.length))
    } else if (arg.startsWith('-l') || arg.startsWith('-L')) {
        // cc-style linker flags (-lraylib, -L/path) pass straight through to
        // the native link step.  Checked before the positional branch below.
        linkArgs.push(arg)
    } else if (arg === '--path' || arg.startsWith('--path=')) {
        // sgl add --path <local> — consumed by cmdAdd, not the global parser.
        // Just skip the value token if --path <val> form was used.
        if (arg === '--path') i++
    } else if (!arg.startsWith('--')) {
        positional = arg
    } else {
        console.error(`sgl: unknown flag '${arg}'`)
        process.exit(1)
    }
}

// sgl.toml [native] libs/link-args become the base linker inputs; CLI -l/-L/--link append.
const nativeTomlFlags = [
    ...(tomlForTarget?.native.libs ?? []).map(l => `-l${l}`),
    ...(tomlForTarget?.native.linkArgs ?? []),
]
const opts: CompileOptions = {
    strataFiles, target, platform, pretty, wat: emitWat, native, maxHeapPages,
    linkArgs: [...nativeTomlFlags, ...linkArgs],
    emitQbe, saveTemps,
}

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
            // `sgl add` needs to see its own flags (e.g. --path); the main
            // parser only consumes flags it recognises, so pass through `rest`.
            cmdAdd(rest)
            break
        case 'resolve':
            cmdResolve(rest)
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
