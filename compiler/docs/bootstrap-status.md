# Bootstrap & Cleanup Status

Tracks progress against `docs/bootstrap-plan.html` and
`docs/stage0-cleanup-plan.html`.  Updated as branches land.

## Stage 0 Cleanup (`docs/stage0-cleanup-plan.html`)

| WS  | Workstream                              | Status        | Branch                       |
| --- | --------------------------------------- | ------------- | ---------------------------- |
| 1   | Determinism property + initial property tests | **Landed** | (pre-merged before this push) |
| 2   | UTF-8 string migration                  | **Landed**    | `stage0/02-utf8`             |
| 3   | Enum / sum-type split + payload layout  | **Partial**   | `stage0/03-types` — `@enum` rename only; payload `@type` blocked on grammar |
| 4   | Structured errors + source spans        | **Landed (infra)** | `stage0/04-diagnostics` — Diagnostic surface + JSON CLI + adapters; deep migration of throw sites is follow-up |
| 5   | Docs cleanup                            | **Landed**    | `stage0/05-docs`             |
| 6   | Parser fuzzing harness                  | **Landed**    | `stage0/06-fuzz`             |

## Bootstrap Phase −1 (`docs/bootstrap-plan.html`)

| Item | Feature                                       | Status     | Branch                                 |
| ---- | --------------------------------------------- | ---------- | -------------------------------------- |
| A    | Sum types with payloads                       | **Blocked** | grammar can't express variant payload params inline — needs design discussion |
| B    | Pattern destructure in `@match`               | **Blocked** | depends on A                            |
| C    | Multi-file `@use 'path.si'` includes          | **Landed** | `bootstrap/-1-c-use-includes`           |
| D    | UTF-8 source bytes                            | **Landed** | folded into WS 2                        |
| E    | WASIX `_start` export (`--target=wasix`)      | **Landed** | `bootstrap/-1-e-wasix-start`            |
| F    | Out-pointer `@extern` calling convention      | **Landed** | `bootstrap/-1-f-extern-outptr`          |
| G    | `@type_alias` lowering (optional)             | **Existing** | already accepted by the typechecker (declaration only) |

**Phase −1 gate not yet met.**  The plan's gate requires "A miniature
AST-node fixture compiles end-to-end: declare a sum type with payloads,
build a value via constructor, destructure via `@match`, return one
field."  That requires items A + B, which are blocked on the grammar
constraint documented in `CLAUDE.md`.

## Outstanding Phase −1 Work

Items A and B (sum types with payloads + destructure) are the only
remaining blockers for tagging `v0.bootstrap-ready`.  Two paths forward:

1. **Grammar extension** — relax `Definition` to allow variant payload
   syntax (`Red r:Int | Green g:Int`).  Smallest change: a new
   `SumBinding` production used only when `defKw == '@type'`.
2. **Encode payloads via existing syntax** — model variants as
   sibling definitions or via object-literal-style payloads (e.g.
   `Red := $variant { name='Red', fields=$['r' = Int] }`).
   Less ergonomic but stays inside the existing grammar.

Both options need a design discussion before implementation begins.

## Phase 0 and Beyond

Out of scope for this status — every later phase depends on the
Phase −1 gate.  Once payload sum types land, the next branch is
`bootstrap/00-runtime` per the plan's working-order table (§11).

## Test Surface (post WS 1–6)

- `bun test` → 564 tests across 26 files (was 518 at start of WS 2).
- `bun run test:properties` → property suite (UTF-8 strings,
  determinism, IR-type coverage, registry uniqueness, source-location
  coverage, AST round-trip, `@enum` parity, extern out-pointer,
  WASIX `_start`).
- `bun run test:fuzz` → three fuzz targets (random bytes, random
  token streams, generative round-trip) with a 60s local budget.
  Nightly CI cron bumps to 30 min per target.

## Touched Files (sanity check before merging)

Branches landed independently so they can be reviewed / cherry-picked
in any order:

```
stage0/02-utf8                : src/ir/lower.ts, src/codegen/std.wat,
                                tests/properties/string-encoding.property.test.ts
stage0/03-types               : src/strata/defkinds.si, src/types/typechecker.ts,
                                tests/properties/enum-parity.property.test.ts
stage0/04-diagnostics         : src/errors/diagnostic{.ts,.test.ts},
                                src/sigil_cli.ts, docs/diagnostics.md
stage0/05-docs                : CLAUDE.md, docs/strata.md, README.md
stage0/06-fuzz                : tests/fuzz/**, .github/workflows/fuzz.yml,
                                package.json
bootstrap/-1-c-use-includes   : src/modules/useResolver{.ts,.test.ts,.integration.test.ts},
                                src/sigil_cli.ts, docs/use-includes.md
bootstrap/-1-e-wasix-start    : src/ir/lower.ts, src/codegen/index.ts,
                                src/sigil_cli.ts, tests/properties/wasix-start.property.test.ts
bootstrap/-1-f-extern-outptr  : src/codegen/std.wat, docs/extern-out-pointer.md,
                                tests/properties/extern-outptr.property.test.ts
```
