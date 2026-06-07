# Strata Authoring Guide

> Sigil 0.1 — Phase 3, story 3-24.

A **stratum** is the Silicon mechanism for adding a keyword, operator, or
annotation-driven code transformation to the compiler **as data**, not as a
hard-coded compiler change. If you have ever wanted to write your own `@defer`,
your own `@@derive Eq`, or your own DSL keyword that produces real WASM — this
is the doc.

## TL;DR

```silicon
@stratum MyStratum := {
    Compiler::register::keyword('@my_kw');
    Compiler::on::decl('@my_kw', {
        ;; what happens when the compiler sees `@my_kw` in source
    });
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
Compiler::register::keyword('@my_kw');
Compiler::register::operator('<<');
```

After registration the parser will tokenise `@my_kw` as a keyword and `<<` as
an operator and route them through the elaborator. Without any further
hooks, the keyword/operator is *registered* but has no semantics — calls
through it return `IR_NONE`.

To give the symbol semantics, attach one of the phase handlers below.

---

## The five phase hooks

Strata 2.0 exposes five lifecycle phases. Register handlers via
`Compiler::on::<phase>(...)`.

### `on::decl` — fires for each definition

```silicon
Compiler::on::decl('@my_kw', {
    ;; runs for every `@my_kw foo := ...;` declaration the compiler sees.
    ;; you can inspect node.name, node.params, node.binding,
    ;; emit IR via Compiler::module::push_definition(...),
    ;; or stash state for the module_finalize pass.
});
```

Fires once per `AST_DEFINITION` whose keyword span matches.

### `on::callSite` — fires for each call

```silicon
Compiler::on::callSite('my_fn', {
    ;; runs for every `my_fn(arg0, arg1);` call.
    ;; node.args is the arg list (Silicon expressions, not yet lowered).
    ;; commonly used for @try / `?`-style desugaring strata.
});
```

### `on::annotation` — fires for each annotation on a definition

```silicon
Compiler::on::annotation('@@derive', {
    ;; runs for every `@@derive Foo` annotation attached to a definition.
    ;; node.ann.args carries the annotation's arguments;
    ;; node.def is the Definition being annotated.
});
```

The `@@derive` and `@@eq` strata in the standard library work this way.

### `on::module_finalize` — fires once at end of compilation

```silicon
Compiler::on::module_finalize({
    ;; runs once after every user definition has been seen.
    ;; this is where generic-style strata emit their monomorphised
    ;; concrete definitions via Compiler::module::push_definition(...).
});
```

No token argument — there is only one finalize phase per stratum.

### `on::comptime` — comptime evaluation rule (advanced)

```silicon
Compiler::on::comptime('@if', {
    ;; defines how `@if(cond, then, else)` evaluates at compile time
    ;; when the arms are literal constants.  Per the dissolution plan
    ;; (`docs/comptime-via-compilation.md`), every keyword that has a
    ;; runtime stratum will eventually also have a matching on::comptime
    ;; handler so the body interpreter can be deleted entirely.
});
```

Today this is registration-only; the comptime engine (3-22) routes through the
existing body interpreter as a stub.  When story 8-9 lands (Phase 8 + wasmtime
as a linked C library) these handlers will fire under a real wasm runtime
wherever a comptime-foldable expression appears.

---

## The comptime engine in Sigil 0.1

**TL;DR**: the 0.1 comptime engine is the **AST interpreter** in
`src/elaborator/`.  Handler bodies are not compiled to wasm and run
inside an embedded runtime — they're walked node-by-node by the
TypeScript host. The full WASM-in-WASM dissolution arrives in a later release via
Phase 8 + 8-9 once native compilation lets us link wasmtime as a
C library.

This shapes what's allowed inside a handler body.

### What works in handler bodies today

- All `Compiler::*` surface calls — `register::*`, `on::*`, `state`,
  `module::push_definition`, `ast::*`, `type::*`, `diag::*`, `ir::*`,
  `ctx::*`, `lowerExpr`, `arg`, `watId`, `resolveType`, `assertDefined`.
- Scalar arithmetic and comparisons on `Int` (`+`, `-`, `*`, `/`, `%`,
  `==`, `!=`, `<`, `>`, `<=`, `>=`).
