// SPDX-License-Identifier: MIT
// Filesystem read of the Silicon runtime std.wat (Node/Bun toolchain).
// The browser build swaps this for stdWatSource.browser.ts (inlined copy).
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))

export function loadStdWatRaw(): string {
    return readFileSync(join(__dir, 'std.wat'), 'utf-8')
}
