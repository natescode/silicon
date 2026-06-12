// SPDX-License-Identifier: MIT
/**
 * ADR 0027 — minimal WASI-aligned object capabilities (v0).
 *
 * Proves the whole model deterministically (no WASI runtime needed in-test;
 * the live `sgl run` timestamp is verified manually):
 *   - ENFORCEMENT: a cap-gated op (`clock_now`) cannot be called without the
 *     capability — the existing call-site type check IS the enforcement.
 *   - UNFORGEABILITY: a function can't return a `World` it fabricated from a
 *     literal (`@type_distinct` mints no constructor).
 *   - MINT-SITE RULE: `@cap_derive` only attenuates the root `World` (E0017) —
 *     no forging from a non-cap, no amplifying one domain cap into another.
 *   - ROOTING: a `@fn main (World)` program's synthesised `_start` calls
 *     `main` with the inline root token — the sole, un-nameable mint.
 *   - NO REGRESSION: a program without a `World`-typed `main` is unaffected.
 */

import { test, expect, describe } from 'bun:test'
import parse from '../parser'
import { buildStrataRegistry, elaborate } from '../elaborator/index'
import { typecheck } from '../types/index'
import { lowerProgram } from '../ir/lower'
import { emitModule } from '../ir/emit'
import { loadModules } from '../modules/loader'
import { resolveUses } from '../modules/useResolver'

const ENTRY = '/virtual/main.si'

function check(src: string): string[] {
    const { source } = resolveUses(src, ENTRY, { target: 'wasix' as any })
    const ast = parse(source) as any
    const registry = buildStrataRegistry(ast)
    const { program: elab, errors: elabErrs } = elaborate(ast, registry)
    if (elabErrs.length) return elabErrs.map((e: any) => `elab:${e.message}`)
    const tc = typecheck(elab, registry, undefined, 'wasix' as any)
    return tc.errors.map((e: any) => `${e.kind}:${e.message}`)
}

/** Lower a program and return its WAT (wasix target → `_start` is synthesised). */
function watOf(src: string): string {
    const { source } = resolveUses(src, ENTRY, { target: 'wasix' as any })
    const ast = parse(source) as any
    const registry = buildStrataRegistry(ast)
    const { program: elab } = elaborate(ast, registry)
    const tc = typecheck(elab, registry, undefined, 'wasix' as any)
    const mod = lowerProgram(tc.program, registry, tc.functions, loadModules(), { target: 'wasix' as any })
    return emitModule(mod)
}

describe('capabilities (ADR 0027) — enforcement', () => {
    test('a valid main(World) → world_clock → clock_now program typechecks', () => {
        const errs = check(`@use 'cap';
\\\\ main (World) -> Int
@fn main w := {
    c := world_clock(w);
    now := clock_now(c);
    0
};`)
        expect(errs).toEqual([])
    })

    test('clock_now cannot be called without a Clock capability (cap is mandatory)', () => {
        const errs = check(`@use 'cap';
\\\\ run (Int) -> Int64
@fn run x := clock_now(x);`)
        expect(errs.join('\n')).toContain('Mismatch')
        expect(errs.join('\n')).toContain('expected Clock')
    })
})

describe('capabilities (ADR 0027) — unforgeability', () => {
    test('a World cannot be fabricated from a literal (@type_distinct has no constructor)', () => {
        const errs = check(`@use 'cap';
\\\\ forge () -> World
@fn forge := { 0 };`)
        expect(errs.join('\n')).toContain('World')
        expect(errs.length).toBeGreaterThan(0)
    })

    test('@cap_derive in user code on a non-root value is rejected (E0017 mint-site rule)', () => {
        const errs = check(`@use 'cap';
\\\\ evil (Int) -> Clock
@fn evil x := @cap_derive(x);`)
        expect(errs.join('\n')).toContain('CapDeriveNonRoot')
        expect(errs.join('\n')).toContain('World')
    })

    test('@cap_derive cannot amplify one domain cap into another (Clock → another Clock-shaped cap)', () => {
        // A user holding a Clock cannot relabel it: @cap_derive demands World.
        const errs = check(`@use 'cap';
\\\\ amplify (Clock) -> Clock
@fn amplify c := @cap_derive(c);`)
        expect(errs.join('\n')).toContain('CapDeriveNonRoot')
    })
})

describe('capabilities (ADR 0027) — rooting', () => {
    test('a main(World) program’s _start calls main with the inline root token', () => {
        const wat = watOf(`@use 'cap';
\\\\ main (World) -> Int
@fn main w := { now := clock_now(world_clock(w)); 0 };`)
        expect(wat).toContain('(export "_start"')
        // The entry shim — the SOLE, un-nameable root mint — calls main(3).
        expect(wat).toMatch(/\$__start[\s\S]*call \$main \(i32\.const 3\)/)
    })

    test('clock_now lowers to the WASI clock_time_get import (the cap gates a real syscall)', () => {
        const wat = watOf(`@use 'cap';
\\\\ main (World) -> Int
@fn main w := { now := clock_now(world_clock(w)); 0 };`)
        expect(wat).toContain('(import "wasi_snapshot_preview1" "clock_time_get"')
        expect(wat).toMatch(/call \$wasi_snapshot_preview1__clock_time_get/)
    })
})

describe('capabilities (ADR 0027) — no regression', () => {
    test('a program without a World-typed main does not get the root-call shim', () => {
        const wat = watOf(`@use 'io';
@fn main := { print_int(42) };
main();`)
        // The cap shim only fires on main(World); a plain main is untouched.
        expect(wat).not.toMatch(/call \$main \(i32\.const 3\)/)
    })
})
