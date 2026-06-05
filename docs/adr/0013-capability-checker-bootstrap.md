# ADR 0013 — Capability checker: the comptime reflection surface, and the host-first → in-stratum build order

- **Status:** Proposed (design exploration; no implementation timeline)
- **Date:** 2026-06-02
- **Deciders:** NatesCode
- **Related:** ADR 0011 (borrow checker: scopes + rcaps + actor isolation) · ADR 0012 (optimizer consumes caps as a purity certificate) · ADR 0015 (object capabilities: authority as unforgeable values — what this plan *implements*) · ADR 0003 (comptime engine: wasm3 for 1.0, Silicon interp for 1.1) · `docs/comptime-via-compilation.md` (the Phase A–E dissolution — SHIPPED) · `src/comptime/engine.ts` · `src/comptime/imports.ts` · `src/elaborator/registry.ts` (`StratumPhase`) · `src/strata/defkinds.si` (`@capability` would live beside the other def-kinds) · `wit/comptime.wit` · CaaS `SemanticModel.typeOf` (`src/types/typechecker.ts`) + Roslyn-parity tracker [[caas-roslyn-parity-tracker]] · prior art: React class lifecycle → Hooks (why phase-boundary hooks were abandoned), rustc queries + salsa, Roslyn analyzers, Swift request-evaluator, Flix (Datalog with lattices), E sealer/unsealer (unforgeability) · [[silicon-mutability-capability-model]] memory

## Context

ADR 0011 (safety) and ADR 0012 (optimization) describe *what* a capability/borrow checker computes. This ADR addresses *how to build it* — and resolves an apparent chicken-and-egg that makes the plan confusing:

> "I need comptime in order to make Stratum more powerful, in order to do comptime."

