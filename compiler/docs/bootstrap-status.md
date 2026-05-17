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

## Phase 3 (`bootstrap/03-strata`) — in flight

| Slice                                                | Status | LoC Silicon |
| ---------------------------------------------------- | ------ | ----------- |
| Registry data structure (`boot/strata/registry.si`)  | **Landed** | ~170 |
| AST walker / loader (`boot/strata/loader.si`)        | **Landed** | ~140 |
| DefKind detection via `&IR::def_*` / `&IR::meta_*`   | **Landed** | (in loader) |
| Registry JSON dumper (`boot/strata/registry_json.si`) | **Landed** | ~190 |
| Phase 3 gate test (byte-exact JSON diff vs Stage 0)  | **Landed** | — |

What lands today:
- Operator, keyword, and **defkind** tables (parallel `vec_i32`).
- `load_strata(prog)` walks `Program.elements`, registers each
  `AST_ELABORATION` by `(elab_kind, symbol-span, elab-node-idx)`.
  When a keyword stratum's semantics block opens with
  `&IR::def_<kind>` or `&IR::meta_<kind>`, the loader extracts the
  suffix and pushes a `(keyword → codegenKind)` row to the defkind
  table.
- Linear-scan `registry_op_lookup` / `registry_kw_lookup`.
- Smoke test feeds `cat src/strata/*.si` to the Silicon loader,
  which emits a sorted JSON document with `operators`, `keywords`,
  and `defKinds`.  The test rebuilds the same registry via Stage 0's
  `buildStrataRegistry`, formats the same shape, and diffs
  byte-for-byte.  Currently **17 bare operators + 23 keywords +
  12 defkinds** match exactly (`@let=function`, `@var=global`,
  `@enum=type_sum`, …).  Typed variants like `+:Int` / `+:Float`
  collapse to a single `+` entry on both sides — the Silicon
  registry won't track typed variants until the body interpreter
  lands in Phase 4.

Still ahead for Phase 3:
- Two-pass `@use` resolution (Stage 1 collapses everything into a
  single bundle today; the dependency-graph walk is post-Stage-3
  per the plan).
- `defExpanders` map — Stage 0's per-codegenKind expander dispatch.
- IR-kind table — currently a hard-coded `Record<string, IRKind>`
  in `src/ir/irKinds.ts`; Phase 3 wants it open-tagged so user
  strata can register new IR kinds without a TS patch.
- Capability stub (`required_caps: i32`) — Phase 1 grants
  `0xFFFFFFFF` everywhere; the policy check lands post-Stage-3.

## Phase 4 (`bootstrap/03-strata` cont.) — in flight

| Slice                                                | Status | LoC Silicon |
| ---------------------------------------------------- | ------ | ----------- |
| Elaborator walker — Definition.hook stamping         | **Landed** | ~95 |
| Defkind constraint validation (params / binding)     | **Landed** | (in elaborator) |
| BinaryOp.semantics resolution + recursive walker     | **Landed** | ~80 |
| Per-stratum intrinsic extractor (`extractIntrinsicFromBody`) | **Landed** | ~240 |
| Body template extractor (per-step `{call, args}`)    | **Landed** | ~340 |
| `isRichBody` classification                          | **Landed** | (in `templates_json.si`) |
| Phase 4 gate: elaboration JSON byte-equal vs Stage 0 | **Landed** | — |
| Body interpreter (`&Compiler::*` surface)            | Pending | ~250 (estimated) |
| Generics-not-allowed validation                      | Deferred — parser doesn't yet store generic params on Definitions |

What lands today:
- `boot/elab/elaborator.si` walks `AST_PROGRAM`, looks up each
  `AST_DEFINITION`'s keyword in the defKinds registry, and records
  the resulting codegen-kind span (`"function"`, `"global"`,
  `"extern"`, …) in a parallel side table.  Unknown keywords
  collect into a separate error vec.  Hooks live in a side table
  rather than in the AST_DEFINITION record so the Phase 1/2
  byte-equal AST/JSON harnesses stay valid.
- `registry_dk_lookup(off, len)` — linear scan by keyword span.
- `boot/tests/elaborator_test.si` reads the strata bundle + a
  user-program tail from stdin and emits
  `{ "definitions": [...], "errors": [...] }`.
