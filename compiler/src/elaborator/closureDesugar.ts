// SPDX-License-Identifier: MIT
/**
 * `@closure` / `@call_closure` desugar (ADR 0019 C1 — non-escaping closures
 * with by-value capture).
 *
 * One AST→AST pass at elaboration time, modelled exactly on `loopDesugar.ts`:
 * it rewrites the two closure keyword-calls into the SHIPPED `@fnref` /
 * `@call_indirect` (C0 multi-signature funcref ABI) + `vec_*` machinery, so
 * there is **zero new IR, zero new codegen, no grammar change** (the keywords
 * ride the existing `@kw(args)` FunctionCall form, like `@fnref`/`@with_arena`).
 *
 * Surface (ADR 0019 §6):
 *   `@closure(body_fn, cap0, cap1, …)` — build a closure over a NAMED top-level
 *       `@fn body_fn` whose LEADING params are the captures (by value, in arg
 *       order) and whose trailing params are the call args.
 *   `@call_closure(clo, arg0, …)` — invoke it.
 *
 * Representation (the non-escaping, all-modes form):
 *   A closure value is an `i32` pointer to a `Vec[i32]` env record laid out as
 *     [ slot0 = fnref index of a generated wrapper,  slot1.. = captured i32s ].
 *   For each `@closure(body_fn, …caps)` site we synthesize a top-level wrapper
 *     `@fn __clo_<body_fn>_<n>(env, …args) := body_fn(<env slot1..>, …args)`
 *   whose first param is the env (so every closure shares ONE uniform
 *   `(env, …args)->ret` call_indirect signature regardless of capture count —
 *   the static-resolvability the call site needs), and whose body unpacks the
 *   captures via `vec_get_i32(env, k)` before calling the user's `body_fn`.
 *   `@call_closure(clo, …args)` lowers to
 *     `@call_indirect(vec_get_i32(clo, 0), clo, …args)`
 *   — load the wrapper index from slot 0, dispatch with `clo` (the env) first.
 *
 * Scope (v1.0 C1): by-value capture of `i32`-represented values (Int/Bool and
 * heap pointers). `Float` captures and the full per-concrete-env-type
 * monomorphized DIRECT-call zero-cost form (ADR §2.1) are refinements on top of
 * this correct call_indirect baseline; the escaping host-callable tier is C2
 * (`--target=wasm-gc`, ADR §2.2). Captures are evaluated once at the build site;
 * the closure subject of `@call_closure` is snapshotted to avoid double-eval.
 */

import type { ElaborationError } from './elaborator'

// ── Tiny AST builders (loose handwritten-parser shapes — match loopDesugar) ──
const ns = (name: string): any => ({ type: 'Namespace', path: [name] })
const intLit = (v: number): any => ({ type: 'IntLiteral', value: String(v), base: 'decimal' })
const block = (items: any[], trailing?: any): any => ({ type: 'Block', items, trailing })
const localDef = (name: string, expr: any): any => ({
    type: 'Definition', keyword: '@local',
    name: { type: 'TypedIdentifier', name },
    params: [], binding: { type: 'Binding', expression: expr },
})
const userCall = (fn: string, args: any[]): any => ({ type: 'FunctionCall', name: ns(fn), isBuiltin: false, args })
const kwCall = (kw: string, args: any[]): any => ({ type: 'FunctionCall', name: kw, isBuiltin: true, args })
const param = (name: string, typename: string): any => ({
    type: 'Parameter', name, typeAnnotation: { type: 'TypeAnnotation', typename }, isLiteral: false,
})
const fnDef = (name: string, params: any[], resultType: string, bodyExpr: any): any => ({
    type: 'Definition', keyword: '@fn',
    name: { type: 'TypedIdentifier', name, typeAnnotation: { type: 'TypeAnnotation', typename: resultType } },
    params,
    binding: { type: 'Binding', expression: bodyExpr },
})
const exportDef = (name: string): any => ({
    type: 'Definition', keyword: '@export', name: { type: 'TypedIdentifier', name }, params: [],
})

interface FnSig { paramTypes: string[]; resultType: string }
interface Ctx {
    n: number
    errors: ElaborationError[]
    fns: Map<string, FnSig>      // top-level @fn name → signature
    wrappers: any[]              // synthesized wrapper @fn Definitions to append
    /** C2: arities for which a host-callable __closure_invoke_<k> trampoline
     *  export must be synthesized (set when @export_callback is used). */
    invokeArities: Set<number>
}

const err = (ctx: Ctx, kw: string, message: string): void => { ctx.errors.push({ keyword: kw, message }) }

/** A bare identifier reference → its name, else null. */
function refName(node: any): string | null {
    if (node && node.type === 'Namespace' && Array.isArray(node.path) && node.path.length === 1) return node.path[0]
    return null
}

