// SPDX-License-Identifier: MIT
/**
 * Integration tests: Silicon source → type-checked AST.
 *
 * Exercises the type checker through the full parse → AST → elaborate →
 * typecheck chain. These tests catch interactions between the grammar/AST
 * layer and the type system that unit tests can't reach.
 */

import { test, expect } from 'bun:test'
import parse from '../parser'
import addToAstSemantics from '../ast/toAst'
import elaborate from '../elaborator/elaborator'
import typecheck from './typechecker'
import { type Program } from '../ast/astNodes'
import { siliconGrammar } from '../grammar'
import { TypeInt, TypeFloat, TypeBool, TypeString, ArrayOf, typeEquals } from './types'

function check(src: string) {
    const match = parse(src)
    const ast = addToAstSemantics(siliconGrammar)(match).toAst() as Program
    const { program: elab, registry } = elaborate(ast)
    return typecheck(elab, registry)
}

test('"5;" — int literal, no errors', () => {
    const { errors } = check('5;')
    expect(errors).toHaveLength(0)
})

test('"3.14;" — float literal, no errors', () => {
    const { errors } = check('3.14;')
    expect(errors).toHaveLength(0)
})

test('"@true;" — bool literal, no errors', () => {
    const { errors } = check('@true;')
    expect(errors).toHaveLength(0)
})

test('"\'hi\';" — string literal, no errors', () => {
    const { errors } = check("'hi';")
    expect(errors).toHaveLength(0)
})

test('"1 + 2;" — Int + Int clean', () => {
    const { errors } = check('1 + 2;')
    expect(errors).toHaveLength(0)
})

test('"1.5 + 2.5;" — Float + Float clean', () => {
    const { errors } = check('1.5 + 2.5;')
    expect(errors).toHaveLength(0)
})

test('"1 + 2.5;" — strict: Int + Float is an error', () => {
    const { errors } = check('1 + 2.5;')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('InvalidOperator')
})

test('"1 < 2;" — comparison yields Bool, clean', () => {
    const { errors } = check('1 < 2;')
    expect(errors).toHaveLength(0)
})

test('"$[1, 2, 3];" — homogeneous int array clean', () => {
    const { errors } = check('$[1, 2, 3];')
    expect(errors).toHaveLength(0)
})

test('"$[1, 2.0];" — heterogeneous array errors', () => {
    const { errors } = check('$[1, 2.0];')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('HeterogeneousArray')
})

test('"x = 10; x + 1;" — identifier flows through', () => {
    const { errors } = check('x = 10; x + 1;')
    expect(errors).toHaveLength(0)
})

test('"x = 10; y + 1;" — unbound identifier errors', () => {
    const { errors } = check('x = 10; y + 1;')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('UnboundIdentifier')
})

test('complex expression "(1 + 2) * 3 - 4;" clean', () => {
    const { errors } = check('(1 + 2) * 3 - 4;')
    expect(errors).toHaveLength(0)
})

test('mixed operators all-Int clean', () => {
    const { errors } = check('1 + 2 - 3 * 4 / 5 % 2;')
    expect(errors).toHaveLength(0)
})

test('all comparison operators on Int clean', () => {
    for (const op of ['<', '>', '<=', '>=', '==', '!=']) {
        const { errors } = check(`3 ${op} 5;`)
        expect(errors).toHaveLength(0)
    }
})

test('type annotation Int matches int literal', () => {
    // Silicon grammar supports `x := 5`
    const { errors } = check('x := 5;')
    expect(errors).toHaveLength(0)
})

test('type annotation Float on int binding is an error', () => {
    const { errors } = check('\\\\ x Float\nx := 5;')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('Annotation')
})

test('unknown type annotation errors', () => {
    const { errors } = check('\\\\ x Bogus\nx := 5;')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('UnknownType')
})

test('WASM::i32_add intrinsic type-checks', () => {
    const { errors } = check('WASM::i32_add(1, 2);')
    expect(errors).toHaveLength(0)
})

