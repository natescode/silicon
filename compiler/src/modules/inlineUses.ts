// SPDX-License-Identifier: MIT
/**
 * Browser-safe `@use` inliner for bare-name standard-library modules.
 *
 * The full `@use` resolver (`useResolver.ts`) reads the filesystem and is not
 * part of the browser bundle.  The playground compiles source directly, so it
 * historically could not pull in the stdlib at all.  This helper bridges that
 * gap without touching the filesystem: every stdlib module is already inlined
 * as a string in the generated `STDLIB` map, so a bare-name `@use 'num';` can
 * be expanded by textual substitution.
 *
 * Only bare-name modules present in `STDLIB` are inlined (e.g. `'num'`,
 * `'str'`, `'mem'`, `'io'`, `'option'`).  Path-style uses (`'../x.si'`) are
 * left untouched — the browser has no filesystem to resolve them against.
 *
 * Modules are expanded post-order (dependencies first) and de-duplicated, so
 * `@use 'io'` (which itself `@use`s `num` and `mem`) pulls each dependency in
 * exactly once, ahead of its dependents.
 */

import { STDLIB } from '../assets.generated'

const USE_RE = /@use\s+'([^']+)'\s*;?[ \t]*\r?\n?/g

function keyFor(spec: string): string {
    return spec.endsWith('.si') ? spec : `${spec}.si`
}

/** Strip every bare-name-stdlib `@use` line from `src`, leaving other uses. */
function stripStdlibUses(src: string): string {
    return src.replace(USE_RE, (full, spec: string) =>
        STDLIB[keyFor(spec)] !== undefined ? '' : full)
}

/**
 * Expand bare-name stdlib `@use` directives in `source` by prepending the
 * referenced module sources (dependencies first, de-duplicated).  Returns the
 * expanded program text ready for `parse`.
 */
export function inlineStdlibUses(source: string): string {
    const seen = new Set<string>()
    const modules: string[] = []

    function expand(spec: string): void {
        const key = keyFor(spec)
        if (seen.has(key)) return
        const body = STDLIB[key]
        if (body === undefined) return // not a bundled stdlib module
        seen.add(key)
        // Expand this module's own dependencies first (post-order).
        let m: RegExpExecArray | null
        const re = new RegExp(USE_RE.source, 'g')
        while ((m = re.exec(body)) !== null) expand(m[1])
        modules.push(stripStdlibUses(body))
    }

    let m: RegExpExecArray | null
    const re = new RegExp(USE_RE.source, 'g')
    while ((m = re.exec(source)) !== null) expand(m[1])

    if (modules.length === 0) return source
    return `${modules.join('\n')}\n${stripStdlibUses(source)}`
}
