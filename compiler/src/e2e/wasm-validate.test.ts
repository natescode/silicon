// SPDX-License-Identifier: MIT
/**
 * WASM validate gate (Tier-1, ADR-0024).
 *
 * Every binary the direct emitter produces must be spec-valid. We compile a
 * representative slice of the language surface to a `.wasm` for BOTH the default
 * (wasm-mvp) target and the opt-in `wasm-gc` mode, and assert the host engine's
 * validator accepts it (see `../codegen/wasm-validator`). This catches emitter
 * regressions — bad LEB lengths, wrong section order, mis-encoded custom
 * sections — that the WAT-text tests can't see.
 *
 * Run standalone with `bun run test:wasm-validate`.
 */

import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { compile } from '../caas'
import { loadModules } from '../modules'
import { validateWasmBinary, wasmToolsAvailable } from '../codegen/wasm-validator'

const moduleRegistry = loadModules(join(import.meta.dirname, '../..'))
const EXAMPLES_DIR = join(import.meta.dirname, 'examples')

// Curated example fixtures that compile cleanly with no special setup — a broad
// slice of the core surface (arithmetic, comparisons, functions, control flow,
// globals, mutation). These are also exercised by the e2e/backends suites, so
// they won't flake here.
const FIXTURES = [
    'simple_literal.si', 'basic_arithmetic.si', 'subtraction.si', 'multiplication.si',
    'division.si', 'modulo.si', 'nested_expressions.si', 'complex_expression.si',
    'comparison_equal.si', 'comparison_not_equal.si', 'comparison_greater_than.si',
    'comparison_greater_equal.si', 'boolean_true.si', 'boolean_false.si',
    'fn_function.si', 'function_definition.si', 'function_call.si',
    'if_else_expr.si', 'if_in_block.si', 'early_return.si', 'count_loop.si',
    'var_global.si', 'var_mutation.si', 'block_trailing_expr.si', 'block_stmts_then_expr.si',
]

// Inline programs exercising aggregate/heap features (sum types, structs) — the
// paths that diverge most between wasm-mvp (pad-to-max linear layout) and wasm-gc
// (struct/array refs). The sum-type program is the canonical one from the docs.
const INLINE = [
    {
        name: 'sum type + @match',
        src: `@type Shape := $Circle r Int | $Square s Int;
\\\\ size (Shape) -> Int
@fn size sh := {
    @match(sh, $Circle r => r, $Square s => s)
};
@export size;`,
    },
    {
        name: 'struct field access',
        src: `@type Point := { x Int, y Int };
\\\\ sum_xy (Point) -> Int
@fn sum_xy p := { p::x + p::y };
@export sum_xy;`,
    },
    {
        name: 'recursion',
        src: `\\\\ fact (Int) -> Int
@fn fact n := { @if(n < 2, { 1 }, { n * fact(n - 1) }) };
@export fact;`,
    },
]

function compileBinary(src: string, target?: 'wasm-gc') {
    const r = compile(src, { emitBinary: true, moduleRegistry, ...(target ? { target } : {}) } as any)
    return r
}

function assertValid(src: string, target?: 'wasm-gc') {
    const r = compileBinary(src, target)
    expect(r.diagnostics.map(d => `${d.code}: ${d.message}`)).toEqual([])
    expect(r.binary).toBeDefined()
    const v = validateWasmBinary(r.binary!)
    if (!v.ok) throw new Error(`invalid wasm: ${v.error}`)
    expect(v.ok).toBe(true)
}

describe('wasm validate gate — fixtures (wasm-mvp)', () => {
    for (const f of FIXTURES) {
        test(f, () => assertValid(readFileSync(join(EXAMPLES_DIR, f), 'utf-8')))
    }
})

describe('wasm validate gate — fixtures (wasm-gc)', () => {
    for (const f of FIXTURES) {
        test(f, () => assertValid(readFileSync(join(EXAMPLES_DIR, f), 'utf-8'), 'wasm-gc'))
    }
})

describe('wasm validate gate — aggregates (wasm-mvp)', () => {
    for (const p of INLINE) test(p.name, () => assertValid(p.src))
})

describe('wasm validate gate — aggregates (wasm-gc)', () => {
    for (const p of INLINE) test(p.name, () => assertValid(p.src, 'wasm-gc'))
})

// Sanity: the validator must actually reject garbage (guards against a
// vacuously-passing gate). Garbage must be rejected by whichever oracle ran.
test('validator rejects a non-wasm byte sequence', () => {
    const r = validateWasmBinary(new Uint8Array([1, 2, 3, 4]))
    expect(r.ok).toBe(false)
})

// Wiring: the gate prefers the canonical wasm-tools oracle when it's on PATH,
// and falls back to the host engine otherwise. Either way a valid binary passes.
test('uses wasm-tools as the oracle when installed (engine fallback otherwise)', () => {
    const r = compileBinary(readFileSync(join(EXAMPLES_DIR, 'fn_function.si'), 'utf-8'))
    const v = validateWasmBinary(r.binary!)
    expect(v.ok).toBe(true)
    expect(v.via).toBe(wasmToolsAvailable() ? 'wasm-tools' : 'engine')
})
