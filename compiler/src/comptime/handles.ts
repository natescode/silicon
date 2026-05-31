// SPDX-License-Identifier: MIT
/**
 * Handle table for the comptime-via-compilation host.
 *
 * Strata handler bodies, once compiled to WASM (Phase C), can't hold JS
 * references to AST nodes or template objects — those don't have a WASM
 * representation.  Instead, the host hands each object an opaque `i32`
 * identifier, and the WASM-side strata body passes that integer back into
 * import calls.  The host maps each `i32` back to the live object.
 *
 * This module is intentionally tiny and unaware of what's being handed
 * out — clients (`imports.ts`) drop in AST nodes, TemplateHandle objects,
 * state buckets, type values, strings, whatever.  The contract is just
 * "give me an id, give me back the object."
 */

/**
 * A bidirectional integer-handle table.
 *
 * Allocates monotonically increasing `i32` ids starting at 1.  `0` is
 * reserved as "no handle" / null sentinel so strata-side code can compare
 * against zero without ambiguity.
 *
 * The table is *per firing* by convention: client code creates a fresh
 * table for each handler invocation, hands ids out as the body runs, and
 * discards the table when the handler returns.  Persistent state lives in
 * the strata's `state('stratum')` bucket — handle ids do not carry across
 * firings.
 */
export class HandleTable<T> {
    private next = 1
    private byId = new Map<number, T>()
    private byObj = new Map<T, number>()

    /** Hand `value` a fresh id, or return its existing id if already tabled.
     *  Object identity is the key (===) for non-primitive values; for
     *  primitives, identity comparison is value equality, so identical
     *  primitives share an id.  Pass a wrapper if that's not desired. */
    intern(value: T): number {
        const existing = this.byObj.get(value)
        if (existing !== undefined) return existing
        const id = this.next++
        this.byId.set(id, value)
        this.byObj.set(value, id)
        return id
    }

    /** Hand `value` a new id even if it's already tabled.  Used when the
     *  caller specifically wants distinct ids per call site (rare). */
    fresh(value: T): number {
        const id = this.next++
        this.byId.set(id, value)
        this.byObj.set(value, id)
        return id
    }

    /** Look up the object behind an id, or `undefined` if the id is 0 or
     *  was released. */
    get(id: number): T | undefined {
        if (id === 0) return undefined
        return this.byId.get(id)
    }

    /** Release `id` from the table.  No-op if already gone.  Future
     *  lookups for this id return `undefined`. */
    release(id: number): void {
        const obj = this.byId.get(id)
        if (obj === undefined) return
        this.byId.delete(id)
        // Only remove the byObj entry if it still points at this id —
        // a fresh() could have allocated a newer id for the same value.
        if (this.byObj.get(obj) === id) this.byObj.delete(obj)
    }

    /** Number of currently-live handles.  Useful for leak checks in tests. */
    size(): number {
        return this.byId.size
    }

    /** Drop everything.  Called at end-of-firing teardown. */
    clear(): void {
        this.byId.clear()
        this.byObj.clear()
        this.next = 1
    }
}

/**
 * String pool — a specialised handle table for strings.
 *
 * Strings cross the WASM boundary as `i32` ids into this pool, not as
 * pointer+length pairs into WASM linear memory.  Reasons:
 *   - Strata bodies don't need to allocate strings in their own memory.
 *   - Host JS can hand back a JS string when an import returns one
 *     (e.g. `callee::name`) without needing to write into WASM memory.
 *   - Equality and dedup are automatic — same string content → same id.
 *
 * Phase C cost: every string-returning import does one Map lookup; every
 * string-arg import does one Map.get(id).  Negligible.
 */
export class StringPool {
    private next = 1
    private byId = new Map<number, string>()
    private byString = new Map<string, number>()

    /** Reserve id 0 as the empty / null-string sentinel.  Imports that
     *  receive `0` for a string argument should treat it as "no string". */
    static EMPTY = 0

    intern(s: string): number {
        if (s === '') return StringPool.EMPTY
        const existing = this.byString.get(s)
        if (existing !== undefined) return existing
        const id = this.next++
        this.byId.set(id, s)
        this.byString.set(s, id)
        return id
    }

    get(id: number): string {
        if (id === StringPool.EMPTY) return ''
        return this.byId.get(id) ?? ''
    }

    size(): number {
        return this.byId.size
    }

    clear(): void {
        this.byId.clear()
        this.byString.clear()
        this.next = 1
    }
}