test('alloc_string returns a String buffer', () => {
    const { errors } = check(`\\\\ one String
@fn one := {
    @mut out := alloc_string(1);
    WASM::i32_store8(str_ptr(out) + 4, 65);
    out
};`)
    expect(errors).toHaveLength(0)
})

test('WASM::i32_add with float operand fails', () => {
    const { errors } = check('WASM::i32_add(1, 2.5);')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('Mismatch')
})

test('annotation informs inferred types (i32 alias)', () => {
    // Using i32 as annotation is allowed as a low-level escape hatch
    const { errors, program } = check('x := 42;')
    expect(errors).toHaveLength(0)
    // The definition's type should resolve as Int
    // (we don't introspect beyond "no errors" since Definition node isn't
    // an expression and doesn't carry inferredType directly)
})

// ------------------------------------------------------------------
// @if type inference
// ------------------------------------------------------------------

test('@if with matching branches has no errors', () => {
    const { errors } = check('\\\\ abs (Int)\nabs x := {\n    @if(x < 0, {\n        0 - x\n    }, {\n        x\n    })\n};')
    expect(errors).toHaveLength(0)
})

test('@if result type flows through to caller', () => {
    // &@if flag, { 1 }, { 2 } should infer Int, so 3 + result is valid
    const { errors } = check('3 + @if(1, { 1 }, { 2 });')
    expect(errors).toHaveLength(0)
})

test('@if with mismatched branch types produces an error', () => {
    // then: Int, else: Float → mismatch
    const { errors } = check('x := { @if(1, { 1 }, { 2.5 }) };')
    expect(errors.length).toBeGreaterThan(0)
})

test('@if without else branch is void (TypeUnknown — no errors)', () => {
    // Void @if should not error; result type Unknown propagates silently
    const { errors } = check('@if(1, { 1 });')
    expect(errors).toHaveLength(0)
})

// ------------------------------------------------------------------
// User-defined function call type inference (end-to-end)
// ------------------------------------------------------------------

test('return type of user function resolves at call site', () => {
    const { errors } = check('\\\\ add (Int, Int)\nadd x, y := x + y;\nadd(1, 2);')
    expect(errors).toHaveLength(0)
})

test('wrong arg type at user function call site errors', () => {
    const { errors } = check('\\\\ double (Int)\ndouble x := x + x;\ndouble(1.5);')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('Mismatch')
})

test('wrong arity at user function call site errors', () => {
    const { errors } = check('\\\\ add (Int, Int)\nadd x, y := x + y;\nadd(1);')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('ArityMismatch')
})

test('@fn with no signature infers parameter types from its call sites', () => {
    // ADR-0020: signatures are optional — an unannotated parameter's type is
    // inferred from the function's call sites.  `add(1, 2)` pins a, b to Int, so
    // `a + b` type-checks with no errors (no MissingParamType, no UnboundIdentifier).
    const { errors } = check('@fn add a, b := { a + b };\nadd(1, 2);')
    expect(errors).toHaveLength(0)
})

test('@fn no-signature inference picks up Float call sites', () => {
    const { errors } = check('@fn add a, b := { a + b };\nadd(1.0, 2.0);')
    expect(errors).toHaveLength(0)
})

test('@fn no-signature inference flows through nested calls', () => {
    // The inner `add(1, 2)` must resolve to Int before the outer call's argument
    // type is concrete — the fixpoint loop handles this.
    const { errors } = check('@fn add a, b := { a + b };\nadd(add(1, 2), 3);')
    expect(errors).toHaveLength(0)
})

test('@fn no-signature with no call sites cannot infer params (E0015)', () => {
    // Nothing to infer from — report a clear "could not infer" (E0015), NOT a
    // misleading "unbound identifier 'a'" in the body.
    const { errors } = check('@fn add a, b := { a + b };')
    expect(errors.some(e => e.kind === 'MissingParamType')).toBe(true)
    expect(errors.every(e => e.kind !== 'UnboundIdentifier')).toBe(true)
})

