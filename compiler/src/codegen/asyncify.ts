// SPDX-License-Identifier: MIT
/**
 * ADR 0018 Phase 1 — the Asyncify transform (the portable blocking-`@await`
 * baseline, route A).
 *
 * Runs Binaryen's `asyncify` pass over an emitted wasm binary, instrumenting it
 * with the unwind/rewind state machine that lets a synchronous-looking guest
 * suspend on ANY engine — V8, JSC/Bun, SpiderMonkey, native — with no host async
 * feature required (§2.1: Asyncify is the permanent floor because JSPI is absent
 * on JSC/Bun today).  `binaryen` v117 is already a dependency.
 *
 * The pass adds the exported control functions the host reactor drives:
 *   asyncify_start_unwind(ptr) · asyncify_stop_unwind()
 *   asyncify_start_rewind(ptr)  · asyncify_stop_rewind()
 *   asyncify_get_state() → 0 normal | 1 unwinding | 2 rewinding
 * and a small linear-memory "asyncify stack" region the guest's live locals are
 * serialized into across a suspension.  See `runAsyncReactor` in
 * `cli/src/host/js-host.ts` for the driver, and `asyncify.test.ts` for the
 * end-to-end round-trip.
 *
 * v1 is route A — whole-program instrumentation (every import call is a possible
 * suspension point; only the host-async ones actually unwind).  An optional
 * `suspendingImports` list narrows instrumentation to the named imports (the
 * precise-coloring step toward route B, recovering most of the size tax).
 */

import binaryen from 'binaryen'

export interface AsyncifyOptions {
    /** `module.field` import names that may suspend; when given, only these are
     *  instrumented (Binaryen `asyncify-imports`).  Omit for whole-program. */
    suspendingImports?: string[]
    /** Binaryen optimize level for the pass (default 1 — recommended; an
     *  un-optimized asyncify binary explodes in size, ADR 0018 §5). */
    optimizeLevel?: number
}

/** Apply Binaryen's Asyncify pass to `bin`, returning the instrumented binary. */
export function applyAsyncify(bin: Uint8Array, opts: AsyncifyOptions = {}): Uint8Array {
    const mod = binaryen.readBinary(bin)
    try {
        binaryen.setOptimizeLevel(opts.optimizeLevel ?? 1)
        if (opts.suspendingImports && opts.suspendingImports.length > 0) {
            // e.g. "env.http_get,env.timer" — restrict suspension points.
            const list = opts.suspendingImports.map(s => s.includes('.') ? s : `env.${s}`).join(',')
            ;(binaryen as any).setPassArgument?.('asyncify-imports', list)
        }
        mod.runPasses(['asyncify'])
        return mod.emitBinary()
    } finally {
        ;(binaryen as any).clearPassArguments?.()
        mod.dispose()
    }
}
