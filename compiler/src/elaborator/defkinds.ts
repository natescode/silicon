/**
 * Def-Kind Registry
 *
 * Def-Kinds categorize definition keywords (@let, @fn, @type, etc.) and describe
 * how the compiler should elaborate and lower them. Built-in Def-Kinds are
 * registered here; user-defined ones will use the same mechanism.
 *
 * Per the Silicon spec: "Built-in Def-Kinds are implemented using the same
 * mechanism as user-defined ones. There are no 'magic' keywords in the compiler."
 */

/**
 * What WAT construct a definition keyword lowers to.
 * 'function' → WAT (func ...), 'global' → WAT (global ...) mutable global.
 */
export type CodegenKind = 'function' | 'global' | 'local' | 'extern' | 'type_alias' | 'type_distinct' | 'type_sum'

export interface DefKindEntry {
    keyword: string          // full keyword, e.g. "@let"
    codegenKind: CodegenKind
    allowsParams: boolean
    allowsBinding: boolean
    allowsGenerics: boolean
}

export type DefKindRegistry = Record<string, DefKindEntry>

export function createDefKindRegistry(): DefKindRegistry {
    return {}
}

export function registerDefKind(reg: DefKindRegistry, entry: DefKindEntry): void {
    reg[entry.keyword] = entry
}

export function lookupDefKind(reg: DefKindRegistry, keyword: string): DefKindEntry | undefined {
    return reg[keyword]
}