- Phase 4 gate: bun-side test rebuilds the same dump using
  Stage 0's `elaborate(ast, reg)` and diffs byte-for-byte.
- Constraint validation: `allowsParams` and `allowsBinding` are
  derived from the hook (codegen kind) via byte comparison
  against `"function"`, `"extern"`, `"export"` literals.
  Violations are classified into error codes:
  `0` unknown keyword, `1` params not allowed, `2` binding not
  allowed.  The bun-side dump classifies Stage 0's error
  messages into the same codes via substring match — gate
  currently exercises all three.
- Body template extractor (`boot/strata/templates_json.si`,
  ~340 LoC): mirrors Stage 0's `extractBodyTemplate`.  For every
  stratum, walks its body items; for each item finds the first
  FunctionCall and emits a `{call, args}` step.  `call` is the
  full `IR::xxx` / `WASM::xxx` namespace path or a bare
  user-function name; `args` classifies each arg's embedded
  Namespace against `<nodeParamName>.left` / `<nodeParamName>.right`
  / `"unknown"`.  Multi-segment non-IR/WASM callees (e.g.
  `&Compiler::ctx`) are silently skipped — those are consumed by
  the body interpreter (later slice), not the template-based
  codegen path.  Gate test `templates_test.si` rebuilds the same
  shape from Stage 0's `data.bodyTemplate` and diffs byte-equal
  across all 17 ops + 23 keywords (including the two-step bodies
  for `@local` and `@platform`, and the single user-function step
  for `++` → `str_concat`).
- Per-stratum intrinsic extractor (`boot/strata/intrinsics_json.si`,
  ~240 LoC): for every registered operator and keyword, recurses
  through the stratum's body and finds the first `&IR::*` or
  `&WASM::*` call.  Emits a sorted, deduped map mirroring Stage 0's
  `StrataNode.data.intrinsic` exactly (17 operators + 23 keywords,
  with `++` → `null` as the only operator without an IR/WASM call).
  Selection sort now carries a tie-breaker on original registration
  index so the dedup keeps first-registered-wins — matching Stage 0
  where `==` resolves to `IR::i32_eq` (Equal), not `IR::f32_eq`
  (EqualFloat).  Bun-side `intrinsics_test.si` gate diffs the dump
  byte-for-byte against `buildStrataRegistry().operators` /
  `.keywords` projected to bare keys.
- BinaryOp.semantics: `walk_expr` recurses through Definitions'
  binding expressions and top-level expression statements,
  visiting `AST_BIN_OP`, `AST_CALL`, `AST_BLOCK`,
  `AST_ASSIGNMENT`, `AST_ARRAY_LIT`, `AST_TUPLE_LIT`,
  `AST_OBJECT_LIT`.  Each binop's operator span is looked up in
  the registry and the (node-idx, resolved?) pair is recorded
  in the side table.  Dump appends a `"binops"` array; bun-side
  test mirrors the same preorder walk over Stage 0's
  elaborated AST and diffs byte-for-byte.

Still ahead for Phase 4:
- Body interpreter — port `src/elaborator/strataBody.ts` (~250
  LoC) into Silicon.  Per the plan: stub the whole `Compiler::*`
  surface up front, fail-loud on unimplemented calls, port them
  in order of "first failing test".  17 CompilerAPI entry points
  are actually used by built-in strata
  (`Compiler::arg`, `Compiler::ir`, `Compiler::lowerExpr`,
  `Compiler::ctx`, `Compiler::watId`, `Compiler::resolveType`,
  `Compiler::lowerParams`, `Compiler::lowerFunctionBody`,
  `Compiler::lowerGlobalInit`, `Compiler::lowerExternParams`,
  `Compiler::lowerExternResult`, `Compiler::resolveFunctionReturnType`,
  `Compiler::lowerExprIfDefined`, `Compiler::assertDefined`,
  `Compiler::choose`, `Compiler::isVarName`,
  `Compiler::expandMatchChain`).
- BinaryOp.semantics: attach the resolved StrataNode reference
  per operator (already populated in the registry).
- Constraint validation on Definitions: enforce `allowsParams`,
  `allowsBinding`, `allowsGenerics` flags.

