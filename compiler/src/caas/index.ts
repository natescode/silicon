// SPDX-License-Identifier: MIT
/**
 * Silicon Compiler-as-a-Service (CaaS) — public API.
 *
 * @public — Silicon 1.0 stable.  Import from `src/api.ts` (or the published
 * package root), not directly from this file.  All names re-exported from
 * `src/api.ts` are covered by the 1.0 stability promise; `_`-prefixed
 * members are `@internal` pipeline contracts subject to change.
 *
 * Stable, composable entry points for each pipeline phase.
 * All functions are pure: they never throw on user errors — failures are
 * captured as Diagnostic records in the result.
 *
 * Typical usage:
 *
 *   import { parse, elaborate, typecheck, lower, buildRegistry } from 'sigil/caas'
 *
 *   const { tree, diagnostics: parseErrs } = parse(source)
 *   const reg   = buildRegistry(tree)
 *   const { tree: elab, diagnostics: elabErrs } = elaborate(tree, reg)
 *   const { model, diagnostics: typeErrs }  = typecheck(elab, reg)
 *   const { wat,   diagnostics: lowerErrs } = lower(elab, reg, model)
 *
 * Stability contract: docs/stability.md §2.
 */

import { parseProgramWithExtents } from '../parser/parser'
import { buildPositionTable } from '../ast/positionTable'
import { astChildren } from '../ast/astChildren'
import { SyntaxNode } from './syntaxNode'
export { SyntaxNode }
import {
    incrementalReparse, damageFromText, damageFromChanges, stableStringify,
    type GreenIndex, type ElementReuse,
} from './incremental'
export type { GreenIndex, ElementReuse }
import elaborateInternal from '../elaborator/elaborator'
import { buildStrataRegistry } from '../elaborator/strataLoader'
import typecheckInternal, { type FunctionSig } from '../types/typechecker'
import { compileToWat, compileToWasm } from '../codegen'
import { toDiagnostic } from '../errors/diagnostic'
import type { Program, ASTNode } from '../ast/astNodes'
import type { ElaboratorRegistry } from '../elaborator/registry'
import type { ModuleRegistry } from '../modules/registry'
import type { LowerOptions as InternalLowerOptions } from '../ir/lower'

export type { ModuleRegistry }

// Re-export stable types that consumers need.
export type { Diagnostic, SourceSpan, Phase } from '../errors/diagnostic'
export type { SemanticModel, Symbol as CaaSSymbol, SymbolKind, SourceRange } from '../ast/semanticModel'
export type { SiliconType } from '../types/types'
export type { ElaboratorRegistry }

// CaaS-11 — CodeAction surface.  Re-exported as part of the 1.0 stable API.
export type { CodeAction, CodeActionProvider, TextEdit } from './codeAction'
export { registerCodeAction, getCodeActions, clearCodeActions, applyEdits, listCodeActionCodes } from './codeAction'

// CaaS-2f — SyntaxWalker / SyntaxRewriter.
export { SyntaxWalker, SyntaxRewriter } from './syntaxWalker'

// CaaS-2e — Trivia.
export type { TriviaItem } from './syntaxNode'

// Incremental text changes — range-based edits that can span line boundaries.
export type { TextChange } from './textChange'
export { applyTextChanges } from './textChange'
import { applyTextChanges } from './textChange'

// ---------------------------------------------------------------------------
// SyntaxTree — thin wrapper around Program that carries the source text.
// ---------------------------------------------------------------------------

/**
 * Immutable wrapper around a parsed Silicon program.
 *
 * Acts as the currency between pipeline stages. The `withText` method
 * re-parses new source without rebuilding the strata registry — the typical
 * incremental-edit path for an LSP or REPL:
 *
 *   const reg = buildRegistry(initialTree)
 *   // ... user edits source ...
 *   const { tree: newTree } = initialTree.withText(editedSource)
 *   const { tree: elab } = elaborate(newTree, reg)   // registry reused
 */
export class SyntaxTree {
    /** The underlying AST. Pass this tree between pipeline stages. */
    readonly program: Program
    /** Original source text this tree was built from. */
    readonly source: string
    /** File name used for diagnostic spans. */
    readonly file: string

