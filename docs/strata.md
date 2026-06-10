# Strata

Strata are Silicon's open extension system. Built-in operators, control-flow keywords, sum-type lowering, etc. are all implemented as strata files (`src/strata/*.si`); user code will eventually be able to ship its own strata as the language's mod surface (post-bootstrap; see `docs/archive/bootstrap-plan.html` §7 — "Strata as Mods").

## How Strata Work Today

1. **Loader** — `src/elaborator/strataLoader.ts` reads the built-in bundle from `src/strata/*.si` and parses each `@stratum_*` definition.
2. **Registry** — Each registration lands in `ElaboratorRegistry` tables keyed by operator symbol, keyword, or definition-keyword.
3. **Rich body interpreter** — A stratum body that uses `Compiler::*()` calls is compiled into a closure via `compileBodyToExpanderFn` / `compileBodyToDefExpander` and runs during IR lowering. The body interpreter lives in `src/elaborator/strataBody.ts`.
4. **`CompilerAPI`** — The surface strata bodies dispatch into is documented in `docs/compiler-api.md` and implemented in `src/compiler-api/index.ts`.

## StrataTypes

The Silicon spec defines **nine** conceptual StrataTypes. The compiler does **not**
dispatch on them — built-in lowering is selected by the registered token (operator
symbol or keyword) and its `on::lower` handler, not by StrataType. The `StrataType`
enum (`src/elaborator/strataenum.ts`) is a coarse classification tag with **six**
variants, and in the current loader only two are ever assigned: `strataLoader.ts`
tags every keyword `StrataType.Keyword` and every operator `StrataType.Operator`.
The mapping from the nine spec types to the enum, with status:

| Spec StrataType | Code enum variant | What It Extends | Status |
| --- | --- | --- | --- |
| Operator    | `Operator`        | Binary infix operators (`+`, `==`, …)                                 | Implemented (`operators.si`); assigned at load |
| Control     | `Control` ¹       | Control-flow keywords (`@if`, `@loop`, `@break`, `@match`, `@return`) | Implemented as data (`if.si`, `loop.si`, `control.si`, `match.si`); tagged `Keyword` at load |
| Type        | `Definition` ²    | Named types the type system understands                               | Hard-coded primitives (`Int`, `Float`, `Bool`, `String`); user types via `@type` / `@enum` / `@type_alias` / `@type_distinct` |
| Constraint  | `Constraint`      | Typeclass / protocol-style constraints                                | None — enum slot reserved, no dispatch |
| Codegen     | — (reserved)      | Replaces or supplements lowering for an AST/IR node kind              | Partial — control/def-kind lowering live in `.si`; new IR node kinds still need TS. The full version needs open-tagged IR (bootstrap-plan R1, done with the self-host port) |
| Runtime     | — (reserved)      | Custom allocators, schedulers, panic handlers                         | None |
| Capability  | — (reserved)      | Effect / permission gates                                             | None — `required_caps` is post-bootstrap |
| Metadata    | `Metadata` ¹      | Annotation kinds (`@export`, `@platform`, future `@inline`)           | Implemented as data (`metadata.si`); tagged `Keyword` at load |
| DSL         | — (reserved)      | Delegates a syntactic region to a sub-parser                          | None — bootstrap-plan reserves `parse_dsl_region` hook |

¹ The finer variants `Control`, `Definition`, `Constraint`, and `Metadata` exist in
the enum but are **not assigned by the live loader** — every keyword is tagged
`StrataType.Keyword`, every operator `StrataType.Operator`. The
`strataTypeFromIntrinsic` classifier that *would* assign the finer tags (from
`WASM::control_*` / `IR::def_*` / `IR::meta_*` intrinsic names) is currently
**unused**, because migrated strata carry an `on::lower` handler instead of an
intrinsic. The classification is informational, not load-bearing.

