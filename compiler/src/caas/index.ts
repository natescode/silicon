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

import parseInternal from '../parser/parser'
import { addToAstSemantics } from '../ast'
import { siliconGrammar } from '../grammar'
import elaborateInternal from '../elaborator/elaborator'
import { buildStrataRegistry } from '../elaborator/strataLoader'
import typecheckInternal, { type FunctionSig } from '../types/typechecker'
import { compileToWat, compileToWasm } from '../codegen'
import { toDiagnostic } from '../errors/diagnostic'
import type { Program, ASTNode } from '../ast/astNodes'
import type { ElaboratorRegistry } from '../elaborator/registry'
import type { ModuleRegistry } from '../modules/registry'
import type { LowerOptions } from '../ir/lower'

export type { ModuleRegistry }

// Re-export stable types that consumers need.
export type { Diagnostic, SourceSpan, Phase } from '../errors/diagnostic'
export type { SemanticModel, Symbol as CaaSSymbol, SymbolKind, SourceRange } from '../ast/semanticModel'
export type { SiliconType } from '../types/types'
export type { ElaboratorRegistry }

// CaaS-11 — CodeAction surface.  Re-exported as part of the 1.0 stable API.
export type { CodeAction, CodeActionProvider, TextEdit } from './codeAction'
export { registerCodeAction, getCodeActions, clearCodeActions, applyEdits } from './codeAction'

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

    constructor(program: Program, source: string, file = '<input>') {
        this.program = program
        this.source = source
        this.file = file
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
        return parse(newSource, { file: this.file, ...options })
    }
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

import type { Diagnostic } from '../errors/diagnostic'

export interface ParseResult {
    readonly tree: SyntaxTree
    readonly diagnostics: readonly Diagnostic[]
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
}

export interface LowerOptions2 extends LowerOptions {
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
        const match = parseInternal(source)
        const ast = addToAstSemantics(siliconGrammar)(match).toAst()
        const tree = new SyntaxTree(ast as Program, source, file)
        return { tree, diagnostics: [] }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const diag: Diagnostic = {
            phase: 'parse',
            code: 'E0000',
            span: { file, line: 1, col: 1, length: 0 },
            message: msg,
        }
        // Return a minimal valid tree so callers don't have to null-check.
        const emptyTree = new SyntaxTree(
            { type: 'Program', elements: [], source } as unknown as Program,
            source,
            file,
        )
        return { tree: emptyTree, diagnostics: [diag] }
    }
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
    const { program, registry: reg, errors } = elaborateInternal(tree.program, registry)
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
    const result = typecheckInternal(tree.program, registry, options.moduleRegistry, options.target)
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
    options: LowerOptions2 = {},
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
}

/**
 * Full pipeline: parse → elaborate → typecheck → lower (→ optional wasm binary).
 *
 * Returns at the first phase that produces diagnostics (errors).
 * On success, `wat` holds the emitted WAT text; when `options.emitBinary` is
 * set, `binary` additionally holds the assembled `.wasm`.
 */
export function compile(source: string, options: ParseOptions & ElabOptions & LowerOptions2 = {}): CompileResult {
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
        return { wat: lowerResult.wat, binary, model: checkResult.model, diagnostics: [] }
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
