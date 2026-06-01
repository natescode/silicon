// SPDX-License-Identifier: MIT
// Native (compiled-binary) variant of moduleSources.ts.
//
// A `bun build --compile` binary has no real source tree to scan, so built-in
// env modules come from the inlined assets (like the browser). But unlike the
// browser, a native `sgl` binary still reads the *user's* project from disk, so
// user modules keep the real filesystem path.
import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join, basename, extname } from 'path'
import { BUILTIN_MODULES } from '../assets.generated'

export interface RawModule {
    name: string
    kind: 'env' | 'user'
    source: string
}

/** Built-in env modules — inlined (no $bunfs scandir). */
export function listBuiltinModules(): RawModule[] {
    return Object.keys(BUILTIN_MODULES).sort().map(filename => ({
        name: filename.replace(/\.si$/, ''),
        kind: 'env' as const,
        source: BUILTIN_MODULES[filename],
    }))
}

/** User modules under <projectDir>/modules/ — real filesystem (same as the
 *  Node loader). Supports single-file (modules/Draw.si) and folder layouts. */
export function listUserModules(projectDir: string): RawModule[] {
    const out: RawModule[] = []
    const userModulesDir = join(projectDir, 'modules')
    if (!existsSync(userModulesDir)) return out
    for (const name of readdirSync(userModulesDir).sort()) {
        const entryPath = join(userModulesDir, name)
        const stat = statSync(entryPath)
        if (stat.isFile() && extname(name) === '.si') {
            out.push({ name: basename(name, '.si'), kind: 'user', source: readFileSync(entryPath, 'utf-8') })
        } else if (stat.isDirectory()) {
            const siFile = join(entryPath, `${name}.si`)
            if (existsSync(siFile)) out.push({ name, kind: 'user', source: readFileSync(siFile, 'utf-8') })
        }
    }
    return out
}
