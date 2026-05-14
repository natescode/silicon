import type { IRExpr } from './nodes'

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
