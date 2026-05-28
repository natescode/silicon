# docs/archive

Historical and superseded documents. Preserved for traceability —
none describe how the v1.0 compiler actually works. The live
documentation tree is one level up at `docs/`.

Three categories live here:

## 1. Bootstrap / boot/ era

The Silicon-in-Silicon bootstrap previously lived under `boot/`; that
tree was removed on 2026-05-27 (commit `1a69613`). A fresh bootstrap
is planned later (see the v1.1 user stories) but will not pick up
where these documents left off. Anything in these files referring to
`boot/`, `stage1.wasm`, `stage0`, or "the bootstrapped compiler" is
about a pipeline that no longer exists.

- `bootstrap-plan.html` — original Silicon-in-Silicon plan
- `bootstrap-audit.html` — audit of the bootstrap status
- `bootstrap-status.md` — tracking progress against the plan
- `sigil-wasm-bootstrap-plan.html` — WASM-targeting variant of the plan
- `silicon-only-bootstrap-plan.html` — Silicon-only variant
- `v1-bootstrap-requirements.html` — what bootstrap would need at 1.0
- `test-bootstrapped-compiler.html` — how to validate the bootstrap
- `stage0-cleanup-plan.html` — Stage 0 cleanup workstreams
- `stage0-production-roadmap.html` — Stage 0 production readiness

## 2. Shipped-design docs

The feature has landed; the design doc is preserved for the
"why was it shaped this way" record. The live behavior is documented
in `docs/strata.md`, `docs/compiler-as-a-service.md`, etc. — not
here.

- `sigil-1.0-roadmap.md` — early 1.0 roadmap, superseded by
  `docs/v1-user-stories.html` (which is now ✅ complete).
- `phase-2-typechecker-port.md` — planned a port to the Silicon-in-
  Silicon typechecker. Typechecker shipped in `src/types/`; the
  port itself is v1.1 work.
- `wasm-binary-emitter-plan.md` — direct .wasm emit deferred per
  [ADR 0006](../adr/0006-wasm-emitter-mixed-mode.md); v1.0 routes
  through WAT → binaryen.
- `robust-strata-implementation-plan.html` — implementation plan
  for Strata 2.0; Strata 2.0 shipped in `src/strata/` + Strata 2.0
  test suite.
- `silicon-core-i64-plan.html` — `Int64` design plan; shipped (see
  CLAUDE.md "Integer Type Hierarchy" section).
- `use-as-stratum-plan.html` — proposed making `@use` a stratum.
  The shipped design is different: `@use` is a pre-parse step in
  `src/modules/useResolver.ts` (cleanup plan §10). Plan retained
  for the reasoning trail.

## 3. Brainstorming / aspirational

Explicit "not a spec, not implemented" docs. Preserved because the
ideas might come back in v1.x.

- `loop-design.md` — sketches a unified `@loop` (while + for +
  for-each). Explicit "Status: brainstorming. No code in this doc
  is implemented today."
- `parens-optional-grouping.md` — grammar refinement proposal for
  optional parens around param lists. Not in the v1.0 grammar.
- `language-tooling.html` — external tooling adoption plan
  (TextMate grammar, Tree-sitter, syntax highlighters). Aspirational
  and likely v1.x work, depending on demand.

## Re-activating an archived doc

If one of these becomes the foundation for new work:

1. Move it back up one level (`git mv docs/archive/X docs/X`).
2. Update its header — strip the "Historical" marker, replace with
   a current status note.
3. Link it from the appropriate live index page
   (`docs/strata.md`, ADRs, etc.).
4. Remove the entry from this README.

Don't ressurrect a doc in place; re-promoting to `docs/` makes the
status change obvious in git history and prevents readers from
inheriting the historical framing.
