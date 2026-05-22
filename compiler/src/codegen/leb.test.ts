import { test, expect } from "bun:test"
import { uleb128, sleb128i32, sleb128i64, uleb128Size } from "./leb"
import { WasmBuffer } from "./wasm-buffer"

// ── ULEB128 ──────────────────────────────────────────────────────────────────

test("uleb128 encodes 0", () => {
    expect(uleb128(0)).toEqual([0x00])
})

test("uleb128 encodes 1", () => {
    expect(uleb128(1)).toEqual([0x01])
})

test("uleb128 encodes 127 as single byte", () => {
    expect(uleb128(127)).toEqual([0x7f])
})

test("uleb128 encodes 128 as two bytes", () => {
    // 128 = 0b10000000 → [0x80, 0x01]
    expect(uleb128(128)).toEqual([0x80, 0x01])
})

test("uleb128 encodes 300", () => {
    // 300 = 0x12C → low 7 bits = 0x2C | 0x80, high = 0x02
    expect(uleb128(300)).toEqual([0xac, 0x02])
})

test("uleb128 encodes 624485 (spec example)", () => {
    // From the LEB128 Wikipedia example
    expect(uleb128(624485)).toEqual([0xe5, 0x8e, 0x26])
})

test("uleb128 encodes 2^28 correctly", () => {
    const v = 0x10000000
    const encoded = uleb128(v)
    let decoded = 0
    for (let i = encoded.length - 1; i >= 0; i--) decoded = (decoded << 7) | (encoded[i] & 0x7f)
    expect(decoded).toBe(v)
})

// ── SLEB128 i32 ──────────────────────────────────────────────────────────────

test("sleb128i32 encodes 0", () => {
    expect(sleb128i32(0)).toEqual([0x00])
})

test("sleb128i32 encodes 1", () => {
    expect(sleb128i32(1)).toEqual([0x01])
})

test("sleb128i32 encodes -1", () => {
    expect(sleb128i32(-1)).toEqual([0x7f])
})

test("sleb128i32 encodes 63", () => {
    expect(sleb128i32(63)).toEqual([0x3f])
})

test("sleb128i32 encodes 64 as two bytes (sign extension)", () => {
    // 64 = 0b01000000 — the 0x40 bit looks like a sign bit, so needs continuation
    expect(sleb128i32(64)).toEqual([0xc0, 0x00])
})

test("sleb128i32 encodes -64", () => {
    expect(sleb128i32(-64)).toEqual([0x40])
})

test("sleb128i32 encodes -65 as two bytes", () => {
    expect(sleb128i32(-65)).toEqual([0xbf, 0x7f])
})

test("sleb128i32 encodes 128", () => {
    expect(sleb128i32(128)).toEqual([0x80, 0x01])
})

test("sleb128i32 encodes -128", () => {
    expect(sleb128i32(-128)).toEqual([0x80, 0x7f])
})

// ── SLEB128 i64 ──────────────────────────────────────────────────────────────

test("sleb128i64 encodes 0n", () => {
    expect(sleb128i64(0n)).toEqual([0x00])
})

test("sleb128i64 encodes -1n", () => {
    expect(sleb128i64(-1n)).toEqual([0x7f])
})

test("sleb128i64 encodes 2^32 (exceeds i32 range)", () => {
    const v = 4294967296n // 2^32
    const encoded = sleb128i64(v)
    // Decode it back
    let decoded = 0n
    let shift = 0n
    for (const byte of encoded) {
        decoded |= BigInt(byte & 0x7f) << shift
        shift += 7n
    }
    expect(decoded).toBe(v)
})

test("sleb128i64 encodes negative i64", () => {
    const v = -9999999999n
    const encoded = sleb128i64(v)
    // Decode with sign extension
    let decoded = 0n
    let shift = 0n
    let last = 0
    for (const byte of encoded) {
        decoded |= BigInt(byte & 0x7f) << shift
        shift += 7n
        last = byte
    }
    // Sign extend
    if (last & 0x40) decoded |= -(1n << shift)
    expect(decoded).toBe(v)
})

// ── uleb128Size ───────────────────────────────────────────────────────────────

test("uleb128Size returns 1 for values 0..127", () => {
    expect(uleb128Size(0)).toBe(1)
    expect(uleb128Size(127)).toBe(1)
})

test("uleb128Size returns 2 for values 128..16383", () => {
    expect(uleb128Size(128)).toBe(2)
    expect(uleb128Size(16383)).toBe(2)
})

test("uleb128Size matches actual encoded length", () => {
    for (const v of [0, 1, 127, 128, 255, 300, 16383, 16384, 65535, 624485]) {
        expect(uleb128Size(v)).toBe(uleb128(v).length)
    }
})

// ── WasmBuffer ────────────────────────────────────────────────────────────────

test("WasmBuffer u8 appends a byte", () => {
    const b = new WasmBuffer()
    b.u8(0x42)
    expect(b.toUint8Array()).toEqual(new Uint8Array([0x42]))
})

test("WasmBuffer u32 appends ULEB128", () => {
    const b = new WasmBuffer()
    b.u32(300)
    expect(b.toUint8Array()).toEqual(new Uint8Array([0xac, 0x02]))
})

test("WasmBuffer i32 appends SLEB128", () => {
    const b = new WasmBuffer()
    b.i32(-1)
    expect(b.toUint8Array()).toEqual(new Uint8Array([0x7f]))
})

test("WasmBuffer f32 encodes IEEE 754 little-endian", () => {
    const b = new WasmBuffer()
    b.f32(1.0)
    expect(b.toUint8Array()).toEqual(new Uint8Array([0x00, 0x00, 0x80, 0x3f]))
})

test("WasmBuffer f64 encodes IEEE 754 little-endian", () => {
    const b = new WasmBuffer()
    b.f64(1.0)
    expect(b.toUint8Array()).toEqual(new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f]))
})

test("WasmBuffer vec writes count then items", () => {
    const b = new WasmBuffer()
    b.vec([0x7f, 0x7f]) // two i32 val types
    expect(b.toUint8Array()).toEqual(new Uint8Array([0x02, 0x7f, 0x7f]))
})

test("WasmBuffer name writes ULEB128 length then UTF-8 bytes", () => {
    const b = new WasmBuffer()
    b.name("add")
    expect(b.toUint8Array()).toEqual(new Uint8Array([0x03, 0x61, 0x64, 0x64]))
})

test("WasmBuffer section writes id + length-prefixed content", () => {
    const inner = new WasmBuffer()
    inner.u8(0x01) // one type entry (placeholder)

    const b = new WasmBuffer()
    b.section(1, inner)

    // section id=1, size=1 byte (uleb128), then the content byte
    expect(b.toUint8Array()).toEqual(new Uint8Array([0x01, 0x01, 0x01]))
})

test("WasmBuffer prefixed writes ULEB128 length then content", () => {
    const inner = new WasmBuffer()
    inner.raw([0xaa, 0xbb])

    const b = new WasmBuffer()
    b.prefixed(inner)

    expect(b.toUint8Array()).toEqual(new Uint8Array([0x02, 0xaa, 0xbb]))
})

test("WasmBuffer length tracks byte count", () => {
    const b = new WasmBuffer()
    expect(b.length).toBe(0)
    b.u8(0x01)
    expect(b.length).toBe(1)
    b.u32(128) // 2 bytes
    expect(b.length).toBe(3)
})
