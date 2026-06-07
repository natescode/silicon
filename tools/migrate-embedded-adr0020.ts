// SPDX-License-Identifier: MIT
/**
 * ADR 0020 embedded-snippet codemod — migrate Silicon source embedded inside
 * `.md` fenced code blocks and `.test.ts` string/template literals.
 *
 * Reuses the proven string→string transform in migrate-adr0020.ts (migrateSource).
 * A snippet is rewritten only when ALL of the following hold:
 *   1. it contains a legacy marker (`&` call, `@local`/`@global`/`@var`/`@let`/
 *      `@struct`/`@type_sum` surface kw, or `@extern {`/`@interface {` brace form);
 *   2. it parses cleanly as a complete Silicon program via migrateSource;
 *   3. the migration changes the text.
 * Anything else (fragments, error-test snippets, JS-interpolated strings, non-
 * Silicon strings) throws or no-ops and is SKIPPED + logged for manual handling.
 *
 * USAGE (dry by default — reports, writes nothing):
 *   bun run tools/migrate-embedded-adr0020.ts <files...>
 *   bun run tools/migrate-embedded-adr0020.ts --write <files...>
 */

import { migrateSource } from './migrate-adr0020'
import { readFileSync, writeFileSync } from 'node:fs'

const LEGACY = /(^|[^&])&(@?[A-Za-z_]|@)|(^|\s)@(local|global|var|let|struct|type_sum)\s|@(extern|interface)\s*\{/

// Test/doc snippets need EXACT semantics: `@local`/`@var` → `@mut` always (no lossy
// demote-unreassigned-to-bare, which would flip a mutable global to immutable).
const MUT = { preserveMutable: true }

interface Skip { reason: string; snippet: string }
interface Stat { file: string; migrated: number; skipped: Skip[] }

function shorten(s: string): string {
    const one = s.replace(/\s+/g, ' ').trim()
    return one.length > 70 ? one.slice(0, 67) + '…' : one
}

const WRAP = '@fn _t := '

// Try to migrate one snippet. Returns the new text, or null if it should be left
// untouched (no legacy marker, parse failure, or no change). `skips` collects the
// reason when a legacy-bearing snippet could not be migrated. Two strategies:
//   (a) parse as a complete program (compile()/parse()/data-table inputs);
//   (b) if that fails, wrap as a function body `@fn _t := <snippet>;` and extract
//       it back — covers the block-expression / bare-expression fragments that
//       test helpers splice into a definition (e.g. slice.test's `{ … }` bodies).
// Single-line snippets stay single-line (many live in single-quoted strings).
function tryMigrate(snippet: string, skips: Skip[]): string | null {
    if (!LEGACY.test(snippet)) return null            // nothing legacy here
    const oneLine = !snippet.trim().includes('\n')
    const endsSemi = /;\s*$/.test(snippet)
    let firstErr = ''

    // (a) whole-program, as-is.
    try {
        return finalize(snippet, migrateSource(snippet, MUT).text.replace(/\n+$/, ''), oneLine)
    } catch (e: any) { firstErr = e.message || String(e) }

    // (a') definition/statement fragment missing its trailing `;`.
    if (!endsSemi) {
        try {
            const out = migrateSource(snippet + ';', MUT).text.replace(/\n+$/, '').replace(/;\s*$/, '')
            return finalize(snippet, out, oneLine)
        } catch { /* fall through */ }
    }

    // (b) expression / block-body fragment spliced into a definition by the helper.
    try {
        const wrapped = migrateSource(WRAP + snippet + ';', MUT).text.replace(/\n+$/, '')
        if (!wrapped.startsWith(WRAP)) throw new Error('unexpected wrap output')
        const body = wrapped.slice(WRAP.length).replace(/;\s*$/, '')
        return finalize(snippet, body, oneLine)
    } catch { /* report the whole-program error — it's the meaningful one */ }

    skips.push({ reason: 'parse/emit failed: ' + firstErr, snippet: shorten(snippet) })
    return null
}

// Smallest indentation among non-first, non-blank lines (the base column the
// snippet sits at inside its host literal). Used to realign migrated multi-line
// output to match the original's indentation instead of the codemod's col-0.
function baseIndent(text: string): number {
    const lines = text.split('\n').slice(1).filter(l => l.trim())
    if (!lines.length) return 0
    return Math.min(...lines.map(l => l.match(/^ */)![0].length))
}

function finalize(original: string, out: string, oneLine: boolean): string | null {
    let result: string
    if (oneLine) {
        result = out.replace(/\s*\n\s*/g, ' ')
    } else {
        const shift = baseIndent(original) - baseIndent(out)
        result = shift > 0
            ? out.split('\n').map((l, i) => (i === 0 || !l ? l : ' '.repeat(shift) + l)).join('\n')
            : out
    }
    if (result.trim() === original.trim()) return null
    return result
}

// ── Markdown: ```silicon / ```sigil / ```si fenced blocks ───────────────────
function processMarkdown(src: string, stat: Stat): string {
    const FENCE = /(^|\n)(```+)(silicon|sigil|si)[ \t]*\n([\s\S]*?)\n\2[ \t]*(?=\n|$)/g
    return src.replace(FENCE, (full, pre, ticks, lang, body) => {
        const migrated = tryMigrate(body, stat.skipped)
        if (migrated == null) return full
        stat.migrated++
        return `${pre}${ticks}${lang}\n${migrated.replace(/\n+$/, '')}\n${ticks}`
    })
}

// ── TypeScript: backtick template literals + quoted string literals ─────────
function processTestTs(src: string, stat: Stat): string {
    let out = src

    // 1) Backtick template literals (the dominant compile()/parse() input form).
    out = out.replace(/`(?:[^`\\]|\\.)*`/g, (lit) => {
        const raw = lit.slice(1, -1)
        // A real `${…}` interpolation (one not escaped as `\${`, Silicon's object
        // literal) means this isn't a standalone program — skip for manual handling.
        if (/(^|[^\\])\$\{/.test(raw)) {
            if (LEGACY.test(raw)) stat.skipped.push({ reason: 'JS interpolation in template literal', snippet: shorten(raw) })
            return lit
        }
        const migrated = tryMigrate(jsUnescape(raw), stat.skipped)
        if (migrated == null) return lit
        stat.migrated++
        return '`' + tlEscape(migrated.replace(/\n+$/, '')) + '`'
    })

    // 2) Single-line quoted string literals (data-table entries like "&add 1, 2;").
    out = out.replace(/(['"])((?:\\.|(?!\1).)*)\1/g, (lit, q, inner) => {
        // Only touch strings that look like a complete Silicon statement.
        if (!inner.includes(';')) return lit
        const migrated = tryMigrate(jsUnescape(inner), stat.skipped)
        if (migrated == null) return lit
        stat.migrated++
        return q + jsEscape(migrated.replace(/\n+$/, ''), q) + q
    })

    return out
}

// Decode JS string-literal escapes to the actual characters Silicon will lex.
function jsUnescape(s: string): string {
    return s.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_m, e: string) => {
        switch (e[0]) {
            case 'n': return '\n'; case 't': return '\t'; case 'r': return '\r'
            case 'b': return '\b'; case 'f': return '\f'; case 'v': return '\v'; case '0': return '\0'
            case 'u': return String.fromCodePoint(parseInt(e.replace(/[u{}]/g, ''), 16))
            case 'x': return String.fromCharCode(parseInt(e.slice(1), 16))
            default: return e            // \\, \', \", \`, literal char
        }
    })
}

// Re-encode for a quoted string literal: escape backslash, the quote, and control chars.
function jsEscape(s: string, quote: string): string {
    return s.replace(/\\/g, '\\\\').replace(new RegExp(quote, 'g'), '\\' + quote)
        .replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r')
}

// Re-encode for a template literal: escape backslash, backtick, and `${` (Silicon's
// `${…}` object literal must not read as a JS interpolation). Real newlines stay.
function tlEscape(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
}

function main() {
    const argv = process.argv.slice(2)
    const write = argv.includes('--write')
    const files = argv.filter((a) => a !== '--write')
    const stats: Stat[] = []

    for (const f of files) {
        const src = readFileSync(f, 'utf8')
        const stat: Stat = { file: f, migrated: 0, skipped: [] }
        const out = f.endsWith('.md') ? processMarkdown(src, stat) : processTestTs(src, stat)
        if (write && out !== src) writeFileSync(f, out)
        stats.push(stat)
    }

    let totMig = 0, totSkip = 0
    console.error(`\nADR 0020 embedded migration (${write ? 'WRITE' : 'dry-run'})`)
    console.error('─'.repeat(64))
    for (const s of stats) {
        if (s.migrated === 0 && s.skipped.length === 0) continue
        totMig += s.migrated; totSkip += s.skipped.length
        console.error(`${s.file}: ${s.migrated} migrated, ${s.skipped.length} skipped`)
        for (const sk of s.skipped) console.error(`   ⚠ ${sk.reason}\n      ${sk.snippet}`)
    }
    console.error('─'.repeat(64))
    console.error(`${totMig} snippets migrated, ${totSkip} skipped${write ? '' : ' (dry-run: nothing written)'}`)
}

main()
