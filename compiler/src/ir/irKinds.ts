/**
 * IR Kind Registry
 *
 * IR kinds classify what *compiler construct* a definition keyword (@let, @fn, …)
 * or metadata annotation (@export) produces.  They live at the IR level — not the
 * WASM level — because they drive the IR lowering phase, not instruction selection.
 *
 * Strata bodies reference these as `IR::def_function`, `IR::meta_export`, etc.
 * The `IR::` namespace is intentionally distinct from `WASM::` to make it clear
 * that these entries never emit a WASM instruction directly.
 *
 * Future backends (native, LLVM, …) would map the same IRKind to their own
 * target-specific constructs, with the `WASM::` intrinsics table untouched.
 */

import type { CodegenKind } from '../elaborator/defkinds'

export interface IRKind {
    /** Fully-qualified name, e.g. 'IR::def_function'. */
    name: string
    /** The CodegenKind that the elaborator stamps on matching Definition nodes. */
    codegenKind: CodegenKind
    description: string
}

export const irKinds: Record<string, IRKind> = {
    // -------------------------------------------------------------------------
    // Definition kinds — drive how @let / @fn / @var / … are lowered
    // -------------------------------------------------------------------------
    def_function:      { name: 'IR::def_function',      codegenKind: 'function',       description: 'Def-kind: function (@let, @fn)' },
    def_global:        { name: 'IR::def_global',        codegenKind: 'global',         description: 'Def-kind: mutable global (@var)' },
    def_extern:        { name: 'IR::def_extern',        codegenKind: 'extern',         description: 'Def-kind: import (@extern)' },
    def_type_alias:    { name: 'IR::def_type_alias',    codegenKind: 'type_alias',     description: 'Def-kind: transparent type alias (@type_alias)' },
    def_type_distinct: { name: 'IR::def_type_distinct', codegenKind: 'type_distinct',  description: 'Def-kind: opaque distinct type (@type_distinct)' },
    def_type_sum:      { name: 'IR::def_type_sum',      codegenKind: 'type_sum',       description: 'Def-kind: payload-free sum type (@enum / @type_sum)' },
    def_type_record:   { name: 'IR::def_type_record',   codegenKind: 'type_record',    description: 'Def-kind: sum type with variant payloads (@type)' },
    def_local:         { name: 'IR::def_local',         codegenKind: 'local',          description: 'Def-kind: block-local variable (@local)' },

    // -------------------------------------------------------------------------
    // Metadata kinds — non-value-producing annotations lowered to module directives
    // -------------------------------------------------------------------------
    meta_export:    { name: 'IR::meta_export',    codegenKind: 'export',    description: 'Metadata: explicit export declaration (@export)' },
    meta_platform:  { name: 'IR::meta_platform',  codegenKind: 'platform',  description: 'Metadata: platform declaration (@platform) — no WAT emitted' },
}

export function isIRKind(name: string): boolean {
    const m = name.match(/^IR::(.+)$/)
    return m != null && m[1] in irKinds
}

export function getIRKind(name: string): IRKind | undefined {
    const m = name.match(/^IR::(.+)$/)
    if (!m) return undefined
    return irKinds[m[1]]
}