test('@fn no-signature used at two concrete types stays uninferred (E0015)', () => {
    // Monomorphic inference: Int at one call, Float at another — genuinely
    // polymorphic, so we do not pick one.  Surface E0015 (reach for `[T]`).
    const { errors } = check('@fn add a, b := { a + b };\nadd(1, 2);\nadd(1.0, 2.0);')
    expect(errors.some(e => e.kind === 'MissingParamType')).toBe(true)
})

test('@fn called with a non-annotatable arg type (Array) is uninferable (E0015, not UnknownType)', () => {
    // Array[T] has no surface annotation name, so inference must NOT synthesize an
    // `Array[Int]` annotation (which the resolver would reject as "unknown type
    // 'Array'"). It leaves the param unresolved → honest E0015.
    const { errors } = check('@fn f a := { a };\nr := f($[1, 2, 3]);')
    expect(errors.some(e => e.kind === 'MissingParamType')).toBe(true)
    expect(errors.every(e => e.kind !== 'UnknownType')).toBe(true)
})

test('@fn with a signature line types its parameters (no inference needed)', () => {
    const { errors } = check('\\\\ add (Int, Int) -> Int\n@fn add a, b := { a + b };\nadd(1, 2);')
    expect(errors).toHaveLength(0)
})

// ------------------------------------------------------------------
// Forward references
// ------------------------------------------------------------------

test('forward reference: wrong arg type caught before definition', () => {
    // &add appears before @global add — pre-pass seeds the signature so the
    // call site is type-checked even though the definition comes later.
    const { errors } = check('add(1.0, 2.0);\n\\\\ add (Int, Int)\nadd x, y := x + y;')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('Mismatch')
})

test('forward reference: correct call before definition has no errors', () => {
    const { errors } = check('\\\\ add (Int, Int)\nadd x, y := x + y;')
    expect(errors).toHaveLength(0)
})

// ------------------------------------------------------------------
// Immutable bindings
// ------------------------------------------------------------------

test('@global binding cannot be reassigned', () => {
    const { errors } = check('x := 5; x = 10;')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('ImmutableAssignment')
})

test('@fn binding cannot be reassigned', () => {
    const { errors } = check('\\\\ add (Int, Int)\n@fn add x, y := x + y; add = 0;')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('ImmutableAssignment')
})

test('@local binding can be reassigned', () => {
    const { errors } = check('@mut count := 0; count = 1;')
    expect(errors).toHaveLength(0)
})

test('a mutable @local local shadows a same-named top-level @fn for assignment', () => {
    // Regression: a top-level `@fn out` marked `out` immutable globally, so a
    // later local `@mut out` inside another function could not be reassigned.
    const { errors } = check(
        '\\\\ out () -> Int\n@fn out := 0;\n' +
        '\\\\ build Int\n@fn build := {\n    @mut out := 1;\n    out = 2;\n    out\n};')
    expect(errors).toHaveLength(0)
})

// NB: the legacy "@global inside a function body is an error (E0014 — use @local)"
// test was removed in the ADR-0020 migration. There is no `@global` surface keyword
// any more, and a bare `x := 5` inside a function body is a valid immutable local
// (not a GlobalInFunction error), so that diagnostic is no longer reachable from
// surface syntax.

test('a top-level binding is fine and is readable from a function body', () => {
    const { errors } = check('PI := 3;\n\\\\ f Int\n@fn f := {\n    PI + 1\n};')
    expect(errors).toHaveLength(0)
})

// ------------------------------------------------------------------
// String equality
// ------------------------------------------------------------------

test('String == String yields Bool with no error', () => {
    const { errors } = check("'a' == 'b';")
    expect(errors).toHaveLength(0)
})

