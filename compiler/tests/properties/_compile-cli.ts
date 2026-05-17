#!/usr/bin/env bun
/**
 * Compile-to-stdout helper for cross-process determinism tests.
 *
 * Usage: bun run tests/properties/_compile-cli.ts <source-file.si>
 *
 * Reads the source file, runs the full Stage 0 pipeline, writes WAT to
 * stdout (no other output). The cross-process determinism test spawns this
 * twice and byte-compares stdouts.
 */

import { readFileSync } from 'fs'
import { compileToWatString } from './_compile.ts'

const arg = process.argv[2]
if (!arg) {
    process.stderr.write('usage: _compile-cli.ts <source-file>\n')
    process.exit(2)
}

try {
    const source = readFileSync(arg, 'utf-8')
    const wat = compileToWatString(source)
    process.stdout.write(wat)
} catch (e) {
    process.stderr.write(String(e) + '\n')
    process.exit(1)
}
