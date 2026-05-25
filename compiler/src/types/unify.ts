/**
 * Hindley-Milner-lite unification core for Silicon.
 *
 * "Lite" because we only support declared polymorphism (introduced by
 * `@fn[T]` / `@type[T]`): there is no let-generalisation, no rank-N, no
 * polymorphic recursion.  These are deliberate omissions matching the
 * Roc-style trajectory laid out in docs/comptime-via-compilation.md and
 * the design discussions accompanying this implementation.
 *
 * Algorithm shape: Algorithm J without generalise().
 *   - Each call site `instantiate`s the callee's Scheme to fresh `?Ti` vars.
 *   - Arg types `unify` against instantiated parameter types, accumulating
 *     a substitution `Subst = Map<string, SiliconType>`.
 *   - `applySubst` propagates a substitution through a type.
 *   - `occursCheck` prevents infinite types (`T = List[T]`).
 *
 * No caller imports this module yet — phase P3 wires it in.
 */

import type { SiliconType, Scheme } from './types'

/** A substitution maps type-variable names to the concrete types they were
 *  unified with.  Keys are the var names (e.g. `?T1`); values are arbitrary
 *  SiliconTypes, possibly containing other unresolved vars. */
export type Subst = Map<string, SiliconType>

/** Empty substitution — identity. */
export function emptySubst(): Subst {
    return new Map()
}

/** A monotonically-increasing counter for fresh type-variable names. */
export interface FreshGen {
    next(prefix?: string): SiliconType
}

export function makeFreshGen(): FreshGen {
    let n = 0
    return {
        next: (prefix = 'T') => ({ kind: 'Variable', name: `?${prefix}${++n}` }),
    }
}

// ---------------------------------------------------------------------------
// Substitution application
// ---------------------------------------------------------------------------

/**
 * Walk `t`, replacing every `Variable` whose name appears in `s` with the
 * bound type (recursively, so `?T1 ↦ ?T2 ↦ Int` resolves all the way to Int).
 * Pure: never mutates t or s.
 */
export function applySubst(t: SiliconType, s: Subst): SiliconType {
    if (s.size === 0) return t
    switch (t.kind) {
        case 'Variable': {
            const bound = s.get(t.name)
            if (!bound) return t
            // Identity binding (T ↦ T) — return directly to avoid infinite
            // recursion when a substitution maps a variable to itself
            // (legitimately happens when a variant scheme's tvar matches
            // the discriminant's own type-arg variable).
            if (bound.kind === 'Variable' && bound.name === t.name) return t
            // Recurse to resolve chains: `?T1 ↦ ?T2 ↦ Int`.
            return applySubst(bound, s)
        }
        case 'Array':
            return { kind: 'Array', element: applySubst(t.element, s) }
        case 'Function':
            return {
                kind: 'Function',
                params: t.params.map(p => applySubst(p, s)),
                result: applySubst(t.result, s),
            }
        case 'Sum':
            return t.typeArgs && t.typeArgs.length > 0
                ? { kind: 'Sum', name: t.name, variants: t.variants, typeArgs: t.typeArgs.map(a => applySubst(a, s)) }
                : t
        case 'Distinct':
            return { kind: 'Distinct', name: t.name, underlying: applySubst(t.underlying, s) }
        // Primitives and Unknown have no substructure.
        default:
            return t
    }
}

/** Compose two substitutions: `(s2 ∘ s1)(t) = s2(s1(t))`.  Right-to-left
 *  application — the standard HM convention. */
export function composeSubst(s2: Subst, s1: Subst): Subst {
    const out = new Map<string, SiliconType>()
    for (const [k, v] of s1) out.set(k, applySubst(v, s2))
    for (const [k, v] of s2) if (!out.has(k)) out.set(k, v)
    return out
}

// ---------------------------------------------------------------------------
// Occurs check
// ---------------------------------------------------------------------------

/** Returns true if `name` appears anywhere inside `t`, forbidding bindings
 *  like `?T1 := List[?T1]` that would create an infinite type. */
export function occursIn(name: string, t: SiliconType): boolean {
    switch (t.kind) {
        case 'Variable': return t.name === name
        case 'Array':    return occursIn(name, t.element)
        case 'Function': return t.params.some(p => occursIn(name, p)) || occursIn(name, t.result)
        case 'Sum':      return (t.typeArgs ?? []).some(a => occursIn(name, a))
        case 'Distinct': return occursIn(name, t.underlying)
        default:         return false
    }
}

// ---------------------------------------------------------------------------
// Unification
// ---------------------------------------------------------------------------

export class UnifyError extends Error {
    constructor(public a: SiliconType, public b: SiliconType, msg?: string) {
        super(msg ?? `cannot unify ${formatForError(a)} with ${formatForError(b)}`)
    }
}

