// SPDX-License-Identifier: MIT
// Browser / compiled-binary variant of stdlibSource.ts — reads the bundled
// standard library from the inlined STDLIB map instead of the filesystem.
import { STDLIB } from '../assets.generated'

/** Return the source of stdlib module `rel` (e.g. 'io.si' or 'gc/rc.si'), or
 *  undefined when no such bundled module exists. */
export function readStdlibModule(rel: string): string | undefined {
    return Object.prototype.hasOwnProperty.call(STDLIB, rel) ? STDLIB[rel] : undefined
}

/** Whether stdlib module `rel` exists in the bundle. */
export function hasStdlibModule(rel: string): boolean {
    return Object.prototype.hasOwnProperty.call(STDLIB, rel)
}
