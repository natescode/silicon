---
title: Stability — Strata API
---

# Strata API stability

The `Compiler::*` surface that strata bodies call is itself a stable
API at 1.0. The stratum body is Silicon source under
`src/strata/*.si`; what it can ask the compiler to do is locked.

## Stable calls

| Call | Purpose |
|------|---------|
| `Compiler::register::keyword('name')` | Register `name` as a definition keyword |
| `Compiler::register::operator('sym')` | Register `sym` as an operator |
| `Compiler::register::annotation('@@tok')` | Register an annotation token |
| `Compiler::on::decl('name', H)` | Fire `H` on definitions with this keyword |
| `Compiler::on::call_site('name', H)` | Fire `H` at call-sites |
| `Compiler::on::annotation('@@tok', H)` | Fire `H` on annotation appearance |
| `Compiler::on::lower('name', H)` | Fire `H` during IR lowering |
| `Compiler::on::module_finalize(H)` | Fire `H` once at end of module |
| `Compiler::diag::error('CODE', args, msg)` | Emit a structured diagnostic |
| `Compiler::diag::warn('CODE', args, msg)` | Emit a structured warning |
| `Compiler::module::push_definition(def)` | Push a new definition |
| `Compiler::module::push_global(g)` | Push a new global |

## Caveated calls

These work today but are subject to refinement; use at your own pace.

- `Compiler::ir::*(…)` — abstract-op builders. The op set is stable; the
  individual builder names may consolidate in v1.x.
- `Compiler::ast::*(…)` — read-only AST inspection. Stable enough for
  authoring; specific field names track the AST node design which
  evolves slowly.
- `Compiler::type::*(…)` — type-querying helpers.

## Not stable

- Raw IR builders that bypass the abstract-op layer.
- The execution engine internals (handle table, IR-handle ABI).
- Anything in `src/comptime/` not listed in `wit/comptime.wit`.

## Graceful degradation rule

Unknown `Compiler::*` paths emit a *warning*, not an error. A stratum
written against a future Compiler API doesn't refuse to run on an older
compiler — its calls to unknown methods warn, and the rest of the
stratum proceeds. This lets the ecosystem evolve without lockstep
upgrades.

[Full reference: docs/stability.md §3 →](/stability/)
