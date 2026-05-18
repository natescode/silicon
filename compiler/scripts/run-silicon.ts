#!/usr/bin/env bun
/**
 * scripts/run-silicon.ts — compile a Silicon source file via stage1.wasm.
 *
 * Concatenates the built-in strata bundle in front of the user source
 * so stage1 can resolve operators/keywords/defkinds, pipes the result
 * through stage1.wasm under wasmtime, and writes the WAT to disk.
 * Optionally also runs wat2wasm to produce a wasm artifact.
 *
 * Runtime: wasmtime (the WASI reference implementation).  Wasmer 2.x
 * has a known mapped-dir rights bug that blocks Phase 4b's path_open
 * end-to-end test, and wasmer 7.x has post-path_open fd corruption
 * plus a Windows absolute-path stdout bug.  Wasmtime ≥ 14 is the
 * minimum.
 *
 * Usage:
 *   bun run scripts/run-silicon.ts <source.si>                 # → source.wat
 *   bun run scripts/run-silicon.ts <source.si> <out.wat>       # custom output
 *   bun run scripts/run-silicon.ts <source.si> <out.wat> --wasm
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { watToWasm } from '../src/codegen/toWasm'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..')

async function main(): Promise<void> {
    const args = process.argv.slice(2)
    const sourcePath = args[0]
    if (!sourcePath) {
        console.error('Usage: bun run scripts/run-silicon.ts <source.si> [out.wat] [--wasm]')
        process.exit(2)
    }
    const wantWasm = args.includes('--wasm')
    const watOut = (args[1] && !args[1].startsWith('--'))
        ? args[1]
        : sourcePath.replace(/\.si$/, '.wat')

    const stage1Path = path.join(PROJECT_ROOT, 'stage1.wasm')
    try { await fs.access(stage1Path) }
    catch {
        console.error('stage1.wasm missing. Build it first:')
        console.error('  bun run scripts/build-stage1.ts')
        process.exit(1)
    }

    // Assemble strata bundle + user source.
    const strataDir = path.join(PROJECT_ROOT, 'src', 'strata')
    const strataFiles = (await fs.readdir(strataDir))
        .filter(f => f.endsWith('.si'))
        .sort()
    let bundle = ''
    for (const f of strataFiles) {
        bundle += await fs.readFile(path.join(strataDir, f), 'utf-8') + '\n'
    }
    const userSrc = await fs.readFile(sourcePath, 'utf-8')

    const r = spawnSync('wasmtime', [stage1Path], {
        input: Buffer.from(bundle + userSrc, 'utf-8'),
        maxBuffer: 64 * 1024 * 1024,
    })
    if (r.status !== 0) {
        process.stderr.write(r.stderr ?? '')
        process.exit(r.status ?? 1)
    }
    const wat = (r.stdout ?? Buffer.alloc(0)).toString('utf-8')
    await fs.writeFile(watOut, wat)
    console.log(`  → ${watOut} (${wat.length} bytes)`)

    if (wantWasm) {
        const wasmOut = watOut.replace(/\.wat$/, '.wasm')
        const compiled = await watToWasm(wat)
        await fs.writeFile(wasmOut, Buffer.from(compiled.buffer))
        console.log(`  → ${wasmOut} (${compiled.buffer.byteLength} bytes)`)
    }
}

main().catch(err => {
    console.error(err.message ?? err)
    process.exit(1)
})
