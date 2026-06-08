# ADR 0025 — WASI version target & world roadmap: Preview 1 floor, 0.2 emit-target, 0.3-async behind the FFI seam

- **Status:** Proposed
- **Date:** 2026-06-07
- **Deciders:** NatesCode
- **Related:** ADR 0015 ([0015-object-capabilities.md](0015-object-capabilities.md) — imports = authority; WASI is the canonical capability source) · ADR 0024 ([0024-module-and-component-system.md](0024-module-and-component-system.md) — component = WIT package/world; single-core-`.wasm` default; `--emit=wit/component` deferred — this ADR fills the WASI-versioning gap it left open) · ADR 0018 ([0018-async-promise-ffi.md](0018-async-promise-ffi.md) — Asyncify/Promise async; **not** CM async) · ADR 0017 ([0017-ffi-binding-generator.md](0017-ffi-binding-generator.md) — machine-generated host bindings; WASI worlds are a future generator target) · ADR 0023 ([0023-language-identity-and-non-goals.md](0023-language-identity-and-non-goals.md) — no hidden control flow; the non-goals filter) · ADR 0008/0009 ([0008-memory-management-arenas.md](0008-memory-management-arenas.md), [0009-wasm-gc-target.md](0009-wasm-gc-target.md) — memory modes) · `../targets.md` (the shipped WASI posture) · `compiler/src/strata/modules/wasi_snapshot_preview1.si`

## Context

WASI exists in three incompatible generations, and Silicon currently commits to exactly
one of them **implicitly** — there is no ADR recording the stance or the path forward.
The capability *model* lives in ADR 0015 and the component *artifacts* in ADR 0024, but
neither says **which WASI generation Silicon targets, runs on, or emits** — the gap this
ADR closes.

**Shipped reality (Preview 1).** Silicon's I/O surface today is WASI Preview 1
(`wasi_snapshot_preview1`):

- `compiler/src/strata/modules/wasi_snapshot_preview1.si` declares the import surface
  (`fd_write`, `fd_read`, `fd_close`, `path_open`, `args_get`/`args_sizes_get`,
  `environ_get`/`environ_sizes_get`, `proc_exit`, `clock_time_get`, …); each becomes an
  `(import "wasi_snapshot_preview1" "<name>" …)` and is auto-registered as an env module
  callable as `wasi_snapshot_preview1::<fn>` (the registry path of ADR 0024).
- `compiler/src/stdlib/io.si` wraps it (`print`/`read_line`/`exit` → `fd_write`/`fd_read`/
  `proc_exit`); `docs/targets.md` documents WASI = `wasi_snapshot_preview1` and `sgl run`
  executing under **wasmtime**.

**The three generations (status verified 2026):**

| Gen | What it is | 2026 status / reach |
|---|---|---|
| **Preview 1** (`wasi_snapshot_preview1`) | flat, integer-`fd`, core-module imports; pre-opened dirs scope filesystem authority | the **runnable floor everywhere**: wasmtime, Node (`node:wasi`), Bun, browser shims |
| **Preview 2 / 0.2** | the Component-Model world: capability-based, **resource handles** (own/borrow), WIT interfaces/worlds | **stable since Jan 2024**, but **no runtime loads components natively** (per ADR 0024) — needs `jco transpile` to run on web/Bun/Node |
| **Preview 3 / 0.3** | adds **async** (streams/futures) to the component model | **RC (Feb 2026), wasmtime 37+ only** — not on web/Bun/Node |

The tension: Preview 1 *runs everywhere* but is pre-capability (ambient-ish integer fds);
0.2 *is* the capability/world model ADR 0024 maps onto but isn't natively loadable in 2026;
0.3 async is both immature **and** an architectural mismatch for ADR 0023 (a guest-side
scheduler with implicit suspension = hidden control flow, non-goal #8 — the same reason
ADR 0018 chose Asyncify/Promise over CM async). This ADR sequences all three without
re-deciding artifacts (0024) or the capability model (0015).

