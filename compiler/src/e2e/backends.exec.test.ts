// SPDX-License-Identifier: MIT
/**
 * QBE ↔ WASM execution-oracle parity.
 *
 * The QBE native backend re-implements operator lowering independently of the
 * strata/WASM path (`lookupOpToQbe`), so the two backends can silently drift.
 * This suite compiles each small program through BOTH backends and asserts
 * they produce the SAME integer result — a semantic gate the textual parity
 * checks in `backends.test.ts` can't provide.
 *
 *   - WASM runs in-process via Bun's WebAssembly (no wasmtime/wat2wasm needed).
 *   - Native runs via qbe → cc → process exit code.
 *
 * Scope: the QBE-supported, import-free subset — Int arithmetic / comparison /
 * bitwise, `@if`, locals + mutation, function calls, recursion. No strings /
 * structs / `@extern` / casts / arenas (unsupported on QBE). Results are kept
 * in 0..255 so the POSIX exit code faithfully matches the WASM i32.
 *
 * The native half auto-skips when `qbe`/`cc` are unavailable; the WASM half
 * always runs as a smoke check, so a toolchain-free CI shard still exercises
 * something. The surface-derived anti-drift gate that needs no toolchain lives
 * in `backends.test.ts`.
 */
import { describe, test, expect, afterAll } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { compileToTyped } from '../../tests/properties/_compile'
import { compileToWasm } from '../codegen'
import { compileToQbe } from '../native'
import { findQbe, invokeQbe, hostQbeArch } from '../../../cli/src/native/backend'
import { findCc, link } from '../../../cli/src/native/linker'

const QBE = findQbe()
const CC = findCc()
const NATIVE_OK = !!QBE && !!CC

const TMP = mkdtempSync(join(tmpdir(), 'sgl-parity-'))
let counter = 0
afterAll(() => { try { rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ } })

/** Compile `body` as `@fn probe := <body>` through the WASM backend and run it. */
function runWasm(body: string, prelude = ''): number {
    const src = `${prelude}\n\\\\ probe () -> Int\n@fn probe := ${body};\n@export probe;\n`
    const { typedAST, registry, functions, moduleRegistry } = compileToTyped(src)
    const bin = compileToWasm(typedAST, registry, functions, moduleRegistry)
    const mod = new WebAssembly.Module(bin)
    const instance = new WebAssembly.Instance(mod, { env: { print: () => {}, read: () => 0 } })
    return (instance.exports.probe as () => number)() | 0
}

/** Compile `body` as `@fn main := <body>` through the QBE backend, link, run; return exit code. */
function runNative(body: string, prelude = ''): number {
    const src = `${prelude}\n\\\\ main () -> Int\n@fn main := ${body};\n`
    const { qbeIr, diagnostics } = compileToQbe(src)
    if (diagnostics.some(d => d.severity === 'error')) {
        throw new Error('qbe compile error: ' + diagnostics.map(d => d.message).join('; '))
    }
    const asm = invokeQbe(QBE!, qbeIr, hostQbeArch())
    const stem = join(TMP, `p${counter++}`)
    writeFileSync(`${stem}.s`, asm)
    link(CC!, `${stem}.s`, stem)
    const r = spawnSync(stem, [], { stdio: 'pipe' })
    return r.status ?? -1
}

/** Assert both backends agree. WASM always runs (smoke check); native is gated. */
function parity(body: string, expected: number, prelude = ''): void {
    const w = runWasm(body, prelude)
    expect(w).toBe(expected)
    if (NATIVE_OK) expect(runNative(body, prelude)).toBe(w)
}

