/**
 * WAT → WASM binary conversion using the wabt npm package.
 *
 * wabt is the reference WebAssembly Binary Toolkit compiled to JS/WASM.
 * It uses the same parser as wat2wasm and handles the mixed folded/unfolded
 * WAT syntax that Sigil's emitter produces.
 *
 * The module is async-initialized once and cached for subsequent calls.
 */

import WabtFactory from 'wabt'

type WabtModule = Awaited<ReturnType<typeof WabtFactory>>
let _wabt: WabtModule | null = null

async function wabt(): Promise<WabtModule> {
    if (!_wabt) _wabt = await WabtFactory()
    return _wabt
}

/**
 * Convert a WAT text string to a WASM binary.
 * Throws a descriptive error if the WAT is invalid.
 *
 * Now calls `module.validate()` between parse and toBinary. Previously this
 * was skipped, which meant invalid programs (e.g. `drop` after a void call,
 * stack-type mismatches) silently produced bytes that then failed inside
 * wasmtime at load time — a much worse failure mode because the WAT-level
 * source location is lost by then. Strict validation here surfaces codegen
 * bugs in src/ir/emit.ts (and boot/emit/wat.si) at compile time, which is
 * a prerequisite for the Silicon-only build path that uses standalone
 * wat2wasm (see docs/silicon-only-bootstrap-plan.html Phase 1.5).
 */
export async function watToWasm(wat: string): Promise<Uint8Array> {
    const w = await wabt()
    const m = w.parseWat('module.wat', wat, { mutableGlobals: true })
    try {
        m.validate()
    } catch (err) {
        m.destroy()
        throw new Error(
            `WAT validation failed (would have produced a wasm module ` +
            `that wasmtime rejects at load time): ${(err as Error).message}`
        )
    }
    const { buffer } = m.toBinary({})
    m.destroy()
    return new Uint8Array(buffer)
}
