// SPDX-License-Identifier: MIT
/**
 * `@loop`-over-iterables desugar (ADR 0016).
 *
 * One keyword, syntactic/arity dispatch at elaboration time.  This pass runs
 * BEFORE operator elaboration and typechecking and rewrites the iterate / range
 * / infinite forms of `@loop` into the plain `while`-shaped `@loop cond, {body}`
 * the bootstrap already lowers — so there is zero new IR, zero new typechecker
 * rule, and `..` never survives into a context that would try to resolve it as
 * an operator (ranges are syntactic-only inside `@loop`).
 *
 * Dispatch is a pure operand-count switch.  Let N = `args.length` (the parser
 * flattens every comma-operand, including the trailing `{ body }` block, into
 * one `args` array), so k = N − 1 operands precede the block:
 *
 *   | N | k | form        | meaning                                            |
 *   |---|---|-------------|----------------------------------------------------|
 *   | 1 | 0 | infinite    | `@loop {body}` → `@loop 1, {body}` (loop forever)|
 *   | 2 | 1 | while       | `@loop cond, {body}` — unchanged (backward-compat)|
 *   | 3 | 2 | iterate     | `@loop v, subj, {body}`   — v ← element            |
 *   | 4 | 3 | iterate     | `@loop i, v, subj, {body}` — i ← position, v ← elem|
 *   | ≥5| ≥4| reserved    | rejected                                            |
 *
 * The subject (args[N−2]) selects the desugar by syntactic shape:
 *   - a `a..b` range BinaryOp  → a half-open counter loop (no IterStep built);
 *   - anything else            → indexed iteration over the allow-listed
 *                                `vec_len` / `vec_get_i32` surface.
 *
 * M1 typed-Vec dispatch: the generated `vec_len` / `vec_get_i32` calls are
 * tagged `vecIterDispatch: true` and the snapshotted subject local is tagged
 * `vecIterSubject: true`.  The names are the i32 DEFAULT — when the subject's
 * inferred type is `Vec[Float]` / `Vec[Int64]`, the typechecker rewrites the
 * tagged calls to the matching monomorph family (`vec_len_f32`/`vec_get_f32`,
 * `vec_len_i64`/`vec_get_i64`), so the binder is typed by the element type.
 * (The desugar itself runs pre-typecheck and cannot see the element type.)
 * Under `--target=wasm-gc` the subject tag also lets the lowerer ref-type the
 * synthetic local from its INFERRED type (it has no annotation to read).
 *
 * Synthetic temporaries are gensym'd from a per-program counter (`__loopN_*`)
 * so they cannot collide with user names or across nested loops; the subject /
 * bounds are snapshotted once at entry (ADR 0016 "subject is snapshotted").
 * A `_` binder discards (no binding emitted).  See docs/adr/0016-loop-over-iterables.md.
 */

import type { ElaborationError } from './elaborator'

// ── Tiny AST builders (loose handwritten-parser shapes) ────────────────────
// The handwritten parser produces "loose" nodes: Block.items / FunctionCall.args
// hold raw Definition / expression nodes directly (no Item/Statement/
// ExpressionStart wrappers), so the desugar builds the same raw shapes.

const ns = (name: string): any => ({ type: 'Namespace', path: [name] })
const intLit = (v: number): any => ({ type: 'IntLiteral', value: String(v), base: 'decimal' })
const binop = (left: any, operator: string, right: any): any => ({ type: 'BinaryOp', left, operator, right })
const block = (items: any[], trailing?: any): any => ({ type: 'Block', items, trailing })
const localDef = (name: string, expr: any): any => ({
    type: 'Definition',
    keyword: '@local',
    name: { type: 'TypedIdentifier', name },
    params: [],
    binding: { type: 'Binding', expression: expr },
})
const assign = (name: string, expr: any): any => ({ type: 'Assignment', target: ns(name), value: expr })
const loopCall = (cond: any, body: any): any => ({ type: 'FunctionCall', name: '@loop', isBuiltin: true, args: [cond, body] })
const userCall = (fn: string, args: any[]): any => ({ type: 'FunctionCall', name: ns(fn), isBuiltin: false, args })
const incr = (name: string): any => assign(name, binop(ns(name), '+', intLit(1)))