    constructor(program: Program, source: string, file = '<input>', greenIndex?: GreenIndex) {
        this.program = program
        this.source = source
        this.file = file
        this.#greenIndex = greenIndex
    }

    #root?: SyntaxNode

    /**
     * Per-top-level-element byte extents, present only on trees built by a clean
     * `parse()` (CaaS tracker 3b).  Enables `withText`/`withChanges` to reuse
     * unchanged elements instead of full-reparsing.  `@internal`.
     */
    readonly #greenIndex?: GreenIndex

    /** @internal Per-element byte extents (the GreenIndex), for incremental semantics. */
    get _extents(): GreenIndex | undefined {
        return this.#greenIndex
    }

    /**
     * The root of the syntax tree.
     *
     * Use this to walk or query nodes without accessing the unstable `program`
     * field directly.  The root `SyntaxNode` is built lazily and cached.
     *
     *   for (const node of tree.root.descendantsOfKind('Definition')) {
     *       console.log(node.kind, node.span)
     *   }
     */
    get root(): SyntaxNode {
        if (!this.#root) {
            // M3: a PositionTable resolves element-relative spans (relSpan +
            // elemBase) for the wrapper nodes' `.span`.
            const positions = buildPositionTable(this.program, this.source)
            this.#root = new SyntaxNode(this.program as object, undefined, positions)
        }
        return this.#root
    }

    /**
     * Re-parse `newSource` and return a fresh `ParseResult`.
     *
     * The registry is NOT rebuilt — callers pass the existing registry to
     * `elaborate()` for an incremental update.  Strata definitions added or
     * removed in `newSource` will be invisible until `buildRegistry` is called
     * again, which is acceptable for the common editor-edit path where strata
     * don't change.
     */
    withText(newSource: string, options: ParseOptions = {}): ParseResult {
        return this.#reparse(newSource, () => damageFromText(this.source, newSource), options)
    }

    /**
     * Apply a set of range-based `TextChange`s to this tree's source and
     * return a fresh `ParseResult` for the rewritten text.
     *
     * Changes are applied bottom-up so they don't shift each other's offsets.
     * The file name is preserved; the strata registry is not rebuilt.
     *
     * This is the incremental-edit primitive for LSP `textDocument/didChange`
     * integration:
     *
     *   ws.onDidChange(({ document }) => {
     *       const { tree } = document.tree.withChanges(lspChanges)
     *       // ... re-elaborate with the existing registry ...
     *   })
     *
     * Throws if any two changes have overlapping ranges.
     */
    withChanges(changes: readonly import('./textChange').TextChange[], options: ParseOptions = {}): ParseResult {
        const newSource = applyTextChanges(this.source, changes)
        return this.#reparse(newSource, () => damageFromChanges(this.source, changes), options)
    }

