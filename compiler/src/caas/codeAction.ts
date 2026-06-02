// SPDX-License-Identifier: MIT
/**
 * Code action / quick-fix API surface (story CaaS-11).
 *
 * A CodeAction takes a Diagnostic and produces zero or more TextEdits
 * that fix it.  Foundational for "press ⌘+. to fix this error" IDE
 * workflows.
 *
 * Design:
 *
 *   - A `CodeActionProvider` is a pure function `Diagnostic → CodeAction[]`.
 *     It inspects the diagnostic's `code` and `span` and decides what
 *     edits (if any) would resolve it.
 *
 *   - Providers register against diagnostic codes via `registerCodeAction`.
 *     The registry is a small map keyed by code (e.g. `'E0004'` for
 *     undefined-name); dispatch is O(1).
 *
 *   - `getCodeActions(diagnostic, source)` walks the registry, runs every
 *     provider that matches the diagnostic's code, and returns the
 *     concatenated result.  Pure — no I/O, no parsing in the hot path.
 *
 * The 1.0 surface ships:
 *
 *   - The types (`CodeAction`, `TextEdit`, `CodeActionProvider`).
 *   - The registry (`registerCodeAction`, `getCodeActions`,
 *     `clearCodeActions`).
 *   - One built-in provider — undefined-name suggestion → rename edit —
 *     as a proof-of-concept that strata authors can mirror.
 *
 * Things that are explicitly v1.x:
 *
 *   - Multi-file edits.  At 1.0 every TextEdit lives in the same source
 *     as the diagnostic.
 *   - Workspace-level refactorings (rename-all, extract-function).
 *   - Interactive previews (LSP `CodeAction.command`).
 *
 * @public — Silicon 1.0 stable.
 */

import type { Diagnostic, SourceSpan } from '../errors/diagnostic'

/**
 * A pure text edit: replace bytes `[start, end)` in `file` with `newText`.
 * Spans use the same 1-based line/col convention as `SourceSpan`.  `end`
 * is exclusive; `end == start` is a pure insertion.
 *
 * @public
 */
export interface TextEdit {
    readonly span: SourceSpan
    readonly newText: string
}

/**
 * A user-visible fix attached to a diagnostic.  `title` is what an IDE
 * surfaces in the lightbulb menu; `edits` is what gets applied.
 *
 * `kind` mirrors the LSP CodeActionKind convention — `quickfix` for
 * fixes that resolve a specific diagnostic, `refactor` for behavior-
 * preserving rewrites, `source` for source-only actions (organize
 * imports, etc.).  1.0 only the `quickfix` kind is documented; the
 * other two are reserved.
 *
 * @public
 */
export interface CodeAction {
    readonly title: string
    readonly kind: 'quickfix' | 'refactor' | 'source'
    readonly edits: readonly TextEdit[]
    /** The diagnostic this action resolves (or empty for source actions). */
    readonly diagnostics: readonly Diagnostic[]
    /**
     * The diagnostic code this action is registered under (e.g. `'E0004'`).
     * Stamped automatically by `getCodeActions` — callers do not need to set it.
     */
    readonly diagnosticCode?: string
    /** True if this action should be offered as the default when the user
     *  invokes the action menu and only this action is offered. */
    readonly isPreferred?: boolean
}

/**
 * A provider sees a single Diagnostic + the source text it lives in
 * and returns zero or more CodeActions.  Pure function; no side effects.
 *
 * @public
 */
export type CodeActionProvider = (
    diagnostic: Diagnostic,
    source: string,
) => readonly CodeAction[]

// ---------------------------------------------------------------------------
// Registry — keyed by diagnostic code
// ---------------------------------------------------------------------------

const REGISTRY: Map<string, CodeActionProvider[]> = new Map()

/**
 * Register a provider against a diagnostic code.  Multiple providers may
 * register for the same code; all run on dispatch and their actions are
 * concatenated.
 *
 * Strata authors can call this from `&Compiler::on::module_finalize`
 * (or any TypeScript module init); the registration persists for the
 * process lifetime.
 *
 * @public
 */
export function registerCodeAction(code: string, provider: CodeActionProvider): void {
    const existing = REGISTRY.get(code)
    if (existing) existing.push(provider)
    else REGISTRY.set(code, [provider])
}

/**
 * Look up every action for `diagnostic` against `source`.  Returns the
 * concatenated, dedup-by-title result.
 *
 * @public
 */
