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
 *   3. Pipe the bundle through boot.wasm under wasmer → stage1.wat.
 *   4. Run stage1.wat through wabt → stage1.wasm.
 *   5. Write both stage1.wat and stage1.wasm.
 *
 * Usage:
 *   bun run scripts/build-stage1.ts                  # build into ./stage1.wasm
 *   bun run scripts/build-stage1.ts <output-prefix>  # custom output paths
 *
 * After building, run user Silicon code through stage1.wasm:
 *
 *   cat src/strata/*.si user.si | wasmer run stage1.wasm > user.wat
 *
 * The strata bundle has to be prepended because stage1 doesn't
 * resolve @use yet — it expects the full source on stdin.
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { watToWasm } from '../src/codegen/toWasm'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..')
const OUTPUT_PREFIX = process.argv[2] ?? path.join(PROJECT_ROOT, 'stage1')

// The order matters — files are concatenated and later @use'd
// definitions become unreachable; this list is the bootstrap source
// in dependency order.
const STAGE1_FILES = [
    'boot/std/io.si',
    'boot/std/arena.si',
    'boot/std/vec.si',
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
    'boot/stage1.si',
]

const WASI_STUB = [
    '@extern wasi_snapshot_preview1::fd_write:Int',
    '  fd:Int, iovs_ptr:Int, iovs_len:Int, nwritten_out:Int;',
    '@extern wasi_snapshot_preview1::fd_read:Int',
    '  fd:Int, iovs_ptr:Int, iovs_len:Int, nread_out:Int;',
].join('\n') + '\n'

async function main(): Promise<void> {
    // 1. Ensure boot.wasm exists (build if missing).
    const bootPath = path.join(PROJECT_ROOT, 'boot.wasm')
    let needBuild = false
    try { await fs.access(bootPath) } catch { needBuild = true }
    if (needBuild) {
        console.log('boot.wasm missing — building it first…')
        const r = spawnSync('bun', ['run', 'scripts/build-boot.ts',
                                     'boot/tests/fn_test.si'],
                            { cwd: PROJECT_ROOT, stdio: 'inherit' })
        if (r.status !== 0) throw new Error('boot.wasm build failed')
    }

    // 2. Assemble the stage1 source bundle.
    const strataDir = path.join(PROJECT_ROOT, 'src', 'strata')
    const strataFiles = (await fs.readdir(strataDir))
        .filter(f => f.endsWith('.si'))
        .sort()
    let bundle = ''
    for (const f of strataFiles) {
        bundle += await fs.readFile(path.join(strataDir, f), 'utf-8') + '\n'
    }
    const userSrc = WASI_STUB + (await Promise.all(
        STAGE1_FILES.map(p => fs.readFile(path.join(PROJECT_ROOT, p), 'utf-8')),
    )).join('')

    // 3. Pipe through boot.wasm.
    const compileRes = spawnSync('wasmer', ['run', bootPath], {
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

    // 4. wat2wasm.
    const stage1Bin = await watToWasm(stage1Wat)
    const wasmPath = `${OUTPUT_PREFIX}.wasm`
    await fs.writeFile(wasmPath, Buffer.from(stage1Bin.buffer))

    console.log(`  → ${path.relative(PROJECT_ROOT, watPath)} (${stage1Wat.length} bytes)`)
    console.log(`  → ${path.relative(PROJECT_ROOT, wasmPath)} (${stage1Bin.buffer.byteLength} bytes)`)
    console.log(`\nRun user code via:`)
    console.log(`  cat src/strata/*.si user.si | wasmer run ${path.relative(PROJECT_ROOT, wasmPath)} > user.wat`)
}

main().catch(err => {
    console.error(err.message ?? err)
    process.exit(1)
})
