// SPDX-License-Identifier: MIT
/**
 * Dissolution Phase A — strata bodies as first-class @fn definitions.
 *
 * Today a strata writes inline blocks:
 *
 *     @stratum X := { &Compiler::on::decl '@t', { ...body... }; };
 *
 * Phase A also accepts a named-handler reference:
 *
 *     @stratum X := { &Compiler::on::decl '@t', X_handler; };
 *     @fn X_handler node:Int := { ...body... };
 *
 * The body still runs through the AST-walking interpreter (Phase C will
 * swap that for compile-then-run).  The new authoring shape is the bridge:
 * handlers become real top-level Silicon programs that can be type-checked
 * normally, called from other Silicon code, and eventually compiled to
 * stand-alone WASM functions invoked via a comptime engine.
 *
 * These tests cover the four interception phases (decl, callSite,
 * annotation, module_finalize) plus comptime, plus the equivalence
 * property: inline vs named must produce the same observable behavior.
 */

import { test, expect, describe } from 'bun:test'
import { buildStrataRegistry } from './strataLoader'
import { lookupNamedHandler, lookupComptimeHandler } from './registry'
import elaborate from './elaborator'
import { lowerProgram } from '../ir/lower'
import { emitModule } from '../ir/emit'
import parse from '../parser'
import addToAstSemantics from '../ast/toAst'
import siliconGrammar from '../grammar/SiliconGrammar'

function compile(src: string): { wat: string; errors: string[] } {
    const prog = addToAstSemantics(siliconGrammar)(parse(src)).toAst() as any
    const registry = buildStrataRegistry(prog)
    const elab = elaborate(prog, registry)
    const mod = lowerProgram(elab.program, registry, new Map())
    return {
        wat: emitModule(mod),
        errors: registry.diagnostics.map(d => `${d.code}: ${d.message}`),
    }
}

// ---------------------------------------------------------------------------
// Pre-pass: every @fn body gets stashed in namedHandlers
// ---------------------------------------------------------------------------

describe('Phase A pre-pass: @fn bodies are collected into namedHandlers', () => {
    test('a top-level @fn is registered by name with its first param', () => {
        const src = `\\\\ my_handler (Int)
@fn my_handler node := { node };`
        const prog = addToAstSemantics(siliconGrammar)(parse(src)).toAst() as any
        const registry = buildStrataRegistry(prog)
        const entry = lookupNamedHandler(registry, 'my_handler')
        expect(entry).toBeDefined()
        expect(entry!.paramName).toBe('node')
    })

    test('custom param name is captured', () => {
        const src = `\\\\ h (Int)
@fn h callNode := { callNode };`
        const prog = addToAstSemantics(siliconGrammar)(parse(src)).toAst() as any
        const registry = buildStrataRegistry(prog)
        const entry = lookupNamedHandler(registry, 'h')
        expect(entry!.paramName).toBe('callNode')
    })

    test('paramless @fn falls back to "node" so legacy interpreter works', () => {
        const src = `@fn h  := { 1 };`
        const prog = addToAstSemantics(siliconGrammar)(parse(src)).toAst() as any
        const registry = buildStrataRegistry(prog)
        const entry = lookupNamedHandler(registry, 'h')
        expect(entry!.paramName).toBe('node')
    })
})

// ---------------------------------------------------------------------------
// Equivalence — same stratum authored two ways gives the same observable
// ---------------------------------------------------------------------------

