// SPDX-License-Identifier: MIT
/**
 * WAT → WASM binary conversion using the wabt npm package.
 *
 * wabt is the reference WebAssembly Binary Toolkit compiled to JS/WASM.
 * It uses the same parser as wat2wasm and handles the mixed folded/unfolded
 * WAT syntax that Sigil's emitter produces.
 *
 * Initialised once at module load via top-level await so subsequent calls
 * can be synchronous (D-E prerequisite — the comptime engine needs sync
 * compilation to pre-compile strata handlers during buildStrataRegistry).
 */

import WabtFactory from 'wabt'

type WabtModule = Awaited<ReturnType<typeof WabtFactory>>

// Top-level await — Bun supports this in ESM.  Module evaluation blocks
// until wabt is ready, so any caller that imports from this module gets
// a fully-initialised wabt.
const _wabt: WabtModule = await WabtFactory()

/**
 * Convert a WAT text string to a WASM binary.
 * Throws a descriptive error if the WAT is invalid.
 */
export async function watToWasm(wat: string): Promise<Uint8Array> {
    return watToWasmSync(wat)
}

/**
 * Synchronous WAT → WASM.  Safe to call from anywhere in this module's
 * dependency tree because wabt was initialised at module load.
 */
export function watToWasmSync(wat: string): Uint8Array {
    const m = _wabt.parseWat('module.wat', wat, { mutableGlobals: true })
    const { buffer } = m.toBinary({})
    m.destroy()
    return new Uint8Array(buffer)
}
