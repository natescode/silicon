#!/usr/bin/env bun
/**
 * scripts/check-ts-watToWasm.ts — diagnostic probe for the Silicon-only
 * deletion path.
 *
 * Compares Stage 0's wabt-NPM-backed watToWasm wrapper against strict
 * standalone wat2wasm.  The wabt-NPM API silently emits bytes even when
 * the WAT contains validation errors (e.g. stage1's `drop` after void
 * calls inside @if), but wasmtime then rejects those bytes at load
 * time.  Standalone wat2wasm rejects the same WAT immediately.
 *
 * Use this to triage: if `bun run scripts/check-ts-watToWasm.ts in.wat
 * out.wasm` succeeds AND `wasmtime out.wasm` fails, the input WAT is in
 * the "silently invalid" zone — a stage1 codegen bug, not a wabt issue.
 *
 * Usage:
 *   bun run scripts/check-ts-watToWasm.ts <input.wat> <output.wasm>
 */
import { watToWasm } from '../src/codegen/toWasm'
import * as fs from 'node:fs/promises'

const [inPath, outPath] = process.argv.slice(2)
if (!inPath || !outPath) {
    console.error('usage: check-ts-watToWasm.ts <in.wat> <out.wasm>')
    process.exit(64)
}
const wat = await fs.readFile(inPath, 'utf-8')
const buf = await watToWasm(wat)
console.log(`TS watToWasm produced ${buf.length} bytes`)
await fs.writeFile(outPath, Buffer.from(buf.buffer))
console.log(`wrote ${outPath}`)
console.log('next: run `wasmtime ' + outPath + '` to confirm it loads')