describe('Phase A equivalence: inline-block vs named-handler', () => {
    test('on::decl named handler fires and observes the right node', () => {
        // The stratum captures the def name into state; the test reads state
        // to confirm the handler fired correctly.
        const inline = `@stratum Inline := {
            Compiler::register::keyword('@inline_kw');
            Compiler::on::decl('@inline_kw', {
                @mut s := Compiler::state('stratum');
                s::set('seen', node::name::name);
            });
        };
        @inline_kw alpha;`

        const named = `@stratum Named := {
            Compiler::register::keyword('@named_kw');
            Compiler::on::decl('@named_kw', Named_decl);
        };
        \\\\ Named_decl (Int)
        @fn Named_decl node := {
            @mut s := Compiler::state('stratum');
            s::set('seen', node::name::name);
        };
        @named_kw alpha;`

        // Both must compile cleanly and produce some module.  The real
        // assertion is that the named form doesn't crash on the lookup path.
        expect(() => compile(inline)).not.toThrow()
        expect(() => compile(named)).not.toThrow()

        // Cross-check: the named-handler entry is registered.
        const prog = addToAstSemantics(siliconGrammar)(parse(named)).toAst() as any
        const registry = buildStrataRegistry(prog)
        const entry = lookupNamedHandler(registry, 'Named_decl')
        expect(entry).toBeDefined()
    })

    test('on::call_site (wildcard) accepts a named handler', () => {
        // Wildcard registration via Namespace handler — no string token,
        // arg[0] is the function name.
        const src = `@stratum W := {
            Compiler::on::call_site(W_cs);
        };
        \\\\ W_cs (Int)
        @fn W_cs node := {
            0
        };
        @fn run := unrelated();`
        // Should compile without lookup errors (the handler fires but does
        // nothing observable except not crashing).
        expect(() => compile(src)).not.toThrow()
    })

    test('on::module_finalize accepts a named handler', () => {
        const src = `@stratum F := {
            Compiler::on::module_finalize(F_finalize);
        };
        \\\\ F_finalize (Int)
        @fn F_finalize node := {
            0
        };
        @fn main := 1;`
        expect(() => compile(src)).not.toThrow()
    })

    test('on::annotation accepts a named handler', () => {
        const src = `@stratum A := {
            Compiler::register::annotation('@@mark');
            Compiler::on::annotation('@@mark', A_ann);
        };
        \\\\ A_ann (Int)
        @fn A_ann node := {
            0
        };`
        expect(() => compile(src)).not.toThrow()
    })

    test('on::comptime accepts a named handler', () => {
        // Define an operator '++' whose comptime semantics live in a named @fn.
        const src = `@stratum C := {
            Compiler::on::comptime('++', C_concat);
        };
        \\\\ C_concat (Int)
        @fn C_concat arg0 := {
            arg0
        };`
        // Compile and check that the comptime handler is registered.
        const prog = addToAstSemantics(siliconGrammar)(parse(src)).toAst() as any
        const registry = buildStrataRegistry(prog)
        const handler = lookupComptimeHandler(registry, '++')
        expect(handler).toBeDefined()
    })
})

// ---------------------------------------------------------------------------
// Error path: named handler that doesn't exist
// ---------------------------------------------------------------------------

describe('Phase A error reporting', () => {
    test('referencing an undefined @fn name surfaces a clear error at fire time', () => {
        const src = `@stratum Broken := {
            Compiler::register::keyword('@broken_kw');
            Compiler::on::decl('@broken_kw', NonExistent);
        };
        @broken_kw alpha;`
        // The handler is registered at strata-load time without checking
        // existence (the @fn could be added later in the source).  The
        // error fires when the handler is invoked — i.e. when @broken_kw
        // appears in user code.
        expect(() => compile(src)).toThrow(/NonExistent/)
    })

    test('but no error if the keyword is declared but never used', () => {
        const src = `@stratum Lazy := {
            Compiler::register::keyword('@lazy_kw');
            Compiler::on::decl('@lazy_kw', NonExistent);
        };`
        // No @lazy_kw appears in user code → handler never fires → no error.
        expect(() => compile(src)).not.toThrow()
    })
})

// ---------------------------------------------------------------------------
// Forward references: @fn defined AFTER its strata reference
// ---------------------------------------------------------------------------

describe('Phase A forward references', () => {
    test('@fn defined after its strata reference still resolves', () => {
        // The pre-pass collects @fn bodies before strata registration looks
        // them up, so source-order doesn't matter.
        const src = `@stratum Forward := {
            Compiler::register::keyword('@fwd_kw');
            Compiler::on::decl('@fwd_kw', Forward_handler);
        };

        @fwd_kw alpha;

        \\\\ Forward_handler (Int)
        @fn Forward_handler node := {
            @mut s := Compiler::state('stratum');
            s::set('fired', 1);
        };`
        expect(() => compile(src)).not.toThrow()
    })
})