## Decision

**Preview 1 is the runnable floor; WASI 0.2 (component world) is the emit-target for the
capability/world model; WASI 0.3 async stays behind the FFI/effect seam (ADR 0018), never
surfaced.** Concretely:

1. **Floor — Preview 1.** `sgl run`/`sgl build` keep targeting `wasi_snapshot_preview1` as
   the lowest common denominator that runs on every host at v1.0 (already shipped). This is
   ratified, not changed.
2. **Emit-target — WASI 0.2.** The 0.2 component world is the conceptual model Silicon's
   capabilities and component contract map onto (ADR 0015/0024). It is produced via the
   **deferred** `--emit=wit` / `--emit=component` path (ADR 0024), **not** the default v1.0
   artifact — nothing loads components natively in 2026, so the default stays one core `.wasm`.
3. **Async — 0.3 behind the seam.** Silicon does **not** adopt CM async (streams/futures/
   backpressure) as surface async. Async is the explicit, effect-tagged Asyncify/Promise FFI
   seam of ADR 0018; CM async is the path *not* taken (ADR 0023 non-goal). Track 0.3; don't
   build it into the language.
4. **`wasi:cli/run` = `main`.** Consistent with ADR 0024 §Entry point: the root module's
   `main` maps to `wasi:cli/run`. The **Env** capability (`args`/`environ`) is the first
   concrete capability slice.

### World roadmap (which WASI worlds, in what order)

| Tier | Worlds | Capability (ADR 0015) | When | Notes |
|---|---|---|---|---|
| **1 — near-term** | `wasi:cli` (= `main`/`run`) · `wasi:clocks` · `wasi:random` | Env (args/environ) · Clock · Random (erased-witness) | v1.0 via P1 today; 0.2 world *shape* later | smallest, cleanest capability examples; all have P1 equivalents already imported |
| **2 — post-v1.0** | `wasi:filesystem` · `wasi:sockets` · `wasi:http` | Fs (the ADR 0015 template) · Net · the edge/serverless flagship | gated on CM lift/lower (`--emit=component`, ADR 0024) | **P1 integer-`fd` pre-opens are the v1.0 stand-in** for filesystem until 0.2 resource handles land at the boundary |
| **3 — watch** | `wasi-keyvalue` · `wasi-config` · `wasi-nn` · `wasi-blobstore` | host-service caps | as **dependency components** (ADR 0024) or **FFI bindings** (ADR 0017), never in the systems core | sub-stable; no portable consumers to ship against |

### Capability mapping (how WASI lands on ADR 0015)

Importing a WASI world **is** granting that authority (ADR 0015: imports = authority; no
ambient access). At the 0.2 boundary a capability is a **resource handle** (own/borrow),
enforced at runtime by the handle table. At the **Preview 1 floor**, the equivalent is the
**pre-opened `fd`**: `path_open` against a pre-opened directory scopes filesystem authority,
but an integer `fd` is *weaker* than a resource handle — it is forgeable in-module and not
unforgeable across a boundary. So the v1.0 capability story is "pre-open scoping," upgrading
to true handle unforgeability when the 0.2 emit-target's lift/lower lands (the comptime→
runtime handoff of ADR 0024 §Capabilities).

## Options considered

### Option A — Preview 1 only, forever
Keep `wasi_snapshot_preview1` as the sole surface. **Rejected:** no capability/resource
story, no path to the ADR 0024 world model, no edge/`wasi:http` future — forfeits the whole
reason 0015/0024 exist.

### Option B — Make WASI 0.2 the default v1.0 artifact
Emit a Component-Model 0.2 world as the default `sgl run`/`build` output. **Rejected:**
nothing loads components natively in 2026 (ADR 0024) — `sgl run` would be unrunnable on
web/Bun/Node without a `jco transpile` step on every run.

