// SPDX-License-Identifier: MIT
// Filesystem access to the bundled standard library (Node/Bun toolchain).
//
// Drives bare-name `@use 'io';` resolution: a module name maps to a file under
// this directory (`io` -> `io.si`, `gc/rc` -> `gc/rc.si`).  The browser /
// compiled-binary build swaps this for stdlibSource.browser.ts (inlined copy),
// because a `bun build --compile` binary has no source tree to read.
import { existsSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))

/** Return the source of stdlib module `rel` (e.g. 'io.si' or 'gc/rc.si'), or
 *  undefined when no such bundled module exists. */
export function readStdlibModule(rel: string): string | undefined {
    const abs = join(__dir, rel)
    return existsSync(abs) ? readFileSync(abs, 'utf-8') : undefined
}

/** Whether stdlib module `rel` exists in the bundle. */
export function hasStdlibModule(rel: string): boolean {
    return existsSync(join(__dir, rel))
}
