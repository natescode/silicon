# Strata Authoring Guide

> Sigil 1.0 — Phase 3, story 3-24.

A **stratum** is the Silicon mechanism for adding a keyword, operator, or
annotation-driven code transformation to the compiler **as data**, not as a
hard-coded compiler change. If you have ever wanted to write your own `@defer`,
your own `@@derive Eq`, or your own DSL keyword that produces real WASM — this
is the doc.

## TL;DR

```silicon
@stratum MyStratum := {
    &Compiler::register::keyword '@my_kw';
    &Compiler::on::decl '@my_kw', {
        ;; what happens when the compiler sees `@my_kw` in source
    };
};

@my_kw foo := 42;       ;; user code; the handler above runs at compile time
```

Save that to any `.si` file in your build's `@use` graph and the keyword is
live. No grammar changes, no compiler rebuild.

---

## The unified form

```silicon
@stratum <Name> := {
    <statement>;
    <statement>;
    ...
};
```

`<Name>` is a normal Silicon identifier — used in diagnostics and as the
identity key for `state 'stratum'`. The body is a sequence of `Compiler::*`
calls; the loader recognises a small fixed vocabulary (described below) and
ignores anything else.

`@stratum` lives at top level in a Silicon source file. You can declare any
number of strata per file.

The legacy `@stratum_keyword Foo ('@foo', Node) = { ... };` and
`@stratum_operator Bar ('+', Node) = { ... };` forms are still recognised, but
new strata should use the unified form.

---

## Registering keywords and operators

```silicon
&Compiler::register::keyword '@my_kw';
&Compiler::register::operator '<<';
```

After registration the parser will tokenise `@my_kw` as a keyword and `<<` as
an operator and route them through the elaborator. Without any further
hooks, the keyword/operator is *registered* but has no semantics — calls
through it return `IR_NONE`.

To give the symbol semantics, attach one of the phase handlers below.

---

## The five phase hooks

Strata 2.0 exposes five lifecycle phases. Register handlers via
`&Compiler::on::<phase>`.

### `on::decl` — fires for each definition

```silicon
&Compiler::on::decl '@my_kw', {
    ;; runs for every `@my_kw foo := ...;` declaration the compiler sees.
    ;; you can inspect node.name, node.params, node.binding,
    ;; emit IR via &Compiler::module::push_definition,
    ;; or stash state for the module_finalize pass.
};
```

Fires once per `AST_DEFINITION` whose keyword span matches.

### `on::callSite` — fires for each call

```silicon
&Compiler::on::callSite 'my_fn', {
    ;; runs for every `&my_fn arg0, arg1;` call.
    ;; node.args is the arg list (Silicon expressions, not yet lowered).
    ;; commonly used for &@try / `?`-style desugaring strata.
};
```

### `on::annotation` — fires for each annotation on a definition

```silicon
&Compiler::on::annotation '@@derive', {
    ;; runs for every `@@derive Foo` annotation attached to a definition.
    ;; node.ann.args carries the annotation's arguments;
    ;; node.def is the Definition being annotated.
};
```

The `@@derive` and `@@eq` strata in the standard library work this way.

### `on::module_finalize` — fires once at end of compilation

```silicon
&Compiler::on::module_finalize {
    ;; runs once after every user definition has been seen.
    ;; this is where generic-style strata emit their monomorphised
    ;; concrete definitions via &Compiler::module::push_definition.
};
```

No token argument — there is only one finalize phase per stratum.

### `on::comptime` — comptime evaluation rule (advanced)

```silicon
&Compiler::on::comptime '@if', {
    ;; defines how `@if cond, then, else` evaluates at compile time
    ;; when the arms are literal constants.  Per the dissolution plan
    ;; (`docs/comptime-via-compilation.md`), every keyword that has a
    ;; runtime stratum will eventually also have a matching on::comptime
    ;; handler so the body interpreter can be deleted entirely.
};
```

Today this is registration-only; the comptime engine (3-22) routes through the
existing body interpreter as a stub. When the WASM-in-WASM engine lands these
handlers will fire automatically wherever a comptime-foldable expression
appears.

---

## The `state` API

Two scopes:

```silicon
@local s := &Compiler::state 'stratum';     ;; persists across handler calls
                                            ;; within THIS stratum

@local h := &Compiler::state 'instance';    ;; fresh per handler call
```

Both return a handle that supports:

```silicon
&s::set 'key', value;
@local v := &s::get 'key';
@local exists := &s::has 'key';
&s::each {  ;; for each (k, v) in this bucket
    ;; ...
};
```

