// SPDX-License-Identifier: MIT
/**
 * `@use 'path.si';` resolver — Phase −1.C of bootstrap plan.
 *
 * Pre-parse step that finds `@use '<path>';` declarations in the input source,
 * reads the named files, recursively resolves their own `@use`s, and returns a
 * single concatenated source string in dependency order.
 *
 * Why pre-parse rather than a grammar rule: per CLAUDE.md, grammar changes are
 * last-resort. The cleanup plan also picks "include = textual concatenation in
 * dependency order, error on cycles" as the simplest viable rule (cleanup-plan
 * §10).
 *
 * Scoping: `#` comments are honoured so `# @use 'x.si';` is NOT followed.
 * Visibility / namespacing is deliberately deferred to post-Stage-3 — everything
 * ends up in one global namespace as if the user had concatenated by hand.
 */

import { readFileSync, existsSync } from 'fs'
import { dirname, resolve, isAbsolute } from 'path'
import { readStdlibModule, hasStdlibModule } from '../stdlib/stdlibSource'

/**
 * Match `@use 'path';` (with optional whitespace) at start-of-line or after
 * whitespace, NOT inside a `#` line comment.  Group 1 is the path string.
 */
const USE_RE = /^[ \t]*@use[ \t]+'([^'\n\r]+)'[ \t]*;[ \t]*(?:#[^\n\r]*)?$/gm

/**
 * A bare-name `@use 'io';` (a plain identifier — no `/`, no `.si` extension)
 * resolves to a bundled standard-library module rather than a filesystem path.
 * Anything path-like (`./x.si`, `../y/z.si`, `/abs/p.si`) keeps fs resolution.
 */
const BARE_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/

/** Phase 9d-6 — given a resolved stdlib path like
 *  `…/src/stdlib/rc.si`, return the wasm-gc shadow candidate
 *  `…/src/stdlib/gc/rc.si` (whether or not it exists).  Returns
 *  `null` for paths that don't sit directly under `stdlib/` —
 *  nested paths (`…/stdlib/gc/X.si` itself, or `…/stdlib/subdir/X.si`)
 *  pass through unchanged. */
function wasmGcShadowPath(abs: string): string | null {
    // Match …/stdlib/<filename>.si (not …/stdlib/gc/… and not deeper).
    const m = abs.match(/^(.*\/stdlib)\/([^/]+\.si)$/)
    if (!m) return null
    return `${m[1]}/gc/${m[2]}`
}

/** Strip `#` line comments from a source line (but keep them in multi-line
 *  string literals — which Silicon doesn't have, so the simple approach works).
 *  Used only to decide whether a `@use` directive is shadowed by a comment. */
function isCommentedOut(line: string): boolean {
    const hashIdx = line.indexOf('#')
    if (hashIdx < 0) return false
    const usePos = line.indexOf('@use')
    return usePos > hashIdx
}

export interface ResolvedSource {
    /** The fully-concatenated source: every included file's text followed by
     *  the entry source, in dependency order.  `@use` directives are stripped. */
    source: string
    /** The order in which included files were visited.  Useful for diagnostics. */
    visited: string[]
}

/** Resolves bundled standard-library modules for bare-name `@use`s. */
export interface StdlibHook {
    /** Source of stdlib module `rel` ('io.si' | 'gc/rc.si'), or undefined. */
    read(rel: string): string | undefined
    /** Whether stdlib module `rel` exists in the bundle. */
    has(rel: string): boolean
}

export interface UseResolverOptions {
    /** Override file reads — used by tests and the WASIX in-memory loader. */
    readFile?: (absPath: string) => string | undefined
    /** Override file existence checks. */
    fileExists?: (absPath: string) => boolean
    /** Override bundled-stdlib lookup (bare-name `@use`s).  Defaults to the
     *  swappable stdlibSource module (filesystem in dev, inlined in the
     *  browser / compiled binary).  Injected by tests. */
    stdlib?: StdlibHook
    /** Phase 9d-6 — compile target.  When `'wasm-gc'`, `@use` paths
     *  ending in `…/stdlib/<name>.si` are first checked for a sibling
     *  `…/stdlib/gc/<name>.si`; if it exists, the gc variant is used
     *  instead.  Lets `src/stdlib/gc/rc.si` (identity-shim Rc) shadow
     *  `src/stdlib/rc.si` (bump-allocator Rc) without per-call-site
     *  changes in user code.  Falls through to the original path when
     *  no shadow exists or target isn't wasm-gc. */
    target?: import('../ir/lower').LowerTarget
}

