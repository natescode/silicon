// SPDX-License-Identifier: MIT
/**
 * WAT → WASM binary conversion using the wabt npm package.
 *
 * This is a Node/Bun convenience for callers that have a WAT *string* and want
 * a binary (e.g. tooling, the legacy playground server). The compiler's own
 * codegen no longer needs it — compileToWasm/irModuleToWasm assemble binaries
 * directly from IR (including funcref/call_indirect), so the browser bundle
 * never pulls wabt in.
 *
 * wabt is initialised lazily on first use (no top-level await) so that merely
 * importing this module has no side effect and bundlers can tree-shake it away
 * when `watToWasm` is unused.
 */

type WabtModule = Awaited<ReturnType<typeof import('wabt')['default']>>

let _wabt: WabtModule | null = null

/**
 * Convert a WAT text string to a WASM binary. Throws on invalid WAT.
 *
 * wabt is loaded via a lazy dynamic import so it's pulled in only when this
 * function is actually called. The browser playground marks `wabt` external
 * and never calls this (it assembles binaries directly from IR), so wabt
 * stays out of the bundle entirely.
 */
export async function watToWasm(wat: string): Promise<Uint8Array> {
    if (!_wabt) {
        const { default: WabtFactory } = await import('wabt')
        _wabt = await WabtFactory()
    }
    const m = _wabt.parseWat('module.wat', wat, { mutableGlobals: true })
    // write_debug_names preserves the WAT `$func`/`$local` symbols into the
    // binary's `name` custom section, matching the direct emitter (Tier-1 DX).
    const { buffer } = m.toBinary({ write_debug_names: true })
    m.destroy()
    return new Uint8Array(buffer)
}
