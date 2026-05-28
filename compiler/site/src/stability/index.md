---
title: "Stability"
---
# Silicon 1.0 — Stability Policy

This document is the authoritative reference for what is and is not stable across
Silicon 1.0 releases.  It covers three surfaces: the **language**, the **CaaS
compiler API**, and the **strata authoring API**.  Each surface has its own
contract because they have different consumers and different rates of change.

---

## Versioning scheme

Silicon follows semantic versioning — `MAJOR.MINOR.PATCH`:

- **PATCH** — bug fixes only.  No observable behaviour changes.
- **MINOR** — additive changes: new keywords, new API methods, new diagnostic
  codes.  Existing code continues to compile.
- **MAJOR** — breaking changes: removed syntax, changed API signatures, retired
  diagnostic codes.  Migration notes shipped with the release.

The 1.0 stability promise begins on the first `1.0.0` tag.  Pre-1.0 tags
(`0.x.y`) are developmental — any release may break any surface.

---

## 1. Language stability

### Stable in 1.0

| Feature | Notes |
|---|---|
| Definition keywords | `@fn`, `@let`, `@var`, `@type`, `@enum`, `@struct`, `@extern`, `@use` |
| Control-flow keywords | `@if`, `@loop`, `@match`, `@return`, `@defer`, `@try` |
| Literal syntax | integers (decimal, hex `0x`, binary `0b`, octal `0o`), floats, booleans (`@true`/`@false`), strings, arrays `[…]`, tuples `(…)`, objects `{…}` |
| Type surface | `Int`, `Int32`, `Int64`, `Float`, `Bool`, `Str`, `Option[T]`, `Result[T,E]`, `Slice[T]` |
| Operator surface | `+`, `-`, `*`, `/`, `%`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `&&`, `\|\|`, `!`, `&` (call sigil), `@` (keyword sigil), `$` (variant sigil) |
| Generic functions | `@fn f[T] x:T := …` — call-site inference, no explicit `[T]` required |
| Sum types | `@type Foo := $A x:Int \| $B;` — variant constructors + `@match` destructure |
| Parametric types | `@type Opt[T] := $Some v:T \| $None;` |
| `@match` forms | flat form and arm-expression (`$A v => expr`) forms |
| Namespace paths | `Module::name` |
| Semicolon rules | trailing semicolons required on definitions; expressions inside blocks are semicolon-separated |
| Comment syntax | `;;` line comments, `##` doc comments |

### Stable with caveats

| Feature | Caveat |
|---|---|
| `@use "path"` | path resolution algorithm may change in a minor release if it is needed to support package registries |
| Strata keywords | user-defined keywords via `@stratum` are stable once registered; the _registration API_ follows the strata API contract below |
| `@comptime` | strata-body interpreter is Zig-style dissolution target (see `docs/comptime-via-compilation.md`); the surface syntax is stable but the execution model may change |

### Not stable (internal)

- The Ohm grammar file `src/grammar/silicon-official.ohm` — used by the `src/`
  TypeScript compiler.
- AST node shapes (`Program`, `Definition`, `FunctionCall`, etc.) — internal
  to the compiler; accessed only through the CaaS API.
- IR node shapes (`IRExpr`, `IRBlock`, etc.) — internal.
- WAT output layout — the emitted WAT is correct but its exact structure
  (local ordering, block nesting) may change between patch releases.

### Removed / never shipped

- Postfix operators (e.g. Rust-style `expr?`) — Silicon operators are binary
  infix or prefix-keyword.  Will not be added.  See ADR 0010 — LL(1) target.
- Integer literal suffixes (`42i64`) — use `&@toInt64 42` instead.
- Implicit numeric coercion — always explicit.

### Grammar shape invariant

Silicon's grammar targets **LL(1)** — top-down, leftmost derivation, single
token of lookahead.  This is a binding design constraint, not aspirational:
new grammar changes must preserve the property, and `docs/grammar.ebnf` §LL(1)
is the canonical reference for the parser-shaped (left-factored) form.  See
[ADR 0010](adr/0010-grammar-targets-ll1.md) for the rationale.

---

## 2. CaaS API stability

The full API reference is in `docs/compiler-as-a-service.md`.

