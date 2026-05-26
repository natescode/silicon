# ADR 0004 — Uniform `Backend<T>` interface for codegen targets

- **Status:** Proposed
- **Date:** 2026-05-26
- **Related:** `docs/v1-bootstrap-requirements.html` §3a · `src/codegen/` · `src/sigil_cli.ts`

## Context

Today three codegen targets each ship their own entry point:

- `compileToWat(p, registry, fns, modules, opts, model): string`
- `compileToWasm(p, registry, fns, modules, opts, model): Uint8Array`
- `lowerToQbe(p, …): string`

Signatures drift. `src/sigil_cli.ts` switches on `--emit=` and calls each
directly. The boot/ port will inherit this shape unless we finalize a single
`Backend<T>` contract in `src/` first.

This isn't a runtime bug — it's a porting hazard. Authoring a fresh codegen
in Silicon is much harder than refactoring three TS functions into one
contract. The boot/ port goes ~3× faster if there's a single shape to mirror.

## Decision

**Recommendation: introduce `Backend<T>` in `src/codegen/backend.ts` with
three implementations (WAT text, WASM binary, QBE IR). Wire `src/sigil_cli.ts`
through the interface so the public CLI proves the abstraction holds.**

Sketch:

```ts
export interface Backend<T> {
    readonly name: 'wat' | 'wasm' | 'qbe'
    readonly artifactExtension: string
    compile(
        program: Program,
        registry: ElaboratorRegistry,
        functions: Map<string, FunctionSig>,
        options: BackendOptions,
    ): { artifact: T, diagnostics: readonly Diagnostic[] }
}
```

## Options considered

### Option A — Add the interface now *(recommended)*

Cost: ~4 hours. ~30 lines TS for the interface; thin adapters around the
existing functions; CLI rewrite.

- Pro: boot/ port has a single contract to mirror
- Pro: any future backend (LLVM, Cranelift) plugs in without surgery on the CLI
- Pro: testing each backend uses the same harness shape
- Con: small adapter overhead per backend

### Option B — Leave the ad-hoc entry points, port them as-is

Cost: ~0 now; ~2 days extra in boot/ to author three independent codegen
entry points in Silicon (likely with eventual drift).

- Pro: no work today
- Con: locks the ad-hoc shape into the self-hosted compiler
- Con: boot/ design churn likely as we try to factor common pieces later

### Option C — Only ship one backend in 1.0 (WAT) and add the others in 1.1

Cost: ~0 now. Removes the abstraction need.

- Pro: simplest possible 1.0
- Con: native self-host (story 9.5-6) needs QBE — we don't actually have one backend
- Reject

## Consequences

- **Positive (A):** single Silicon contract to mirror in boot/
- **Negative (A):** small refactor risk around CLI argument handling and
  error reporting (diagnostics must flow through the interface uniformly)
- **Follow-up work:**
  - QBE backend completion (ADR-related to bootstrap-requirements §4a)
  - Define `BackendOptions` exhaustively so it doesn't grow into a `Map<string, any>`

## Implementation pointer

Pending — link the PR that introduces `src/codegen/backend.ts` and updates
`sigil_cli.ts` to use it.
