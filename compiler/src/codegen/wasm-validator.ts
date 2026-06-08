// SPDX-License-Identifier: MIT
/**
 * wasm-validator — assert an emitted `.wasm` binary is spec-valid.
 *
 * The `wasm-tools` CLI is not a build dependency, so we use the host engine's
 * own WebAssembly validator (Bun / JavaScriptCore). That engine is the exact
 * platform Silicon's web/Bun coverage gate targets, and a faithful spec oracle
 * — including WasmGC, which is default-on in JSC. `new WebAssembly.Module(bytes)`
 * runs the engine's full decode+validate pass and throws a descriptive
 * `CompileError` on any spec violation, which is strictly more informative than
 * `WebAssembly.validate` (a bare boolean), so we surface that message.
 *
 * This is intentionally engine-backed rather than a hand-rolled validator: the
 * point of the gate is to catch emitter regressions the codegen tests would
 * otherwise let through, measured against the same engine that will run the code.
 */

export interface ValidationResult {
    readonly ok: boolean
    /** Present only when `ok === false`. */
    readonly error?: string
}

/** Validate a WASM binary against the host engine's spec validator. */
export function validateWasmBinary(bytes: Uint8Array): ValidationResult {
    try {
        // Constructing a Module runs decode + validation. We don't keep it.
        new WebAssembly.Module(bytes)
        return { ok: true }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
}
