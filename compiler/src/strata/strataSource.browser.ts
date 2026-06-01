// SPDX-License-Identifier: MIT
// Browser variant of strataSource.ts — joins the inlined strata, no fs.
import { STRATA } from '../assets.generated'

export function loadBuiltinStrata(): string {
    return Object.keys(STRATA).sort().map(k => STRATA[k]).join('\n')
}
