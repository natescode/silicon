// SPDX-License-Identifier: MIT
// Filesystem read of the Ohm grammar source (Node/Bun toolchain).
// The browser build swaps this module for grammarSource.browser.ts via the
// bundler alias in playground/web/build.ts, so the browser never touches fs.
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))

export function loadGrammarSource(): string {
    return readFileSync(join(__dir, 'silicon-official.ohm'), 'utf-8')
}