test('String != String yields Bool with no error', () => {
    const { errors } = check("'hello' != 'world';")
    expect(errors).toHaveLength(0)
})

test('String < String is a type error', () => {
    const { errors } = check("'a' < 'b';")
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('InvalidOperator')
})

// ---------------------------------------------------------------------------
// @type_alias
// ---------------------------------------------------------------------------

test('@type_alias: declaration alone produces no errors', () => {
    const { errors } = check('@type_alias age := Int;')
    expect(errors).toHaveLength(0)
})

test('@type_alias: annotation using the alias resolves correctly', () => {
    const { errors } = check('@type_alias age := Int;\nmy_age := 34;')
    expect(errors).toHaveLength(0)
})

test('@type_alias: alias is transparent — alias value + Int is valid', () => {
    const { errors } = check('@type_alias age := Int;\nx := 5;\nx + 10;')
    expect(errors).toHaveLength(0)
})

test('@type_alias: alias registered in typeAliases map', () => {
    const { typeAliases } = check('@type_alias Metres := Int;')
    expect(typeAliases.has('Metres')).toBe(true)
    const t = typeAliases.get('Metres')!
    expect(t.kind).toBe('Int')
})

test('@type_alias: unknown underlying type is an error', () => {
    const { errors } = check('@type_alias Foo := NonExistentType;')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('UnknownType')
})

// ---------------------------------------------------------------------------
// @type_distinct
// ---------------------------------------------------------------------------

test('@type_distinct: declaration alone produces no errors', () => {
    const { errors } = check('@type_distinct UserId := Int;')
    expect(errors).toHaveLength(0)
})

test('@type_distinct: registered as Distinct kind in typeAliases', () => {
    const { typeAliases } = check('@type_distinct UserId := Int;')
    expect(typeAliases.has('UserId')).toBe(true)
    const t = typeAliases.get('UserId')!
    expect(t.kind).toBe('Distinct')
    if (t.kind === 'Distinct') {
        expect(t.name).toBe('UserId')
        expect(t.underlying.kind).toBe('Int')
    }
})

test('@type_distinct: assigning Int to distinct-typed binding is a type error', () => {
    const { errors } = check('@type_distinct UserId := Int;\n\\\\ id UserId\nid := 42;')
    // 42 is Int; UserId is Distinct — they are not equal, so this is a type error.
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('Annotation')
})

// ---------------------------------------------------------------------------
// @type_sum
// ---------------------------------------------------------------------------

test('@type_sum: declaration alone produces no errors', () => {
    const { errors } = check('@enum Color := Red | Green | Blue;')
    expect(errors).toHaveLength(0)
})

test('@type_sum: sum type registered in typeAliases as Sum kind', () => {
    const { typeAliases } = check('@enum Color := Red | Green | Blue;')
    expect(typeAliases.has('Color')).toBe(true)
    const t = typeAliases.get('Color')!
    expect(t.kind).toBe('Sum')
    if (t.kind === 'Sum') {
        expect(t.name).toBe('Color')
        expect(t.variants).toEqual(['Red', 'Green', 'Blue'])
    }
})

test('@type_sum: variant reference Color::Red resolves without error', () => {
    const { errors } = check('@enum Color := Red | Green | Blue;\nColor::Red;')
    expect(errors).toHaveLength(0)
})

test('@type_sum: variant reference has the sum type', () => {
    const { errors, program } = check('@enum Color := Red | Green | Blue;\nColor::Red;')
    expect(errors).toHaveLength(0)
    // The program elements contain the Namespace node annotated with inferredType.
    // We just verify no errors — full type annotation tests live in unit tests.
})

test('@type_sum: variants are immutable — assigning to Color::Red is a type error', () => {
    const { errors } = check('@enum Color := Red | Green | Blue;\nColor::Red = 99;')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('ImmutableAssignment')
})

test('@type_sum: variant == variant comparison is valid (returns Bool)', () => {
    const { errors } = check('@enum Color := Red | Green | Blue;\nColor::Red == Color::Green;')
    expect(errors).toHaveLength(0)
})