// body → expected result (all in 0..255). prelude carries extra top-level defs.
const CASES: { name: string; body: string; expect: number; prelude?: string }[] = [
    // Int arithmetic
    { name: 'add', body: '40 + 2', expect: 42 },
    { name: 'sub', body: '100 - 58', expect: 42 },
    { name: 'mul', body: '6 * 7', expect: 42 },
    { name: 'div (signed)', body: '85 / 2', expect: 42 },
    { name: 'mod (signed)', body: '142 % 100', expect: 42 },
    // Int comparisons (signed) via @if call form
    { name: '== true', body: '@if(4 == 4, { 1 }, { 0 })', expect: 1 },
    { name: '== false', body: '@if(4 == 5, { 1 }, { 0 })', expect: 0 },
    { name: '!= true', body: '@if(4 != 5, { 1 }, { 0 })', expect: 1 },
    { name: '< true', body: '@if(3 < 5, { 1 }, { 0 })', expect: 1 },
    { name: '< false', body: '@if(5 < 3, { 1 }, { 0 })', expect: 0 },
    { name: '> true', body: '@if(7 > 2, { 1 }, { 0 })', expect: 1 },
    { name: '<= eq', body: '@if(4 <= 4, { 1 }, { 0 })', expect: 1 },
    { name: '>= false', body: '@if(4 >= 9, { 1 }, { 0 })', expect: 0 },
    // Bitwise (no `&` — Silicon has no bitwise-and operator stratum)
    { name: 'or', body: '12 | 1', expect: 13 },
    { name: 'xor', body: '12 ^ 10', expect: 6 },
    { name: 'shl', body: '1 << 4', expect: 16 },
    { name: 'shr (signed/arith)', body: '64 >> 2', expect: 16 },
    // Control flow / value
    { name: '@if value', body: '@if(1, { 10 }, { 20 })', expect: 10 },
    { name: 'nested precedence (FLAT — parenthesized)', body: '(2 + 3) * 4', expect: 20 },
    // Locals + mutation (block body)
    { name: 'locals + mutation', body: '{ @mut x := 20; x = x + 22; x }', expect: 42 },
    // Function call
    { name: 'fn call', body: 'double(21)', expect: 42, prelude: '\\\\ double (Int) -> Int\n@fn double n := n * 2;' },
    // Recursion
    { name: 'recursion fib(9)', body: 'fib(9)', expect: 34, prelude: '\\\\ fib (Int) -> Int\n@fn fib n := @if(n <= 1, { n }, { fib(n - 1) + fib(n - 2) });' },
    // Short-circuit logic (logic.si) — previously unimplemented / wrong on QBE.
    // `||` is `if a then 1 else b`; `@and`/`@or`/`@not` mirror the strata IRIf forms.
    // `||` is Bool-typed, so test it through @if (truthiness parity — still
    // catches the old QBE bug where `||` always yielded 0 → @if took the wrong arm).
    { name: '|| truthy', body: '@if(1 || 0, { 1 }, { 0 })', expect: 1 },
    { name: '|| both falsy', body: '@if(0 || 0, { 1 }, { 0 })', expect: 0 },
    { name: '|| left falsy → right truthy', body: '@if(0 || 5, { 1 }, { 0 })', expect: 1 },
    { name: '@and both truthy → b', body: '@and(1, 7)', expect: 7 },
    { name: '@and left falsy → 0', body: '@and(0, 9)', expect: 0 },
    { name: '@and right falsy → 0', body: '@and(1, 0)', expect: 0 },
    { name: '@or left truthy → 1', body: '@or(1, 0)', expect: 1 },
    { name: '@or left falsy → right', body: '@or(0, 5)', expect: 5 },
    { name: '@not 0 → 1', body: '@not(0)', expect: 1 },
    { name: '@not nonzero → 0', body: '@not(5)', expect: 0 },
    // NOTE: unsigned-signedness drift (UInt32/UInt64 `/ % < > <= >= >>`) can't be
    // exercised here — distinguishing signed from unsigned needs a high-bit-set
    // operand (≥ 2³¹), which both exceeds an exit code AND requires a `@toU32`
    // cast that the QBE backend doesn't lower. That fix is locked at the table
    // level in backends.test.ts ("QBE unsigned-operator routing").
]

describe('QBE↔WASM execution oracle' + (NATIVE_OK ? '' : ' (native skipped — qbe/cc absent)'), () => {
    for (const c of CASES) {
        test(`${c.name} → ${c.expect}`, () => parity(c.body, c.expect, c.prelude ?? ''))
    }
})
