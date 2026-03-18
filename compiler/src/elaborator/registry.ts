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

/**
 * Central registry mapping operator/keyword symbols to StrataNode semantics
 */
export interface ElaboratorRegistry {
    operators: Record<string, StrataNode>    // "+" → StrataNode
    keywords: Record<string, StrataNode>     // "@fn" → StrataNode (future)
}

/**
 * Create a new empty elaborator registry
 * Initially populated with builtins via registerElaborator calls
 */
export function createElaboratorRegistry(): ElaboratorRegistry {
    return {
        operators: {},
        keywords: {}
    }
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
 * Look up the semantic definition for an operator
 *
 * @param registry - The registry to search
 * @param symbol - The operator symbol (e.g., "+")
 * @returns StrataNode if found, undefined otherwise
 */
export function lookupOperator(
    registry: ElaboratorRegistry,
    symbol: string
): StrataNode | undefined {
    return registry.operators[symbol]
}

/**
 * Look up the semantic definition for a keyword
 *
 * @param registry - The registry to search
 * @param name - The keyword name (e.g., "@fn")
 * @returns StrataNode if found, undefined otherwise
 */
export function lookupKeyword(
    registry: ElaboratorRegistry,
    name: string
): StrataNode | undefined {
    return registry.keywords[name]
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
        keywords: { ...target.keywords, ...source.keywords }
    }
}
