// SPDX-License-Identifier: MIT
// Browser variant of stdWatSource.ts — returns the inlined std.wat, no fs.
import { STD_WAT } from '../assets.generated'

export function loadStdWatRaw(): string {
    return STD_WAT
}
