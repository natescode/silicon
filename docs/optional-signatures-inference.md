# Optional function signatures & monomorphic inference

ADR-0020 makes `\\` signature lines **optional**. A `@fn` whose parameters carry
no type annotations (and no explicit `[T]`) has its parameter types **inferred**.
This is a convenience for demos and application-internal code; it is **not** a
substitute for annotating a library's public API (see *Guidance* below).

## TL;DR

- An unannotated parameter's type is inferred from the function's **call sites**.
- Inference is **monomorphic**: it resolves to **one** concrete type, or it errors
  (`E0015`). It is **inference, not monomorphization** — no per-call-site
  specialization and no extra copies are generated.
- Inference is **per compilation unit** — it only sees call sites in the same unit.
- An inferred function is **byte-identical at codegen** to a hand-annotated one.
  The only cost is at type-check time (and, in the editor, losing incremental
  reuse for that file); there is **zero** runtime/codegen cost.

## How it works

`inferUntypedParams()` (in `compiler/src/types/typechecker.ts`) runs as a pre-pass
inside the canonical `typecheck()`:

1. `collectUntypedFns()` finds `@fn`s with unannotated, non-`[T]` parameters.
2. It runs the real checker in *capture mode*, observing the concrete argument
   types at every call to those functions.
3. For each parameter, if all observed call sites agree on **one** concrete type,
   it writes a (synthetic) `TypeAnnotation` back onto the parameter AST node — so
   the final pass and lowering see a fully-annotated function, exactly as if the
   signature had been written by hand.
4. It iterates to a **fixpoint**, so nested and recursive calls resolve (once a
   callee's parameters are pinned, its return type becomes concrete for callers).

## Scope: per compilation unit

Inference only sees call sites **in the same compilation unit**. What counts as a
unit differs by entry point:

| Path | Unit | Consequence |
|---|---|---|
| `sgl build`/`run`/`check` of an **importer** | `@use` is a **pre-parse inliner** (`compiler/src/modules/useResolver.ts`) that concatenates dependency source into the entry → importer **+** library are **one** unit | An imported library function **can** be inferred from the **importer's** call sites |
| `sgl check` of a **library by itself** | just that file | No external call sites → `E0015` |
| **LSP / CaaS workspace** | **each document is its own unit** (cross-doc references resolve via `externalSymbols`, not by inlining) | A library file with no local call site shows `E0015` in the editor |

> ⚠️ **CLI ↔ LSP discrepancy.** Because the CLI inlines `@use` but the LSP checks
> per-file, a no-signature library function can **build fine via `sgl build <app>`
> yet be flagged `E0015` when you open the library file in the editor.** This is a
> known, deferred wrinkle — see *Deferred work*.

A document containing **any** no-signature `@fn` is routed to the full
whole-program `typecheck()` oracle (via the exported `programNeedsParamInference`
predicate in `compiler/src/caas/workspace.ts`) instead of the per-group
incremental engine — inference needs the whole program, which the per-element
incremental engine can't provide. So such files do **not** get incremental
type-check reuse in the editor (fine for typical sizes; see *Deferred work*).

## Monomorphic only

Inference resolves a parameter to a **single** concrete type:

- **Two different concrete types** across call sites → `E0015` (the function is
  genuinely polymorphic; it is *not* specialized into multiple copies). Use an
  explicit `[T]` generic.
- **No concrete anchor at all** (e.g. a function only ever called with the result
  of an unbound name, or never called) → `E0015`.

## Current limitation: call-site only, NOT body-based

Inference today looks **only** at call sites — it ignores how a parameter is
**used inside the body**, even when the body fully determines the type:

```silicon
@fn greet name := { 'Hello, ' ++ name };   # ++ forces name : String, body ⇒ String
@export greet;                             # …yet with no call site: E0015 today
```

```silicon
@fn inc n := { n + 1 };                    # literal 1 ⇒ n : Int … still E0015 with no call site
```

**Body-based (use-based) inference is a natural future extension.** It would bind
unannotated parameters as fresh type variables, collect constraints from the body
(operator operand types, calls to typed functions, literals), and unify. It would:

- resolve **uncalled / library** functions straight from their bodies — which
  removes much of the CLI↔LSP discrepancy and the "annotate public APIs" friction
  for any function whose body determines its types;
- still leave **genuinely ambiguous** bodies (e.g. `@fn double x := { x + x }`,
  which is any numeric type) needing a call site or an explicit `[T]`.

It is deferred because the body checker currently returns plain `SiliconType`s
without threading a substitution; body inference needs constraint collection
through it (a larger change than the call-site approach).

## Guidance: annotate public / library APIs

Inference is for **app-internal code and demos**. **Annotate a library's public
surface** (`\\` signature line or `[T]`), for three independent reasons:

1. **Separate / standalone checking and the editor can't see downstream callers**
   — a library checked on its own (or per-file in the LSP) has no call sites.
2. **A signature is the API contract.** Don't let it depend on how one consumer
   happens to call the function.
3. **Inference is monomorphic.** Two consumers calling at different concrete types
   → `E0015` regardless. A function meant to be reused at many types needs `[T]`.

## Diagnostic

`E0015` (`MissingParamType`) — *"could not monomorphically infer the type of
parameter '…' of '…'"* — fires only when monomorphic inference genuinely can't
decide (no concrete call sites in the unit, or call sites disagree). The hint
points to the fixes: annotate the parameter, add a `\\` signature, or make it
generic with `[T]`. See [diagnostics.md](diagnostics.md).

## Deferred work (tracked, intentionally delayed)

1. **Body-based (use-based) inference** — infer a parameter from its body usage,
   not just call sites (see *Current limitation* above). This is the highest-value
   follow-up: it would let body-determined functions (like `greet`) work with no
   call site and would heal most of the CLI↔LSP discrepancy. Drafted (not
   prioritized) as **ADR-0021** (bounded inference: body-first constraint generation
   + call-site refinement) — [`adr/0021-bounded-type-inference.md`](adr/0021-bounded-type-inference.md).
2. **CLI ↔ LSP consistency** — either inline `@use`d dependencies into the
   importer's unit in the workspace (matching `sgl build`), or emit a gentler,
   library-aware hint on standalone files.
3. **True polymorphic monomorphization** — emit specialized copies for a function
   used at multiple concrete types without an explicit `[T]`.

## Related

- [hm-lite.md](hm-lite.md) — the underlying HM-lite inference (declared
  polymorphism on `@fn[T]` / `@type[T]`).
- [signature-lines.md](signature-lines.md) — `\\` signature lines and bare params.
- [use-includes.md](use-includes.md) — `@use` textual inclusion semantics.
- [diagnostics.md](diagnostics.md) — the `E0015` error.
- ADR-0001 (generic monomorphization scope), ADR-0020 (grammar redesign — bare
  params, optional signatures).