interface Ctx {
    n: number                       // monotonic gensym counter
    errors: ElaborationError[]
}

const err = (ctx: Ctx, message: string): void => { ctx.errors.push({ keyword: '@loop', message }) }

/** Extract a single-identifier binder name, or null if the binder isn't a bare name. */
function binderName(node: any): string | null {
    if (node && node.type === 'Namespace' && Array.isArray(node.path) && node.path.length === 1) {
        return node.path[0]
    }
    return null
}

/** Split a loop body into (items, trailing) regardless of whether it's a Block. */
function bodyParts(body: any): { items: any[]; trailing: any } {
    if (body && body.type === 'Block') {
        return { items: Array.isArray(body.items) ? body.items : [], trailing: body.trailing }
    }
    // Non-block body (`@loop v, 0..n, print v`) — treat as a lone expression.
    return { items: [], trailing: body }
}

/** Flatten a body's items + trailing into a single statement list (value discarded). */
function flattenBody(body: any): any[] {
    const { items, trailing } = bodyParts(body)
    const out = [...items]
    if (trailing !== undefined && trailing !== null) out.push(trailing)
    return out
}

const isRange = (node: any): boolean => node && node.type === 'BinaryOp' && node.operator === '..'

/**
 * Rewrite one `@loop` call.  Returns the replacement node, or the original
 * `call` unchanged for the while form (N=2) and on error.
 */
function transformLoop(call: any, ctx: Ctx): any {
    const args: any[] = Array.isArray(call.args) ? call.args : []
    const N = args.length

    // N=2 while — the existing form; leave it for Loop_lower untouched.
    if (N === 2) return call

    // N=1 infinite — `@loop {body}` ≡ `@loop 1, {body}` (loop forever).
    if (N === 1) return loopCall(intLit(1), args[0])

    // N=0 — `@loop` with no body; leave it to error downstream as before.
    if (N === 0) return call

    if (N >= 5) {
        err(ctx, `@loop takes at most 3 operands before the { body } block ` +
            `(while: cond; iterate: [index,] value, subject), got ${N - 1}`)
        return call
    }

    // N=3 (1 binder) or N=4 (2 binders).
    const body = args[N - 1]
    const subject = args[N - 2]
    const id = ctx.n++

    if (isRange(subject)) {
        const lo = subject.left
        const hi = subject.right
        const iN = `__loop${id}_i`
        const hiN = `__loop${id}_hi`

        if (N === 3) {
            // @loop v, lo..hi, {body}
            const vName = binderName(args[0])
            if (vName === null) { err(ctx, 'the element binder of an iterate @loop must be a bare name (or `_`)'); return call }
            const inner: any[] = []
            if (vName !== '_') inner.push(localDef(vName, ns(iN)))
            inner.push(...flattenBody(body), incr(iN))
            return block(
                [localDef(iN, lo), localDef(hiN, hi)],
                loopCall(binop(ns(iN), '<', ns(hiN)), block(inner)),
            )
        }
        // N === 4 — @loop idx, v, lo..hi, {body}
        const idxName = binderName(args[0])
        const vName = binderName(args[1])
        if (idxName === null || vName === null) { err(ctx, 'the binders of an iterate @loop must be bare names (or `_`)'); return call }
        const kN = `__loop${id}_k`
        const inner: any[] = []
        if (idxName !== '_') inner.push(localDef(idxName, ns(kN)))
        if (vName !== '_') inner.push(localDef(vName, ns(iN)))
        inner.push(...flattenBody(body), incr(iN), incr(kN))
        return block(
            [localDef(iN, lo), localDef(hiN, hi), localDef(kN, intLit(0))],
            loopCall(binop(ns(iN), '<', ns(hiN)), block(inner)),
        )
    }

    // Indexed container form — Vec surface (vec_len / vec_get_i32 defaults;
    // the typechecker retargets the tagged calls for Vec[Float]/Vec[Int64]).
    const xsN = `__loop${id}_xs`
    const iN = `__loop${id}_i`
    const nN = `__loop${id}_n`
    const tag = (node: any): any => { node.vecIterDispatch = true; return node }
    const get = (): any => tag(userCall('vec_get_i32', [ns(xsN), ns(iN)]))
    const len = (): any => tag(userCall('vec_len', [ns(xsN)]))
    const subjDef = (): any => { const d = localDef(xsN, subject); d.vecIterSubject = true; return d }

    if (N === 3) {
        // @loop item, xs, {body}
        const itemName = binderName(args[0])
        if (itemName === null) { err(ctx, 'the element binder of an iterate @loop must be a bare name (or `_`)'); return call }
        const inner: any[] = []
        if (itemName !== '_') inner.push(localDef(itemName, get()))
        inner.push(...flattenBody(body), incr(iN))
        return block(
            [subjDef(), localDef(iN, intLit(0)), localDef(nN, len())],
            loopCall(binop(ns(iN), '<', ns(nN)), block(inner)),
        )
    }
    // N === 4 — @loop idx, item, xs, {body}
    const idxName = binderName(args[0])
    const itemName = binderName(args[1])
    if (idxName === null || itemName === null) { err(ctx, 'the binders of an iterate @loop must be bare names (or `_`)'); return call }
    const inner: any[] = []
    if (idxName !== '_') inner.push(localDef(idxName, ns(iN)))
    if (itemName !== '_') inner.push(localDef(itemName, get()))
    inner.push(...flattenBody(body), incr(iN))
    return block(
        [subjDef(), localDef(iN, intLit(0)), localDef(nN, len())],
        loopCall(binop(ns(iN), '<', ns(nN)), block(inner)),
    )
}

