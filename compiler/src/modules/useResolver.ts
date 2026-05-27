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

/**
 * Match `@use 'path';` (with optional whitespace) at start-of-line or after
 * whitespace, NOT inside a `#` line comment.  Group 1 is the path string.
 */
const USE_RE = /^[ \t]*@use[ \t]+'([^'\n\r]+)'[ \t]*;[ \t]*(?:#[^\n\r]*)?$/gm

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

export interface UseResolverOptions {
    /** Override file reads — used by tests and the WASIX in-memory loader. */
    readFile?: (absPath: string) => string | undefined
    /** Override file existence checks. */
    fileExists?: (absPath: string) => boolean
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

    const visited = new Set<string>()
    const visitOrder: string[] = []
    /** Path of files currently on the resolution stack — for cycle detection. */
    const stack = new Set<string>()
    const parts: string[] = []

    function visit(absPath: string, source: string) {
        if (visited.has(absPath)) return
        if (stack.has(absPath)) {
            throw new Error(`@use cycle detected: ${[...stack, absPath].join(' -> ')}`)
        }
        stack.add(absPath)

        const baseDir = dirname(absPath)
        const uses: { abs: string, raw: string }[] = []
        USE_RE.lastIndex = 0
        let match: RegExpExecArray | null
        while ((match = USE_RE.exec(source)) !== null) {
            // Re-derive the matched line to check it isn't shadowed by `#`.
            const lineStart = source.lastIndexOf('\n', match.index) + 1
            const lineEnd = source.indexOf('\n', match.index)
            const line = source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd)
            if (isCommentedOut(line)) continue
            const raw = match[1]
            let abs = isAbsolute(raw) ? raw : resolve(baseDir, raw)
            // Phase 9d-6 — wasm-gc stdlib shadow.
            if (options.target === 'wasm-gc') {
                const shadow = wasmGcShadowPath(abs)
                if (shadow && fileExists(shadow)) abs = shadow
            }
            if (!fileExists(abs)) {
                throw new Error(`@use cannot resolve '${raw}' (looked for ${abs}) from ${absPath}`)
            }
            uses.push({ abs, raw })
        }

        for (const u of uses) {
            const child = readFile(u.abs)
            if (child === undefined) {
                throw new Error(`@use cannot read '${u.raw}' (resolved to ${u.abs}) from ${absPath}`)
            }
            visit(u.abs, child)
        }

        stack.delete(absPath)
        visited.add(absPath)
        visitOrder.push(absPath)
        // Strip the @use directives from the contributed source so the
        // parser never sees them.
        const stripped = source.replace(USE_RE, (line) => {
            // Preserve the line break so source locations stay close-ish.
            return ''
        })
        parts.push(`# region @use ${absPath}\n${stripped}\n# endregion ${absPath}`)
    }

    visit(entryPath, entrySource)

    return {
        source: parts.join('\n'),
        visited: visitOrder,
    }
}