### Option C — Adopt WASI 0.3 CM async as the async model
Use streams/futures + the CM task scheduler for Silicon async. **Rejected:** hidden control
flow (ADR 0023 non-goal #8); 0.3 is a wasmtime-37-only RC; duplicates/contradicts the
already-decided Asyncify/Promise seam (ADR 0018).

### Option D — P1 floor + 0.2 emit-target + 0.3-behind-FFI + tiered worlds *(chosen)*
Ratifies the shipped floor, adopts 0.2 as the model to emit toward (deferred per 0024), keeps
async honest, and sequences worlds by capability cleanliness + portability.

## Consequences

- **Positive:** closes the one clear ADR gap the WASM-feature survey surfaced; re-decides
  nothing (ratifies P1, references 0024 for artifacts and 0015 for caps); keeps `sgl run`
  runnable on every host at v1.0; keeps async within the ADR 0018 seam; gives a concrete,
  capability-ordered world roadmap with `wasi:cli/run = main = Env-cap` as the first slice.
- **Negative:** P1's integer-`fd` model is ambient-ish — the v1.0 filesystem capability is
  "pre-open scoping," not handle unforgeability, until the 0.2 emit-target matures; two
  surfaces coexist during the transition (P1 imports for `run`; 0.2 world emission for
  `--emit`); running a 0.2 world on web/Bun requires external `jco transpile` (ADR 0024),
  not a Silicon-native loader.
- **Follow-up work:**
  - A **Silicon→WASI 0.2 world mapping** (interfaces/worlds ↔ component `@export` surface),
    feeding `--emit=wit` (ADR 0024) — ties to the Silicon→WIT type-mapping table also owed by 0024.
  - Tier-1 capabilities (**Env / Clock / Random**) as the **first concrete ADR 0015 capability
    values** — Clock is the smallest reference implementation; Env the most-used.
  - A WASI-world binding generator (the ADR 0017 generator, pointed at WASI `.wit`).
  - The `jco transpile` / WASI-Virt pipeline (ADR 0024) for running 0.2 worlds on web/Bun.
  - Document the stance in `../targets.md` (P1 floor + the 0.2/0.3 roadmap).

## Open questions

- **P1↔0.2 coexistence:** keep P1 imports for `sgl run` while emitting 0.2 worlds for
  `--emit=component`, or transpile 0.2→P1 for the run path? (Leaning: keep P1 for `run`, emit
  0.2 only under `--emit`, until native component loading exists.)
- **Shim ownership:** ship a Silicon-integrated `preview2-shim`/WASI-Virt, or rely entirely on
  `jco` (ADR 0024)?
- **First reference capability:** which Tier-1 world is the worked ADR 0015 example — `Clock`
  (smallest) or `Env` (most-used)?
- **`wasi:http` mapping:** the edge target uses `wasi:http/incoming-handler` (`jco serve`),
  which is distinct from the `main`/`wasi:cli/run` mapping (ADR 0024 §Entry point flagged this) —
  resolve when Tier 2 lands.

## Implementation pointer

**Proposed — no commit yet.** Ratifies the shipped Preview 1 floor; the 0.2/0.3 work is
sequenced, not started. Touch points (from the shipped code):

- `compiler/src/strata/modules/wasi_snapshot_preview1.si` — the P1 import surface (shipped;
  the floor); `compiler/src/stdlib/io.si` — its stdlib wrappers (shipped).
- `compiler/src/modules/loader.ts` / `registry.ts` — auto-registration of `wasi_*::` env
  modules (shipped); future home of 0.2 world registration.
- `cli/src/sigil_cli.ts` — `sgl run`/`build` under wasmtime (shipped); future `--emit=wit` /
  `--emit=component` per ADR 0024.
- `docs/targets.md` — document the P1-floor / 0.2-emit / 0.3-behind-FFI stance + the world tiers.
- New: Silicon→WASI 0.2 world emission; Tier-1 capability values (Env/Clock/Random) for ADR 0015.
