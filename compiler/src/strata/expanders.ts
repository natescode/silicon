/**
 * Built-in IR Expanders
 *
 * Each entry maps a WASM::control_* / IR::control_* intrinsic to an IRExpanderFn
 * that emits the correct IR subtree. Registered into the ElaboratorRegistry by
 * strataLoader.ts so lower.ts never needs to be touched for new structural keywords.
 *
 * Each expander receives a CompilerAPI bound to the active lowering context,
 * accessed as `api.lowerExpr(node)`, `api.ctx.*`, `api.ir.*`. There is no
 * direct LowerCtx exposure — all context interaction goes through the API.
 *
 * To add a new structural keyword:
 *   1. Add a WASM::control_* entry to intrinsics.ts (or an IR::def_/IR::meta_ entry to irKinds.ts)
 *   2. Add a strata file entry (@stratum_keyword) referencing it
 *   3. Add an expander here
 *   4. No changes to lower.ts needed
 */

import type { IRExpanderFn } from '../ir/expander'
import type { IRExpr, WasmType } from '../ir/nodes'
import { IRLowerError } from '../ir/lower'
import { wasmTypeOf } from '../types/types'

// ---------------------------------------------------------------------------
// Built-in expanders
// ---------------------------------------------------------------------------

const expandIf: IRExpanderFn = (rawArgs, api) => {
    const [condN, thenN, elseN] = rawArgs
    const cond  = api.lowerExpr(condN)
    const then  = api.lowerExpr(thenN)
    const else_ = elseN ? api.lowerExpr(elseN) : undefined
    return api.ir.makeIf(cond, then, else_)
}

const expandLoop: IRExpanderFn = (rawArgs, api) => {
    const [condN, bodyN] = rawArgs
    const id = api.ctx.nextLoopId()
    api.ctx.loopStack.push(id)
    const cond = api.lowerExpr(condN)
    const body = api.lowerExpr(bodyN)
    api.ctx.loopStack.pop()
    return api.ir.makeLoop(id, cond, body)
}

const expandBreak: IRExpanderFn = (_rawArgs, api) => {
    const id = api.ctx.loopStack.peek()
    if (id === undefined) throw new IRLowerError('@break outside @loop')
    return api.ir.makeBreak(id)
}

const expandContinue: IRExpanderFn = (_rawArgs, api) => {
    const id = api.ctx.loopStack.peek()
    if (id === undefined) throw new IRLowerError('@continue outside @loop')
    return api.ir.makeContinue(id)
}

const expandReturn: IRExpanderFn = (rawArgs, api) => {
    const value = rawArgs[0] ? api.lowerExpr(rawArgs[0]) : undefined
    return api.ir.makeReturn(value)
}

const expandAnd: IRExpanderFn = (rawArgs, api) => {
    const [leftN, rightN] = rawArgs
    const left  = api.lowerExpr(leftN)
    const right = api.lowerExpr(rightN)
    return api.ir.makeIf(left, right, api.ir.makeConst(0, 'i32'), 'i32')
}

const expandOr: IRExpanderFn = (rawArgs, api) => {
    const [leftN, rightN] = rawArgs
    const left  = api.lowerExpr(leftN)
    const right = api.lowerExpr(rightN)
    return api.ir.makeIf(left, api.ir.makeConst(1, 'i32'), right, 'i32')
}

const expandMatch: IRExpanderFn = (rawArgs, api, inferredType) => {
    // @match disc, pat0, res0, pat1, res1, ...       — exhaustive, ends unreachable
    // @match disc, pat0, res0, pat1, res1, default   — trailing default (even total)
    //
    // Even arg count: last argument is a catch-all default with no pattern comparison.
    // Odd arg count: all arms are explicit; falls through to (unreachable).
    if (rawArgs.length < 3) return api.ir.makeNop()

    const discExpr = api.lowerExpr(rawArgs[0])
    const wt: WasmType = (inferredType && inferredType.kind !== 'Unknown')
        ? (wasmTypeOf(inferredType) as WasmType)
        : 'i32'

    function buildNested(i: number): IRExpr {
        // Past all arms — no default provided; fall to unreachable.
        if (i >= rawArgs.length) return api.ir.makeUnreachable()
        // Lone last item (no paired result) = trailing default / catch-all.
        if (i + 1 >= rawArgs.length) return api.lowerExpr(rawArgs[i])

        const pat = api.lowerExpr(rawArgs[i])
        const res = api.lowerExpr(rawArgs[i + 1])
        const eqInstr = api.resolveExprType(discExpr) === 'f32' ? 'f32.eq' : 'i32.eq'
        const cond = api.ir.makeBinOp(eqInstr, discExpr, pat, 'i32')
        return api.ir.makeIf(cond, res, buildNested(i + 2), wt)
    }

    return buildNested(1)
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const builtinExpanders: Record<string, IRExpanderFn> = {
    'IR::control_if':       expandIf,
    'IR::control_loop':     expandLoop,
    'IR::control_break':    expandBreak,
    'IR::control_continue': expandContinue,
    'IR::control_return':   expandReturn,
    'IR::control_and':      expandAnd,
    'IR::control_or':       expandOr,
    'IR::control_match':    expandMatch,
}