/**
 * Structural-sharing AST walk: returns the same node reference when no
 * descendant changed (so the registry's references to untouched strata
 * definitions keep their identity), and rebuilds only the spine down to each
 * transformed `@loop`.
 *
 * `@loop` is intercepted in PRE-order: an iterate/infinite form is desugared
 * first (consuming its `..` subject) and the rewritten spine is then walked, so
 * a range used as a loop subject never reaches the stray-`..` check below while
 * a `..` anywhere else still does.  Nested loops in the body desugar during that
 * second walk.
 */
function walk(node: any, ctx: Ctx): any {
    if (!node || typeof node !== 'object') return node

    if (Array.isArray(node)) {
        let changed = false
        const out = new Array(node.length)
        for (let i = 0; i < node.length; i++) {
            const y = walk(node[i], ctx)
            out[i] = y
            if (y !== node[i]) changed = true
        }
        return changed ? out : node
    }

    if (node.type === 'FunctionCall' && node.name === '@loop') {
        const transformed = transformLoop(node, ctx)
        // A rewrite happened (infinite / iterate form) — walk the new spine to
        // handle nested loops and the embedded user body.  The while form (N=2)
        // returns the same node and falls through to the generic child walk.
        if (transformed !== node) return walk(transformed, ctx)
    }

    let changed = false
    const out: any = {}
    for (const k of Object.keys(node)) {
        const y = walk(node[k], ctx)
        out[k] = y
        if (y !== node[k]) changed = true
    }
    const result = changed ? out : node

    // A `..` range reaching here is used outside an iterate @loop subject —
    // not supported in v1 (ranges are syntactic-only inside @loop).
    if (result.type === 'BinaryOp' && result.operator === '..') {
        err(ctx, 'a `..` range is only valid as the subject of an iterate `@loop` ' +
            '(e.g. `@loop(v, 0..n, { … })`); ranges are not first-class values in v1')
    }
    return result
}

/**
 * Desugar every iterate / range / infinite `@loop` in `program` into plain
 * while-shaped loops.  Mutates nothing; returns the rewritten program plus any
 * diagnostics (arity > 3, malformed binders, stray `..`).
 */
export function desugarLoops(program: any): { program: any; errors: ElaborationError[] } {
    const ctx: Ctx = { n: 0, errors: [] }
    const rewritten = walk(program, ctx)
    return { program: rewritten, errors: ctx.errors }
}