² The code's `Definition` variant covers **all** definition keywords (`@fn`,
`@global`, `@extern`, `@struct`, `@type` / `@enum` / `@type_alias` / `@type_distinct`) —
broader than the spec's `Type` (just named types). The enum's sixth variant,
`Keyword`, is the catch-all every expression keyword is actually tagged with. The
four spec types with no enum variant (`Codegen`, `Runtime`, `Capability`, `DSL`) are
reserved; see `docs/strata-feature-audit.html` for which are unbuilt and why.

Authoritative API reference: `docs/compiler-api.md`. Bootstrap roadmap (which StrataTypes Stage 1 will need, in what order): `docs/archive/bootstrap-plan.html`.

## Example: An Operator Stratum

```silicon
@stratum_operator Plus ('+', Node) = {
  WASM::i32_add(Node.left, Node.right);
};
```

That registration lets `1 + 2;` compile correctly. Once the constraint StrataType lands, a typed variant can be added with a parameter type so the operator is dispatched per operand type without the body interpreter sniffing types.

## Definition-Kind Strata

Bare `:=` globals, `@fn`, `@mut`, `@extern`, `@enum`, `@type`, `@export`, `@platform` are all definition keywords whose lowering is contributed by strata in `src/strata/defkinds.si` and `src/strata/metadata.si`. Each one references an `IR::*` intrinsic (see `src/ir/irKinds.ts`); the elaborator stamps the matching `CodegenKind` onto the AST Definition node, and the lowering walker picks the corresponding def-expander from the registry.

## Future: an optimization phase (Strata-driven IR passes)

Every phase today is **front-end**: `StratumPhase = 'decl' | 'callSite' |
'annotation' | 'lower' | 'moduleFinalize' | 'comptime'` (see
`src/elaborator/registry.ts`). These *declare* and *lower* — they turn surface
syntax into IR. **None of them rewrites already-lowered IR**, so Strata cannot
yet express an *optimization* pass. (The Bootstrap Notes below name "IR passes"
as an intended open-mod surface; this is the missing hook for it.)

A future `'optimize'` phase — an `on::optimize` handler that runs post-lowering
over the IR and may return a rewritten node — would let optimizations *be
strata too*, keeping Silicon's "language features are data, not compiler
special-cases" ethos extended past lowering into the optimizer. Note this is
**distinct from** the ADR-0012 work where an *existing* optimizer consumes
effect-class metadata: the point here is Strata themselves *expressing* the
IR→IR pass.

**Motivating first candidate — constant folding / nullary-const globalization.**
A bare top-level `PI := 314` is the nullary case of a definition, so — by
deliberate front-end uniformity (every top-level def lowers the same way) — it
becomes a zero-arg function and each use lowers to `(call $PI)`. That front-end
consistency is intentional and worth keeping; the cost is that, since the
default (non-async) pipeline runs **no optimizer** (`watToWasm` just assembles
WAT→wasm via wabt — binaryen's passes only run on the Asyncify path), the call
survives in the binary instead of folding to `(i32.const 314)` or a wasm
`global`. A constant-folding `'optimize'` stratum would detect a
compile-time-constant nullary def and rewrite its call sites to the constant
(or a `global.get`) — removing the overhead **without** special-casing the
front-end. It is an ideal proving ground: small, self-contained, unambiguously
an optimization (IR→IR, not lowering), and it leaves the "everything is a
function" surface untouched. (Folding a *computed* nullary body to a stored
global would change recompute-once-per-call semantics, so the pass must gate on
a genuinely constant body — exactly the kind of rule a stratum should carry.)

## Bootstrap Notes

Once Silicon self-hosts, strata become the open mod surface — third-party packages will register new types, operators, IR passes, and codegen backends without compiler patches. To keep that path open, the bootstrap parser's top-level dispatch and the IR registry are designed to be registry-driven from day one (bootstrap-plan §7.2 R1–R3). Today's TS implementation already follows that shape for operators, control flow, and definition kinds.
