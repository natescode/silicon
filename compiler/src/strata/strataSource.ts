// SPDX-License-Identifier: MIT
// Filesystem read of the built-in strata (Node/Bun toolchain). Any .si file
// dropped in this directory is picked up automatically — no explicit list.
// The browser build swaps this for strataSource.browser.ts (inlined copy).
import { readdirSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))

export function loadBuiltinStrata(): string {
    const files = readdirSync(__dir)
        .filter(f => f.endsWith('.si'))
        .sort()
    return files.map(f => readFileSync(join(__dir, f), 'utf-8')).join('\n')
}
