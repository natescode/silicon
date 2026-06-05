# ADR 0012 — Capability-driven optimization: rcaps + ocaps as a modular purity certificate

- **Status:** Proposed (design exploration; no implementation timeline)
- **Date:** 2026-06-02
- **Deciders:** NatesCode
- **Related:** ADR 0011 (borrow checker: scopes + rcaps + actor isolation) · ADR 0008 (memory management: explicit arenas) · ADR 0003 (comptime engine path) · `src/stdlib/rc.si` (uniqueness / refcount) · `src/caas/` `MetadataReference` — precompiled library symbols (commit 6a814ac) · planned object-capability (ocap) ADR (not yet drafted) · [[silicon-mutability-capability-model]] memory · prior art: Koka (Perceus reuse, *functional but in-place*, effect types), Roc (opportunistic in-place via refcount uniqueness), Lean 4 (Perceus), LLVM function attributes (`readnone` / `readonly` / `writeonly`), MLton (whole-program flow analysis)

## Context

Silicon's settled mutability direction ([[silicon-mutability-capability-model]], formalized for safety in ADR 0011): immutable by default, module globals immutable, function locals freely mutable, and mutation constrained **only when it crosses a function or module boundary**. Shared mutation is opt-in and carries an explicit, type-visible capability — in ADR 0011's vocabulary the `&mut` / `&uniq` reference capabilities; for I/O, the (separately specified) object-capability that grants the effect.

ADR 0011 designs these capabilities for **safety** (no use-after-free, no data races, aliasing discipline). It does **not** say how the **optimizer** uses them. But the capability annotations are exactly the information an optimizer needs to prove a function pure — and the design goal stated when the mutation model was chosen was explicitly *"so we can still aggressively optimize immutable functions."* This ADR makes that consumption model explicit so it doesn't get reinvented inconsistently across the codegen/backends.

Two facts make this unusually clean for Silicon versus a C/LLVM-style optimizer:

1. **There is no mutable shared state by construction.** Globals are immutable; `&mut` is *unique* (ADR 0011 R2: at any point, 0..n `&` XOR 0..1 `&mut`). So "a function reads memory through an immutable reference" does **not** weaken referential transparency the way it does in C — nothing else can write that memory between two calls. LLVM's `readonly` is strictly weaker than `readnone`; in Silicon they collapse.
2. **The safety inference already computes the capability of every binding** (ADR 0011: rcap + scope inferred end-to-end in bodies, explicit at API seams). The optimizer's purity certificate is therefore a *byproduct* of an analysis the compiler already runs — not a second pass.

Design-exploration ADR, same status as ADR 0011: no implementation timeline; v1.x ships without it. The point is to fix the consumption model and to record that purity-based optimization **rides the safety/security capabilities** rather than a parallel effect system.

## Decision

**Treat the capability annotations at a function boundary as a modular purity certificate. The optimizer reads an effect class off each signature — no body inspection, sound across separate compilation — and uses the per-binding rcap/scope to drive in-placing.** Specifically:

1. **Effect lattice, read off the signature.** Each function classifies into:
   - **`pure`** — no `&mut` / `&uniq` parameter or return, no effect ocap. Depends only on argument *values*. Because all reachable shared state is immutable, a function that merely *reads* through `&` / `&val` references is also `pure` — **`readonly` collapses into `pure`.**
   - **`mut`** — takes `&mut` / `&uniq` (may write through it), no effect ocap. Its write set is *exactly* the state transitively reachable from its `&mut` / `&uniq` arguments; uniqueness means those writes cannot alias the caller's *other* live references.
   - **`effectful`** — holds an effect ocap (I/O, nondeterminism) or calls an `@extern` import. Opaque; an optimization barrier for the effect it carries.

   The lattice is `pure ⊑ mut ⊑ effectful`, **flat (a set of effect tags), not polymorphic effect rows** — to stay within HM-lite's budget (matching ADR 0011's finite-lattice discipline).

