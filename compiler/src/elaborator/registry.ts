// SPDX-License-Identifier: MIT
/**
 * Elaborator Registry
 *
 * Central lookup system for operator and keyword elaborators.
 * Operators are mapped to their semantic definitions (stored as AST bodies).
 *
 * Architecture:
 * - In-memory registry built at compiler startup
 * - All operators defined via @stratum blocks (builtins + user-defined)
 * - O(1) lookup by operator symbol or keyword name
 * - Registry is stateless per compilation (fresh registry for each compile)
 *
 * @example
 *   const registry = createElaboratorRegistry()
 *   registerElaborator(registry, 'operator', '+', strataPlusNode)
 *   const semantics = lookupOperator(registry, '+')
 */

import { type StrataNode } from './strataenum'
import { type DefKindRegistry, type DefKindEntry, createDefKindRegistry, lookupDefKind as _lookupDefKind } from './defkinds'
import type { IRExpanderFn, IRDefExpander } from '../ir/expander'
import type { Diagnostic } from '../errors/diagnostic'

// ─────────────────────────────────────────────────────────────────────────────
// @struct layout registry
// ─────────────────────────────────────────────────────────────────────────────

export interface StructFieldLayout {
    name: string
    typeName: string
    wasmType: 'i32' | 'f32' | 'i64'
    offset: number
    size: number
}

export interface StructLayout {
    name: string
    fields: StructFieldLayout[]
    size: number
}

/** Phase 9c-3a — `@type Foo := $A x:T | $B y:U;` layout descriptor.
 *  `maxFields` is the largest field count across all variants (pad-to-max).
 *  Each variant entry carries its declared field types in source order;
 *  the lowerer consults them to decide whether a value of `Foo` can be
 *  promoted by `&@move_to_parent_arena` (flat-payload) or has to be
 *  rejected as nested heap (`$Some s:String`). */