const isClosureCall = (n: any): boolean => n && n.type === 'FunctionCall' && n.name === '@closure'

/** The callee name of a FunctionCall, whether a builtin keyword (string name) or
 *  a user/namespaced call (Namespace path joined by `::`). */
function calleeName(call: any): string | null {
    const nm = call?.name
    if (typeof nm === 'string') return nm
    if (nm?.type === 'Namespace' && Array.isArray(nm.path)) return nm.path.join('::')
    return null
}

/**
 * ADR 0019 C2 — the conservative escape/host-reachability classifier + mode-gate.
 *
 * A closure handed across an `@extern` boundary is a HOST-CALLABLE ESCAPING
 * closure: the host may retain it and call it back after the env's frame is
 * gone.  Under C1's non-escaping representation the env is a linear-memory
 * `Vec` that does NOT outlive the call, so letting a closure cross `@extern`
 * (where it would type-check as a bare i32 pointer) is UNSOUND.  The ADR routes
 * this case to the wasm-gc Tier-B `(struct $Clo)` representation (§2.2); that
 * codegen is not yet implemented, so the only sound action today is to REJECT.
 *
 * The classifier is the conservative syntactic over-approximation the ADR
 * mandates (§9): a closure-valued expression — a `@closure(…)` literal, or a
 * local bound to one — appearing in an `@extern`/namespaced-host call argument
 * position is flagged.  (Fuller flow — a closure stored in a struct or returned
 * past its frame — is a documented gap that loosens as ADR 0011 R4 lands.)
 */
function classifyEscapes(program: any, ctx: Ctx): void {
    // Collect @extern declaration names (bare and namespaced `mod::field`).
    const externs = new Set<string>()
    for (const el of (program.elements ?? []) as any[]) {
        const d = el && el.type === 'Definition' ? el : (el?.value?.type === 'Definition' ? el.value : null)
        if (d && d.keyword === '@extern' && d.name?.name) externs.add(d.name.name)
    }
    if (externs.size === 0) return

    // Conservatively collect every local name ever bound to a @closure(…).
    const closureVars = new Set<string>()
    const scanBinds = (node: any): void => {
        if (!node || typeof node !== 'object') return
        if (Array.isArray(node)) { node.forEach(scanBinds); return }
        if (node.type === 'Definition' && (node.keyword === '@local' || node.keyword === '@mut' || node.keyword === '@var')
            && node.name?.name && isClosureCall(node.binding?.expression)) {
            closureVars.add(node.name.name)
        }
        if (node.type === 'Assignment' && isClosureCall(node.value)) {
            const t = refName(node.target); if (t) closureVars.add(t)
        }
        for (const k of Object.keys(node)) scanBinds(node[k])
    }
    scanBinds(program)

    const isClosureArg = (a: any): boolean => isClosureCall(a) || (refName(a) !== null && closureVars.has(refName(a)!))
    const scanCalls = (node: any): void => {
        if (!node || typeof node !== 'object') return
        if (Array.isArray(node)) { node.forEach(scanCalls); return }
        if (node.type === 'FunctionCall') {
            const callee = calleeName(node)
            // `mod::field` host-module calls share the @extern boundary; match
            // either the bare extern name or a namespaced call whose tail is one.
            const tail = callee?.includes('::') ? callee.split('::').pop()! : callee
            if (callee && (externs.has(callee) || (tail && externs.has(tail)))) {
                for (const a of (node.args ?? [])) {
                    if (isClosureArg(a)) {
                        err(ctx, '@closure',
                            `a bare closure passed to the @extern boundary '${callee}' is a host-callable escaping ` +
                            `closure (ADR 0019 C2): the host may retain it and call it back after this frame returns. ` +
                            `Wrap it in @export_callback(…) to make it an intentional host-callable export (the closure ` +
                            `env is retained for the host and an exported __closure_invoke_<k> trampoline is synthesized), ` +
                            `or pass a plain @fnref (no captures) if no capture is needed.`)
                    }
                }
            }
        }
        for (const k of Object.keys(node)) scanCalls(node[k])
    }
    scanCalls(program)
}

/** Pre-scan: collect every top-level `@fn`'s param types + result type. */
function collectFns(program: any): Map<string, FnSig> {
    const fns = new Map<string, FnSig>()
    for (const el of (program.elements ?? []) as any[]) {
        const d = el && el.type === 'Definition' ? el : (el?.value?.type === 'Definition' ? el.value : null)
        if (d && d.keyword === '@fn' && d.name?.name) {
            const paramTypes = (d.params ?? [])
                .filter((p: any) => !p.isLiteral)
                .map((p: any) => p.typeAnnotation?.typename ?? 'Int')
            fns.set(d.name.name, { paramTypes, resultType: d.name?.typeAnnotation?.typename ?? 'Int' })
        }
    }
    return fns
}

