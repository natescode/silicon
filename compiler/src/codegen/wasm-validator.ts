// SPDX-License-Identifier: MIT
/**
 * wasm-validator — assert an emitted `.wasm` binary is spec-valid.
 *
 * Primary oracle: the `wasm-tools validate` CLI (Bytecode Alliance), the
 * canonical, engine-INDEPENDENT implementation of the WebAssembly validation
 * algorithm. When the CLI isn't on `PATH` (e.g. a CI runner without it) we fall
 * back to the host engine's validator (Bun/JSC `new WebAssembly.Module`), which
 * is the platform Silicon's web/Bun gate targets and supports WasmGC by default.
 * Either way the verdict is reported with `via` so logs show which oracle ran.
 *
 * `--features all` is passed so wasm-gc / bulk-memory / etc. validate under one
 * invocation, and the bytes are piped over stdin (`-`) so no temp files are used.
 *
 * Install the CLI with: `cargo install wasm-tools` (or a prebuilt release).
 */

export interface ValidationResult {
    readonly ok: boolean
    /** Present only when `ok === false`. */
    readonly error?: string
    /** Which oracle produced the verdict. */
    readonly via?: 'wasm-tools' | 'engine'
}

// Probe `PATH` once. `undefined` = not yet probed; `null` = absent.
let wasmToolsPath: string | null | undefined

/** Absolute path to `wasm-tools` on `PATH`, or null when unavailable. */
export function wasmToolsAvailable(): string | null {
    if (wasmToolsPath === undefined) {
        try { wasmToolsPath = typeof Bun !== 'undefined' ? Bun.which('wasm-tools') : null }
        catch { wasmToolsPath = null }
    }
    return wasmToolsPath
}

function validateWithWasmTools(bin: string, bytes: Uint8Array): ValidationResult {
    // `validate -` reads the binary from stdin; `--features all` enables wasm-gc,
    // bulk-memory, etc. so both targets validate under one invocation.
    const r = Bun.spawnSync([bin, 'validate', '--features', 'all', '-'], {
        stdin: bytes, stdout: 'ignore', stderr: 'pipe',
    })
    if (r.exitCode === 0) return { ok: true, via: 'wasm-tools' }
    const err = (r.stderr ? new TextDecoder().decode(r.stderr) : '').trim()
    return { ok: false, error: err || `wasm-tools validate exited ${r.exitCode}`, via: 'wasm-tools' }
}

function validateWithEngine(bytes: Uint8Array): ValidationResult {
    try {
        // Constructing a Module runs decode + validation. We don't keep it.
        new WebAssembly.Module(bytes)
        return { ok: true, via: 'engine' }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err), via: 'engine' }
    }
}

/** Validate a WASM binary — `wasm-tools` if installed, else the host engine. */
export function validateWasmBinary(bytes: Uint8Array): ValidationResult {
    const wt = wasmToolsAvailable()
    if (wt) {
        try { return validateWithWasmTools(wt, bytes) }
        catch { /* spawn failed (perms, etc.) — fall through to the engine */ }
    }
    return validateWithEngine(bytes)
}