export interface SumLayout {
    name: string
    maxFields: number
    variants: { name: string; fieldTypes: import('../types/types').SiliconType[] }[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Strata 2.0 — Phase handler types
// ─────────────────────────────────────────────────────────────────────────────

/** Tier classification per Strata 2.0 §3. */
export type StratumTier = 'T0' | 'T1' | 'T2'

/** Phases a stratum handler can fire on (MVP subset). */
export type StratumPhase = 'decl' | 'callSite' | 'annotation' | 'lower' | 'moduleFinalize' | 'comptime'

/**
 * A compiled handler function. Receives the matching AST node and the live
 * CompilerAPI for the current compilation unit. Returns an IR node or null.
 * Import as `any` to avoid circular dependency with compiler-api.
 */
export type PhaseHandler = (node: any, api: any) => any

/**
 * A comptime handler — the function invoked when the strata body interpreter
 * encounters a registered keyword/operator in expression position.  Unlike
 * lowering handlers (which build IR), a comptime handler returns a JS-level
 * value: the result of evaluating the form at compile time.
 *
 * Receives raw AST args (unevaluated) plus an `evalArg` callback so the
 * handler can decide which args to evaluate and in what order.  This is
 * what makes lazy forms like `@if` expressible.
 */
export type ComptimeHandler = (rawArgs: any[], api: any, evalArg: (node: any) => any) => any

/** Per-stratum metadata for ordering and cycle detection. */
export interface StratumMeta {
    name: string
    tier: StratumTier
    /** Names of strata this one must fire BEFORE. */
    before: string[]
    /** Names of strata this one must fire AFTER. */
    after: string[]
}

/**
 * Central registry mapping operator/keyword symbols to StrataNode semantics
 * and definition keywords to Def-Kind descriptors.
 *
 * Strata 2.0 additions: per-phase handler maps, annotation registry,
 * stratum metadata, pending definitions from module::push_definition, and
 * an accumulated diagnostics list (runtime-trap model, T-5).
 */
export interface ElaboratorRegistry {
    operators: Record<string, StrataNode>    // "+" → StrataNode
    keywords: Record<string, StrataNode>     // "@fn" → StrataNode
    /** Annotation token → StrataNode (Strata 2.0 §5.1). */
    annotations: Record<string, StrataNode>
    defKinds: DefKindRegistry
    /** Intrinsic name → IR expander fn. */
    expanders: Map<string, IRExpanderFn>
    /** CodegenKind → IR definition expander. */
    defExpanders: Map<string, IRDefExpander>

    // ── Strata 2.0: phase handler tables ─────────────────────────────────────
    handlers: {
        /** Fires for each Definition node with keyword matching the registered token. */
        decl:           Map<string, PhaseHandler[]>
        /** Fires for each call-site expression matching the registered keyword token. */
        callSite:       Map<string, PhaseHandler[]>
        /** Fires when an annotation token is applied to a Definition. Second arg is the target def. */
        annotation:     Map<string, PhaseHandler[]>
        /** Fires during IR lowering for the registered keyword/operator token. */
        lower:          Map<string, PhaseHandler[]>
        /** Fires once at end of module walk — no token discrimination. */
        moduleFinalize: PhaseHandler[]
        /** Compile-time evaluation: token (operator or keyword) → handler.
         *  Single handler per token — comptime semantics is unambiguous by
         *  construction (unlike `on::lower` which can be observed). */
        comptime: Map<string, ComptimeHandler>
    }

    // ── Strata 2.0: metadata + cross-stratum composition ──────────────────────
    /** stratum name → StratumMeta (tier, ordering). */
    strata: Map<string, StratumMeta>

    // ── Strata 2.0: module::push_definition accumulator ───────────────────────
    /** Definitions emitted by module::push_definition, appended to the module. */
    pendingDefinitions: any[]

    // ── Strata 2.0: T-5 runtime-trap error model ──────────────────────────────
    /** Diagnostics accumulated by diag::error / diag::warn (never throws). */
    diagnostics: Diagnostic[]

    // ── Per-stratum state storage (state 'stratum' scope) ─────────────────────
    stratumState: Map<string, Map<string, any>>

    // ── @struct layout registry ────────────────────────────────────────────────
    structTypes: Map<string, StructLayout>

    // ── Phase 9c-3a — @type sum layout registry ────────────────────────────────
    //
    // Populated by the typechecker's `preRegisterRecordSumType` for every
    // `@type Foo := $A x:T | $B y:U;` declaration.  The lowerer reads it
    // when sizing values for `&@move_to_parent_arena` so flat-payload sums
    // can be promoted out of an `&@with_arena` block; nested-heap variants
    // (e.g. `$Some s:String`) are rejected with a structured error.
    //
    // Layout follows the constructor emit in `src/strata/defExpanders.ts`
    // (pad-to-max): `[tag:i32, field0:i32, …, field<maxFields-1>:i32]`.
    // Total size = 4 + 4 × maxFields.  Each variant's declared field types
    // (per-source-order index) carry through so the lower-time
    // "any field heap?" check is precise rather than conservative.
    sumLayouts: Map<string, SumLayout>

    // ── Dissolution Phase A: named-handler bodies ─────────────────────────────
    /** `@fn` body blocks keyed by function name.  Populated by a pre-pass
     *  over program elements so that strata handlers referencing `@fn` by
     *  name can find the body at fire time, regardless of source order.
     *  `paramName` is the @fn's first parameter name (typically 'node') so
     *  the body sees the triggering AST under the binding the author wrote.
     *
     *  Phase A bridge: the body is still interpreted via compileHandlerBlock.
     *  Phase C will swap interpretation for compile-then-run.  Either way,
     *  this map is the lookup point. */
    namedHandlers: Map<string, { body: any; paramName: string }>

    /** Names of `@fn`s that have been claimed as strata handlers.  Those
     *  bodies use `&Compiler::*` calls that have no runtime meaning, so
     *  the lowerer skips them — they exist only at compile-time as
     *  interpreted handler bodies.  Phase C will lower them as real WASM
     *  functions invoked through a comptime engine. */
    strataHandlerFnNames: Set<string>

    /** Phase C compiled-handler cache.  Populated by an opt-in async
     *  pre-compile pass (`compileStrataHandlers`).  When a handler fires,
     *  the wrapper checks this map first: if a compiled instance exists,
     *  it invokes the WASM function; otherwise it falls back to the
     *  interpreter.  Bridge pattern — both paths coexist until Phase D
     *  finishes migrating every strata to the compiled path. */
    compiledHandlers: Map<string, { invoke: (arg: number) => number }>
}

/**
 * Create a new empty elaborator registry.
 * Initially populated with builtins via registerElaborator calls.
 */
export function createElaboratorRegistry(): ElaboratorRegistry {
    return {
        operators: {},
        keywords: {},
        annotations: {},
        defKinds: createDefKindRegistry(),
        expanders: new Map(),
        defExpanders: new Map(),
        handlers: {
            decl:           new Map(),
            callSite:       new Map(),
            annotation:     new Map(),
            lower:          new Map(),
            moduleFinalize: [],
            comptime:       new Map(),
        },
        strata: new Map(),
        pendingDefinitions: [],
        diagnostics: [],
        stratumState: new Map(),
        namedHandlers: new Map(),
        strataHandlerFnNames: new Set(),
        compiledHandlers: new Map(),
        structTypes: new Map(),
        sumLayouts: new Map(),
    }
}

/** Register a `@fn` body as a candidate strata-handler target by name.  Called
 *  from a buildStrataRegistry pre-pass.  Last-write-wins on name collision —
 *  same convention as comptime handler registration. */
export function registerNamedHandler(
    registry: ElaboratorRegistry,
    name: string,
    body: any,
    paramName: string,
): void {
    registry.namedHandlers.set(name, { body, paramName })
}

/** Look up a named-handler entry by function name.  Returns undefined if the
 *  pre-pass didn't see a matching `@fn`. */
export function lookupNamedHandler(
    registry: ElaboratorRegistry,
    name: string,
): { body: any; paramName: string } | undefined {
    return registry.namedHandlers.get(name)
}

/**
 * Register a pluggable IR expander for a WASM intrinsic name.
 * When `lowerBuiltinCall` encounters a strata whose intrinsic matches,
 * it calls `fn` instead of the generic instruction-emission path.
 */
export function registerExpander(
    registry: ElaboratorRegistry,
    intrinsic: string,
    fn: IRExpanderFn,
): void {
    registry.expanders.set(intrinsic, fn)
}

/**
 * Register a pluggable IR definition expander for a CodegenKind.
 * When `lowerDefinition` encounters a definition with the matching hook,
 * it calls the expander instead of the hardcoded switch case.
 */
export function registerDefExpander(
    registry: ElaboratorRegistry,
    codegenKind: string,
    expander: IRDefExpander,
): void {
    registry.defExpanders.set(codegenKind, expander)
}

/**
 * Look up a Def-Kind entry by full keyword (e.g. "@let")
 */
export function lookupDefKindEntry(registry: ElaboratorRegistry, keyword: string): DefKindEntry | undefined {
    return _lookupDefKind(registry.defKinds, keyword)
}

/**
 * Register an elaborator (operator or keyword) in the registry
 * Later registrations override earlier ones for the same symbol
 *
 * @param registry - The registry to add to
 * @param type - 'operator' or 'keyword'
 * @param symbol - The operator symbol (e.g., "+") or keyword name (e.g., "@fn")
 * @param semantics - The StrataNode containing the semantic definition
 */
export function registerElaborator(
    registry: ElaboratorRegistry,
    type: 'operator' | 'keyword',
    symbol: string,
    semantics: StrataNode
): void {
    if (type === 'operator') {
        registry.operators[symbol] = semantics
    } else {
        registry.keywords[symbol] = semantics
    }
}

/**
 * Look up the semantic definition for an operator (primary / untyped entry).
 * For typed dispatch by operand type use lookupTypedOperator instead.
 */
export function lookupOperator(
    registry: ElaboratorRegistry,
    symbol: string
): StrataNode | undefined {
    return registry.operators[symbol]
}

/**
 * Register a type-specific overload under the compound key `${symbol}:${typeKind}`.
 * The primary entry (plain `symbol`) is managed separately by registerElaborator.
 */
export function registerTypedOperator(
    registry: ElaboratorRegistry,
    symbol: string,
    typeKind: string,
    node: StrataNode,
): void {
    registry.operators[`${symbol}:${typeKind}`] = node
}

/**
 * Type-driven operator lookup. Tries the compound key `${symbol}:${typeKind}` first,
 * then falls back to the plain primary entry. Callers pass `leftType.kind` (e.g.
 * `'Float'`, `'Int'`) as `typeKind`.
 */
export function lookupTypedOperator(
    registry: ElaboratorRegistry,
    symbol: string,
    typeKind: string,
): StrataNode | undefined {
    return registry.operators[`${symbol}:${typeKind}`] ?? registry.operators[symbol]
}

/**
 * Look up the semantic definition for a keyword (primary / untyped entry).
 * For typed dispatch by argument type use lookupTypedKeyword instead.
 */
export function lookupKeyword(
    registry: ElaboratorRegistry,
    name: string
): StrataNode | undefined {
    return registry.keywords[name]
}

/**
 * Register a type-specific keyword overload under the compound key `${name}:${typeKind}`.
 * The primary entry (plain `name`) is managed separately by registerElaborator.
 */
export function registerTypedKeyword(
    registry: ElaboratorRegistry,
    name: string,
    typeKind: string,
    node: StrataNode,
): void {
    registry.keywords[`${name}:${typeKind}`] = node
}

/**
 * Type-driven keyword lookup. Tries `${name}:${typeKind}` first, then falls
 * back to the plain primary entry. Callers pass the first argument's type kind
 * (e.g. `'Float'`, `'Int'`) as `typeKind`.
 */
export function lookupTypedKeyword(
    registry: ElaboratorRegistry,
    name: string,
    typeKind: string,
): StrataNode | undefined {
    return registry.keywords[`${name}:${typeKind}`] ?? registry.keywords[name]
}

/**
 * Get all registered operator symbols
 */
export function listOperators(registry: ElaboratorRegistry): string[] {
    return Object.keys(registry.operators)
}

/**
 * Get all registered keyword names
 */
export function listKeywords(registry: ElaboratorRegistry): string[] {
    return Object.keys(registry.keywords)
}

/**
 * Check if an operator is registered
 */
export function hasOperator(registry: ElaboratorRegistry, symbol: string): boolean {
    return symbol in registry.operators
}

/**
 * Check if a keyword is registered
 */
export function hasKeyword(registry: ElaboratorRegistry, name: string): boolean {
    return name in registry.keywords
}

/**
 * Merge one registry into another (source overwrites target for conflicts)
 * Useful for combining builtins + user elaborators
 */
export function mergeRegistries(target: ElaboratorRegistry, source: ElaboratorRegistry): ElaboratorRegistry {
    const mergeHandlerMap = (
        a: Map<string, PhaseHandler[]>,
        b: Map<string, PhaseHandler[]>,
    ): Map<string, PhaseHandler[]> => {
        const out = new Map(a)
        for (const [k, v] of b) out.set(k, [...(out.get(k) ?? []), ...v])
        return out
    }
    return {
        operators: { ...target.operators, ...source.operators },
        keywords: { ...target.keywords, ...source.keywords },
        annotations: { ...target.annotations, ...source.annotations },
        defKinds: { ...target.defKinds, ...source.defKinds },
        expanders: new Map([...target.expanders, ...source.expanders]),
        defExpanders: new Map([...target.defExpanders, ...source.defExpanders]),
        handlers: {
            decl:           mergeHandlerMap(target.handlers.decl, source.handlers.decl),
            callSite:       mergeHandlerMap(target.handlers.callSite, source.handlers.callSite),
            annotation:     mergeHandlerMap(target.handlers.annotation, source.handlers.annotation),
            lower:          mergeHandlerMap(target.handlers.lower, source.handlers.lower),
            moduleFinalize: [...target.handlers.moduleFinalize, ...source.handlers.moduleFinalize],
            comptime:       new Map([...target.handlers.comptime, ...source.handlers.comptime]),
        },
        strata:              new Map([...target.strata, ...source.strata]),
        pendingDefinitions:  [...target.pendingDefinitions, ...source.pendingDefinitions],
        diagnostics:         [...target.diagnostics, ...source.diagnostics],
        stratumState:        new Map([...target.stratumState, ...source.stratumState]),
        namedHandlers:       new Map([...target.namedHandlers, ...source.namedHandlers]),
        strataHandlerFnNames: new Set([...target.strataHandlerFnNames, ...source.strataHandlerFnNames]),
        compiledHandlers:    new Map([...target.compiledHandlers, ...source.compiledHandlers]),
        structTypes:         new Map([...target.structTypes, ...source.structTypes]),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Strata 2.0 — registration helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Register an annotation token in the registry. */
export function registerAnnotation(
    registry: ElaboratorRegistry,
    token: string,
    node: StrataNode,
): void {
    registry.annotations[token] = node
}

/** Register a phase handler for a token. Handlers accumulate (observer pattern). */
export function registerPhaseHandler(
    registry: ElaboratorRegistry,
    phase: Exclude<StratumPhase, 'moduleFinalize' | 'comptime'>,
    token: string,
    handler: PhaseHandler,
): void {
    const map = registry.handlers[phase] as Map<string, PhaseHandler[]>
    const existing = map.get(token) ?? []
    existing.push(handler)
    map.set(token, existing)
}

/** Register a module-finalize handler (no token). */
export function registerModuleFinalizeHandler(
    registry: ElaboratorRegistry,
    handler: PhaseHandler,
): void {
    registry.handlers.moduleFinalize.push(handler)
}

/** Register a comptime handler for an operator/keyword token.  Last
 *  registration wins (comptime semantics is unambiguous by design — a single
 *  evaluation rule per token).  Built-in handlers register first; user
 *  strata can override by registering later. */
export function registerComptimeHandler(
    registry: ElaboratorRegistry,
    token: string,
    handler: ComptimeHandler,
): void {
    registry.handlers.comptime.set(token, handler)
}

/** Look up the comptime handler for a token, if any. */
export function lookupComptimeHandler(
    registry: ElaboratorRegistry,
    token: string,
): ComptimeHandler | undefined {
    return registry.handlers.comptime.get(token)
}

/** Register stratum metadata (tier, ordering). */
export function registerStratumMeta(
    registry: ElaboratorRegistry,
    meta: StratumMeta,
): void {
    registry.strata.set(meta.name, meta)
}

/**
 * Fire all handlers registered for a given token under the given phase.
 * Returns an array of non-null results (handlers that return null/undefined
 * are excluded — they ran for side-effects only).
 *
 * When `stratumRef` is provided, each handler's `.__stratumName` is written
 * into it before invocation so that `api.state('stratum')` returns the
 * correct per-stratum bucket inside the handler.
 */
export function fireHandlers(
    registry: ElaboratorRegistry,
    phase: Exclude<StratumPhase, 'moduleFinalize'>,
    token: string,
    node: any,
    api: any,
    stratumRef?: { name: string },
): any[] {
    const handlers = (registry.handlers[phase] as Map<string, PhaseHandler[]>).get(token) ?? []
    const results: any[] = []
    for (const h of handlers) {
        const sName = (h as any).__stratumName ?? '__global__'
        if (stratumRef) stratumRef.name = sName
        // The compiled-engine `state('stratum')` primitive reads
        // registry.__currentStratum (it has no access to the lowerer's
        // threaded stratumRef), so set it here too — otherwise per-stratum
        // state always lands in the '__global__' bucket.
        ;(registry as any).__currentStratum = { name: sName }
        const r = h(node, api)
        if (r != null) results.push(r)
    }
    if (stratumRef) stratumRef.name = '__global__'
    ;(registry as any).__currentStratum = { name: '__global__' }
    return results
}

/** Fire all module-finalize handlers in registration order. */
export function fireModuleFinalizeHandlers(
    registry: ElaboratorRegistry,
    api: any,
    stratumRef?: { name: string },
): any[] {
    const results: any[] = []
    for (const h of registry.handlers.moduleFinalize) {
        const sName = (h as any).__stratumName ?? '__global__'
        if (stratumRef) stratumRef.name = sName
        ;(registry as any).__currentStratum = { name: sName }
        const r = h(null, api)
        if (r != null) results.push(r)
    }
    if (stratumRef) stratumRef.name = '__global__'
    ;(registry as any).__currentStratum = { name: '__global__' }
    return results
}

/** Look up the per-stratum state bucket (creates it on first access). */
export function getStratumState(
    registry: ElaboratorRegistry,
    stratumName: string,
): Map<string, any> {
    if (!registry.stratumState.has(stratumName)) {
        registry.stratumState.set(stratumName, new Map())
    }
    return registry.stratumState.get(stratumName)!
}