## Phase 6 prelude — IR record layout (`bootstrap/03-strata` cont.)

| Slice                                                | Status | LoC Silicon |
| ---------------------------------------------------- | ------ | ----------- |
| IR record layout + builders for fixed-shape kinds    | **Landed** | ~165 |
| Variable-arity builders (Block / Call / Loop)        | Pending | — |
| Lowering walker (`boot/ir/lower.si`)                 | Pending | — |
| IR → JSON dumper                                     | Pending | — |
| Phase 6 gate: IR-JSON byte-equal vs Stage 0          | Pending | — |

What lands today:
- `boot/ir/nodes.si` (~165 LoC) — arena (`IR_VEC`) + builders for the
  fixed-shape IR kinds (`IR_NULL`, `IR_I32_CONST`, `IR_F32_CONST`,
  `IR_BINOP`, `IR_UNOP`, `IR_LOCAL_GET` / `_SET`, `IR_GLOBAL_GET` /
  `_SET`, `IR_IF`, `IR_RETURN`, `IR_BREAK`, `IR_CONTINUE`) and 17
  op-codes for binop/unop.
- Handles are integer indices into the arena vec; field 0 is the
  kind, fields 1+ are payload.
- Round-trip unit test (`boot/tests/ir_nodes_test.si`) builds a
  graph (`(if (eqz 42) 1 null)` with an enclosing `42 + 7`),
  reads back every field, and prints `ok`.

Still ahead:
- Variable-arity builders (`IR_BLOCK`, `IR_CALL`, `IR_LOOP` with
  body block) — needed once the body interpreter starts emitting
  sequences.
- Lowering walker that consumes the typed AST and dispatches by
  codegen kind.
- IR-JSON dump on both sides for the Phase 6 byte-equal gate.

## Phase 1 (`bootstrap/01-parser`) — in flight

| Slice                                                    | Status | LoC Silicon |
| -------------------------------------------------------- | ------ | ----------- |
| Token kinds (`boot/parser/tokens.si`)                    | **Landed** | ~30 |
| Lexer (`boot/parser/lex.si`)                             | **Landed** | ~280 |
| AST encoding (`boot/parser/ast.si`)                      | **Landed** | ~180 |
| Parser (`boot/parser/parse.si`)                          | **Landed** | ~500 |
| AST → JSON serializer (`boot/parser/json.si`)            | **Landed** (15 kinds) | ~620 |
| Curated fixture suite (`boot/tests/json_test.si`)        | **Landed** (26/26 byte-equal) | — |
| Corpus harness against `src/e2e/examples/*.si`           | **Landed** (38/40 byte-equal) | — |

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
- Generic params stored in AST (currently consumed but skipped).

### Multi-fixture state bug — root-caused and fixed

**Symptom (was):** ~20+ varied fixtures processed in one wasmer
module instance corrupted late fixtures' parse output (`elements: []`,
huge garbage Programs, eventual OOB).

**Root cause:** `std.wat`'s `$heap` initialiser was hard-coded to
1024.  Stage 0 allocates string-literal data segments starting at
offset 4 and grows them sequentially.  For modules with many string
literals (the boot tree's parser fixtures + their JSON output
labels) the cumulative literal size exceeded 1024 bytes — the heap
then allocated *on top of* the string-literal area, silently
corrupting source bytes the parser reads back through
`(&str_ptr s) + 4`.

The garbage `n = 86432` for a 36-byte string literal was the
smoking-gun: heap allocations overwrote the length-header word at
the literal's address.

**Fix:** `src/codegen/index.ts` now computes a safe heap base from
the lowered IR's data segments (max segment end + 256-byte safety
pad, 16-byte aligned, floor 1024) and rewrites `(global $heap …)`
in the inlined `std.wat` before emission.  For programs that fit in
1024 bytes of string data the value stays at 1024; the boot
fixture-test module now starts the heap at 1440.

**Impact:** `boot/tests/json_test.si` was previously stdin-driven
with one wasmer process per fixture (a heavy workaround); the new
`boot/tests/json_fixtures_test.si` drives all 26 fixtures through
**one** wasmer instance in ~250 ms and matches Stage 0 byte-for-byte.
The corpus harness still runs per-process (one wasmer call per
example file) but only because each file is its own input.

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
