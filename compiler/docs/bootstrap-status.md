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

| Slice                                                    | Status | LoC Silicon |
| -------------------------------------------------------- | ------ | ----------- |
| Token kinds (`boot/parser/tokens.si`)                    | **Landed** | ~30 |
| Lexer (`boot/parser/lex.si`)                             | **Landed** | ~280 |
| AST encoding (`boot/parser/ast.si`)                      | **Landed** | ~180 |
| Parser (`boot/parser/parse.si`)                          | **Landed** | ~500 |
| AST → JSON serializer (`boot/parser/json.si`)            | **Landed** (15 kinds) | ~620 |
| Corpus equivalence harness vs Stage 0                    | **Landed** (26 fixtures) | — |

What's covered today:
- Lexer: all 27 token kinds.
- Parser: int / float / string / bool literals, namespaces, binary
  expressions (flat left-fold), function calls (`&name` and
  `&@keyword`), paren groups, blocks, definitions
  (`@kw name [: Type] [params] [:= binding]`), `$[]` / `$()` / `${}`
  literals, variant declarators (`$Variant fields`), doc comments
  (stripped from `Program.elements` to match Stage 0), assignments,
  proper `Parameter` AST nodes for definition args.
- Serializer + Phase 2 gate (byte-exact JSON match vs Stage 0):
  Program, Definition (with TypedIdentifier name, optional
  TypeAnnotation, Parameter[] params, Binding expression), Block
  (with optional trailing), IntLiteral, FloatLiteral, StringLiteral,
  BooleanLiteral, Namespace, BinaryOp, FunctionCall (user + builtin),
  ArrayLiteral, TupleLiteral, ObjectLiteral (with KeyValuePair +
  TypedIdentifier key), Assignment, VariantDecl.

Phase 2 gate harness:
- `boot/tests/json_test.si` reads one fixture from stdin and writes
  its JSON to stdout.
- `tests/wasix-smoke.test.ts` runs `wasmer run boot.wasm` once per
  fixture (26 fixtures covering every Stage-0-emitted AST kind) and
  asserts byte-equality against `JSON.stringify(stage0Ast, null, 2)`.
  Per-process isolation sidesteps cumulative parser-state issues that
  surface with 20+ parses in one module instance.

Currently 26 / 26 fixtures match byte-for-byte.

Still ahead before declaring Phase 1 done:
- Multi-fixture-in-one-process state isolation — `arena_reset` between
  parses isn't sufficient; @vars and possibly heap-growth interact in
  a way that corrupts late fixtures.  Per-process is a clean workaround
  for the test harness; a real Stage 1 compiler must run many parses
  per process so this needs root-causing before Phase 4+.
- Generic params stored in AST (currently consumed but skipped).
- Grow the corpus to cover every shape in `src/e2e/examples/*.si`.

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
