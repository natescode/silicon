/**
 * LEB128 encoding helpers for the WASM binary emitter.
 *
 * ULEB128: unsigned, used for section IDs, indices, counts, byte lengths.
 * SLEB128: signed, used for i32.const / i64.const immediate values.
 */

/** Encode an unsigned integer as ULEB128. `v` must be a non-negative integer. */
export function uleb128(v: number): number[] {
    const out: number[] = []
    do {
        let byte = v & 0x7f
        v >>>= 7
        if (v !== 0) byte |= 0x80
        out.push(byte)
    } while (v !== 0)
    return out
}

/** Encode a signed 32-bit integer as SLEB128. */
export function sleb128i32(v: number): number[] {
    const out: number[] = []
    let more = true
    while (more) {
        let byte = v & 0x7f
        v >>= 7
        // Sign bit of this group must match the continuation sign.
        if ((v === 0 && (byte & 0x40) === 0) || (v === -1 && (byte & 0x40) !== 0)) {
            more = false
        } else {
            byte |= 0x80
        }
        out.push(byte)
    }
    return out
}

/** Encode a signed 64-bit integer as SLEB128 (passed as BigInt). */
export function sleb128i64(v: bigint): number[] {
    const out: number[] = []
    let more = true
    while (more) {
        let byte = Number(v & 0x7fn)
        v >>= 7n
        if ((v === 0n && (byte & 0x40) === 0) || (v === -1n && (byte & 0x40) !== 0)) {
            more = false
        } else {
            byte |= 0x80
        }
        out.push(byte)
    }
    return out
}

/** Number of bytes needed to encode `v` as ULEB128. */
export function uleb128Size(v: number): number {
    let n = 0
    do { n++; v >>>= 7 } while (v !== 0)
    return n
}