- `name := expr;` bindings (resolved against the body scope).
- `@if(cond, { then }, { else })` — the AST interpreter has this hardcoded.
- Hardcoded `@return`, `@break`, `@continue` work as expected at the
  outermost handler level (but see limits below).

### What doesn't work yet

- **`@loop` in handler bodies.** The AST interpreter has no loop driver.
  Workaround: unroll manually, or stash iteration state in
  `state 'stratum'` across multiple `on::decl` firings.
- **Recursion in handler bodies.** The interpreter has no call stack for
  user-defined functions invoked from a handler.  You can call `Compiler::*`
  primitives freely; you cannot call your own `@fn foo := { ... }` recursively
  from inside a handler.
- **Generic user-defined Silicon functions called from a handler.**  Same
  reason as recursion — the interpreter doesn't dispatch arbitrary `@fn`
  calls.  Stick to `Compiler::*` calls + arithmetic + bare bindings.
- **`@match` inside a handler body.**  The AST interpreter doesn't lower
  match arms.  Use chained `@if` instead.
- **Strings other than as literal arguments to `Compiler::*` calls.**
  No string manipulation, concatenation, or comparison inside a handler.
  If you need to compare strings, do it via the type/AST handle layer —
  the host-side primitives compare bytes for you.

### Designing around the limits

Most production strata don't actually need the missing pieces:

- **`@defer`-style strata** stash deferred bodies in `state 'stratum'`
  during `on::decl`; emit cleanup code in `on::module_finalize`.  No loop
  needed — `module_finalize` fires once and walks the deferred list via
  `Compiler::state::each` (a primitive, not user-side iteration).
- **`@@derive Eq`-style strata** inspect `def.fields` from `on::annotation`
  and emit one comparison per field.  The iteration over fields is a host
  primitive (`Compiler::ast::children`), not a user-side `@loop`.
- **Generic monomorphisation strata** capture the template in `on::decl`,
  clone + substitute in `on::module_finalize` per requested instance.  No
  recursion — substitution is a host primitive.  Note: user-written
  generic functions are *already shipped* via the built-in `@fn[T]`
  surface (see `docs/hm-lite.md`).  The strata-authored `@generic`
  pattern is an *advanced Strata 2.0 capability proof* — it shows the
  Strata system is powerful enough to implement monomorphization from
  scratch.  End-to-end shipping of the `@generic` keyword is a post-0.1
  follow-up; see `docs/adr/0001-generic-monomorphization-scope.md` story G-1.

The pattern: **anything that needs iteration runs as a host primitive,
not as Silicon control flow in the handler body**.  The handler body
orchestrates host primitives; it doesn't implement the algorithm itself.

### When the limits start to bite

When you genuinely need user-side iteration or recursion at compile time —
typically for complex codegen like a regex compiler stratum, a
state-machine generator, or a SQL parser stratum — you've hit the cases
8-9 unlocks.  Track those needs in the issue tracker; they motivate the
production engine's priority.

### What 8-9 changes

When Phase 8 + 8-9 ship, the AST interpreter becomes optional.  Native
sigilc compiles handler bodies through the normal Silicon pipeline → wat
→ wasm and runs them under wasmtime's Cranelift JIT.  At that point every
Silicon feature is available in handler bodies — `@loop`, `@match`,
recursion, user-defined functions, generics.  The `Compiler::*` API
signatures stay identical, so handlers written today continue to work
unchanged.

---

## The `state` API

Two scopes:

```silicon
s := Compiler::state('stratum');     ;; persists across handler calls
                                     ;; within THIS stratum

h := Compiler::state('instance');    ;; fresh per handler call
```

Both return a handle that supports:

```silicon
s::set('key', value);
v := s::get('key');
exists := s::has('key');
s::each({  ;; for each (k, v) in this bucket
    ;; ...
});
```

