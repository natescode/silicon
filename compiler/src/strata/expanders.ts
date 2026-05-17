/**
 * Built-in IR Expanders
 *
 * Each entry maps a WASM::control_* intrinsic to an IRExpanderFn that emits
 * the correct IR subtree.  Registered into the ElaboratorRegistry by
 * strataLoader.ts so lower.ts never needs to be touched for new structural keywords.
 *
 * To add a new structural keyword:
 *   1. Add a WASM::control_* entry to intrinsics.ts (or an IR::def_/IR::meta_ entry to irKinds.ts)
 *   2. Add a strata file entry (@stratum_keyword) referencing it
 *   3. Add an expander here
 *   4. No changes to lower.ts needed
 */

import type { IRExpanderFn } from '../ir/expander'
import type { IRExpr, IRBinOp, WasmType } from '../ir/nodes'
import { IRLowerError, exprWasmType } from '../ir/lower'
import { wasmTypeOf } from '../types/types'

// ---------------------------------------------------------------------------
// Built-in expanders
// ---------------------------------------------------------------------------

const expandIf: IRExpanderFn = (rawArgs, ctx, lower, inferredType) => {
    const [condN, thenN, elseN] = rawArgs
    const cond = lower(condN, ctx)
    const then = lower(thenN, ctx)
    const else_ = elseN ? lower(elseN, ctx) : undefined
    const wt = else_ ? exprWasmType(then) : 'void'
    return { kind: 'If', wasmType: wt, cond, then, else_ }
}

const expandLoop: IRExpanderFn = (rawArgs, ctx, lower) => {
    const [condN, bodyN] = rawArgs
    const id = ctx.loopCount.n++
    ctx.loopStack.push(id)
    const cond = lower(condN, ctx)
    const body = lower(bodyN, ctx)
    ctx.loopStack.pop()
    return { kind: 'Loop', id, cond, body }
}

const expandBreak: IRExpanderFn = (_rawArgs, ctx) => {
    const id = ctx.loopStack.at(-1)
    if (id === undefined) throw new IRLowerError('@break outside @loop')
    return { kind: 'Break', id }
}

const expandContinue: IRExpanderFn = (_rawArgs, ctx) => {
    const id = ctx.loopStack.at(-1)
    if (id === undefined) throw new IRLowerError('@continue outside @loop')
    return { kind: 'Continue', id }
}

const expandReturn: IRExpanderFn = (rawArgs, ctx, lower) => {
    const value = rawArgs[0] ? lower(rawArgs[0], ctx) : undefined
    return { kind: 'Return', value }
}

const expandAnd: IRExpanderFn = (rawArgs, ctx, lower) => {
    const [leftN, rightN] = rawArgs
    const left = lower(leftN, ctx)
    const right = lower(rightN, ctx)
    return {
        kind: 'If', wasmType: 'i32', cond: left, then: right,
        else_: { kind: 'Const', wasmType: 'i32', value: 0 },
    }
}

const expandOr: IRExpanderFn = (rawArgs, ctx, lower) => {
    const [leftN, rightN] = rawArgs
    const left = lower(leftN, ctx)
    const right = lower(rightN, ctx)
    return {
        kind: 'If', wasmType: 'i32', cond: left,
        then: { kind: 'Const', wasmType: 'i32', value: 1 }, else_: right,
    }
}

const expandMatch: IRExpanderFn = (rawArgs, ctx, lower, inferredType) => {
    // @match disc, pat0, res0, pat1, res1, ...       — exhaustive, ends unreachable
    // @match disc, pat0, res0, pat1, res1, default   — trailing default (even total)
    //
    // Even arg count: last argument is a catch-all default with no pattern comparison.
    // Odd arg count: all arms are explicit; falls through to (unreachable).
    if (rawArgs.length < 3) return { kind: 'Nop' }

    const discExpr = lower(rawArgs[0], ctx)
    const wt: WasmType = (inferredType && inferredType.kind !== 'Unknown')
        ? (wasmTypeOf(inferredType) as WasmType)
        : 'i32'

    function buildNested(i: number): IRExpr {
        // Past all arms — no default provided; fall to unreachable.
        if (i >= rawArgs.length) return { kind: 'Unreachable' }
        // Lone last item (no paired result) = trailing default / catch-all.
        if (i + 1 >= rawArgs.length) return lower(rawArgs[i], ctx)

        const pat = lower(rawArgs[i], ctx)
        const res = lower(rawArgs[i + 1], ctx)
        const eqInstr = exprWasmType(discExpr) === 'f32' ? 'f32.eq' : 'i32.eq'
        const cond: IRBinOp = { kind: 'BinOp', wasmType: 'i32', instr: eqInstr, left: discExpr, right: pat }
        return { kind: 'If', wasmType: wt, cond, then: res, else_: buildNested(i + 2) }
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
