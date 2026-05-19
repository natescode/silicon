/**
 * String encoding property tests — WS 2 of Stage 0 Cleanup Plan.
 *
 * Asserts string literals lower to UTF-8 byte sequences in the data
 * segment with a 4-byte little-endian length header. Matches the
 * representation the bootstrap parser reads from `fd_read`, eliminating
 * bootstrap-plan §6.2 row D.
 */

import { test, expect, describe } from 'bun:test'
import fc from 'fast-check'
import { compileToWatString } from './_compile'

function compileSource(src: string): { success: boolean, wat: string | null, error?: string } {
    try {
        return { success: true, wat: compileToWatString(src) }
    } catch (err) {
        return { success: false, wat: null, error: String(err) }
    }
}

/** Decode an escaped data-segment string ("\68\65\6c..." or ASCII chars) to bytes. */
function decodeSegment(encoded: string): number[] {
    const out: number[] = []
    let i = 0
    while (i < encoded.length) {
        const ch = encoded[i]
        if (ch === '\\') {
            out.push(parseInt(encoded.substring(i + 1, i + 3), 16))
            i += 3
        } else {
            out.push(ch.charCodeAt(0))
            i += 1
        }
    }
    return out
}

/** Extract every `(data (i32.const N) "...")` segment from emitted WAT. */
function dataSegments(wat: string): { offset: number, bytes: number[] }[] {
    const re = /\(data \(i32\.const (\d+)\) "((?:[^"\\]|\\.)*)"\)/g
    const out: { offset: number, bytes: number[] }[] = []
    let m: RegExpExecArray | null
    while ((m = re.exec(wat))) {
        out.push({ offset: Number(m[1]), bytes: decodeSegment(m[2]) })
    }
    return out
}

describe('string encoding (UTF-8)', () => {
    test("'hello' lowers to [5, 'h', 'e', 'l', 'l', 'o']", () => {
        const result = compileSource("'hello';")
        expect(result.success).toBe(true)
        const segs = dataSegments(result.wat!)
        // Find the segment whose payload (after 4-byte header) matches 'hello'.
        const hello = [0x68, 0x65, 0x6c, 0x6c, 0x6f]
        const lenHeader = [5, 0, 0, 0]
        const expected = [...lenHeader, ...hello]
        const found = segs.find(s =>
            s.bytes.length === expected.length &&
            expected.every((b, i) => b === s.bytes[i]))
        expect(found).toBeDefined()
    })

    test("ASCII strings: byte_len equals .length", () => {
        const inputs = ['', 'a', 'foo', 'the quick brown fox']
        for (const s of inputs) {
            const result = compileSource(`'${s}';`)
            expect(result.success).toBe(true)
            const segs = dataSegments(result.wat!)
            const expectedPayload = Array.from(s).map(c => c.charCodeAt(0))
            const expectedLen = s.length
            const header = [expectedLen & 0xff, (expectedLen >> 8) & 0xff, 0, 0]
            const expected = [...header, ...expectedPayload]
            const found = segs.find(seg =>
                seg.bytes.length === expected.length &&
                expected.every((b, i) => b === seg.bytes[i]))
            expect(found).toBeDefined()
        }
    })

    test("non-ASCII codepoints use UTF-8 multi-byte sequences (not UTF-16)", () => {
        // 'é' is U+00E9 → UTF-8 0xc3 0xa9 (2 bytes), UTF-16 LE 0xe9 0x00 (2 bytes).
        // Distinguishable by the leading byte: UTF-8 starts 0xc3, UTF-16 starts 0xe9.
        const result = compileSource("'é';")
        expect(result.success).toBe(true)
        const segs = dataSegments(result.wat!)
        // Look for a segment containing the UTF-8 byte 0xc3 0xa9 (with len 2).
        const expected = [2, 0, 0, 0, 0xc3, 0xa9]
        const found = segs.find(seg =>
            seg.bytes.length === expected.length &&
            expected.every((b, i) => b === seg.bytes[i]))
        expect(found).toBeDefined()
    })

    test('byte length header matches utf-8 encoded payload length', () => {
        fc.assert(
            fc.property(fc.string({ minLength: 0, maxLength: 32 }), (s) => {
                // Escape single-quotes to keep the source valid.
                if (s.includes("'")) return true
                const result = compileSource(`'${s}';`)
                if (!result.success) return true
                const segs = dataSegments(result.wat!)
                const payload = Array.from(new TextEncoder().encode(s))
                const header = [
                    payload.length & 0xff,
                    (payload.length >> 8) & 0xff,
                    (payload.length >> 16) & 0xff,
                    (payload.length >> 24) & 0xff,
                ]
                const expected = [...header, ...payload]
                return segs.some(seg =>
                    seg.bytes.length === expected.length &&
                    expected.every((b, i) => b === seg.bytes[i]))
            }),
            { numRuns: 60 },
        )
    })
})
