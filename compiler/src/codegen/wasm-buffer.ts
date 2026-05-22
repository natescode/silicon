/**
 * WasmBuffer — accumulates bytes for WASM binary section construction.
 *
 * Usage pattern:
 *   const section = new WasmBuffer()
 *   section.u8(0x60)          // functype indicator
 *   section.vec([0x7f, 0x7f]) // two i32 params
 *   mainBuf.section(1, section) // write type section with auto length-prefix
 */

import { uleb128, sleb128i32, sleb128i64 } from './leb'

export class WasmBuffer {
    private bytes: number[] = []

    /** Current number of bytes in the buffer. */
    get length(): number { return this.bytes.length }

    /** Append a single raw byte (0–255). */
    u8(v: number): this {
        this.bytes.push(v & 0xff)
        return this
    }

    /** Append multiple raw bytes. */
    raw(vs: number[] | Uint8Array): this {
        for (const b of vs) this.bytes.push(b & 0xff)
        return this
    }

    /** Append a ULEB128-encoded unsigned integer. */
    u32(v: number): this {
        return this.raw(uleb128(v))
    }

    /** Append a SLEB128-encoded signed 32-bit integer. */
    i32(v: number): this {
        return this.raw(sleb128i32(v))
    }

    /** Append a SLEB128-encoded signed 64-bit integer. */
    i64(v: bigint): this {
        return this.raw(sleb128i64(v))
    }

    /** Append a 32-bit IEEE 754 float in little-endian byte order. */
    f32(v: number): this {
        const buf = new ArrayBuffer(4)
        new DataView(buf).setFloat32(0, v, true)
        return this.raw(new Uint8Array(buf))
    }

    /** Append a 64-bit IEEE 754 float in little-endian byte order. */
    f64(v: number): this {
        const buf = new ArrayBuffer(8)
        new DataView(buf).setFloat64(0, v, true)
        return this.raw(new Uint8Array(buf))
    }

    /**
     * Append a WASM vector: ULEB128 count followed by each element's bytes.
     * Elements may be raw byte values (number) or pre-built byte arrays.
     */
    vec(items: (number | number[] | Uint8Array)[]): this {
        this.u32(items.length)
        for (const item of items) {
            if (typeof item === 'number') this.u8(item)
            else this.raw(item)
        }
        return this
    }

    /**
     * Append a UTF-8 string as a WASM name: ULEB128 byte-length + bytes.
     * (Used in import/export name fields.)
     */
    name(s: string): this {
        const encoded = new TextEncoder().encode(s)
        this.u32(encoded.length)
        return this.raw(encoded)
    }

    /**
     * Append the contents of another WasmBuffer, length-prefixed with ULEB128.
     * This is the standard WASM section body encoding.
     */
    prefixed(inner: WasmBuffer): this {
        this.u32(inner.length)
        return this.raw(inner.toUint8Array())
    }

    /**
     * Write a complete WASM section: section-id byte, ULEB128 content-length,
     * then the content of `inner`.
     */
    section(id: number, inner: WasmBuffer): this {
        this.u8(id)
        return this.prefixed(inner)
    }

    /** Return accumulated bytes as a Uint8Array. */
    toUint8Array(): Uint8Array {
        return new Uint8Array(this.bytes)
    }
}