function formatForError(t: SiliconType): string {
    switch (t.kind) {
        case 'Int':      return 'Int'
        case 'Int64':    return 'Int64'
        case 'Float':    return 'Float'
        case 'String':   return 'String'
        case 'Bool':     return 'Bool'
        case 'UInt8':    return 'u8'
        case 'UInt16':   return 'u16'
        case 'UInt32':   return 'u32'
        case 'UInt64':   return 'u64'
        case 'Void':     return 'Void'
        case 'Unknown':  return '<unknown>'
        case 'Variable': return t.name
        case 'Array':    return `Array[${formatForError(t.element)}]`
        case 'Function': return `(${t.params.map(formatForError).join(', ')}) → ${formatForError(t.result)}`
        case 'Distinct': return t.name
        case 'Sum':
            if (t.typeArgs && t.typeArgs.length > 0) {
                return `${t.name}[${t.typeArgs.map(formatForError).join(', ')}]`
            }
            return t.name
    }
}

/**
 * Unify two types under a starting substitution.  Returns the extended
 * substitution that makes them equal, or throws UnifyError.
 *
 * Rules (in order):
 *   1. Apply current subst to both sides.
 *   2. Equal types unify trivially.
 *   3. A Variable unifies with anything, subject to occurs check.
 *   4. Compound types unify pointwise on their structure.
 *   5. Anything else fails.
 *
 * `Unknown` is treated as the top type — it unifies with everything and
 * never extends the substitution.  This keeps the checker compatible with
 * existing code paths that produce Unknown on parse/elaboration errors.
 */
export function unify(a: SiliconType, b: SiliconType, s: Subst = emptySubst()): Subst {
    const ra = applySubst(a, s)
    const rb = applySubst(b, s)

    // Top: Unknown propagates without constraining.
    if (ra.kind === 'Unknown' || rb.kind === 'Unknown') return s

    // Variable on either side.
    if (ra.kind === 'Variable') return bindVar(ra.name, rb, s)
    if (rb.kind === 'Variable') return bindVar(rb.name, ra, s)

    // Same primitive kind.
    if (ra.kind === rb.kind && isPrimitiveKind(ra.kind)) return s

    // Same compound kind — recurse.
    if (ra.kind === 'Array' && rb.kind === 'Array') {
        return unify(ra.element, rb.element, s)
    }
    if (ra.kind === 'Function' && rb.kind === 'Function') {
        if (ra.params.length !== rb.params.length) {
            throw new UnifyError(ra, rb, `function arity mismatch: ${ra.params.length} vs ${rb.params.length}`)
        }
        let acc = s
        for (let i = 0; i < ra.params.length; i++) acc = unify(ra.params[i], rb.params[i], acc)
        return unify(ra.result, rb.result, acc)
    }
    if (ra.kind === 'Sum' && rb.kind === 'Sum') {
        if (ra.name !== rb.name) throw new UnifyError(ra, rb)
        const aArgs = ra.typeArgs ?? []
        const bArgs = rb.typeArgs ?? []
        if (aArgs.length !== bArgs.length) throw new UnifyError(ra, rb, `'${ra.name}' arity mismatch`)
        let acc = s
        for (let i = 0; i < aArgs.length; i++) acc = unify(aArgs[i], bArgs[i], acc)
        return acc
    }
    if (ra.kind === 'Distinct' && rb.kind === 'Distinct') {
        if (ra.name !== rb.name) throw new UnifyError(ra, rb)
        return s
    }

    throw new UnifyError(ra, rb)
}

function bindVar(name: string, t: SiliconType, s: Subst): Subst {
    // ?T = ?T  — already equal, nothing to bind.
    if (t.kind === 'Variable' && t.name === name) return s
    if (occursIn(name, t)) {
        throw new UnifyError({ kind: 'Variable', name }, t, `occurs check: ${name} appears in ${formatForError(t)}`)
    }
    const next: Subst = new Map(s)
    next.set(name, t)
    return next
}

function isPrimitiveKind(k: SiliconType['kind']): boolean {
    return k === 'Int' || k === 'Int64' || k === 'Float'
        || k === 'String' || k === 'Bool' || k === 'Void'
}

// ---------------------------------------------------------------------------
// Scheme instantiation
// ---------------------------------------------------------------------------

/**
 * Instantiate a polymorphic scheme by replacing each bound type variable
 * with a fresh `?Ti`.  Called at every call site of a polymorphic function /
 * variant constructor — each invocation gets its own fresh vars, so two
 * separate calls to `id` can be inferred to different concrete types
 * without contaminating each other.
 */
export function instantiate(scheme: Scheme, fresh: FreshGen): SiliconType {
    if (scheme.tvars.length === 0) return scheme.type
    const subst: Subst = new Map()
    for (const tv of scheme.tvars) subst.set(tv, fresh.next(tv))
    return applySubst(scheme.type, subst)
}