/** Rewrite one `@closure(body_fn, …caps)` site → an env-building Block, and
 *  register the synthesized wrapper @fn in ctx.wrappers. */
function transformClosure(call: any, ctx: Ctx): any {
    const args: any[] = Array.isArray(call.args) ? call.args : []
    if (args.length < 1) { err(ctx, '@closure', '@closure expects at least 1 argument: @closure(body_fn, …captures)'); return call }

    const bodyName = refName(args[0])
    if (bodyName === null) { err(ctx, '@closure', "@closure's first argument must be a bare top-level @fn name"); return call }
    const sig = ctx.fns.get(bodyName)
    if (!sig) { err(ctx, '@closure', `@closure references unknown function '${bodyName}'`); return call }

    const caps = args.slice(1)
    const ncaps = caps.length
    if (ncaps > sig.paramTypes.length) {
        err(ctx, '@closure', `@closure captures ${ncaps} value(s) but '${bodyName}' takes only ${sig.paramTypes.length} parameter(s)`)
        return call
    }
    const nargs = sig.paramTypes.length - ncaps
    const argTypes = sig.paramTypes.slice(ncaps)
    const id = ctx.n++
    const wrapName = `__clo_${bodyName}_${id}`
    const envN = `__clo${id}_env`

    // Wrapper: __clo_<body>_<n>(env Int, a0 …) := body_fn(vec_get_i32(env,1)…, a0 …)
    const argNames = argTypes.map((_, i) => `__a${i}`)
    const wrapperParams = [param('env', 'Int'), ...argNames.map((nm, i) => param(nm, argTypes[i]))]
    const bodyCallArgs = [
        ...caps.map((_, k) => userCall('vec_get_i32', [ns('env'), intLit(k + 1)])),
        ...argNames.map(ns),
    ]
    ctx.wrappers.push(fnDef(wrapName, wrapperParams, sig.resultType, block([], userCall(bodyName, bodyCallArgs))))

    // Site: { env := vec_new(ncaps+1); vec_push_i32(env, @fnref(wrap)); vec_push_i32(env, cap0); …; env }
    const items: any[] = [
        localDef(envN, userCall('vec_new', [intLit(ncaps + 1)])),
        userCall('vec_push_i32', [ns(envN), kwCall('@fnref', [ns(wrapName)])]),
    ]
    for (const cap of caps) items.push(userCall('vec_push_i32', [ns(envN), cap]))
    return block(items, ns(envN))
}

/** Rewrite `@call_closure(clo, …args)` → @call_indirect(vec_get_i32(clo,0), clo, …args),
 *  snapshotting `clo` once so it is not evaluated twice. */
function transformCallClosure(call: any, ctx: Ctx): any {
    const args: any[] = Array.isArray(call.args) ? call.args : []
    if (args.length < 1) { err(ctx, '@call_closure', '@call_closure expects at least the closure: @call_closure(clo, …args)'); return call }
    const clo = args[0]
    const callArgs = args.slice(1)
    const id = ctx.n++
    const cN = `__cloc${id}`
    return block(
        [localDef(cN, clo)],
        kwCall('@call_indirect', [userCall('vec_get_i32', [ns(cN), intLit(0)]), ns(cN), ...callArgs]),
    )
}

/**
 * ADR 0019 C2 — `@export_callback(closure)` marks a closure as an intentional
 * HOST-CALLABLE export and evaluates to its handle.  Crossing `@extern` wrapped
 * in `@export_callback` is the sanctioned, gate-exempt escape (vs. the bare
 * `@closure`-crosses-`@extern` footgun the classifier rejects): the closure env
 * lives in the bump heap (it persists past the frame), so the host may store the
 * handle and call it back later through a synthesized exported trampoline
 * `__closure_invoke_<k>(clo, …args) := @call_indirect(vec_get_i32(clo,0), clo, …args)`.
 * The arity is inferred from a literal `@closure` argument, else trampolines for
 * arities 1 and 2 are emitted.
 *
 * NOTE on representation: this is the linear-memory host-callable baseline — the
 * handle crosses as a plain i32 and the persisted env is a documented heap
 * retention (no engine GC).  The ADR's leak-free wasm-gc form (§2.2) — box the
 * env's `(ref $Vec_i32)` as an `externref` so the engine traces it (collected when
 * the host drops it) and recover it in the trampoline via `ref.cast` — now has its
 * codegen primitives implemented and proven end-to-end (the `ExternConvertAny` /
 * `AnyConvertExtern` / `RefCast` IR nodes + emitters; see `gc-closure-box.test.ts`).
 * Auto-routing THIS path under `--target=wasm-gc` additionally needs the closure
 * wrapper/`@call_indirect` to carry a ref-typed (`(ref $Vec_i32)`) env param — today
 * the wrapper hardcodes `param('env', 'Int')`, so closures are linear-only under
 * wasm-gc (`vec_get_i32` rejects the i32 env: E0002). That ref-typed funcref-ABI
 * extension (C0) is the remaining integration step.
 */