Stratum state is the canonical place for a generic-style stratum to stash a
captured template AST between `on::decl` (where it's seen) and
`on::module_finalize` (where it's monomorphised and pushed back).

---

## Module mutation: `push_definition` / `push_global`

```silicon
Compiler::module::push_definition(<ast_def>);
Compiler::module::push_global(<name>, <type>, <init>);
```

Both append to a per-compilation accumulator that the lowerer drains AFTER the
main pass. Handler-synthesised definitions are guaranteed to appear in the
final module exactly once.

---

## AST operations

```silicon
h := Compiler::ast::capture_template(node, 'pre');
h2 := Compiler::ast::clone(h);
h3 := Compiler::ast::substitute(h, ${ T = IntType, U = FloatType });
h4 := Compiler::ast::patch_types(h, ${ T = IntType });
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
int_t   := Compiler::type::int();
fn_t    := Compiler::type::function([int_t, int_t], int_t);
var_t   := Compiler::type::variable('T');
arr_int := Compiler::type::array(int_t);
same    := Compiler::type::equals(int_t, int_t);
s_int   := Compiler::type::substitute(fn_t, { T = int_t });
pretty  := Compiler::type::format(fn_t);       ;; "(Int, Int) -> Int"
```

Substitution is single-binding per call; chain calls for multi-binding.

---

## Diagnostics (T-5)

```silicon
Compiler::diag::error('E0042', node.span, 'oops', 'try this instead');
Compiler::diag::warn('W0001', node.span, 'this is deprecated');
```

Diagnostics **accumulate** — `diag::error` does not stop the build. The compiler
keeps going and emits as many diagnostics as your handler can produce. Errors
in the final output cause a non-zero exit code at the end; the codegen step
inserts `$silicon_runtime_trap` calls at offending sites (T-5 runtime-trap
model — wires up in a later compiler slice).

---

## Testing a stratum

The pattern: drive the compiler in a test alongside the rest of the
TypeScript suite (`bun test src/elaborator/strata2.test.ts` is the
worked example) — load the stratum into a `Program`, run elaboration,
and assert on the resulting AST or diagnostics.

---

## Stratum tiers

Strata are tagged with one of three tiers at load time:

- **T0** — built-in. Comes from `src/strata/*.si`. Always loads first;
  cannot be cyclic (T-6 detects cycles and emits `S0001`).
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
    Compiler::register::keyword('@logged');
    Compiler::on::decl('@logged', {
        Compiler::diag::warn('L001', node.span, 'logged decl');
    });
};

@stratum CountDecl := {
    Compiler::on::decl('@logged', {  ;; same token, different handler
        s := Compiler::state('stratum');
        s::set('count', (s::get('count') + 1));
    });
};
```

Both handlers fire on every `@logged` declaration. Use `state 'stratum'` to
keep their state isolated.

---

## CompilerAPI stability contract

The `Compiler::*` surface is the **intended-stable** strata API; the promise
takes effect at 1.0 and is meant to hold across Sigil 1.x (Silicon is currently
at 0.1 / pre-1.0). Specifically:

- `register::keyword` / `register::operator` — stable contract.
- `on::decl` / `on::callSite` / `on::annotation` / `on::module_finalize` /
  `on::comptime` — stable phase names; new phases may be added; existing
  phases will not be removed without a major version bump.
- `state 'stratum'` / `state 'instance'` — stable scopes; new scopes may be
  added.
- `module::push_definition` / `module::push_global` — stable accumulator.
- `ast::*` and `type::*` — stable APIs; new operations may be added.
- `diag::error` / `diag::warn` — stable; never throws (T-5).

The **comptime engine implementation** is *not* part of the stable surface
— what works inside a handler body grows over time:

- **0.1 (today)**: AST interpreter; `Compiler::*` + scalar arithmetic + `@if` +
  bare bindings (see "The comptime engine in Sigil 0.1" above).
- **Later (after Phase 8 + 8-9)**: wasmtime-backed; full Silicon surface in
  handler bodies — `@loop`, `@match`, recursion, user-defined `@fn` calls.
  Existing handlers written against the 0.1 limits will continue to work
  unchanged; the API signatures don't change.

Anything beyond the stable surface (the `Compiler::ir::*` builders, the
internal field-offset constants, the `R_*` / `H_*` registry vecs) is
private to the compiler implementation and may change without notice.
Strata that touch those internals should expect to be rewritten when they
break.

---

## Pointers

- **Worked example**: `src/elaborator/strata2.test.ts` exercises every API in
  this guide; the test source is the most up-to-date demonstration of correct
  call shapes.
- **Specification**: `docs/strata-2.0-spec.html` is the formal contract; this
  guide is the friendlier introduction.
- **Dissolution plan**: `docs/comptime-via-compilation.md` is where
  `on::comptime` is going long-term.