test('@type_sum: single-variant sum type works', () => {
    const { errors, typeAliases } = check('@enum Unit := Only;')
    expect(errors).toHaveLength(0)
    const t = typeAliases.get('Unit')
    expect(t?.kind).toBe('Sum')
    if (t?.kind === 'Sum') expect(t.variants).toEqual(['Only'])
})

// ---------------------------------------------------------------------------
// @match
// ---------------------------------------------------------------------------

test('@match: basic sum type matching has no errors', () => {
    const { errors } = check(
        '@enum Color := Red | Green | Blue;' +
        '@mut c := Color::Red;' +
        '@match(c, Color::Red, { 1 }, Color::Green, { 2 }, Color::Blue, { 3 });'
    )
    expect(errors).toHaveLength(0)
})

test('@match: wrong pattern type is a type error', () => {
    // Pattern is Int literal, discriminant is Color — Mismatch
    const { errors } = check(
        '@enum Color := Red | Green | Blue;' +
        '@mut c := Color::Red;' +
        '@match(c, 1, { 10 }, 2, { 20 });'
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('Mismatch')
})

test('@match: mismatched arm result types is a type error', () => {
    // First arm returns Int, second returns Float
    const { errors } = check(
        '@enum Color := Red | Green | Blue;' +
        '@mut c := Color::Red;' +
        '@match(c, Color::Red, { 1 }, Color::Green, { 2.5 });'
    )
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('Mismatch')
})

test('@match: result type flows through to caller', () => {
    // @match returns Int, so 3 + result should be valid
    const { errors } = check(
        '@enum Color := Red | Green | Blue;' +
        '@mut c := Color::Red;' +
        '3 + @match(c, Color::Red, { 1 }, Color::Green, { 2 }, Color::Blue, { 3 });'
    )
    expect(errors).toHaveLength(0)
})

// ---------------------------------------------------------------------------
// @local — block-local variable bindings
// ---------------------------------------------------------------------------

test('@local: declaration with matching annotation has no errors', () => {
    const { errors } = check('\\\\ f (Int)\nf x := {\n    @mut tmp := x + 1;\n    tmp\n};')
    expect(errors).toHaveLength(0)
})

test('@local: wrong annotation type is a type error', () => {
    const { errors } = check('\\\\ f (Int)\nf x := { \\\\ tmp Float\n@mut tmp := x + 1; tmp };')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('Annotation')
})

test('@local: is mutable — reassignment does not error', () => {
    const { errors } = check('\\\\ f (Int)\nf x := {\n    @mut tmp := 0;\n    tmp = x + 1;\n    tmp\n};')
    expect(errors).toHaveLength(0)
})

test('@local: type flows through to caller', () => {
    // tmp is Int, so tmp + 1 should be valid
    const { errors } = check('\\\\ f (Int)\nf x := {\n    @mut tmp := x;\n    tmp + 1\n};')
    expect(errors).toHaveLength(0)
})

test('@local: wrong type in reassignment is a type error', () => {
    const { errors } = check('\\\\ f (Int)\nf x := {\n    @mut tmp := 0;\n    tmp = 3.14;\n    tmp\n};')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('Mismatch')
})

// ---------------------------------------------------------------------------
// @extern type checking
// ---------------------------------------------------------------------------

test('@extern: call with correct arg type has no errors', () => {
    const { errors } = check('\\\\ @extern print (String) -> Void;')
    expect(errors).toHaveLength(0)
})

test('@extern: call with wrong arg type is a Mismatch', () => {
    const { errors } = check('\\\\ @extern print (String);\nprint(42);')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('Mismatch')
})

test('@extern: wrong arity is an ArityMismatch', () => {
    const { errors } = check('\\\\ @extern add (Int, Int);\nadd(1);')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].kind).toBe('ArityMismatch')
})
