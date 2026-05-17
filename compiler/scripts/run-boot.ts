#!/usr/bin/env bun
/**
 * scripts/run-boot.ts — build and run the Phase 0 boot program.
 *
 * Convenience: compiles boot/main.si to boot.wasm (via build-boot.ts) and
 * immediately invokes `wasmer run` so a single command exercises the full
 * compile → assemble → run cycle.
 *
 * Usage:
 *   bun run scripts/run-boot.ts                    # default entry boot/main.si
 *   bun run scripts/run-boot.ts <entry.si> -- <args>
 */

import { spawnSync } from 'node:child_process'
import * as path from 'node:path'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const dashDash = argv.indexOf('--')
const entry = dashDash >= 0 ? argv.slice(0, dashDash) : argv
const wasmerArgs = dashDash >= 0 ? argv.slice(dashDash + 1) : []
const entryArg = entry[0] ?? path.join(PROJECT_ROOT, 'boot', 'main.si')

const build = spawnSync('bun', ['run', path.join('scripts', 'build-boot.ts'), entryArg], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
})
if (build.status !== 0) process.exit(build.status ?? 1)

console.log(`\nwasmer run boot.wasm ${wasmerArgs.join(' ')}`.trimEnd())
const run = spawnSync('wasmer', ['run', 'boot.wasm', ...(wasmerArgs.length ? ['--', ...wasmerArgs] : [])], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
})
process.exit(run.status ?? 1)