2. **The certificate is part of the published signature.** Inferred in bodies, explicit at API seams, and **serialized into the `MetadataReference` symbol record** (commit 6a814ac) so cross-module callers get the effect class without the body. A precompiled symbol carrying no effect class is assumed `effectful` (conservative). This is what preserves purity-based optimization across the module boundary that defeats whole-program analyzers.

3. **Optimizations licensed on `pure` calls** — none sound in C without a hand-applied `const`/`pure` attribute: global value numbering / CSE of equal-argument calls; loop-invariant code motion; dead-call elimination when the result is unused; free reordering and scheduling; partial-redundancy elimination; opt-in memoization; dependency-free parallel scheduling (the foundation ADR 0011's actor/concurrency story builds on). For `mut` calls the optimizer still moves *unrelated* pure work across the call, because the `&mut` write set is known and non-aliasing.

4. **Capabilities drive in-placing, tiered by how uniqueness is known:**
   - **Static reuse (no runtime check).** A value with rcap `&uniq` / `&mut`, or a `local`-scope value at its last use, is *statically* unique. "Produce a modified copy" lowers to **destructive in-place update with zero runtime guard** — strictly better than Perceus/Roc, which insert a runtime `rc == 1` branch.
   - **Dynamic reuse (runtime check).** An `Rc` value is shared; in-place reuse falls back to the Perceus `if rc == 1 then mutate else copy` guard. This is the **only** tier that pays the branch.
   - **Compiler-synthesized destination-passing (DPS).** Because `local` / `&uniq` values don't alias, a function that builds and returns a structure may be rewritten to write directly into a caller-provided destination when the caller's slot is unique. This recovers — *in the compiler* — the output-parameter / buffer-reuse optimization the surface language deliberately forbids the user from hand-writing.
   - **Allocation site from scope.** `local` → frame / shadow stack (ADR 0011), `arena` → bump allocator (ADR 0008), `Rc` → refcounted heap. Pure functions over `local` data heap-allocate nothing.
   - **Freeze is a no-op.** A `local` / `&uniq` mutable value frozen to `&` / `&val` on escape is a cap transition with zero runtime cost at last use (no copy).

5. **I/O purity rides the ocap system.** In the planned ocap design, an effect like I/O is performed only through a capability object passed in. A function not passed the I/O capability *cannot* perform I/O → is `pure` w.r.t. I/O. So the purity rule is uniform across both capability systems: **`pure` ≙ (no mutation rcap) ∧ (no effect ocap).** The optimization is a *free rider* on machinery that already exists for safety (rcaps, ADR 0011) and security (ocaps, future ADR).

## Options considered

### Option A — Read purity off the existing capabilities *(chosen)*

The *Decision* above: the optimizer consumes ADR 0011's rcap/scope output plus the ocap effect grant.

- **Pro:** purity is a *free byproduct* of the safety inference — no second analysis.
- **Pro:** modular and cross-module via the `MetadataReference` effect class; survives separate compilation.
- **Pro:** `readonly` collapses into `pure` (immutable-shared-by-construction) — a stronger starting point than C/LLVM.
- **Pro:** static rcaps give *guard-free* in-placing for the common case; only `Rc` pays Perceus' branch.
- **Con:** the *transforms* (DPS synthesis, reuse-token threading, effect-class serialization) are real compiler work even though the *proofs* are free.
- **Con:** soundness is correctness-critical (mis-certified `pure` → miscompile); `@extern`/unknown must default to `effectful`.
- **Cost estimate:** small classifier (rides ADR 0011 inference) + the in-placing/DPS pass is the bulk. Months, not weeks.

### Option B — Separate effect system parallel to rcaps

A dedicated `<mut>` / `<io>` effect-row system independent of the borrow checker.

- **Pro:** clean conceptual separation of "effects" from "aliasing."
- **Con:** duplicates information rcaps already carry; two inference passes; polymorphic effect rows are heavier than the flat lattice; pays HM-lite integration cost twice.

### Option C — Whole-program purity analysis (no annotations)

Interprocedural fixpoint over the call graph (MLton-style).

- **Pro:** no annotation burden; can be precise.
- **Con:** defeated by separate compilation — the exact module-boundary blindness the capability approach fixes. Not modular; doesn't compose with `MetadataReference`; re-derived every build.

### Option D — Do nothing; lean on the backend (QBE / binaryen)

- **Pro:** zero work.
- **Con:** the backend sees no cross-call purity/alias facts; defensive copies and missed CSE land exactly where value semantics needs help. The stated goal goes unmet.

## Consequences

### Positive
- **Purity is modular, checkable, and cross-module** — read off the signature, no whole-program analysis, no body access. Fixes the module-boundary blindness flagged in the mutability discussion.
- **`readonly` collapses into `pure`** because all shared state is immutable — strictly stronger than C/LLVM's starting point.
- **In-placing is tiered and mostly guard-free** — `&uniq` / `local` get static reuse; only `Rc` pays the runtime branch.
- **One capability inference feeds three consumers** — safety (ADR 0011), the optimizer (here), security (ocaps). No parallel effect machinery.
- **Compiler-synthesized DPS** recovers the buffer-reuse performance the surface language forbids users from writing by hand.
- **Purity is the natural comptime gate** — `pure` functions are exactly the safely comptime-evaluable ones (see open question 4 / ADR 0003).

### Negative
- **The transforms are real work** even though the proofs are free: DPS synthesis, reuse-token IR, the effect-class field in `MetadataReference`. Months, not weeks.
- **Soundness is correctness-critical.** A function mis-certified `pure` (hidden effect via `@extern`, FFI, or a future escape hatch) miscompiles under CSE/DCE. Rule: `@extern` / unknown ⇒ `effectful`; purity must be *proven*, never assumed.
- **`Rc`-heavy code doesn't get free in-placing** — only the static tiers do; the `rc == 1` branch is the price of shared ownership.
- **Effect polymorphism is deferred.** "Pure iff the callback is pure" (higher-order purity) needs effect variables the flat lattice can't express; higher-order functions over effectful callbacks conservatively classify `effectful` until that lands.
- **Quality depends on annotation/inference discipline at API seams** — an under-annotated seam silently degrades to `effectful` and loses the optimizations.

### Follow-up work (no story IDs — exploration)
- Effect-class field in the `MetadataReference` schema + the conservative `effectful` default.
- In-placing pass design: reuse-token IR, static-vs-`Rc` tier dispatch, interaction with ADR 0008 arenas and ADR 0011 shadow stack.
- DPS synthesis worked example (build-a-`Vec`-and-return → write-into-destination).
- Stdlib classification table — each exported `vec.si` / `hashmap.si` / `io.si` function's effect class, as a sanity check on the lattice.
- Higher-order / effect-polymorphism sketch (the expensive frontier).

## Implementation pointer

None — Proposed exploration ADR. No committed timeline; v1.x ships without it. Status moves to Accepted when a story scopes the work and a PR lands the effect-class plumbing.

## Load-bearing open questions
1. **Granularity of the `mut` class.** Coarse (one `mut` tag) vs per-region (`mut[r]`, pure w.r.t. other regions). Coarse delivers the headline pure/impure split; per-region needs ADR 0011's scope identity as a type-level parameter (region polymorphism). *Lean: coarse first.*
2. **One inference pass, two consumers.** Confirm the optimizer's effect class is emitted by the *same* ADR 0011 rcap/scope inference rather than a separate walk.
3. **Memoization surface.** `pure` makes a function a caching *candidate*; automatic memoization needs a cost model. *Lean: explicit `@memo` hint, not automatic.*
4. **Comptime interaction.** Are `pure` functions exactly the comptime-eligible set (ADR 0003)? *Lean: yes — purity is the comptime gate; the effect class subsumes the eligibility check.*

## What this is NOT committing to
- An implementation date.
- Polymorphic effect rows (flat lattice only, for now).
- Automatic memoization (candidate-marking only).
- A specific reuse-token IR or DPS frame format — shakes out at implementation time.
- Replacing the backend optimizers — this *feeds* QBE/binaryen purity and alias facts; they still do instruction-level work.
