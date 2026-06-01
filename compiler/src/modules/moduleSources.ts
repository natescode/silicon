// SPDX-License-Identifier: MIT
// Filesystem discovery of module .si sources (Node/Bun toolchain).
// The browser build swaps this for moduleSources.browser.ts, which returns
// the inlined built-in modules and no user modules.
import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join, basename, extname, dirname } from 'path'
import { fileURLToPath } from 'url'

export interface RawModule {
    name: string
    kind: 'env' | 'user'
    source: string
}

const __dir = dirname(fileURLToPath(import.meta.url))
const BUILTIN_MODULES_DIR = join(__dir, '../strata/modules')

/** Built-in env modules in src/strata/modules/*.si, sorted by filename. */
export function listBuiltinModules(): RawModule[] {
    const out: RawModule[] = []
    if (!existsSync(BUILTIN_MODULES_DIR)) return out
    for (const filename of readdirSync(BUILTIN_MODULES_DIR).sort()) {
        if (extname(filename) !== '.si') continue
        out.push({
            name: basename(filename, '.si'),
            kind: 'env',
            source: readFileSync(join(BUILTIN_MODULES_DIR, filename), 'utf-8'),
        })
    }
    return out
}

/**
 * User modules under <projectDir>/modules/, sorted. Supports both the
 * single-file (modules/Draw.si) and folder (modules/Draw/Draw.si) layouts.
 */
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
            if (existsSync(siFile)) {
                out.push({ name, kind: 'user', source: readFileSync(siFile, 'utf-8') })
            }
        }
    }
    return out
}
