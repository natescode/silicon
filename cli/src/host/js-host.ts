// SPDX-License-Identifier: MIT
/**
 * Bun/JS host runner for the web/bun platform.
 *
 * `sgl run --platform=bun` executes a compiled module in-process under Bun's
 * `WebAssembly` (wasmtime can't provide the WASM JS String Builtins).  The
 * module is compiled with `{ builtins: ['js-string'] }` so `wasm:js-string`
 * imports resolve to the host's native JS-string operations, and a small import
 * object provides `env.print/read`, a String↔JSString bridge, and a base
 * Browser/Bun API surface (console, …).  The program's `_start` export (its
 * top-level statements) is then invoked.
 */

interface HostState { memory?: WebAssembly.Memory; alloc?: (n: number) => number }

/** Build the import object + a binder that captures the instance's memory/alloc. */
function buildImports(state: HostState, write: (s: string) => void) {
    // `env.print` receives one byte (or char code) at a time — accumulate and
    // flush on newline, matching the linear-memory `$print_string` convention.
    const buf: number[] = []
    const flush = () => { if (buf.length) { write(Buffer.from(buf).toString('utf-8')); buf.length = 0 } }

    /** Read a Silicon linear-memory string (4-byte LE length + UTF-8) → JS string. */
    const readLenString = (ptr: number): string => {
        if (!state.memory) return ''
        const view = new DataView(state.memory.buffer)
        const len = view.getInt32(ptr, true)
        return new TextDecoder('utf-8').decode(new Uint8Array(state.memory.buffer, ptr + 4, len))
    }
    /** Encode a JS string into a fresh linear-memory string, returning its ptr. */
    const allocLenString = (s: string): number => {
        if (!state.memory || !state.alloc) return 0
        const bytes = new TextEncoder().encode(s)
        const ptr = state.alloc(4 + bytes.length)
        const view = new DataView(state.memory.buffer)
        view.setInt32(ptr, bytes.length, true)
        new Uint8Array(state.memory.buffer, ptr + 4, bytes.length).set(bytes)
        return ptr
    }

    const imports: WebAssembly.Imports = {
        env: {
            print: (v: number) => { if (v === 10) flush(); else buf.push(v) },
            read: () => 0,
        },
        // String↔JSString bridge (W4): linear String ⇄ JS string (externref).
        'js-bridge': {
            string_to_js: (ptr: number) => readLenString(ptr),
            js_to_string: (s: string) => allocLenString(s),
        },
        // Base Browser/Bun API surface — externref-typed; users extend via @extern.
        console: {
            log: (s: unknown) => { flush(); write(String(s ?? '') + '\n') },
            error: (s: unknown) => { flush(); process.stderr.write(String(s ?? '') + '\n') },
        },
    }
    return { imports, flush }
}

/** Compile + instantiate `binary` under Bun with js-string builtins and run
 *  `_start`.  Returns the process exit code (0 on success). */
export async function runUnderBun(binary: Uint8Array): Promise<number> {
    const state: HostState = {}
    const { imports, flush } = buildImports(state, s => process.stdout.write(s))

    let module: WebAssembly.Module
    try {
        // The js-string builtins opt-in lives on compile (verified under Bun).
        module = await WebAssembly.compile(binary, { builtins: ['js-string'] } as WebAssembly.CompileOptions)
    } catch (e) {
        console.error(`sgl run: module failed to compile under Bun — ${(e as Error).message}`)
        console.error('  (the web/bun platform needs a Bun/JS host with JS String Builtins support)')
        return 1
    }

    const instance = await WebAssembly.instantiate(module, imports)
    const ex = instance.exports as Record<string, unknown>
    if (ex.memory instanceof WebAssembly.Memory) state.memory = ex.memory
    if (typeof ex.alloc === 'function') state.alloc = ex.alloc as (n: number) => number

    try {
        if (typeof ex._start === 'function') (ex._start as () => void)()
        else if (typeof ex.main === 'function') (ex.main as () => void)()
    } catch (e) {
        flush()
        console.error(`sgl run: trap — ${(e as Error).message}`)
        return 1
    }
    flush()
    return 0
}
