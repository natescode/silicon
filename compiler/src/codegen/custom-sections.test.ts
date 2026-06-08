// SPDX-License-Identifier: MIT
/**
 * Tier-1: the `name` and `producers` custom sections (ADR-0006 emitter).
 *
 * We assert the emitted binary carries the expected debug names and producer
 * metadata. Names/strings are UTF-8 in the section bodies, so a latin1 view of
 * the bytes lets us substring-match them directly — and `validateWasmBinary`
 * confirms the hand-rolled sections are still spec-valid.
 */

import { test, expect, describe } from 'bun:test'
import { compile } from '../caas'
import { validateWasmBinary } from './wasm-validator'

function binOf(src: string, compilerVersion?: string): Uint8Array {
    const r = compile(src, { emitBinary: true, ...(compilerVersion ? { compilerVersion } : {}) } as any)
    expect(r.diagnostics.map(d => `${d.code}: ${d.message}`)).toEqual([])
    expect(r.binary).toBeDefined()
    return r.binary!
}

/** latin1 view: each byte maps 1:1 to a char, so ASCII substrings match. */
function asText(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('latin1')
}

const SRC = `\\\\ add_two (Int, Int) -> Int
@fn add_two first, second := { first + second };
@export add_two;`

describe('name custom section', () => {
    test('carries the function name and parameter names', () => {
        const text = asText(binOf(SRC))
        expect(text).toContain('name')        // the custom-section name
        expect(text).toContain('add_two')     // function name (subsection 1)
        expect(text).toContain('first')       // param/local name (subsection 2)
        expect(text).toContain('second')
    })

    test('the binary stays spec-valid with the name section', () => {
        expect(validateWasmBinary(binOf(SRC)).ok).toBe(true)
    })
})

describe('producers custom section', () => {
    test('stamps language=Silicon and processed-by=sigilc/<version>', () => {
        const text = asText(binOf(SRC, '9.9.9'))
        expect(text).toContain('producers')
        expect(text).toContain('language')
        expect(text).toContain('Silicon')
        expect(text).toContain('processed-by')
        expect(text).toContain('sigilc')
        expect(text).toContain('9.9.9')
    })

    test('version field is omitted-but-present (empty) when no version is supplied', () => {
        // Still valid and still names sigilc; the version string is just empty.
        const text = asText(binOf(SRC))
        expect(text).toContain('sigilc')
        expect(validateWasmBinary(binOf(SRC)).ok).toBe(true)
    })
})
