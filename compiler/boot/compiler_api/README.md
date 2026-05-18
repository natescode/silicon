# boot/compiler_api — Silicon-side `&Compiler::*` surface (planned)

This directory is the eventual home of Silicon ports for the
TypeScript `CompilerAPI` surface in `src/compiler-api/index.ts`.
Rich strata bodies in `src/strata/*.si` reference these as
`&Compiler::*` and `&Compiler::ctx::*` / `&Compiler::ir::*` calls.

**Status:** placeholder.  Phase 1a (this branch) only lands the
scope + path-eval scaffolding in `boot/elab/body_scope.si`.
Subsequent slices (1b–1e) populate this directory.

## Entry-point inventory

The 17 entry points actually used by built-in strata bodies
(per `boot/embedded_bundle.si`), grouped by the slice that will
deliver them:

### Slice 1b — `Compiler::ir::*` (pure IR constructors)

| Entry point                  | TS source                              | Backing primitive       |
| ---------------------------- | -------------------------------------- | ----------------------- |
| `Compiler::ir::makeFunction` | `src/compiler-api/index.ts:~285`       | `ir_function` (TBD)     |
| `Compiler::ir::makeGlobal`   | `src/compiler-api/index.ts:~287`       | `ir_global` (TBD)       |
| `Compiler::ir::makeImport`   | `src/compiler-api/index.ts:~289`       | `ir_import` (TBD)       |
| `Compiler::ir::makeLocal`    | `src/compiler-api/index.ts:~291`       | `ir_local` in nodes.si  |
| `Compiler::ir::makeExport`   | `src/compiler-api/index.ts:~292`       | `ir_export` (TBD)       |
| `Compiler::ir::makeIf`       | `src/compiler-api/index.ts:~280`       | `ir_if` in nodes.si     |
| `Compiler::ir::makeLoop`     | `src/compiler-api/index.ts:~281`       | `ir_loop` (TBD)         |
| `Compiler::ir::makeConst`    | `src/compiler-api/index.ts:~272`       | `ir_const` in nodes.si  |
| `Compiler::ir::makeBreak`    | `src/compiler-api/index.ts:~282`       | `ir_break` in nodes.si  |
| `Compiler::ir::makeContinue` | `src/compiler-api/index.ts:~283`       | `ir_continue` in nodes.si |
| `Compiler::ir::makeReturn`   | `src/compiler-api/index.ts:~284`       | `ir_return` in nodes.si |

### Slice 1c — `Compiler::ctx::*` (mutable lowering context)

| Entry point                          | TS source                          | Current Silicon backing |
| ------------------------------------ | ---------------------------------- | ----------------------- |
| `Compiler::ctx::globals::set`        | `src/compiler-api/index.ts:~245`   | hard-coded in lower.si  |
| `Compiler::ctx::varNames::add`       | `src/compiler-api/index.ts:~252`   | hard-coded in lower.si  |
| `Compiler::ctx::pendingLocals::push` | `src/compiler-api/index.ts:~257`   | hard-coded in lower.si  |
| `Compiler::ctx::locals::set`         | `src/compiler-api/index.ts:~240`   | hard-coded in lower.si  |
| `Compiler::ctx::loopStack::push`     | `src/compiler-api/index.ts:~260`   | hard-coded in lower.si  |
| `Compiler::ctx::loopStack::pop`      | `src/compiler-api/index.ts:~261`   | hard-coded in lower.si  |
| `Compiler::ctx::loopStack::peek`     | `src/compiler-api/index.ts:~262`   | hard-coded in lower.si  |
| `Compiler::ctx::nextLoopId`          | `src/compiler-api/index.ts:~266`   | hard-coded in lower.si  |

The 1c refactor extracts these out of `boot/ir/lower.si`'s globals
into a shared `boot/compiler_api/ctx.si`.  The hard-coded call sites
in `lower.si` then call into the new surface, preserving byte-equal
output.

### Slice 1d — Lowering helpers + misc

| Entry point                                | TS source                          |
| ------------------------------------------ | ---------------------------------- |
| `Compiler::arg`                            | `src/compiler-api/index.ts:~320`   |
| `Compiler::lowerExpr`                      | `src/compiler-api/index.ts:~324`   |
| `Compiler::lowerExprIfDefined`             | `src/compiler-api/index.ts:~327`   |
| `Compiler::watId`                          | `src/compiler-api/index.ts:~338`   |
| `Compiler::resolveType`                    | `src/compiler-api/index.ts:~305`   |
| `Compiler::resolveFunctionReturnType`      | `src/compiler-api/index.ts:~309`   |
| `Compiler::lowerParams`                    | `src/compiler-api/index.ts:~313`   |
| `Compiler::lowerFunctionBody`              | `src/compiler-api/index.ts:~316`   |
| `Compiler::lowerGlobalInit`                | `src/compiler-api/index.ts:~317`   |
| `Compiler::lowerExternParams`              | `src/compiler-api/index.ts:~318`   |
| `Compiler::lowerExternResult`              | `src/compiler-api/index.ts:~319`   |
| `Compiler::assertDefined`                  | `src/compiler-api/index.ts:~328`   |
| `Compiler::choose`                         | `src/compiler-api/index.ts:~336`   |
| `Compiler::isVarName`                      | `src/compiler-api/index.ts:~339`   |
| `Compiler::expandMatchChain`               | `src/compiler-api/index.ts:~334`   |

### Slice 1e — Wire-up

Replace the hard-coded `lower_definition` branches in
`boot/ir/lower.si` with `interpret_body_rich(sem, nodeParamName, defNode)`
calls.  Byte-equal WAT vs Stage 0 on the e2e corpus is the gate.

## Pre-flight before deletion of `src/`

This directory must contain a working Silicon implementation of every
entry point above, exercised by `boot/tests/compiler_api_*_test.si`
tests with byte-equal expected outputs.  Once Slice 1e's gate is
green, the TS `CompilerAPI` becomes dead code (modulo legacy imports
removed in Phase 7).

See `docs/silicon-only-bootstrap-plan.html` for the staging context.
