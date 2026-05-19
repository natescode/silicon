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
 */
export async function watToWasm(wat: string): Promise<Uint8Array> {
    const w = await wabt()
    const m = w.parseWat('module.wat', wat, { mutableGlobals: true })
    const { buffer } = m.toBinary({})
    m.destroy()
    return new Uint8Array(buffer)
}