Stratum state is the canonical place for a generic-style stratum to stash a
captured template AST between `on::decl` (where it's seen) and
`on::module_finalize` (where it's monomorphised and pushed back).

---

## Module mutation: `push_definition` / `push_global`

```silicon
&Compiler::module::push_definition <ast_def>;
&Compiler::module::push_global     <name>, <type>, <init>;
```

Both append to a per-compilation accumulator that the lowerer drains AFTER the
main pass. Handler-synthesised definitions are guaranteed to appear in the
final module exactly once.

---

## AST operations

```silicon
@local h := &Compiler::ast::capture_template node, 'pre';
@local h2 := &Compiler::ast::clone h;
@local h3 := &Compiler::ast::substitute h, { T = IntType, U = FloatType };
@local h4 := &Compiler::ast::patch_types h, { T = IntType };
```

The `'pre'` / `'post'` argument marks whether the template was captured before
or after type inference. `substitute` walks the AST and replaces every
`AST_NAMESPACE` node whose first segment matches a binding key with the
replacement AST. `patch_types` does the same for inferred-type slots on
typed-IR-carrying nodes.

---

## Types as data

The full `type` API is exposed at compile time:

```silicon
@local int_t   := &Compiler::type::int;
@local fn_t    := &Compiler::type::function [int_t, int_t], int_t;
@local var_t   := &Compiler::type::variable 'T';
@local arr_int := &Compiler::type::array int_t;
@local same    := &Compiler::type::equals int_t, int_t;
@local s_int   := &Compiler::type::substitute fn_t, { T = int_t };
@local pretty  := &Compiler::type::format fn_t;       ;; "(Int, Int) -> Int"
```

Substitution is single-binding per call; chain calls for multi-binding.

---

## Diagnostics (T-5)

```silicon
&Compiler::diag::error 'E0042', node.span, 'oops', 'try this instead';
&Compiler::diag::warn  'W0001', node.span, 'this is deprecated';
```

Diagnostics **accumulate** — `diag::error` does not stop the build. The compiler
keeps going and emits as many diagnostics as your handler can produce. Errors
in the final output cause a non-zero exit code at the end; the codegen step
inserts `$silicon_runtime_trap` calls at offending sites (T-5 runtime-trap
model — wires up in a later compiler slice).

---

## Testing a stratum

The pattern, mirroring `boot/tests/strata2_test.si`:

```silicon
@use '../std/io.si';
@use '../parser/lex.si';
@use '../parser/parse.si';
@use '../strata/registry.si';
@use '../strata/loader.si';
@use '../elab/body_rich.si';

@fn _start:Void := {
    @local src := '@stratum MyTest := { &Compiler::register::keyword \'@my\'; };';
    @local len := &WASM::i32_load (&str_ptr src);
    @local bytes := (&str_ptr src) + 4;

    @local toks := &lex bytes, len;
    @local prog := &parse bytes, len, toks;
    &registry_init;
    &load_strata prog;

    @local ok := ((&registry_kw_count) == 1);
    &@if ok,
      { &write_str 1, 'my-test OK' },
      { &write_str 1, 'my-test FAIL' };
    &write_byte 1, 10;
    &wasi_snapshot_preview1::proc_exit 0;
};
```

Then `./test.sh boot/tests/my_test.si`.

---

## Stratum tiers

Strata are tagged with one of three tiers at load time:

- **T0** — built-in. Comes from `boot/strata/builtin/*.si` via the embedded
  bundle. Always loads first; cannot be cyclic (T-6 detects cycles and emits
  `S0001`).
- **T1** — inline in the user program currently being compiled.
- **T2** — pulled in via `@use`'d dependencies.

Within a tier, handlers fire in registration order. Across tiers, T0 fires
before T1 before T2.

Most strata you write will be T1 (inline in your program) or T2 (a `@use`'d
library). T0 is reserved for the language's own primitives.

---

## Multiple handlers for the same token

Allowed and intentional — Strata composes via the observer pattern:

```silicon
@stratum LogDecl := {
    &Compiler::register::keyword '@logged';
    &Compiler::on::decl '@logged', {
        &Compiler::diag::warn 'L001', node.span, 'logged decl';
    };
};

@stratum CountDecl := {
    &Compiler::on::decl '@logged', {  ;; same token, different handler
        @local s := &Compiler::state 'stratum';
        &s::set 'count', ((&s::get 'count') + 1);
    };
};
```

Both handlers fire on every `@logged` declaration. Use `state 'stratum'` to
keep their state isolated.

---

## CompilerAPI stability contract

The `Compiler::*` surface is **stable across Sigil 1.x**. Specifically:

- `register::keyword` / `register::operator` — stable contract.
- `on::decl` / `on::callSite` / `on::annotation` / `on::module_finalize` /
  `on::comptime` — stable phase names; new phases may be added; existing
  phases will not be removed without a major version bump.
- `state 'stratum'` / `state 'instance'` — stable scopes; new scopes may be
  added.
- `module::push_definition` / `module::push_global` — stable accumulator.
- `ast::*` and `type::*` — stable APIs; new operations may be added.
- `diag::error` / `diag::warn` — stable; never throws (T-5).

Anything beyond this surface (the `Compiler::ir::*` builders, the internal
field-offset constants, the `R_*` / `H_*` registry vecs) is private to the
compiler implementation and may change without notice. Strata that touch
those internals should expect to be rewritten when they break.

---

## Pointers

- **Worked example**: `boot/tests/strata2_test.si` exercises every API in this
  guide; the test source is the most up-to-date demonstration of correct call
  shapes.
- **Specification**: `docs/strata-2.0-spec.html` is the formal contract; this
  guide is the friendlier introduction.
- **Dissolution plan**: `docs/comptime-via-compilation.md` is where
  `on::comptime` is going long-term.
- **v1 roadmap**: `docs/v1-user-stories.html` Phase 3 carries the
  story-by-story status of the boot/ port.
