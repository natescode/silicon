// SPDX-License-Identifier: MIT
/**
 * ADR 0018 Phase 1 — the Asyncify host reactor (the driver half of blocking
 * `@await`).
 *
 * The Asyncify-instrumented guest (see `asyncify.ts`) suspends by calling
 * `asyncify_start_unwind` from inside a host-async import and unwinding back to
 * the host; the host awaits the real Promise, then re-enters the SAME export to
 * rewind to the suspension point and resume.  This module wraps the host-async
 * imports and drives that unwind → await → rewind loop, turning the one-shot
 * `_start` host into a reactor (ADR 0018 §3 P2).  It works on ANY engine
 * (V8/JSC/Bun/SpiderMonkey/native) — Asyncify needs no host async feature.
 *
 * v1 is single-in-flight (one suspended computation at a time, the `setjmp`
 * model the ADR scopes for Phase 1); many-in-flight tasks are the poll-reactor
 * (Phase 4 / F3).  The asyncify "stack" lives in a fresh memory page reserved at
 * bind time, so it never collides with the program's bump heap.
 */

export interface AsyncReactor {
    /** Host-async imports wrapped to participate in the unwind/rewind protocol.
     *  Spread these into the import object (e.g. under `env`). */
    readonly imports: Record<string, (...args: number[]) => number>
    /** Wire the reactor to the instantiated module (sets up the asyncify-stack
     *  region and captures the control exports). Call once after instantiate. */
    bind(instance: WebAssembly.Instance): void
    /** Run `entry` to completion, awaiting any suspensions. `entry` must re-invoke
     *  the same export (rewind re-enters it): `() => instance.exports.run(x)`. */
    run(entry: () => number): Promise<number>
}

type AsyncImport = (...args: number[]) => number | Promise<number>

/**
 * Build a reactor over a set of host-async imports.  Each `asyncImports[name]`
 * may return a value or a Promise; when it returns a Promise the guest suspends
 * until it settles.
 */
export function createAsyncReactor(asyncImports: Record<string, AsyncImport>): AsyncReactor {
    let instance: WebAssembly.Instance
    let dataAddr = 0
    let rewinding = false
    let pending: Promise<number> | null = null
    let resolved = 0

    const ex = () => instance.exports as any

    const imports: Record<string, (...a: number[]) => number> = {}
    for (const [name, fn] of Object.entries(asyncImports)) {
        imports[name] = (...args: number[]): number => {
            if (!rewinding) {
                // First entry into this import: kick off the async work and unwind.
                pending = Promise.resolve(fn(...args))
                ex().asyncify_start_unwind(dataAddr)
                return 0   // placeholder — discarded as the stack unwinds
            }
            // Re-entry on the rewind pass: stop rewinding and yield the result.
            // Clear `rewinding` HERE (not after the entry returns): once this
            // import resumes, execution is normal again, so the NEXT suspension
            // in the same function must unwind freshly rather than reuse this
            // resolved value.
            ex().asyncify_stop_rewind()
            rewinding = false
            return resolved
        }
    }

    return {
        imports,
        bind(inst: WebAssembly.Instance): void {
            instance = inst
            const mem = (inst.exports as any).memory as WebAssembly.Memory
            // Reserve a fresh 64KiB page for the asyncify stack so it never
            // overlaps the program's linear-memory bump heap.
            const prevPages = mem.grow(1)
            dataAddr = prevPages * 65536
            // Asyncify data struct: [dataAddr]=current stack ptr, [dataAddr+4]=end.
            new Int32Array(mem.buffer, dataAddr, 2).set([dataAddr + 8, dataAddr + 65536])
        },
        async run(entry: () => number): Promise<number> {
            let result = entry()
            // state: 0 normal · 1 unwinding (a suspension is pending) · 2 rewinding
            while (ex().asyncify_get_state() === 1) {
                ex().asyncify_stop_unwind()
                resolved = await pending!
                rewinding = true
                ex().asyncify_start_rewind(dataAddr)
                result = entry()   // `rewinding` is cleared inside the resuming import
            }
            return result
        },
    }
}