### Stable public surface (`src/api.ts`)

Import only from `src/api.ts` (or the published package root once distributed).
Every name exported from that file is covered by the 1.0 stability promise.

```
parse()          buildRegistry()     elaborate()
typecheck()      lower()             compile()
SyntaxTree       ElaboratorRegistry  SemanticModel
Symbol           Diagnostic          SourceSpan
ParseResult      ElabResult          CheckResult
LowerResult      CompileResult
Workspace        Document
ParseOptions     ElabOptions         CheckOptions
LowerOptions
```

### Stability rules

| Change type | Policy |
|---|---|
| Add a new exported function or type | Always permitted (minor release) |
| Add an optional field to an options interface | Always permitted (minor release) |
| Add a new method to an existing class/interface | Always permitted (minor release) |
| Change a function signature | Requires a major release |
| Remove an exported name | Requires a major release |
| Change the semantics of an existing function | Requires a major release |
| Add a new diagnostic code | Always permitted (minor release) |
| Retire / reassign a diagnostic code | Never — codes are permanent |

### Internal — not stable

Any import from inside `src/` other than `src/api.ts` is internal:

```
src/parser/        src/elaborator/    src/types/
src/ir/            src/codegen/       src/ast/
src/grammar/       src/modules/       src/fmt/
```

These may change without notice between any releases, including patches.  Do
not import from them directly.

### The `_functions` and `_` prefix convention

Names prefixed with `_` in result types (e.g. `CheckResult._functions`) are
`@internal` — part of the implementation contract between pipeline stages but
not part of the public API.  They may be renamed or removed in a minor release.

---

## 3. Strata API stability

The strata API is the set of `&Compiler::*` calls available inside a stratum
body.  Full reference in `docs/strata-authoring-guide.md`.

### Stable calls (1.0)

| Call | Purpose |
|---|---|
| `&Compiler::register::keyword '@kw'` | Register a new definition keyword |
| `&Compiler::register::operator 'op'` | Register a new binary operator |
| `&Compiler::on::decl '@kw', { … }` | Handler for each declaration |
| `&Compiler::on::call '@kw', { … }` | Handler for each call site |
| `&Compiler::on::operator 'op', { … }` | Handler for each operator use |
| `&Compiler::emit::ir node` | Emit an IR node |
| `&Compiler::node::name` | Read the declaration name |
| `&Compiler::node::params` | Read the parameter list |
| `&Compiler::node::binding` | Read the binding expression |
| `&Compiler::format str, …args` | Diagnostic message formatting |
| `&Compiler::error msg` | Emit a diagnostic and halt elaboration |
| `&Compiler::substitute template, env` | Text substitution for IR templates |

### Stable with caveats

| Call | Caveat |
|---|---|
| `&Compiler::module::push_definition` | Signature may grow optional fields in a minor release |
| `&Compiler::on::derive` | `@@derive` handler; stable syntax but derive trait registry is additive-only |
| `&Compiler::state 'stratum'` | State keys other than `'stratum'` are not yet stable |

### Not stable

- Raw IR builder calls other than `&Compiler::emit::ir` — these are internal
  and subject to change as the IR evolves.
- The execution engine for strata bodies — currently an interpreter; will be
  replaced by the comptime-via-compilation approach documented in
  `docs/comptime-via-compilation.md`.  The _surface_ API does not change.

### Extension rule

Strata authors can add new `&Compiler::register::*` calls in a minor release.
Calling an unrecognised `&Compiler::*` path emits a warning (not an error) so
that strata written against a newer compiler version degrade gracefully on older
toolchains.

---

## Summary table

| Surface | Stable in 1.0 | Breaking change policy |
|---|---|---|
| Silicon language syntax | Yes (see §1) | Major version |
| CaaS public API (`src/api.ts`) | Yes (see §2) | Major version |
| Diagnostic codes | Yes (additive) | Never retired |
| Strata authoring API | Yes (see §3) | Major version |
| AST / IR node shapes | No | Any release |
| Internal compiler modules | No | Any release |
| WAT output layout | No | Any release |

---

*Last updated: Silicon 1.0.  Owned by the Sigil compiler team.*