/**
 * Resolve every `@use 'path';` referenced from `entrySource`, recursively.
 *
 * @param entrySource — the source of the entry .si file.
 * @param entryPath   — absolute path of the entry file.  Used as the base
 *                      for resolving relative `@use` paths.
 * @param options     — optional I/O overrides.
 */
export function resolveUses(
    entrySource: string,
    entryPath: string,
    options: UseResolverOptions = {},
): ResolvedSource {
    const readFile = options.readFile ?? ((p: string) => existsSync(p) ? readFileSync(p, 'utf-8') : undefined)
    const fileExists = options.fileExists ?? existsSync
    const stdlib: StdlibHook = options.stdlib ?? { read: readStdlibModule, has: hasStdlibModule }

    const visited = new Set<string>()
    const visitOrder: string[] = []
    /** Keys of units currently on the resolution stack — for cycle detection. */
    const stack = new Set<string>()
    const parts: string[] = []

    /** A resolved `@use` target: a filesystem file, or a bundled stdlib module.
     *  `key` is the dedup/cycle identity — an absolute path, or a synthetic
     *  `std:<rel>` for stdlib modules. */
    type Unit =
        | { kind: 'fs', key: string, raw: string, abs: string }
        | { kind: 'std', key: string, raw: string, rel: string }

    /** Map a bare module name to its bundled relative path, honouring the
     *  wasm-gc shadow (`rc` -> `gc/rc.si` under --target=wasm-gc).  Returns
     *  null when no such bundled module exists. */
    function resolveStdlibRel(name: string): string | null {
        if (options.target === 'wasm-gc' && stdlib.has(`gc/${name}.si`)) return `gc/${name}.si`
        const rel = `${name}.si`
        return stdlib.has(rel) ? rel : null
    }

    function visit(key: string, source: string, baseDir: string) {
        if (visited.has(key)) return
        if (stack.has(key)) {
            throw new Error(`@use cycle detected: ${[...stack, key].join(' -> ')}`)
        }
        stack.add(key)

        const uses: Unit[] = []
        USE_RE.lastIndex = 0
        let match: RegExpExecArray | null
        while ((match = USE_RE.exec(source)) !== null) {
            // Re-derive the matched line to check it isn't shadowed by `#`.
            const lineStart = source.lastIndexOf('\n', match.index) + 1
            const lineEnd = source.indexOf('\n', match.index)
            const line = source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd)
            if (isCommentedOut(line)) continue
            const raw = match[1]

            // Bare name (`@use 'io';`) — resolve from the bundled stdlib.
            if (BARE_RE.test(raw)) {
                const rel = resolveStdlibRel(raw)
                if (rel === null) {
                    throw new Error(`@use: unknown stdlib module '${raw}' (no bundled std/${raw}.si) from ${key}`)
                }
                uses.push({ kind: 'std', key: `std:${rel}`, raw, rel })
                continue
            }

            // Path form (`@use './x.si';`) — resolve against the filesystem.
            let abs = isAbsolute(raw) ? raw : resolve(baseDir, raw)
            // Phase 9d-6 — wasm-gc stdlib shadow.
            if (options.target === 'wasm-gc') {
                const shadow = wasmGcShadowPath(abs)
                if (shadow && fileExists(shadow)) abs = shadow
            }
            if (!fileExists(abs)) {
                throw new Error(`@use cannot resolve '${raw}' (looked for ${abs}) from ${key}`)
            }
            uses.push({ kind: 'fs', key: abs, raw, abs })
        }

        for (const u of uses) {
            if (u.kind === 'std') {
                const child = stdlib.read(u.rel)
                if (child === undefined) {
                    throw new Error(`@use cannot read stdlib module '${u.raw}' (std/${u.rel}) from ${key}`)
                }
                // stdlib modules reference siblings by bare name, so their
                // baseDir is irrelevant — pass an empty base.
                visit(u.key, child, '')
            } else {
                const child = readFile(u.abs)
                if (child === undefined) {
                    throw new Error(`@use cannot read '${u.raw}' (resolved to ${u.abs}) from ${key}`)
                }
                visit(u.key, child, dirname(u.abs))
            }
        }

        stack.delete(key)
        visited.add(key)
        visitOrder.push(key)
        // Strip the @use directives from the contributed source so the
        // parser never sees them.
        const stripped = source.replace(USE_RE, () => {
            // Preserve the line break so source locations stay close-ish.
            return ''
        })
        parts.push(`# region @use ${key}\n${stripped}\n# endregion ${key}`)
    }

    visit(entryPath, entrySource, dirname(entryPath))

    return {
        source: parts.join('\n'),
        visited: visitOrder,
    }
}
