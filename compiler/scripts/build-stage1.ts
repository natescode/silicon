#!/usr/bin/env bun
/**
 * scripts/build-stage1.ts — produce stage1.wasm: the Silicon-resident
 * compiler.  The output is a self-contained wasm module that reads
 * Silicon source on stdin and writes WAT to stdout under WASI.
 *
 * Pipeline:
 *   1. Build boot.wasm via the Stage 0 (TypeScript) pipeline.
 *   2. Assemble the full stage1 source bundle (WASI extern stub +
 *      every boot/*.si file + boot/stage1.si as the entry).
 *   3. Pipe the bundle through boot.wasm under wasmtime → stage1.wat.
 *   4. Run stage1.wat through wabt → stage1.wasm.
 *   5. Write both stage1.wat and stage1.wasm.
 *
 * Usage:
 *   bun run scripts/build-stage1.ts                  # build into ./stage1.wasm
 *   bun run scripts/build-stage1.ts <output-prefix>  # custom output paths
 *
 * After building, run user Silicon code through stage1.wasm:
 *
 *   wasmtime stage1.wasm < user.si > user.wat
 *
 * Phase 2 embeds src/strata/*.si into stage1.wasm itself, so the
 * caller no longer has to prepend the strata bundle on stdin.  The
 * embedded bundle is generated as boot/embedded_bundle.si at the
 * start of every build, then included in STAGE1_FILES.
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { watToWasm } from '../src/codegen/toWasm'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..')
const WASM_BIN = path.join(PROJECT_ROOT, 'wasm-bin')
const OUTPUT_PREFIX = process.argv[2] ?? path.join(WASM_BIN, 'stage1')

// The order matters — files are concatenated and later @use'd
// definitions become unreachable; this list is the bootstrap source
// in dependency order.  embedded_bundle.si is auto-generated each
// build (see generateEmbeddedBundle below) and contributes the
// EMBEDDED_BUNDLE :String constant that stage1.si copies into the
// source buffer before reading stdin.
const STAGE1_FILES = [
    'boot/std/argv.si',          // declares args_*/proc_exit externs;
    'boot/std/io.si',            // panic_stderr references proc_exit
    'boot/std/fs.si',            // find_preopen_dir + open_file_for_read
    'boot/std/arena.si',
    'boot/std/vec.si',
    'boot/embedded_bundle.si',
    'boot/parser/tokens.si',
    'boot/parser/lex.si',
    'boot/parser/ast.si',
    'boot/parser/parse.si',
    'boot/strata/registry.si',
    'boot/strata/loader.si',
    'boot/elab/elaborator.si',
    'boot/ir/nodes.si',
    'boot/elab/body.si',
    'boot/ir/lower.si',
    'boot/emit/wat.si',
    'boot/cli.si',               // depends on argv.si + io.si + fs.si helpers
    'boot/stage1.si',
]

const WASI_STUB = [
    '@extern wasi_snapshot_preview1::fd_write:Int',
    '  fd:Int, iovs_ptr:Int, iovs_len:Int, nwritten_out:Int;',
    '@extern wasi_snapshot_preview1::fd_read:Int',
    '  fd:Int, iovs_ptr:Int, iovs_len:Int, nread_out:Int;',
    '@extern wasi_snapshot_preview1::args_get:Int',
    '  argv_ptr:Int, argv_buf:Int;',
    '@extern wasi_snapshot_preview1::args_sizes_get:Int',
    '  argc_out:Int, argv_buf_size_out:Int;',
    '@extern wasi_snapshot_preview1::proc_exit',
    '  code:Int;',
    '@extern wasi_snapshot_preview1::path_open:Int',
    '  dirfd:Int, dirflags:Int, path_ptr:Int, path_len:Int,',
    '  oflags:Int, fs_rights_base:Int64, fs_rights_inheriting:Int64,',
    '  fdflags:Int, fd_out:Int;',
    '@extern wasi_snapshot_preview1::fd_prestat_get:Int',
    '  fd:Int, buf_out:Int;',
    '@extern wasi_snapshot_preview1::fd_prestat_dir_name:Int',
    '  fd:Int, path_ptr:Int, path_len:Int;',
].join('\n') + '\n'

// Escape a single byte for inclusion in a Silicon single-quoted
// string literal.  Mirrors the escape set the bootstrap's
// literal_decoded_len / emit_data_segment recognise:
// `\\`, `\'`, `\n`, `\t`, `\r`, `\0`.  Everything else passes
// through as a raw byte (Silicon source is UTF-8).
function escapeForSiliconString(buf: Buffer): string {
    const out: string[] = []
    for (let i = 0; i < buf.length; i++) {
        const b = buf[i]
        if      (b === 0x5c) out.push('\\\\')   // \
        else if (b === 0x27) out.push("\\'")   // '
        else if (b === 0x0a) out.push('\\n')
        else if (b === 0x0d) out.push('\\r')
        else if (b === 0x09) out.push('\\t')
        else if (b === 0x00) out.push('\\0')
        else                 out.push(String.fromCharCode(b))
    }
    return out.join('')
}