export function getCodeActions(diagnostic: Diagnostic, source: string): CodeAction[] {
    const providers = REGISTRY.get(diagnostic.code)
    if (!providers || providers.length === 0) return []
    const out: CodeAction[] = []
    const seen = new Set<string>()
    for (const p of providers) {
        for (const a of p(diagnostic, source)) {
            const key = `${a.kind}:${a.title}`
            if (seen.has(key)) continue
            seen.add(key)
            // Stamp the diagnostic code so callers can correlate actions to codes.
            out.push({ ...a, diagnosticCode: diagnostic.code })
        }
    }
    return out
}

/**
 * Return all diagnostic codes that have at least one registered provider.
 * Useful for advertising "this language server can fix E0004, E0007, …" in
 * LSP `ServerCapabilities.codeActionProvider.resolveProvider`.
 *
 * @public
 */
export function listCodeActionCodes(): string[] {
    return [...REGISTRY.keys()]
}

/**
 * Test helper — wipe the registry.  In production code, providers
 * register once at startup; tests register against single codes and
 * `clearCodeActions()` between cases.
 *
 * @public
 */
export function clearCodeActions(): void {
    REGISTRY.clear()
}

// ---------------------------------------------------------------------------
// Edit application — convenience for callers who want to apply edits
// ---------------------------------------------------------------------------

/**
 * Apply a set of TextEdits to a source string and return the rewritten
 * source.  Edits are applied bottom-up by `(line, col)` so earlier edits
 * don't shift later ones.  Edits with overlapping ranges throw.
 *
 * Useful for CLI fix-it commands (`sgl fix`); IDEs apply edits via the
 * LSP wire protocol directly and don't need this helper.
 *
 * @public
 */
export function applyEdits(source: string, edits: readonly TextEdit[]): string {
    if (edits.length === 0) return source

    // Build a flat list of (offset, end-offset, newText) tuples.
    const lines = source.split('\n')
    const lineOffsets: number[] = [0]
    for (let i = 0; i < lines.length; i++) {
        lineOffsets.push(lineOffsets[i] + lines[i].length + 1)
    }

    function lineColToOffset(line: number, col: number): number {
        const base = lineOffsets[line - 1] ?? source.length
        return base + (col - 1)
    }

    const flat = edits.map(e => ({
        start: lineColToOffset(e.span.line, e.span.col),
        end:   lineColToOffset(e.span.line, e.span.col) + e.span.length,
        text:  e.newText,
    }))

    // Sort descending by `start` so applying one doesn't shift the rest.
    flat.sort((a, b) => b.start - a.start)

    // Reject overlaps — two edits whose [start, end) ranges intersect.
    for (let i = 0; i < flat.length - 1; i++) {
        const cur = flat[i]
        const next = flat[i + 1]
        if (next.end > cur.start) {
            throw new Error(`applyEdits: overlapping edits at offsets [${next.start}, ${next.end}) and [${cur.start}, ${cur.end})`)
        }
    }

    let out = source
    for (const e of flat) {
        out = out.slice(0, e.start) + e.text + out.slice(e.end)
    }
    return out
}

// ---------------------------------------------------------------------------
// Built-in providers (proof of concept; strata authors can mirror)
// ---------------------------------------------------------------------------

/**
 * E0004 (UnboundIdentifier) — when the diagnostic's hint carries a
 * "did you mean X?" suggestion, offer a quickfix that replaces the
 * offending span with X.
 *
 * Wired by the elaborator's diagnostic builder: the `hint` field is
 * `did you mean '<suggestion>'?` and we extract the suggestion via a
 * one-shot regex.
 *
 * @internal — the public re-export lives in caas/index.ts
 */
export const E0004_renameProvider: CodeActionProvider = (diag, _source) => {
    if (diag.code !== 'E0004' || !diag.hint) return []
    const m = diag.hint.match(/did you mean ['"]([^'"]+)['"]/i)
    if (!m) return []
    const suggestion = m[1]
    return [{
        title: `Rename to '${suggestion}'`,
        kind: 'quickfix',
        edits: [{
            span: diag.span,
            newText: suggestion,
        }],
        diagnostics: [diag],
        isPreferred: true,
    }]
}

// Register the built-in on module load.
registerCodeAction('E0004', E0004_renameProvider)
