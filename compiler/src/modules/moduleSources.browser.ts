// SPDX-License-Identifier: MIT
// Browser variant of moduleSources.ts — inlined built-in modules, no fs and
// no user modules (the browser playground has no project directory).
import { BUILTIN_MODULES } from '../assets.generated'

export interface RawModule {
    name: string
    kind: 'env' | 'user'
    source: string
}

export function listBuiltinModules(): RawModule[] {
    return Object.keys(BUILTIN_MODULES).sort().map(filename => ({
        name: filename.replace(/\.si$/, ''),
        kind: 'env' as const,
        source: BUILTIN_MODULES[filename],
    }))
}

export function listUserModules(_projectDir: string): RawModule[] {
    return []
}
