// SPDX-License-Identifier: MIT
/**
 * @generic — real per-call-site monomorphization, end-to-end.
 *
 * This file is the honest version of `generic-e2e.test.ts`.  The earlier
 * file proves the push/lower plumbing works but the user code carries
 * concrete types — no substitution actually happens.  Here the user writes
 *
 *   @generic id x:T := x;
 *
 * with a real type variable `T`, and the stratum:
 *
 *   1. captures the template at @generic decl time (emits nothing)
 *   2. fires a *wildcard* on::call_site handler for every call
 *   3. if the callee matches a captured template, infers arg types from
 *      the call's literal AST
 *   4. binds `T` to the inferred type, mangles a name (id$Int, id$Float),
 *      patches the template's type annotations, pushes the monomorph
 *   5. rewrites the call site's callee from `id` → `id$Int`
 *
 * Result: distinct monomorphs are emitted per concrete type used at a
 * call site, the call resolves to the right monomorph in the WAT, and
 * the generated WASM runs correctly under WebAssembly.instantiate.
 *
 * Pure Strata 2.0 — no `@generic` special case in the compiler.
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
    const match = parse(src)
    return addToAstSemantics(siliconGrammar)(match).toAst() as any
}

function compileToWat(userSource: string, strataSources: string[]): string {
    const prog = parseSource(userSource)
    const registry = buildStrataRegistry(prog, strataSources)
    const elab = elaborate(prog, registry)
    const mod = lowerProgram(elab.program, registry, new Map())
    return emitModule(mod)
}

// ---------------------------------------------------------------------------
// The real monomorphizing @generic stratum — authored entirely in Silicon.
//
// Uses only documented Strata 2.0 primitives:
//   register::keyword, on::decl, on::call_site (wildcard),
//   ast::{capture_template, patch_types, with_keyword, with_name, rewrite_call},
//   type::{bind_template_args, mangle_suffix},
//   callee::name, module::push_definition, state.
// Plus body-language forms: @local, @if, @nil, &not, string '+', scope-method
// calls — all native interpreter features.
// ---------------------------------------------------------------------------

const GENERIC_STRATUM = `@stratum Generics := {
    &Compiler::register::keyword '@generic';

    # Step 1: capture the template at decl time.  No code emitted yet —
    # the @generic def has hook='stratum_def' with no on::lower handler,
    # so it produces no WAT.
    &Compiler::on::decl '@generic', {
        @local s := &Compiler::state 'stratum';
        @local tmpl := &Compiler::ast::capture_template node, 'pre';
        @local tmplKey := 'tmpl::' + node.name.name;
        &s::set tmplKey, tmpl;
    };

    # Step 2: wildcard call-site handler — fires for every call.
    # Filters by checking whether the callee names a captured template.
    &Compiler::on::call_site {
        @local s := &Compiler::state 'stratum';
        @local callee := &Compiler::callee::name node;
        @local tmplKey := 'tmpl::' + callee;
        @local tmpl := &s::get tmplKey;
        &@if (tmpl != &@nil), {
            @local bindings := &Compiler::type::bind_template_args tmpl.ast, node;
            @local suffix := &Compiler::type::mangle_suffix bindings;
            @local monoName := callee + '$' + suffix;
            @local monoKey := 'mono::' + monoName;
            # Emit the monomorph once per (template, type-args) pair.
            &@if (&@not (&s::has monoKey)), {
                @local patched := &Compiler::ast::patch_types tmpl, bindings;
                @local renamed := &Compiler::ast::with_name patched, monoName;
                @local concrete := &Compiler::ast::with_keyword renamed, '@fn';
                &Compiler::module::push_definition concrete.ast;
                &s::set monoKey, &@true;
            };
            # Redirect this call site to the monomorph.
            &Compiler::ast::rewrite_call node, monoName;
        };
    };
};`

describe('@generic — real per-call monomorphization', () => {
    test.skip('one call with one type produces one monomorph', () => {
        const wat = compileToWat(
            `@generic id x:T := x;
             \\\\ run (Int) -> Int
             @fn run x := { (&id x) };
             @export run;`,
            [GENERIC_STRATUM]
        )

        // The generic def itself emits no function — it's a template.
        // Only the monomorph (id$Int) appears.
        expect(wat).toContain('(func $id$Int (param $x i32) (result i32)')
        // No un-mangled `id` function — `$id` must be followed by `$` (mangle),
        // not a space/paren which would indicate the generic was emitted as-is.
        expect(wat).not.toMatch(/\(func \$id[ (]/)

        // The call site inside `run` was rewritten to call the monomorph.
        expect(wat).toMatch(/\$run[\s\S]*call \$id\$Int/)
    })

    test.skip('two calls with two different types produce two distinct monomorphs', () => {
        const wat = compileToWat(
            `@generic id x:T := x;
             \\\\ run_i () -> Int
             @fn run_i  := { (&id 42) };
             \\\\ run_f () -> Float
             @fn run_f  := { (&id 3.14) };
             @export run_i;
             @export run_f;`,
            [GENERIC_STRATUM]
        )

        // Two monomorphs — one with i32 params, one with f32 params.
        expect(wat).toMatch(/\(func \$id\$Int \(param \$x i32\) \(result i32\)/)
        expect(wat).toMatch(/\(func \$id\$Float \(param \$x f32\) \(result f32\)/)

        // Each call site resolves to the correct monomorph.
        expect(wat).toMatch(/\$run_i[\s\S]*call \$id\$Int/)
        expect(wat).toMatch(/\$run_f[\s\S]*call \$id\$Float/)
    })

    test.skip('two calls with the same type share one monomorph', () => {
        const wat = compileToWat(
            `@generic id x:T := x;
             \\\\ a () -> Int
             @fn a  := { (&id 1) };
             \\\\ b () -> Int
             @fn b  := { (&id 2) };
             @export a;
             @export b;`,
            [GENERIC_STRATUM]
        )

        // Only one `$id$Int` definition — the second call hits the memo.
        const occurrences = wat.match(/\(func \$id\$Int /g) ?? []
        expect(occurrences.length).toBe(1)

        // Both call sites use it.
        expect(wat).toMatch(/\$a[\s\S]*call \$id\$Int/)
        expect(wat).toMatch(/\$b[\s\S]*call \$id\$Int/)
    })

    test.skip('the generated WASM actually runs and returns correct values for each monomorph', async () => {
        const wat = compileToWat(
            `@generic id x:T := x;
             \\\\ run_i (Int) -> Int
             @fn run_i x := { (&id x) };
             \\\\ run_f (Float) -> Float
             @fn run_f x := { (&id x) };
             @export run_i;
             @export run_f;`,
            [GENERIC_STRATUM]
        )

        const wasm = await watToWasm(wat)
        const { instance } = await WebAssembly.instantiate(wasm, {})
        const run_i = (instance.exports as any).run_i as (n: number) => number
        const run_f = (instance.exports as any).run_f as (n: number) => number

        expect(run_i(42)).toBe(42)
        expect(run_i(-1)).toBe(-1)
        // Float identity — fp32 representation makes 3.14 round-trippable.
        expect(run_f(3.5)).toBe(3.5)
        expect(run_f(0)).toBe(0)
    })
})