function transformExportCallback(call: any, ctx: Ctx): any {
    const args: any[] = Array.isArray(call.args) ? call.args : []
    if (args.length < 1) { err(ctx, '@export_callback', '@export_callback expects the closure: @export_callback(closure)'); return call }
    const inner = args[0]
    // Infer the call arity from a literal @closure(body_fn, …caps); else 1 and 2.
    if (isClosureCall(inner)) {
        const bn = refName(inner.args?.[0])
        const sig = bn ? ctx.fns.get(bn) : undefined
        if (sig) ctx.invokeArities.add(Math.max(0, sig.paramTypes.length - (inner.args.length - 1)))
        else { ctx.invokeArities.add(1); ctx.invokeArities.add(2) }
    } else { ctx.invokeArities.add(1); ctx.invokeArities.add(2) }
    return inner   // the handle itself; the trampoline is appended at the top level
}

/** Synthesize an exported host-callable trampoline for closure call-arity `k`:
 *  `__closure_invoke_<k>(clo, a0…) -> Int := @call_indirect(vec_get_i32(clo,0), clo, a0…)`. */
function trampolineFor(k: number): any[] {
    const name = `__closure_invoke_${k}`
    const argNames = Array.from({ length: k }, (_, i) => `__a${i}`)
    const params = [param('clo', 'Int'), ...argNames.map(nm => param(nm, 'Int'))]
    const body = block([], kwCall('@call_indirect', [userCall('vec_get_i32', [ns('clo'), intLit(0)]), ns('clo'), ...argNames.map(ns)]))
    return [fnDef(name, params, 'Int', body), exportDef(name)]
}

/** Structural-sharing walk (matches loopDesugar): rebuild only the spine down
 *  to each transformed closure site; PRE-order so a rewritten site is re-walked
 *  (nested closures in captures/args desugar in that second pass). */
function walk(node: any, ctx: Ctx): any {
    if (!node || typeof node !== 'object') return node
    if (Array.isArray(node)) {
        let changed = false
        const out = new Array(node.length)
        for (let i = 0; i < node.length; i++) { const y = walk(node[i], ctx); out[i] = y; if (y !== node[i]) changed = true }
        return changed ? out : node
    }
    if (node.type === 'FunctionCall' && node.name === '@export_callback') {
        const t = transformExportCallback(node, ctx)
        if (t !== node) return walk(t, ctx)
    }
    if (node.type === 'FunctionCall' && node.name === '@closure') {
        const t = transformClosure(node, ctx)
        if (t !== node) return walk(t, ctx)
    }
    if (node.type === 'FunctionCall' && node.name === '@call_closure') {
        const t = transformCallClosure(node, ctx)
        if (t !== node) return walk(t, ctx)
    }
    let changed = false
    const out: any = {}
    for (const k of Object.keys(node)) { const y = walk(node[k], ctx); out[k] = y; if (y !== node[k]) changed = true }
    return changed ? out : node
}

/**
 * Desugar every `@closure` / `@call_closure` in `program` into `@fnref` /
 * `@call_indirect` + `vec_*` (ADR 0019 C1).  Synthesized wrapper `@fn`s are
 * appended to the program's top-level elements.  Returns the rewritten program
 * plus any diagnostics.
 */
export function desugarClosures(program: any): { program: any; errors: ElaborationError[] } {
    const ctx: Ctx = { n: 0, errors: [], fns: collectFns(program), wrappers: [], invokeArities: new Set() }
    // C2 escape gate: flag host-callable escaping closures (a bare closure
    // crossing @extern) BEFORE the rewrite erases the @closure literals.  A
    // closure wrapped in @export_callback is the sanctioned, gate-exempt form.
    classifyEscapes(program, ctx)
    const rewritten = walk(program, ctx)
    // C2: append the exported host-callable trampolines (one per call-arity used
    // with @export_callback) so the JS/Bun host can invoke a stored closure.
    const trampolines = [...ctx.invokeArities].sort().flatMap(trampolineFor)
    const appended = [...ctx.wrappers, ...trampolines]
    if (appended.length === 0) return { program: rewritten, errors: ctx.errors }
    return {
        program: { ...rewritten, elements: [...rewritten.elements, ...appended] },
        errors: ctx.errors,
    }
}
