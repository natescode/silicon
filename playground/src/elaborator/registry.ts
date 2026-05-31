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

/**
 * Central registry mapping operator/keyword symbols to StrataNode semantics
 * and definition keywords to Def-Kind descriptors.
 */
export interface ElaboratorRegistry {
    operators: Record<string, StrataNode>    // "+" → StrataNode
    keywords: Record<string, StrataNode>     // "@fn" → StrataNode (future)
    defKinds: DefKindRegistry                // "@let" → DefKindEntry
    /** Intrinsic name → IR expander fn (bypasses the generic lowering path). */
    expanders: Map<string, IRExpanderFn>
    /** CodegenKind → IR definition expander (bypasses the lowerDefinition switch). */
    defExpanders: Map<string, IRDefExpander>
}

/**
 * Create a new empty elaborator registry
 * Initially populated with builtins via registerElaborator calls
 */
export function createElaboratorRegistry(): ElaboratorRegistry {
    return {
        operators: {},
        keywords: {},
        defKinds: createDefKindRegistry(),
        expanders: new Map(),
        defExpanders: new Map(),
    }
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
    return {
        operators: { ...target.operators, ...source.operators },
        keywords: { ...target.keywords, ...source.keywords },
        defKinds: { ...target.defKinds, ...source.defKinds },
        expanders: new Map([...target.expanders, ...source.expanders]),
        defExpanders: new Map([...target.defExpanders, ...source.defExpanders]),
    }
}
