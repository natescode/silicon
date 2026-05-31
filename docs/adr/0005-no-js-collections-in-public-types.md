# ADR 0005 — No `Map` / `WeakMap` in public CaaS surface

- **Status:** Proposed
- **Date:** 2026-05-26
- **Related:** `docs/archive/v1-bootstrap-requirements.html` §3b · `docs/stability.md` §2 · `etc/sigil.api.md` · `src/modules/registry.ts` · `src/caas/workspace.ts` · `src/ast/semanticModel.ts`

## Context

Three places in today's public surface leak JS-specific collection types:

| File | Surface |
|------|---------|
| `src/modules/registry.ts:16` | `LowerOptions2.moduleRegistry: Map<string, ModuleEntry>` |
| `src/caas/workspace.ts` | `Workspace.documents(): ReadonlyMap<string, Document>` |
| `src/ast/semanticModel.ts` | `WeakMap<object, SiliconType>` for type annotations |

Silicon has no `Map` and no `WeakMap`. The stdlib ships a HashMap type
(per v1-user-story 5a-6), but `WeakMap` semantics — reference-keyed,
GC-aware — aren't expressible in Silicon at all.

If 1.0 ships these signatures, the eventual self-hosted compiler must either:

- (a) expose JS-Map-shaped data through a HashMap-backed wrapper, breaking the
  stability contract subtly (iteration order, presence semantics differ);
- (b) break the surface earlier by changing the signatures in 1.x.

Either way, the cost lands later and bigger. Better to fix while the
TypeScript side is the source of truth and api-extractor catches the change
mechanically.

## Decision

**Recommendation: redesign the affected public signatures to use
array-of-pairs or named opaque types. Internal `Map`/`WeakMap` storage stays;
the public surface must be Silicon-portable.**

Shape:

| Old | New |
|-----|-----|
| `Map<string, ModuleEntry>` | `readonly ModuleEntry[]` (each carries `name: string`), or an opaque `ModuleRegistry` already exposed |
| `ReadonlyMap<string, Document>` | `readonly Document[]` (each carries `uri`) + `getDocument(uri): Document \| undefined` |
| `WeakMap<object, SiliconType>` | private to `SemanticModel`; expose only `typeOf(node): SiliconType \| undefined` |

## Options considered

### Option A — Redesign now *(recommended)*

Cost: ~6 hours per the audit. 3 type definitions and ~10 call sites. The
api-extractor report (`etc/sigil.api.md`) will diff cleanly so reviewers
see exactly what changed.

- Pro: surface stays Silicon-portable, stability contract intact across the v1.0 → self-host jump
- Pro: opaque accessors are friendlier than raw Maps even for TS consumers
- Con: small breaking change to anyone holding a `Map.entries()` iterator today

### Option B — Keep the Maps; document the self-host accommodation in v1.1

Cost: ~0 now; ~2 days of debt in v1.1 when we have to break it. Plus the
ergonomic harm of having the self-hosted compiler expose HashMap-shaped values via a JS-Map shim.

- Pro: no work today
- Con: shipped 1.0 stability contract is misleading
- Reject

### Option C — Keep `Map` only in `@internal`-marked surface; opaque accessors for `@public`

Cost: same as A. Functionally identical because api-extractor's
`publicTrimmedFilePath` strips `@internal` anyway. Just a stricter
discipline around release tags.

- Worth adopting **in addition** to A: mark anything that must stay JS-Map-shaped
  with `@internal` so the public `.d.ts` rollup is automatically clean.

## Consequences

- **Positive (A):** `etc/sigil.public.d.ts` becomes a faithful contract for
  the future self-hosted compiler. Future API checks (`npm run api:check`) will catch regressions.
- **Negative (A):** ~10 call sites and 3 types to update; tiny breaking change
- **Follow-up work:** also finalize the Symbol/Reference schema with optional
  `containingScope?: Scope` and `crossDocumentReferences?: Reference[]`
  (bootstrap-requirements §5b)

## Implementation pointer

Pending — link the PR. The `etc/sigil.api.md` diff is the receipt.
