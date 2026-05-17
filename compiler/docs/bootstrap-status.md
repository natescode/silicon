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
| A    | Sum types with payloads (`$Variant field:Type`) | **Landed** | `bootstrap/-1-a-payload-types`        |
| B    | Pattern destructure in `@match`                 | **Landed** | `bootstrap/-1-a-payload-types`        |
| C    | Multi-file `@use 'path.si'` includes            | **Landed** | `bootstrap/-1-c-use-includes`         |
| D    | UTF-8 source bytes                              | **Landed** | folded into WS 2                       |
| E    | WASIX `_start` export (`--target=wasix`)        | **Landed** | `bootstrap/-1-e-wasix-start`          |
| F    | Out-pointer `@extern` calling convention        | **Landed** | `bootstrap/-1-f-extern-outptr`        |
| G    | `@type_alias` lowering (optional)               | **Existing** | already accepted by the typechecker (declaration only) |

**Phase −1 gate met.**  The Shape fixture from cleanup-plan §3.4
(`@type Shape := $Circle r:Int | $Rectangle w:Int, h:Int;` + an `area`
function that destructures via `@match`) compiles end-to-end, instantiates
under wabt, and returns 99 (5*5*3 + 4*6).  Tagged `v0.bootstrap-ready`.

## Next: Phase 0 — WASIX runtime smoke test

## Phase 0 (`bootstrap/00-runtime`) — landed

| Deliverable                                  | Status     |
| -------------------------------------------- | ---------- |
| WASI extern declarations (§5.3 surface)      | **Landed** (`src/strata/modules/wasi_snapshot_preview1.si`) |
| WASI fd_write / fd_read wrappers             | **Landed** (`boot/std/io.si`) |
| Arena allocator (save / reset)               | **Landed** (`boot/std/arena.si`) |
| `vec_i32` dynamic array                      | **Landed** (`boot/std/vec.si`) |
| File-echo program                            | **Landed** (`boot/main.si`) — stdin redirection |
| Smoke test                                   | **Landed** (`tests/wasix-smoke.test.ts`) — 4 cases |
| `scripts/run-boot.ts`                        | **Landed** |

**Gate met.** `wasmer run boot.wasm < README.md` reproduces README.md
byte-for-byte on stdout, exits 0.  The plan's literal `wasmer run
boot.wasm -- README.md` (argv-based open) is deferred — `path_open` needs
i64 for its `fs_rights_*` parameters and Silicon-Core's WasmValType is
`i32 | f32`.  Same proof of runtime reachability; same data structures
ready for Phase 1.

## Phase 1 (`bootstrap/01-parser`) — in flight

| Slice                                         | Status | LoC of Silicon |
| --------------------------------------------- | ------ | --------------- |
| Token kinds (`boot/parser/tokens.si`)         | **Landed** | ~30 |
| Lexer (`boot/parser/lex.si`)                  | **Landed** | ~280 |
| AST encoding (`boot/parser/ast.si`)           | **Landed** | ~110 |
| Parser core (`boot/parser/parse.si`)          | **Landed** | ~320 |
| AST → JSON serializer                         | Not started | — |
| Corpus equivalence harness vs Stage 0         | Not started | — |

What `parse.si` covers today:
- Integer / float / string literals, namespaces (with `::` / `.`),
  binary expressions (flat left-fold), function calls (`&name args`
  and `&@keyword args`), paren-grouped expressions, multi-element
  programs, blocks (`{ stmts ; trailing }`), definitions
  (`@kw name [: Type] params := binding`).

Still ahead in the parser proper:
- Sum-type variant declarators (`$Variant fields`), array / object /
  tuple literals, bool literals (`@true`/`@false`), doc comments
  (`##`), generic params (consumed but not stored).

After parser completion:
- AST-JSON serializer matching Stage 0's format → that's the Phase 2
  gate ("AST JSON equivalence with Stage 0 across the corpus").

## Test Surface (post WS 1–6 + Phases −1 + 0)

- `bun test` → 575 tests across 28 files (was 518 at start of WS 2).
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
