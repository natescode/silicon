import type { IRExpr, IRGlobal, IRFunction, IRImport, IRExport } from './nodes'

/**
 * IR Expander — pluggable lowering hook for builtin keyword strata.
 *
 * A strata entry whose intrinsic has a registered IRExpanderFn bypasses the
 * generic `lowerBuiltinCall` default path and runs this function instead.
 * This lets new structural keywords (@async, @spawn, …) be added purely as
 * strata entries + expander registrations without touching lower.ts.
 *
 * Parameters:
 *   rawArgs      — un-lowered AST arg nodes; call `lower(node, ctx)` on each
 *   ctx          — LowerCtx from lower.ts (typed `any` to avoid circular import)
 *   lower        — recursive lowering fn; call it for each rawArg you need
 *   inferredType — SiliconType from the type checker (may be undefined)
 */
export type IRExpanderFn = (
    rawArgs: any[],
    ctx: any,
    lower: (node: any, ctx: any) => IRExpr,
    inferredType?: any,
) => IRExpr

/**
 * IR Definition Expander — pluggable lowering hook for definition keywords.
 *
 * Keyed by CodegenKind (e.g. 'type_sum'). Registered into the ElaboratorRegistry
 * so that `lowerDefinition` in lower.ts dispatches to the expander instead of
 * a hardcoded switch case. This makes definition kinds Strata-extensible: adding
 * a new @type_* or @def_* keyword requires only a new strata entry + a registered
 * IRDefExpander, with no changes to lower.ts.
 *
 * Two-phase protocol:
 *   preScan — optional; called before the main lowering pass so the expander
 *             can register globals/functions in ctx for forward-reference resolution.
 *   expand  — main lowering; return the IR node(s) to emit into the module.
 *             Return type matches what lowerProgram currently handles:
 *               IRGlobal[] (multiple globals, e.g. sum-type variants)
 *               IRGlobal | IRFunction | IRImport | IRExport (single node)
 *               null (no output, e.g. type aliases)
 */
export interface IRDefExpander {
    preScan?: (def: any, ctx: any) => void
    expand:   (def: any, name: string, ctx: any) => IRGlobal[] | IRGlobal | IRFunction | IRImport | IRExport | null
}
