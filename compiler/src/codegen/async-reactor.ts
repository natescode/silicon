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

import { applyAsyncify } from './asyncify'

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

// ── The production reactor: JSPI fast path, else Asyncify route-B (ADR 0018) ──

export interface ReactorRun {
    /** Non-async imports (`{ env: { print, … }, … }`), spread as the base. */
    readonly baseImports: WebAssembly.Imports
    /** Promise-returning host impls of the suspending imports, keyed by the
     *  `module.field` name (e.g. `"env.fetch_json"`). */
    readonly asyncImpls: Record<string, AsyncImport>
    /** `module.field` names of the suspending imports (route-B coloring set). */
    readonly suspendingImports: string[]
    /** Export to drive (e.g. `"_start"` / `"run"`) and its args. */
    readonly entry: string
    readonly args?: number[]
    /** Called after instantiate (before the entry runs) to capture memory/alloc. */
    bind?(instance: WebAssembly.Instance): void
    /** Force a backend (default 'auto' = JSPI when available, else Asyncify).
     *  'asyncify' is also the right choice to cap the instrumentation cost or to
     *  match a non-JS target. */
    readonly backend?: 'auto' | 'jspi' | 'asyncify'
    /** Engine compile options (e.g. Bun's `{ builtins: ['js-string'] }`). */
    readonly compileOptions?: WebAssembly.CompileOptions
}

/**
 * ADR 0019 C2 — bind an instance's closure-callback trampolines into a
 * `closureToFn(handle)` helper for the host event glue.  A bindgen-generated
 * event binding (`addEventListener(type, callback)`, `setTimeout(cb, ms)`, …)
 * receives the closure as a handle; the host wraps it with `closureToFn` into a
 * plain JS function it can register/store, which dispatches back through the
 * exported `__closure_invoke_<k>` trampoline (k = arg count) with the captured
 * env intact.  The handle is engine-GC'd (under wasm-gc), so the callback stays
 * alive while the host holds it.
 */
export function makeClosureToFn(instance: WebAssembly.Instance): (handle: any) => (...args: number[]) => number {
    const ex = instance.exports as any
    return (handle: any) => (...args: number[]) => {
        const tramp = ex[`__closure_invoke_${args.length}`]
        if (typeof tramp !== 'function') throw new Error(`no closure trampoline for arity ${args.length}`)
        return tramp(handle, ...args)
    }
}

/** True when the host engine has JS Promise Integration (V8/Node 24+/Deno; and
 *  Bun ≥ 1.3 / JSC since `bun#20878` was resolved).  Both wrappers must be present. */
export function hasJSPI(): boolean {
    const W = WebAssembly as any
    return typeof W.Suspending === 'function' && typeof W.promising === 'function'
}

/** Split a `module.field` import name into its two parts (`field` may contain
 *  no further dots — extern fields are plain identifiers). */
function splitImport(name: string): [string, string] {
    const dot = name.indexOf('.')
    return dot === -1 ? ['env', name] : [name.slice(0, dot), name.slice(dot + 1)]
}

/** Shallow-merge per-module so adding async imports never drops base fields. */
function mergeImports(base: WebAssembly.Imports, add: Record<string, Record<string, any>>): WebAssembly.Imports {
    const out: any = {}
    for (const [mod, fields] of Object.entries(base)) out[mod] = { ...(fields as any) }
    for (const [mod, fields] of Object.entries(add)) out[mod] = { ...(out[mod] ?? {}), ...fields }
    return out
}

/**
 * Run a compiled module that has suspending imports, choosing the backend at
 * LOAD time from one vanilla binary (ADR 0018 §2.1):
 *   - **JSPI fast path** (when `hasJSPI()`): wrap each suspending import with
 *     `WebAssembly.Suspending`, instantiate the binary UNCHANGED, and drive the
 *     entry through `WebAssembly.promising` — the engine suspends the native
 *     stack, zero transform, zero size tax.
 *   - **Asyncify fallback** (Bun/JSC and everywhere else): instrument the binary
 *     with route-B precise coloring (`applyAsyncify({ suspendingImports })`,
 *     instrumenting only the functions that can reach a suspending import) and
 *     drive the unwind→await→rewind loop via `createAsyncReactor`.
 * Same Silicon source, same vanilla binary — only the host glue differs.
 */
export async function runWithReactor(binary: Uint8Array, opts: ReactorRun): Promise<any> {
    const placed: Record<string, Record<string, any>> = {}
    const place = (name: string, fn: any) => { const [m, f] = splitImport(name); (placed[m] ??= {})[f] = fn }
    const useJspi = opts.backend === 'jspi' || (opts.backend !== 'asyncify' && hasJSPI())

    const compileWasm = (bin: Uint8Array) => WebAssembly.compile(bin, opts.compileOptions as any)

    if (useJspi) {
        const W = WebAssembly as any
        for (const [name, fn] of Object.entries(opts.asyncImpls)) place(name, new W.Suspending(fn))
        const imports = mergeImports(opts.baseImports, placed)
        const instance = await WebAssembly.instantiate(await compileWasm(binary), imports)
        opts.bind?.(instance)
        const entry = (instance.exports as any)[opts.entry]
        const promising = W.promising(entry)
        // Pass the result through unchanged — it may be a scalar OR an externref
        // (a JSString/JSValue awaited from `Promise<string>`/`Promise<Response>`).
        return promising(...(opts.args ?? []))
    }

    // Asyncify: instrument (route B) then drive the reactor.  NOTE: Binaryen's
    // Asyncify does NOT support reference types (externref), so this fallback only
    // handles SCALAR awaited results; an externref async result requires JSPI
    // (Bun ≥ 1.3 / V8).  See binaryen#3739.
    const instrumented = applyAsyncify(binary, { suspendingImports: opts.suspendingImports })
    const reactor = createAsyncReactor(opts.asyncImpls)
    for (const [name, wrapped] of Object.entries(reactor.imports)) place(name, wrapped)
    const imports = mergeImports(opts.baseImports, placed)
    const instance = await WebAssembly.instantiate(await compileWasm(instrumented), imports)
    opts.bind?.(instance)
    reactor.bind(instance)
    return reactor.run(() => (instance.exports as any)[opts.entry](...(opts.args ?? [])))
}