The capability checker is most valuable if it is itself an ordinary Silicon program living in `src/strata/capabilities.si` ("strata are programs, not data" — `comptime-via-compilation.md` tenet C-3; ADR 0003's v1.1 dogfooding goal). But writing a *whole-program analysis* as a stratum seems to require strata that are "more powerful" than today's — which itself sounds like comptime work that needs the very power we're trying to add.

**The circularity is an illusion, created by the word "comptime" naming two different layers.** This ADR separates them, proves the dependency graph is acyclic, and records the exact, ordered steps.

### What is already true (verified 2026-06-02)

- The restricted strata-body **interpreter is deleted** (`strataBody.ts` + `comptimeBuiltins.ts` removed in commit `b866a6c`; `comptime-via-compilation.md`: "FULLY SHIPPED"). Handler bodies now compile to WASM through the **same pipeline as user code** (`engine.ts`).
- Therefore handler `@fn`s **already have loops, recursion, `@match`, and helper-`@fn` calls** — anything the language has. The authoring guide's "no loops" is stale.
- **But** no shipped handler exercises this (a grep of `src/strata/*.si` finds `@loop`/`@match` only as keyword *registrations*, never inside a handler body), and — decisively — the six strata hooks are all **per-node**. There is no whole-program hook: `on::check`/`on::typecheck` do **not** exist (the Strata 2.0 spec *reserves* `on::typecheck`, deferred).

So "loops in strata" was never the blocker. The blockers are a whole-program entry point, reflection over the typed AST, and comptime data structures.

## Decision

**Build the capability checker as an `on::check` whole-program pass, and break the apparent chicken-and-egg by adding every increment of "strata power" as a host import that lives *below* strata — not as strata.** Concretely:

1. Each new power (the whole-program hook, AST/type reflection, comptime collections) is a **host primitive** (TypeScript today, Silicon-on-the-shipped-substrate later), consumed by an ordinary Silicon `@fn` that already has loops and recursion.
2. The checker is built **host-first** (a TS pass behind `on::check`) to de-risk the analysis rules, then **re-homed into `capabilities.si`** once the comptime substrate is rich enough.
3. The build order is a strict DAG (P0 → P4 below). No step depends on a later one.

### Why this is not circular — the layering

There are two layers both loosely called "comptime":

| Layer | What it is | Status | Built in |
|-------|-----------|--------|----------|
| **Comptime *engine*** | the thing that *runs* a handler `@fn` | **SHIPPED (P0)** | host (TS now; wasm3 1.0; Silicon interp 1.1 — ADR 0003) |
| **Comptime *reach*** | whole-program hook, reflection, collections | to build | **host imports, below strata** |

You are **not** building the engine — it shipped. You are adding *reach*, and reach is delivered as host imports written in plain TypeScript (later, plain Silicon running on the already-shipped engine). An ordinary Silicon `@fn` — loops and all, expressible the day the interpreter was retired — orchestrates those imports.

**So you never use powerful strata to build powerful strata. You use richer host imports.** The dependency graph only ever points downward: substrate → host primitives → checker.

### Build order (the clear steps)

```
P0 substrate (DONE) ──┬─► P1 on::check hook ──┐
                      │                        ├─► P2 reflection ─┬─► P4a checker (TS) ─► P4b checker (Silicon)
                      ├─► P3 collections ──────┘                  │
                      │     (needs only P0)                       └─► P5 @capability surface ─► (feeds P4a/P4b)
                      │                                                 P4b also needs P2 + P3 + P5
```

| Phase | What | Depends on | Done when | Why it's buildable now (no cycle) |
|------|------|-----------|-----------|-----------------------------------|
| **P0** | Comptime substrate: handler `@fn`s compile-and-run; have loops/recursion/`@match` | — | *Already shipped* | n/a — this is the comptime you already have |
| **P1** | `on::check` lifecycle phase: a new `StratumPhase 'check'` that fires **per module after typecheck** with that module's typed AST + the imported modules' **signatures** + the `typeMap` (see *Compilation model* below) | P0 | a no-op `capabilities.si` registers `&Compiler::on::check` and receives the module handle | Pure TS: a new phase in `registry.ts` + dispatch in `strataLoader.ts` + a pipeline seam between typecheck and lower. Needs **no** strata power |
| **P2** | Reflection + type surface: durable AST handles for the firing's lifetime, full `ast_children`/`ast_field` coverage, new `ast_inferred_type(node) → typeHandle` (`diag_error` already exists) | P0, P1 | a Silicon `@fn` fired by `on::check` recursively walks the program and reads each node's inferred type | Pure TS host imports added to `imports.ts`/`wit`. Consumed by a `@fn` that already loops |
| **P3** | Comptime collections (the analysis state): maps/sets/worklists. **P3a** host map/set primitives (interim, fast). **P3b** make stdlib `vec.si`/`hashmap.si` comptime-clean so handlers can `@use` them | P0 **only** | a handler maintains a `HashMap` of effect-classes across a program walk | P3a is TS. P3b is Silicon that uses **only the P0 substrate** — not the checker, not P1/P2 |
| **P4a** | The checker, **in TS host**: implement the cap/effect analysis behind `on::check`; produce the `capabilityMap` + diagnostics | P1, P2 | the TS pass rejects an aliasing violation and certifies a pure function | Runs in TS; de-risks the *rules* without betting on P3 + wasm3 perf simultaneously |
| **P4b** | The checker, **re-homed into Silicon** (`src/strata/capabilities.si` as an ordinary `@fn` registered via `on::check`) | P4a, P2, P3, P5 | `capabilities.si` rejects the violation / certifies purity, entirely in Silicon — the dogfood flagship | Runs on the P0 substrate using P1–P3 + P5 imports. It never needs the checker to already exist |
| **P5** | **Capability *expression* surface:** the `@capability` stratum + the cap registry + the `is_construction` / `symbol_module` / `extern_effect_of` reflection adds + the root-authority seam | P1, P2 | a `@capability Console;` declaration registers a tag and the mint-site rule; external code cannot construct a `Console`; `main` receives the root `Console` | The stratum is ordinary Silicon on P0 using P1/P2 imports; the registry + reflection adds are host imports *below* strata — no cycle |

Read the last column top to bottom: **no row needs a row beneath it.** That is the whole resolution.

## Compilation model: module-granular (Go export-data style); comptime cost is open-world (Jai stance)

Silicon targets fast builds the **Go/Jai way — be fast and avoid incremental cleverness** — not the salsa/query way. This frames every choice above.

- **Unit of compilation is the WASM module** (coarse-grained). Separate compilation + content-hash module caching, Go-style: recompile a changed module and its dependents, reuse cached artifacts for the rest. No whole-program dependency graph, no query engine.
- **Cross-module information flows through module signatures, never bodies.** A module exports a summary — types + cap/effect classes (ADR 0012's `MetadataReference`) — and dependents read the summary, exactly like Go's export data / `.a` files. This is what keeps separate compilation intact and analyses bounded.
- **Therefore `on::check` fires per module** (that module's bodies + the imported modules' signatures), never over whole-program bodies. Effect/cap inference may run a fixpoint over the *module's* call graph (mutual recursion) — bounded by the module; cross-module is a signature read. P1 above is per-module, not whole-program.
- **Comptime cost is open-world (the Jai stance).** Go's speed is a *closed-world guarantee* — Go owns the whole compiler. Silicon delegates compile-time work to user/third-party strata, so a pathological stratum can slow a build the way a `#run` can slow a Jai build. The answer is Jai's: keep the *baseline* fast, make comptime cost the author's responsibility (budgets, profiling, handler caching), and **do not** incrementalize it away with a query engine. Stratum moves "compile speed" from a language guarantee to a shared responsibility — a tooling/culture matter, not an architecture change.
- **Whole-program optimization is an opt-in slow mode**, never the dev-loop default — Go's LTO stance. The fast path never touches cross-module bodies.
- **The dominant speed lever is generics, not Stratum.** Monomorphization (Rust/C++) is what actually breaks separate compilation and compile times; Go engineered around it with GC-shape stenciling + dictionaries. Silicon's `@fn[T]` instantiation strategy (ADR 0001) will move compile-speed numbers more than the capability checker ever will. Stratum is the secondary, manageable factor.

**Consequence for CaaS (the peer-vs-satellite question):** module-granular separate compilation + a fast comptime baseline make CaaS a **peer without a query engine** — it shares the one core and reuses per-module artifacts + the `SemanticModel`, with incrementality at *module* granularity. That is the Go/Roslyn "one core, shared library" win without salsa's stable-identity / dep-graph / interning tax. The capability checker rides this: per-module, signature-propagating, pure-contract — incremental at module grain, for free.

## Implementing capabilities *via* Stratum — the expression surface and its primitives

P4b already puts the *checker* in Stratum (`capabilities.si`). The same discipline extends to the capabilities **themselves**: a **`@capability` stratum** declares a capability type and installs its rules, so authority is defined *as data*, not baked into the compiler core — exactly the "language semantics live in strata" ethos, now applied to security. The host contract is unchanged: it supplies **primitives below strata**; the capability *semantics* are strata on top. That splits the primitive surface into two buckets.

**Bucket 1 — analysis primitives** (to *write the checker*; mostly P1–P3 plus three reflection adds):

| Primitive | Phase | What it gives | Used for |
|---|---|---|---|
| `&Compiler::on::check` | P1 | per-module firing: typed AST + imported signatures + `typeMap` | the pass entry point |
| `ast_children` / `ast_field` / node-kind | P2 | walk the typed AST | traverse bodies |
| `ast_inferred_type(node)` | P2 | a node's type | find capability-typed bindings / classify values |
| `ast_span(node)` + `diag_error` *(exists)* | P2 | report a fatal violation | block lowering |
| `ast_callee(callNode) → symbol` | P2+ | resolve a call to its target | the call-graph fixpoint |
| `is_construction(node) → capType?` | P2+ | "does this node *construct* a value, of what type?" | the unforgeability rule + capability detection |
| `symbol_module(sym)` / `is_local(sym)` | P2+ | in-module vs imported | walk a body vs read a certificate |
| `required_caps_of(sym) → set` | seam (0012) | read an imported symbol's capability certificate | cross-module |
| `set_required_caps(sym, set)` | seam (0012) | publish the computed certificate | "summarize concretes at seams" |
| comptime `Set` / `Map` / worklist | P3 | analysis state | the bottom-up union / fixpoint |

**Bucket 2 — expression primitives** (to *declare a capability and seal it*; the new **P5**):

| Primitive | What it gives | Used for |
|---|---|---|
| `@capability NAME;` stratum (`&Compiler::register::capability`) | declares a nominal capability type, registers its tag, installs its `on::check` rules | the surface for *defining* a capability |
| capability registry: `is_capability(type)`, `enumerate_capabilities()` | the universe of capability tags | the checker knows what counts as authority |
| `is_construction` + `symbol_module` *(Bucket 1)* | locate every mint site and its module | enforce unforgeability *as a checker rule* |
| **per-symbol visibility** (a module-private constructor, unreachable across `@use`) | a constructor that can't be *named* outside its module | unforgeability *structurally* (defense-in-depth) — the one likely **new language primitive** the capability work needs |
| `extern_effect_of(node) → cap?` | which effect tag an `@extern` call carries | `@extern` ⇒ `effectful` / a declared tag |
| root-authority seam: mark `main`'s capability params + WASI-preopen → capability mapping | where *un-minted* authority enters the program | the bootstrap; `pure ≙ …` bottoms out here |
| rcap mode of a binding (`&uniq` / `&val`, ADR 0011) | non-duplication + send rules for a held capability | one-shot / sendable capabilities |

### Unforgeability, *via* Stratum — the key move

A capability is unforgeable iff user code cannot **mint** one. Two layered mechanisms, both expressible on the primitives above; the via-Stratum sweet spot is the first:

1. **Mint-site restriction as a checker rule (portable; no language change).** The `@capability` stratum installs an `on::check` rule: **constructing a capability type `C` is an error outside `C`'s declaring (issuer) module.** Reflection supplies it directly — `is_construction(node) → C` ∧ `symbol_module(here) ≠ declaringModule(C)` ⇒ `diag_error`. The issuer's *factory/attenuator* functions are the only mint sites; each takes a *stronger* capability as proof of authority (a `&console_write_only (Console) -> WriteOnlyConsole` constructs the weaker cap, authorized because it runs *inside the issuer* and is handed the stronger one). External code may hold, pass, and attenuate but never construct. **Unforgeability is therefore one more rule in the same capability checker** — defined by the `@capability` stratum, riding only the P2 reflection surface. This is "via Stratum" at its purest: a security property installed as *data*.

2. **Module-private constructor (structural; defense-in-depth).** When per-symbol visibility lands, the `@capability` stratum additionally emits the constructor as a module-private symbol, so a forgery fails at *name resolution*, not only at the check — covering unchecked/partial builds and tightening the guarantee from "rejected" to "unnameable." This is the one genuinely new **language** primitive the capability story wants: Silicon today gates *export* but not the *import-visibility of a type's constructor*.

**Lean:** ship (1) first — it needs nothing but P2 + the `@capability` stratum, uniformly covers attenuation, and keeps the security semantics as data; add (2) as the structural backstop when visibility exists. Both converge on the same authority — *the issuer module is the minting authority*; (1) **checks** it, (2) **seals** it. And note (this is the payoff of ADR 0015 point 8): nothing here needs effect rows or phantom types — minting is gated by *provenance* (issuer module) + *flow* (the check), and higher-order/generic capability-polymorphism is dissolved by monomorphization, not abstracted in the type system.

## Options considered

### Option A — Host-pass forever (never a stratum)
Implement and keep the checker as compiler-core TS (P0–P2, P4a; skip P3, P4b).
- **Pro:** fastest, easiest to debug, no comptime-collection or wasm3-perf dependency.
- **Con:** contradicts "language semantics live in strata" for a large feature; not distributable/swappable as a stratum; no dogfooding.

### Option B — In-stratum immediately (skip the host prototype)
Jump straight to P4b: write the checker in `capabilities.si` first.
- **Pro:** maximally pure; the dogfood goal reached soonest.
- **Con:** bets the *analysis design* and the *comptime collections* and *wasm3 performance* all at once; debugging a whole-program analysis buried in comptime WASM (ADR 0003's stated risk) before the rules are proven is the highest-risk path.

### Option C — Host-first, then re-home *(chosen)*
P0 → P1 → P2/P3 → P4a → P4b. Build the reusable plumbing (hook + reflection) once, prototype the rules in TS, port to Silicon when the substrate is ready.
- **Pro:** never blocks the *language feature* on the *metaprogramming infrastructure*; the `on::check` hook + reflection are needed under *any* option, so they're built first regardless; ends exactly where the project's philosophy points.
- **Con:** the checker exists in two homes (TS then Silicon) during the transition — mitigated by treating P4a as a throwaway prototype, not a parallel maintained implementation.

## Architecture: phase hook vs query model (the contract discipline)

P1 introduces `on::check` as a **phase hook** — a stratum fires "after typecheck." That is the right *v1 implementation*, but the *pattern* (extensions observing named phase boundaries) has a known failure mode. This section pins the discipline that keeps it from biting, so the React mistake isn't made by accident.

**The cautionary tale.** React's class lifecycle (`componentWill*`/`componentDid*`) was this same "hook a phase boundary" pattern. When React went concurrent, a phase could be paused, aborted, and restarted, so the `Will*` hooks fired multiply/partially and were renamed `UNSAFE_*`; React moved to a declarative model where the engine owns *when*. Two failure modes transfer directly:

- **Scheduling coupling.** A hook defined as "runs after the typecheck *phase*" assumes typecheck is a discrete, once-per-compile, whole-program event. Silicon is investing in incrementality ([[silicon-line-independent-parsing]], incremental lexing, CaaS). The first time capability facts want recomputing for *one edited function* rather than via a global phase, a phase-boundary hook fights the scheduler.
- **Pass ordering.** Multiple strata registering check-phase passes inherit LLVM's pass-ordering problem and React's `shouldComponentUpdate`-order fragility — order-dependent the moment a pass mutates shared state.

**The contrasting model.** Query / demand-driven compilers (rustc queries + salsa, Roslyn's `SemanticModel`, Swift's request-evaluator) don't run "pass P after phase Q." They define memoized **queries** — `typeOf(node)`, `capabilityOf(fn)`, `effectClassOf(fn)` — each a pure function of inputs; the engine builds a dependency graph and recomputes only what changed. Extensions add *new queries* (derived facts), not *new passes at a time*. No pass ordering (queries declare deps), naturally incremental, naturally parallel.

**The bridge — define the contract as a query, schedule it as a phase.** Keep `on::check` for v1, but specify its *contract*, not its *timing*:

> An `on::check` stratum computes a **pure derived fact** — `capabilityOf(module)` / `effectClassOf(fn)` — given a `typeOf` query it may call. It MUST NOT depend on *when* it fires, MUST NOT mutate cross-pass state observable by other strata, and MUST be deterministic.

Under that contract the phase hook is merely the **v1 scheduler** for a query; the demand-driven query model is the **v2 scheduler** for the *same* contract. They are not rivals — and migrating from one to the other touches the scheduler, **not a single stratum**. This is the React lesson applied: keep the programming model declarative; let the engine own scheduling.

**Migration target — the existing CaaS query surface.** Silicon already exposes `SemanticModel.typeOf(node)` (the `typeMap` WeakMap) and is pursuing Roslyn parity ([[caas-roslyn-parity-tracker]]). A Roslyn analyzer *is* "query the SemanticModel, report diagnostics" — incremental, phase-decoupled. The capability checker should be **a CaaS analyzer that queries `typeOf` and adds `capabilityOf` / `effectClassOf`**, aligned with that surface — not a parallel pipeline-only track. `on::check` is a temporary scheduler for a query that ultimately belongs in the `SemanticModel`.

**Rules shape — declarative where it can be, imperative where it must be.** The analysis splits cleanly, and every mature system converges on this split:

- **Syntax-directed facts** (purity, effect class, scope, rcap-at-boundary) compose and incrementalize as queries / synthesized attributes / lattice-Datalog relations (cf. **Flix** — Datalog with lattice semantics, an uncanny fit for `pure ⊑ mut ⊑ effectful`). Express these as **data** where practical, preserving the "language semantics live as data" ethos for the analysis itself.
- **Flow-sensitive facts** (R2 aliasing: borrow state per program point) resist every declarative model and want an imperative dataflow pass over the CFG. This is the irreducible ~20%.

**Concretely, for P1:**

- **DO** hand the handler the program + a `typeOf` query; **DO** require pure, deterministic, side-effect-free computation; **DO** make a violation fatal (open question 3).
- **DON'T** let an `on::check` stratum observe or depend on another stratum's check-phase effects; **DON'T** allow check-phase mutation of the AST/module (it *analyzes*, it does not rewrite — rewriting is `on::lower`'s job); **DON'T** expose the phase boundary itself as API (only the query contract).

## Consequences

### Positive
- **The confusion is gone:** a single DAG, each step labelled with what it depends on and why it's buildable without the step it appears to need.
- **The `on::check` hook + reflection (P1–P2) are reusable** — needed even for a pure TS checker (ADR 0012's optimizer consumes the same typed program), so the early work is never wasted.
- **The language feature is decoupled from the metaprogramming infrastructure:** capabilities can ship (P4a) before comptime collections / the Silicon comptime interpreter mature.
- **Ends as the dogfood flagship (P4b):** the first heavyweight real-world Silicon program the Silicon compiler runs on itself — directly serving ADR 0003's v1.1 thesis.

### Negative
- **Two checker homes during transition** (P4a TS, P4b Silicon). Treat P4a as a prototype with golden-output tests that P4b must match.
- **P3b is the one real (but acyclic) self-host wrinkle:** the stdlib collections must be *comptime-clean* — compile and run under the comptime engine with its per-firing memory model. They depend only on P0, but proving them comptime-clean is real work.
- **Performance + determinism (per ADR 0003):** P4b runs interpreted under wasm3 (~10–100× slower than JIT) and must be byte-for-byte deterministic (no map-iteration-order dependence). A whole-program analysis is heavy comptime computation.
- **The `on::check` hook is a surface contract** other strata may come to depend on; once published it carries a stability obligation.

### Follow-up work (no story IDs — exploration)
- Spec the `on::check` firing contract: what handle(s) it receives (Program + `typeMap`), ordering vs other phases, whether it can emit *fatal* diagnostics (it must, to block lowering on a violation).
- Define the P2 reflection additions in `wit/comptime.wit` (`ast_inferred_type`, durable-handle lifetime rules) and run the ADR 0003 wit-coverage gate.
- Decide P3a-vs-P3b sequencing and prove a stdlib collection is comptime-clean.
- A `capabilities.si` skeleton that compiles as a no-op `on::check` handler (proves P1 end-to-end).

## Implementation pointer

None — Proposed exploration ADR. Status moves to Accepted when a story scopes P1 (the `on::check` hook) and a PR lands it.

## Load-bearing open questions
1. **Per-module firing.** The check fires once per module (that module's bodies + imported signatures), with its own linear memory — never a whole-program firing. Confirm the engine can hand a single per-module firing a stable handle to that module's typed AST for its full duration. (See *Compilation model* below.)
2. **P3a or P3b first.** Host collection primitives (fast, zero stdlib-comptime risk) vs comptime-clean stdlib (pure, dogfoods). *Lean: P3a to unblock P4a; P3b as the P4b prerequisite.*
3. **Fatal diagnostics.** Today strata diagnostics are non-fatal (T-5 trap model). A capability *violation* must block compilation. Does `on::check` get a fatal-error channel, or does the pipeline treat any `on::check` error as fatal? *Lean: errors from the check phase are fatal by construction.*
4. **`on::check` vs realizing reserved `on::typecheck`.** Are they the same hook under different names, or distinct phases (type-participation vs post-type analysis)? *Lean: distinct — `on::check` runs strictly after typecheck and only reads types; it does not participate in inference.*
5. **Unforgeability enforcement (P5).** Mint-site checker rule (leg 1 — needs only P2 reflection + the `@capability` stratum) vs. module-private constructor (leg 2 — needs per-symbol *import-visibility*, a new language primitive). *Lean: leg 1 ships first as a stratum-installed rule; leg 2 lands as the structural backstop when visibility exists.* Per-symbol/constructor visibility is the single most likely **new language primitive** the capability work requires — everything else is a host import below strata.
6. **`@capability` lowering.** Does `@capability Console;` expand to a zero-field nominal type (erased authority witness) by default, with a `@capability Console := { fd Int };`-style payload form for resource handles? How does the erased-vs-runtime choice (ADR 0015 point 7) surface in the declaration?

## What this is NOT committing to
- An implementation date, or the analysis rules themselves (those are ADR 0011 / ADR 0012).
- A specific reflection ABI beyond "durable handles + `ast_inferred_type`" — shakes out against `wit/comptime.wit` at implementation time.
- That P4b ever fully replaces P4a within 1.x — the re-homing may land in the v1.1 Silicon-comptime window (ADR 0003).
- Host collections (P3a) being permanent — they may persist as a fast path even after P3b lands.
