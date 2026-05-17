# Strata

Strata are Silicon's open extension system. Built-in operators, control-flow keywords, sum-type lowering, etc. are all implemented as strata files (`src/strata/*.si`); user code will eventually be able to ship its own strata as the language's mod surface (post-bootstrap; see `bootstrap-plan.html` §7 — "Strata as Mods").

## How Strata Work Today

1. **Loader** — `src/elaborator/strataLoader.ts` reads the built-in bundle from `src/strata/*.si` and parses each `@stratum_*` definition.
2. **Registry** — Each registration lands in `ElaboratorRegistry` tables keyed by operator symbol, keyword, or definition-keyword.
3. **Rich body interpreter** — A stratum body that uses `&Compiler::*` calls is compiled into a closure via `compileBodyToExpanderFn` / `compileBodyToDefExpander` and runs during IR lowering. The body interpreter lives in `src/elaborator/strataBody.ts`.
4. **`CompilerAPI`** — The surface strata bodies dispatch into is documented in `docs/compiler-api.md` and implemented in `src/compiler-api/index.ts`.

## StrataTypes

The Silicon spec defines nine StrataTypes. Today's Stage 0 status:

| StrataType  | What It Extends                                                       | Stage 0 Status |
| ----------- | --------------------------------------------------------------------- | -------------- |
| Operator    | Binary infix operators (`+`, `==`, …)                                 | Implemented (`operators.si`) |
| Control     | Control-flow keywords (`@if`, `@loop`, `@break`, `@match`, `@return`) | Implemented (`if.si`, `loop.si`, `control.si`, `match.si`) |
| Type        | Named types the type system understands                               | Hard-coded primitives (`Int`, `Float`, `Bool`, `String`); user-defined types via `@enum` / `@type_alias` / `@type_distinct` |
| Constraint  | Typeclass / protocol-style constraints                                | None — registry slot reserved |
| Codegen     | Replaces or supplements lowering for an AST/IR node kind              | Partial — control-flow and definition-kind lowering now live in `.si` strata; new node kinds still need TS |
| Runtime     | Custom allocators, schedulers, panic handlers                         | None |
| Capability  | Effect / permission gates                                             | None — `required_caps` is post-bootstrap |
| Metadata    | Annotation kinds (`@export`, `@platform`, future `@inline`)           | `@export` and `@platform` (`metadata.si`) |
| DSL         | Delegates a syntactic region to a sub-parser                          | None — bootstrap-plan reserves `parse_dsl_region` hook |

Authoritative API reference: `docs/compiler-api.md`. Bootstrap roadmap (which StrataTypes Stage 1 will need, in what order): `docs/bootstrap-plan.html`.

## Example: An Operator Stratum

```silicon
@stratum_operator Plus ('+', Node) = {
  &WASM::i32_add Node.left, Node.right;
};
```

That registration lets `1 + 2;` compile correctly. Once the constraint StrataType lands, a typed variant can be added with a parameter type so the operator is dispatched per operand type without the body interpreter sniffing types.

## Definition-Kind Strata

`@let`, `@fn`, `@var`, `@extern`, `@local`, `@enum`, `@type_alias`, `@type_distinct`, `@export`, `@platform` are all definition keywords whose lowering is contributed by strata in `src/strata/defkinds.si` and `src/strata/metadata.si`. Each one references an `IR::*` intrinsic (see `src/ir/irKinds.ts`); the elaborator stamps the matching `CodegenKind` onto the AST Definition node, and the lowering walker picks the corresponding def-expander from the registry.

## Bootstrap Notes

Once Silicon self-hosts, strata become the open mod surface — third-party packages will register new types, operators, IR passes, and codegen backends without compiler patches. To keep that path open, the bootstrap parser's top-level dispatch and the IR registry are designed to be registry-driven from day one (bootstrap-plan §7.2 R1–R3). Today's TS implementation already follows that shape for operators, control flow, and definition kinds.