// Read src/strata/*.si in sorted order, concatenate (one file per
// newline), and emit boot/embedded_bundle.si declaring an
// EMBEDDED_BUNDLE :String constant containing the escaped bytes.
// The contents must byte-match what callers used to prepend on
// stdin: same files, same order, same separators.  stage1.si reads
// EMBEDDED_BUNDLE at runtime and copies the bytes to the head of
// its source buffer, replacing the manual host-side prepend.
async function generateEmbeddedBundle(): Promise<string> {
    const strataDir = path.join(PROJECT_ROOT, 'src', 'strata')
    const strataFiles = (await fs.readdir(strataDir))
        .filter(f => f.endsWith('.si'))
        .sort()
    let bundle = ''
    for (const f of strataFiles) {
        let src = await fs.readFile(path.join(strataDir, f), 'utf-8')
        // Normalise line endings — Windows checkouts give us CRLF,
        // Unix gives us LF.  The generated boot/embedded_bundle.si
        // gets committed, so we want the same bytes across platforms
        // (avoids cross-machine diff churn) and the same EMBEDDED_BUNDLE
        // contents driving the byte-equal self-host gate.
        src = src.replace(/\r\n/g, '\n')
        bundle += src + '\n'
    }
    const escaped = escapeForSiliconString(Buffer.from(bundle, 'utf-8'))
    const file =
        `# AUTO-GENERATED by scripts/build-stage1.ts — do not edit.\n` +
        `# Concatenated source of every src/strata/*.si file, embedded\n` +
        `# as a Silicon string literal so stage1.wasm has its built-in\n` +
        `# strata available without the caller prepending them on stdin.\n` +
        `@let EMBEDDED_BUNDLE:String := '${escaped}';\n`
    const outPath = path.join(PROJECT_ROOT, 'boot', 'embedded_bundle.si')
    await fs.writeFile(outPath, file)
    return bundle
}

async function main(): Promise<void> {
    // 1. Generate the embedded bundle BEFORE building boot.wasm —
    //    boot/embedded_bundle.si is one of STAGE1_FILES and the
    //    boot.wasm build step needs to read it.
    const bundle = await generateEmbeddedBundle()
    console.log(`  ↳ boot/embedded_bundle.si (${bundle.length} bytes embedded)`)

    // 2. Ensure boot.wasm exists (build if missing).
    await fs.mkdir(WASM_BIN, { recursive: true })
    const bootPath = path.join(WASM_BIN, 'boot.wasm')
    let needBuild = false
    try { await fs.access(bootPath) } catch { needBuild = true }
    if (needBuild) {
        console.log('boot.wasm missing — building it first…')
        const r = spawnSync('bun', ['run', 'scripts/build-boot.ts',
                                     'boot/tests/fn_test.si'],
                            { cwd: PROJECT_ROOT, stdio: 'inherit' })
        if (r.status !== 0) throw new Error('boot.wasm build failed')
    }

    // 3. Assemble the stage1 source.  Strata still get prepended to
    //    the input we feed boot.wasm — boot.wasm itself has no
    //    embedded strata, so it needs them on stdin to understand
    //    operators in the boot/* source it's about to compile.  The
    //    RESULTING stage1.wasm gets strata embedded via
    //    EMBEDDED_BUNDLE (declared in boot/embedded_bundle.si).
    const userSrc = WASI_STUB + (await Promise.all(
        STAGE1_FILES.map(p => fs.readFile(path.join(PROJECT_ROOT, p), 'utf-8')),
    )).join('')

    // 4. Pipe through boot.wasm (wasmtime — see scripts/run-silicon.ts
    //    for the rationale on runtime choice).
    const compileRes = spawnSync('wasmtime', [bootPath], {
        input: Buffer.from(bundle + userSrc, 'utf-8'),
        maxBuffer: 64 * 1024 * 1024,
    })
    if (compileRes.status !== 0) {
        process.stderr.write(compileRes.stderr ?? '')
        throw new Error(`boot.wasm compilation failed (exit ${compileRes.status})`)
    }
    const stage1Wat = (compileRes.stdout ?? Buffer.alloc(0)).toString('utf-8')
    const watPath = `${OUTPUT_PREFIX}.wat`
    await fs.writeFile(watPath, stage1Wat)

    // 5. wat2wasm.
    const stage1Bin = await watToWasm(stage1Wat)
    const wasmPath = `${OUTPUT_PREFIX}.wasm`
    await fs.writeFile(wasmPath, Buffer.from(stage1Bin.buffer))

    console.log(`  → ${path.relative(PROJECT_ROOT, watPath)} (${stage1Wat.length} bytes)`)
    console.log(`  → ${path.relative(PROJECT_ROOT, wasmPath)} (${stage1Bin.buffer.byteLength} bytes)`)
    console.log(`\nRun user code via:`)
    console.log(`  wasmtime ${path.relative(PROJECT_ROOT, wasmPath)} < user.si > user.wat`)
}

main().catch(err => {
    console.error(err.message ?? err)
    process.exit(1)
})
