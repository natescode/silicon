# Property Tests

Stage 0 property suite — Workstream 1 of [`docs/stage0-cleanup-plan.html`](../../docs/stage0-cleanup-plan.html).

These tests don't check that the compiler produces specific WAT for specific input. They check **global invariants the compiler must satisfy across every input** — the kind of guarantee that, once broken, causes hours of debugging at the wrong layer of the bootstrap.

Run them with:

```bash
bun run test:properties           # full suite, 60s budget per property
bun test tests/properties/...     # one file
```

CI runs the same suite on every push and PR to `main` — see `.github/workflows/properties.yml`.

## Why a separate suite

Unit tests cover *what* a function does on specific inputs. Property tests cover *what must always be true* across all inputs. Each property here corresponds to a guarantee the bootstrap relies on:

| Property | Bootstrap reliance |
| --- | --- |
| Compilation determinism | Phase 9 fixed-point check (Stage 2 ≡ Stage 3) is impossible if Stage 0 isn't deterministic |
| Source-location coverage | Phase 5 format-parity gate compares diagnostics on `(phase, code, span)`; spans must be everywhere |
| IR type coverage | Pre-IR, codegen sniffed compiled WAT for `f32.const` to pick instructions. The IR layer killed that — this is the regression guard |
| Strata registry uniqueness | The registry tables are `Map`/`Record`; duplicates silently win and reorder dispatch |
| AST JSON round-trip | §9.4 structural-equivalence diff uses AST JSON as the canonical form |

## The five properties

### `determinism.property.test.ts`

> For any program `p`: `compile(p)` is byte-for-byte identical across runs and processes.

Three forms: two runs in the same process, two fresh `bun run` processes, and a direct check on the strata registry build. Every other determinism rule in §9.1 of the bootstrap plan is downstream of this one — if Stage 0 compiles non-deterministically, the bootstrap fixed-point check can't pass.

**Defends against:**

- `Map` / `Set` iteration order leaking into emit
- Unsorted `readdirSync` on platforms that don't sort by default
- Stray `Date.now()` / `Math.random()` calls in compile paths
- Module-cache reload state changing between processes

### `source-location.property.test.ts`

> Every interesting AST node carries a `sourceLocation`.

Scaffolded for WS 4 (Structured Errors + Source Spans). Today `toAst.ts` doesn't yet populate the field, so the test runs in coverage-report mode: it tallies which node types currently expose `sourceLocation`. Flip `PROMOTE_TO_STRICT` to `true` once WS 4 wires Ohm source intervals through every factory call — from that point on, any new node type that forgets to attach a span will fail the day it lands.

**Defends against:** new AST node kinds added later that silently lose source-location coverage, causing the diagnostics pipeline to produce errors with no span.

### `ir-type.property.test.ts`

> Every IR expression node has `wasmType` set (or is in an explicit allow-list of intentionally void-producing kinds).

Pre-IR, codegen sniffed compiled WAT for `f32.const` to pick `f32.add` vs `i32.add`. The IR layer killed that — every expression node now has `wasmType` pre-computed from `typechecker.inferredType` (see `src/ir/nodes.ts`). This is the regression guard: a future lowering path forgetting to set `wasmType` fails the moment a fixture exercises it.

**Allow-listed void kinds:** `Block`, `Call`, `If`, `Return`, `Break`, `Continue`, `Loop`, `Nop`, `Unreachable` — these legitimately produce no stack value.

### `registry-uniqueness.property.test.ts`

> No two strata definitions claim the same `(kind, symbol, type-kind)` triple.

Two `@stratum_operator` definitions registering `+` for `Int` would have the second silently overwrite the first via the compound `${symbol}:${typeKind}` key in `registry.ts`. The first test walks every `.si` file in `src/strata/` and asserts no triple appears twice.

A secondary sanity check verifies every `Elaboration` node is well-formed: kind is `operator`/`keyword`, symbol is non-empty, any `IR::def_*` / `IR::meta_*` intrinsic referenced exists in the `irKinds` table.

**Defends against:** accidental shadowing of strata overloads; typos in `IR::def_*` / `IR::meta_*` references silently failing to register.

### `ast-roundtrip.property.test.ts`

> `parse(source) → AST → JSON.stringify → JSON.parse` recovers a structurally identical AST.

Bootstrap §9.4 uses AST JSON as the canonical structural-equivalence form between Stage 1 / 2 / 3 outputs. If serialisation is lossy, the diff harness reports false negatives.

**Defends against:**

- Non-JSON values (closures, BigInt, symbols) on AST nodes
- Key-order dependence in any downstream consumer
- Future shape changes that aren't reversible through `JSON.stringify`/`JSON.parse`

## Shared helpers

- `_compile.ts` — pipeline entry points (`compileToWatString`, `compileToTyped`, `compileToIR`). Each spins up a fresh `ModuleRegistry` so determinism tests exercise the disk-read path.
- `_compile-cli.ts` — minimal CLI wrapper used by the cross-process determinism test; reads a source file and writes WAT to stdout.

## Adding a property

Properties live next to each other so the suite is easy to skim. When adding one:

1. New file: `tests/properties/<name>.property.test.ts`.
2. Lift any helper that would duplicate `_compile.ts` into that module.
3. Update the table above with the bootstrap dependency the property defends.
4. Run `bun run test:properties` — expect failures the first time. The whole point of these tests is to surface latent assumptions; the fix list is the deliverable.

## Out of scope

These are explicitly *not* in the property suite:

- Parser fuzzing — that's Workstream 6 (`tests/fuzz/`).
- Round-trip of pretty-printed source — needs a pretty-printer first; deferred to Stage 1.
- Stage 1 / Stage 2 / Stage 3 fixed-point check — lives in the bootstrap harness, not here.