    /**
     * Shared incremental-reparse path for `withText`/`withChanges` (CaaS 3b).
     *
     * Tries to reuse unchanged top-level elements via `incrementalReparse`; on
     * any miss (no green index, no computable damage match, fragment boundary
     * change, or a parse error in the window) it falls back to a full `parse()`
     * so the result is always identical to a non-incremental reparse.
     *
     * When `SIGIL_INCREMENTAL_VERIFY=1`, the incremental tree is compared
     * node-for-node against a full reparse and discarded on any mismatch.
     */
    #reparse(newSource: string, computeDamage: () => ReturnType<typeof damageFromText>, options: ParseOptions): ParseResult {
        const file = options.file ?? this.file
        if (this.#greenIndex !== undefined) {
            const damage = computeDamage()
            if (damage === null) {
                // Identical source — reuse the existing program + index verbatim
                // (every element group is reused, unshifted).
                const reuse: ElementReuse[] = this.#greenIndex.map((_, i) => ({ kind: 'reused', oldGroupIndex: i, delta: 0 }))
                // Diagnostics are derived from the tree, so a reused ParseError
                // element (recovery) keeps its (re-based) diagnostic.
                return { tree: new SyntaxTree(this.program, newSource, file, this.#greenIndex), diagnostics: collectParseDiagnostics(this.program, newSource, file), _elementReuse: reuse }
            }
            const result = incrementalReparse(this.source, this.#greenIndex, newSource, damage)
            if (result !== null) {
                let { program, extents, reuse } = result
                if (incrementalVerifyEnabled()) {
                    const fullParsed = parseProgramWithExtents(newSource)
                    if (stableStringify(program) !== stableStringify(fullParsed.program)) {
                        // Discarded — the reuse diff no longer describes the tree.
                        return { tree: new SyntaxTree(fullParsed.program, newSource, file, fullParsed.extents), diagnostics: collectParseDiagnostics(fullParsed.program, newSource, file) }
                    }
                }
                return { tree: new SyntaxTree(program, newSource, file, extents), diagnostics: collectParseDiagnostics(program, newSource, file), _elementReuse: reuse }
            }
        }
        // Fallback: full reparse (also produces proper diagnostics on syntax errors).
        return parse(newSource, { file, ...options })
    }
}

/** Whether the `SIGIL_INCREMENTAL_VERIFY` correctness tripwire is enabled. */
function incrementalVerifyEnabled(): boolean {
    return typeof process !== 'undefined' && process.env?.SIGIL_INCREMENTAL_VERIFY === '1'
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

import type { Diagnostic } from '../errors/diagnostic'

export interface ParseResult {
    readonly tree: SyntaxTree
    readonly diagnostics: readonly Diagnostic[]
    /**
     * @internal Per-element reuse classification when this tree came from an
     * incremental reparse (`withText`/`withChanges`), aligned with
     * `tree._extents`.  Undefined for full parses / fallbacks — drives
     * incremental elaboration + typecheck in the Workspace.
     */
    readonly _elementReuse?: readonly ElementReuse[]
}

export interface ElabResult {
    readonly tree: SyntaxTree
    readonly registry: ElaboratorRegistry
    readonly diagnostics: readonly Diagnostic[]
}

export interface CheckResult {
    readonly tree: SyntaxTree
    readonly model: import('../ast/semanticModel').SemanticModel
    readonly diagnostics: readonly Diagnostic[]
    /**
     * @internal — function signature map; not part of the stable public API.
     * Pass this to `lower()` via `options._functions` to avoid a second
     * typecheck pass, or use it directly with `compileToWasm`.
     */
    readonly _functions: Map<string, FunctionSig>
}

export interface LowerResult {
    readonly wat: string
    readonly diagnostics: readonly Diagnostic[]
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ParseOptions {
    /** Source file name for span reporting. Defaults to '<input>'. */
    file?: string
}

export interface ElabOptions {
    /** Extra Silicon source strings whose strata definitions are merged in. */
    extraSources?: string[]
}

export interface CheckOptions {
    /**
     * Module registry built from `loadModules()`.  When provided, module
     * function signatures (e.g. `wasi_snapshot_preview1::fd_write`) are
     * pre-registered so call sites type-check correctly.
     */
    moduleRegistry?: ModuleRegistry

    /**
     * Phase 9d-5 — compile target.  When `'wasm-gc'`, the typechecker
     * rejects mvp-only primitive calls (E0012 introspection,
     * E0013 physical-byte) per ADR 0009's two-layer portability split.
     * Defaults to `'host'` (no rejection — programs compile as today).
     */
    target?: import('../ir/lower').LowerTarget

    /**
     * CaaS-2g — cross-document typechecking.
     *
     * A map of `name → SiliconType` for symbols defined in other open
     * documents.  When the typechecker cannot resolve a name locally, it
     * falls back to this map before emitting an "unbound identifier" error.
     *
     * The `Workspace` populates this automatically from its symbol index
     * before calling `typecheck()` on each document.  Single-document
     * callers can ignore this option.
     */
    externalSymbols?: ReadonlyMap<string, import('../types/types').SiliconType>
}

export interface LowerOptions extends InternalLowerOptions {
    /**
     * Module registry — required for programs that use WASI or other
     * registered module APIs.  Build with `loadModules(dir)` in the CLI.
     */
    moduleRegistry?: ModuleRegistry
    /**
     * @internal — pre-computed function signatures from a prior typecheck call.
     * When provided, `lower()` skips its internal re-typecheck pass.
     */
    _functions?: Map<string, FunctionSig>
    /**
     * When true, `compile()` also assembles the `.wasm` binary (via
     * `compileToWasm`) and returns it as `CompileResult.binary`.  Off by
     * default so callers that only want WAT don't pay the assembly cost.
     */
    emitBinary?: boolean
}

// ---------------------------------------------------------------------------
// parse()
// ---------------------------------------------------------------------------

/**
 * Parse Silicon source into a SyntaxTree.
 *
 * Never throws. Parse failures are captured as Diagnostic records with
 * phase='parse'.
 */
export function parse(source: string, options: ParseOptions = {}): ParseResult {
    const file = options.file ?? '<input>'
    try {
        // Parse with per-element byte extents so the resulting tree can drive
        // incremental reparses (CaaS tracker 3b).  The parser recovers from a
        // syntax error by emitting a ParseError element, so the well-formed
        // elements survive; diagnostics are derived from those ParseError nodes.
        const { program, extents } = parseProgramWithExtents(source)
        const tree = new SyntaxTree(program, source, file, extents)
        return { tree, diagnostics: collectParseDiagnostics(program, source, file) }
    } catch (err) {
        // Defensive: recovery itself failed (should not happen).  Fall back to a
        // minimal valid tree so callers don't have to null-check.
        const msg = err instanceof Error ? err.message : String(err)
        const diag: Diagnostic = {
            phase: 'parse',
            code: 'E0000',
            span: { file, line: 1, col: 1, length: 0 },
            message: msg,
        }
        const emptyTree = new SyntaxTree(
            { type: 'Program', elements: [], source } as unknown as Program,
            source,
            file,
        )
        return { tree: emptyTree, diagnostics: [diag] }
    }
}

/**
 * Derive parse diagnostics from the `ParseError` nodes the recovering parser
 * left in the tree.  Positions are reconstructed via the {@link PositionTable}
 * (element `elemBase` + node `relSpan`), so a ParseError node reused verbatim in
 * an incrementally-reparsed prefix/suffix keeps a correct, re-based span.
 */
export function collectParseDiagnostics(program: Program, source: string, file: string): Diagnostic[] {
    const out: Diagnostic[] = []
    let positions: import('../ast/positionTable').PositionTable | undefined
    const walk = (n: any): void => {
        if (n === null || typeof n !== 'object') return
        if (n.type === 'ParseError') {
            positions ??= buildPositionTable(program, source)
            const span = positions.spanOf(n, file)
            // Reconstruct the canonical message from the current span so a reused,
            // shifted ParseError node reports its new line/col (not a stale one).
            out.push({
                phase: 'parse',
                code: 'E0000',
                span,
                message: `Parse error: Line ${span.line}, col ${span.col}: ${n.message}`,
            })
        }
        for (const c of astChildren(n)) walk(c)
    }
    for (const el of (program as any).elements ?? []) walk(el)
    return out
}

// ---------------------------------------------------------------------------
// buildRegistry()
// ---------------------------------------------------------------------------

/**
 * Build the strata registry from the tree's @stratum_* declarations.
 * Call this after parse() and before elaborate().
 */
export function buildRegistry(
    tree: SyntaxTree,
    extraSources: string[] = [],
): ElaboratorRegistry {
    return buildStrataRegistry(tree.program, extraSources)
}

// ---------------------------------------------------------------------------
// elaborate()
// ---------------------------------------------------------------------------

/**
 * Elaborate a parsed tree — resolves operators and keywords via the strata
 * registry.  Returns a new SyntaxTree with the elaborated program.
 *
 * Never throws. Elaboration errors are captured as Diagnostic records with
 * phase='elaborate'.
 */
export function elaborate(
    tree: SyntaxTree,
    registry: ElaboratorRegistry,
    _options: ElabOptions = {},
): ElabResult {
    const { program, registry: reg, errors } = elaborateInternal(tree.program, registry, [], _options.target)
    const elaboratedTree = new SyntaxTree(program, tree.source, tree.file)
    const diagnostics: Diagnostic[] = errors.map(e => ({
        phase: 'elaborate' as const,
        code: 'E0001',
        span: { file: '<input>', line: 1, col: 1, length: 0 },
        message: e.message,
        hint: e.keyword ? `while processing keyword '${e.keyword}'` : undefined,
    }))
    return { tree: elaboratedTree, registry: reg, diagnostics }
}

// ---------------------------------------------------------------------------
// typecheck()
// ---------------------------------------------------------------------------

/**
 * Type-check an elaborated tree.  Returns a SemanticModel with queryable
 * type/symbol information plus any diagnostics.
 *
 * Never throws.
 */
export function typecheck(
    tree: SyntaxTree,
    registry: ElaboratorRegistry,
    options: CheckOptions = {},
): CheckResult {
    // M3: resolve element-relative positions (relSpan + elemBase) into absolute
    // spans for the checker via a PositionTable built from this tree.
    const positions = buildPositionTable(tree.program, tree.source)
    const result = typecheckInternal(tree.program, registry, options.moduleRegistry, options.target, tree.file, options.externalSymbols, positions)
    const typedTree = new SyntaxTree(result.program, tree.source, tree.file)
    const diagnostics: Diagnostic[] = result.errors.map(e => toDiagnostic(e))
    return { tree: typedTree, model: result.semanticModel, diagnostics, _functions: result.functions }
}

// ---------------------------------------------------------------------------
// lower()
// ---------------------------------------------------------------------------

/**
 * Lower a type-checked tree to WAT.
 *
 * Never throws. Lowering errors are captured as Diagnostic records with
 * phase='lower'.
 */
export function lower(
    tree: SyntaxTree,
    registry: ElaboratorRegistry,
    model: import('../ast/semanticModel').SemanticModel,
    options: LowerOptions = {},
): LowerResult {
    try {
        // Use pre-computed functions when available (avoids a second typecheck pass).
        const functions = options._functions
            ?? typecheckInternal(tree.program, registry, options.moduleRegistry, options.target).functions
        const wat = compileToWat(
            tree.program,
            registry,
            functions,
            options.moduleRegistry,
            options,
            model,
        )
        return { wat, diagnostics: [] }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const diag: Diagnostic = {
            phase: 'lower',
            code: 'E0010',
            span: { file: '<input>', line: 1, col: 1, length: 0 },
            message: msg,
        }
        return { wat: '', diagnostics: [diag] }
    }
}

// ---------------------------------------------------------------------------
// compile() — convenience wrapper for the full pipeline
// ---------------------------------------------------------------------------

export interface CompileResult {
    readonly wat: string
    /** Assembled `.wasm` binary — present only when `options.emitBinary` is set. */
    readonly binary?: Uint8Array
    readonly model: import('../ast/semanticModel').SemanticModel | undefined
    readonly diagnostics: readonly Diagnostic[]
    /** ADR 0018 — `module.field` names of `@suspending`-marked extern imports
     *  (Binaryen `asyncify-imports` format).  The host reactor uses this to drive
     *  route-B precise coloring (Asyncify) or JSPI `Suspending` wrapping. */
    readonly suspendingImports?: readonly string[]
}

/** Collect the `module.field` import names of every suspending host import a
 *  program uses (the async-coloring boundary metadata, ADR 0018 §3 P2):
 *    - a direct `@suspending @extern` declaration (bare → `env.<field>`;
 *      namespaced `mod::field` → `mod.field`), and
 *    - a CALL to a `@suspending` binding of a generated module (`bun::fetch(…)`),
 *      looked up in the module registry — this is how the bindgen-generated async
 *      surface (Promise-returning APIs) reaches the reactor.
 *  Deduplicated; order-stable. */
export function collectSuspendingImports(program: any, moduleRegistry?: import('../modules/registry').ModuleRegistry): string[] {
    const out = new Set<string>()
    // (a) direct @suspending @extern declarations.
    for (const el of (program?.elements ?? []) as any[]) {
        const d = el?.type === 'Definition' ? el : (el?.value?.type === 'Definition' ? el.value : null)
        if (d && d.keyword === '@extern' && (d as any).suspending && d.name?.name) {
            const raw: string = d.name.name
            out.add(raw.includes('::') ? raw.replace('::', '.') : `env.${raw}`)
        }
    }
    // (b) calls to a @suspending binding of a generated module.
    if (moduleRegistry) {
        const walk = (n: any): void => {
            if (!n || typeof n !== 'object') return
            if (Array.isArray(n)) { n.forEach(walk); return }
            if (n.type === 'FunctionCall' && n.name?.type === 'Namespace' && Array.isArray(n.name.path) && n.name.path.length === 2) {
                const [mod, field] = n.name.path
                if (moduleRegistry.get(mod)?.functions.get(field)?.suspending) out.add(`${mod}.${field}`)
            }
            for (const k of Object.keys(n)) walk(n[k])
        }
        walk(program)
    }
    return [...out]
}

/**
 * Full pipeline: parse → elaborate → typecheck → lower (→ optional wasm binary).
 *
 * Returns at the first phase that produces diagnostics (errors).
 * On success, `wat` holds the emitted WAT text; when `options.emitBinary` is
 * set, `binary` additionally holds the assembled `.wasm`.
 */
export function compile(source: string, options: ParseOptions & ElabOptions & LowerOptions = {}): CompileResult {
    const parseResult = parse(source, options)
    if (parseResult.diagnostics.length > 0) {
        return { wat: '', model: undefined, diagnostics: parseResult.diagnostics }
    }

    const registry = buildRegistry(parseResult.tree, options.extraSources)
    const elabResult = elaborate(parseResult.tree, registry, options)
    if (elabResult.diagnostics.length > 0) {
        return { wat: '', model: undefined, diagnostics: elabResult.diagnostics }
    }

    const checkResult = typecheck(elabResult.tree, elabResult.registry, options)
    if (checkResult.diagnostics.length > 0) {
        return { wat: '', model: checkResult.model, diagnostics: checkResult.diagnostics }
    }

    const lowerResult = lower(checkResult.tree, elabResult.registry, checkResult.model, {
        ...options,
        _functions: checkResult._functions,
    })
    if (lowerResult.diagnostics.length > 0 || !options.emitBinary) {
        return { wat: lowerResult.wat, model: checkResult.model, diagnostics: lowerResult.diagnostics }
    }

    // emitBinary: assemble the .wasm from the same checked program.
    try {
        const binary = compileToWasm(
            checkResult.tree.program, elabResult.registry, checkResult._functions,
            options.moduleRegistry, options,
        )
        return {
            wat: lowerResult.wat, binary, model: checkResult.model, diagnostics: [],
            suspendingImports: collectSuspendingImports(checkResult.tree.program, options.moduleRegistry),
        }
    } catch (err) {
        const diag: Diagnostic = {
            phase: 'lower', code: 'E0010',
            span: { file: options.file ?? '<input>', line: 1, col: 1, length: 0 },
            message: err instanceof Error ? err.message : String(err),
        }
        return { wat: lowerResult.wat, model: checkResult.model, diagnostics: [diag] }
    }
}

// ---------------------------------------------------------------------------
// check() — front-end only (parse → elaborate → typecheck), no lowering
// ---------------------------------------------------------------------------

export interface CheckOnlyResult {
    readonly model: import('../ast/semanticModel').SemanticModel | undefined
    readonly diagnostics: readonly Diagnostic[]
}

/**
 * Front-end only: parse → elaborate → typecheck.  Returns at the first phase
 * that produces diagnostics.  Use this for `sgl check` / editor diagnostics
 * where no output artifact is needed.
 */
export function check(source: string, options: ParseOptions & ElabOptions & CheckOptions = {}): CheckOnlyResult {
    const parseResult = parse(source, options)
    if (parseResult.diagnostics.length > 0) return { model: undefined, diagnostics: parseResult.diagnostics }

    const registry = buildRegistry(parseResult.tree, options.extraSources)
    const elabResult = elaborate(parseResult.tree, registry, options)
    if (elabResult.diagnostics.length > 0) return { model: undefined, diagnostics: elabResult.diagnostics }

    const checkResult = typecheck(elabResult.tree, elabResult.registry, options)
    return { model: checkResult.model, diagnostics: checkResult.diagnostics }
}
