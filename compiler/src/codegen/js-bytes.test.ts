// SPDX-License-Identifier: MIT
/**
 * FFI follow-up #2 — bulk binary marshalling (guest linear memory ⇄ typed array).
 *
 * Host APIs that return binary (crypto::random_bytes, response::array_buffer,
 * file reads) hand back a Uint8Array/ArrayBuffer handle.  `js::bytes_out` bulk-
 * copies its bytes into guest linear memory; `js::bytes_in` copies guest bytes
 * out into a fresh Uint8Array.  Previously this was only doable one byte at a
 * time via js::get_index — these are the bulk path.
 */
import { describe, test, expect } from 'bun:test'
import { compile } from '../caas/index'
import { loadModules } from '../modules/loader'

const mods = loadModules(process.cwd())

function compileBin(src: string): Uint8Array {
    const r: any = compile(src, { file: 'm.si', moduleRegistry: mods, target: 'host', platform: 'bun', emitBinary: true } as any)
    expect(r.diagnostics ?? []).toEqual([])
    return r.binary
}

/** The `js` binary shim — shares the instance memory via `state` (mirrors js-host.ts). */
function makeHost() {
    const state: { memory?: WebAssembly.Memory } = {}
    const js = {
        byte_length: (h: any) => (h == null ? 0 : ((h.byteLength ?? h.length ?? 0) | 0)),
        u8: (h: any) => (h instanceof Uint8Array ? h : h instanceof ArrayBuffer ? new Uint8Array(h) : new Uint8Array(h.buffer, h.byteOffset, h.byteLength)),
        bytes_in: (ptr: number, len: number) => state.memory ? new Uint8Array(state.memory.buffer.slice(ptr, ptr + len)) : new Uint8Array(0),
        bytes_out: (h: any, ptr: number, len: number) => {
            if (!state.memory || h == null) return 0
            const src = h instanceof Uint8Array ? h : h instanceof ArrayBuffer ? new Uint8Array(h) : new Uint8Array(h.buffer, h.byteOffset, h.byteLength)
            const n = Math.min(len, src.length)
            new Uint8Array(state.memory.buffer, ptr, n).set(src.subarray(0, n))
            return n
        },
    }
    return { imports: { env: { print: () => {}, read: () => 0 }, js }, state }
}

async function instantiate(bin: Uint8Array) {
    const host = makeHost()
    const inst = new WebAssembly.Instance(await WebAssembly.compile(bin), host.imports)
    host.state.memory = (inst.exports as any).memory
    return { ex: inst.exports as any, mem: () => host.state.memory!.buffer }
}

const PROG = `\\\\ from_linear (Int, Int) -> JSValue
@fn from_linear ptr, len := { js::bytes_in(ptr, len) };
\\\\ to_linear (JSValue, Int, Int) -> Int
@fn to_linear src, dst, cap := { js::bytes_out(src, dst, cap) };
\\\\ blen (JSValue) -> Int
@fn blen h := { js::byte_length(h) };
@export from_linear;
@export to_linear;
@export blen;`

describe('FFI #2 — bulk binary marshalling', () => {
    test('bytes_in: guest linear memory → a host Uint8Array', async () => {
        const { ex, mem } = await instantiate(compileBin(PROG))
        const ptr = ex.alloc(16)
        new Uint8Array(mem(), ptr, 4).set([10, 20, 30, 40])
        const arr = ex.from_linear(ptr, 4)
        expect(arr).toBeInstanceOf(Uint8Array)
        expect([...arr]).toEqual([10, 20, 30, 40])
    })

    test('bytes_out: a host Uint8Array → guest linear memory (returns count)', async () => {
        const { ex, mem } = await instantiate(compileBin(PROG))
        const ptr = ex.alloc(16)
        const n = ex.to_linear(new Uint8Array([5, 6, 7]), ptr, 16)
        expect(n).toBe(3)
        expect([...new Uint8Array(mem(), ptr, 3)]).toEqual([5, 6, 7])
    })

    test('bytes_out clamps to the capacity', async () => {
        const { ex, mem } = await instantiate(compileBin(PROG))
        const ptr = ex.alloc(16)
        const n = ex.to_linear(new Uint8Array([1, 2, 3, 4, 5]), ptr, 2)   // cap 2
        expect(n).toBe(2)
        expect([...new Uint8Array(mem(), ptr, 2)]).toEqual([1, 2])
    })

    test('byte_length works for a typed array and an ArrayBuffer', async () => {
        const { ex } = await instantiate(compileBin(PROG))
        expect(ex.blen(new Uint8Array([1, 2, 3]))).toBe(3)
        expect(ex.blen(new ArrayBuffer(8))).toBe(8)
    })

    test('INTEGRATION: copy a host-produced byte buffer (ArrayBuffer) into guest memory', async () => {
        // The real win: a host API hands back binary; the guest reads it in bulk.
        const { ex, mem } = await instantiate(compileBin(`\\\\ ingest (JSValue, Int, Int) -> Int
@fn ingest buf, dst, cap := {
    \\\\ arr JSValue
    @mut arr := js::u8(buf);
    js::bytes_out(arr, dst, cap)
};
@export ingest;`))
        const ab = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]).buffer   // an ArrayBuffer, like response.arrayBuffer()
        const ptr = ex.alloc(16)
        const n = ex.ingest(ab, ptr, 16)
        expect(n).toBe(4)
        expect([...new Uint8Array(mem(), ptr, 4)]).toEqual([0xDE, 0xAD, 0xBE, 0xEF])
    })
})
