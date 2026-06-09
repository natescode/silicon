// SPDX-License-Identifier: MIT
/**
 * M0 — the comptime monomorphization SUBSTRATE, proven end-to-end.
 *
 * `generic-monomorph.test.ts` (the full per-call-site fixture, still skipped)
 * additionally needs comptime *conditionals* (`@if`/`@not`/`!=`/`@nil`) for
 * memoization and string `+`, none of which the compiled comptime engine
 * provides yet.  This file proves everything UNDERNEATH that: a Silicon-authored
 * stratum, using only documented + compiled primitives, captures a generic
 * template at `on::decl`, and at a wildcard `on::call_site`:
 *
 *   - reads the captured template back out of *shared state* — a handle stored
 *     during the decl firing and resolved in a DIFFERENT handler firing (the
 *     registry-shared handle table, M0);
 *   - infers the call's concrete type args (`type::bind_template_args`),
 *     mangles a suffix (`type::mangle_suffix`), builds the monomorph name
 *     (`callee::name` + `str::concat`), patches the template's type
 *     annotations to concrete (`ast::patch_types`), renames + re-keywords it to
 *     a real `@fn` (`ast::with_name` / `with_keyword`), pushes it
 *     (`module::push_definition`), and redirects the call (`ast::rewrite_call`).
 *
 * Result: a real `$id$Int` / `$id$Float` monomorph in the WAT whose param/result
 * types were substituted from the template's type variable, the call resolves to
 * it, and the generated WASM runs.  Pure Strata 2.0 — no `@generic` special case.
 *
 * NOTE on scope: a single call site per concrete type is exercised here.
 * De-duplicating *repeated* same-type call sites needs the memoization guard
 * (`@if(@not(state::has …)))`), i.e. comptime conditionals — tracked with the
 * skipped generic-monomorph.test.ts fixture.
 */

import { test, expect, describe } from 'bun:test'
import { buildStrataRegistry } from './strataLoader'
import elaborate from './elaborator'
import { lowerProgram } from '../ir/lower'
import { emitModule } from '../ir/emit'
import parse from '../parser'
import addToAstSemantics from '../ast/toAst'
import siliconGrammar from '../grammar/SiliconGrammar'
import { watToWasm } from '../codegen/toWasm'

function parseSource(src: string): any {
    return addToAstSemantics(siliconGrammar)(parse(src)).toAst() as any
}
function compileToWat(userSource: string, strataSources: string[]): string {
    const prog = parseSource(userSource)
    const registry = buildStrataRegistry(prog, strataSources)
    const elab = elaborate(prog, registry)
    return emitModule(lowerProgram(elab.program, registry, new Map()))
}

// ---------------------------------------------------------------------------
// A cross-handler handoff stratum: on::decl captures a template into shared
// state; a wildcard on::call_site reads it back and synthesises a function.
// Proves the registry-shared handle table carries a handle across handler
// firings (decl → call_site).
// ---------------------------------------------------------------------------
const HANDOFF_STRATUM = `@stratum Handoff := {
    Compiler::register::keyword('@capture');
    Compiler::on::decl('@capture', {
        @mut s := Compiler::state('stratum');
        @mut tmpl := Compiler::ast::capture_template(node, 'pre');
        s::set('captured', tmpl);
    });
    Compiler::on::call_site({
        @mut s := Compiler::state('stratum');
        @mut tmpl := s::get('captured');
        @mut concrete := Compiler::ast::with_keyword(tmpl, '@fn');
        Compiler::module::push_definition(concrete::ast);
    });
};`

// ---------------------------------------------------------------------------
// A real monomorphizing stratum, authored entirely in Silicon, using only
// primitives the compiled comptime engine supports (no `+` / `!=` / `@if`).
// ---------------------------------------------------------------------------
const MONO_STRATUM = `@stratum Mono := {
    Compiler::register::keyword('@generic');
    Compiler::on::decl('@generic', {
        @mut s := Compiler::state('stratum');
        @mut tmpl := Compiler::ast::capture_template(node, 'pre');
        s::set('tmpl', tmpl);
    });
    Compiler::on::call_site({
        @mut s := Compiler::state('stratum');
        @mut tmpl := s::get('tmpl');
        @mut bindings := Compiler::type::bind_template_args(tmpl::ast, node);
        @mut suffix := Compiler::type::mangle_suffix(bindings);
        @mut monoName := Compiler::str::concat(Compiler::str::concat(Compiler::callee::name(node), '$'), suffix);
        @mut patched := Compiler::ast::patch_types(tmpl, bindings);
        @mut renamed := Compiler::ast::with_name(patched, monoName);
        @mut concrete := Compiler::ast::with_keyword(renamed, '@fn');
        Compiler::module::push_definition(concrete::ast);
        Compiler::ast::rewrite_call(node, monoName);
    });
};`

describe('M0 — comptime monomorphization substrate', () => {
    test('a captured template handed off decl→call_site synthesises a function (shared handle table)', () => {
        const wat = compileToWat(
            `@capture grabbed x Int := x;
             \\\\ run () -> Int
             @fn run := { grabbed(7) };`,
            [HANDOFF_STRATUM],
        )
        // The call_site handler read the decl-captured template out of shared
        // state and pushed it as a real @fn.
        expect(wat).toContain('(func $grabbed')
        expect(wat).toMatch(/call \$grabbed/)
    })

    test('a generic call site is monomorphized to a concrete @fn with substituted types (Int)', () => {
        const wat = compileToWat(
            `@generic id x T := x;
             \\\\ run () -> Int
             @fn run := { id(42) };`,
            [MONO_STRATUM],
        )
        // T was bound to Int from the literal arg; the template's `x T` param
        // became `x i32`, the monomorph is named id$Int, and the call resolves.
        expect(wat).toMatch(/\(func \$id\$Int \(param \$x i32\) \(result i32\)/)
        expect(wat).toMatch(/call \$id\$Int/)
        // The generic template itself emitted no function — only the monomorph.
        expect(wat).not.toMatch(/\(func \$id[ (]/)
    })

    test('the same generic monomorphizes to a Float instance at a Float call site', () => {
        const wat = compileToWat(
            `@generic id x T := x;
             \\\\ run () -> Float
             @fn run := { id(3.5) };`,
            [MONO_STRATUM],
        )
        expect(wat).toMatch(/\(func \$id\$Float \(param \$x f32\) \(result f32\)/)
        expect(wat).toMatch(/call \$id\$Float/)
    })

    test('the monomorphized function actually runs under WebAssembly', async () => {
        const wat = compileToWat(
            `@generic id x T := x;
             \\\\ run (Int) -> Int
             @fn run x := { id(x) };
             @export run;`,
            [MONO_STRATUM],
        )
        expect(wat).toMatch(/\(func \$id\$Int/)
        const wasm = await watToWasm(wat)
        const { instance } = await WebAssembly.instantiate(wasm, {})
        const run = (instance.exports as any).run as (n: number) => number
        expect(run(42)).toBe(42)
        expect(run(-7)).toBe(-7)
    })
})
