---
title: Reference overview
---

# Reference overview

The reference docs are organised around what you're looking up:

## Language

- [Grammar (EBNF)](/reference/grammar) — every production in
  ISO/IEC 14977 EBNF, the spec implemented by the hand-written parser.
- [Types](/reference/types) — the integer / float / bool / string /
  slice / function-type hierarchy.
- [Type inference (HM-lite)](/reference/hm-lite) — Hindley-Milner
  restricted to declared polymorphism on `@fn[T]` / `@type[T]`,
  no let-generalisation.
- [Diagnostics](/reference/diagnostics) — error code catalogue,
  caret rendering rules, hint format.

## Strata

- [Strata system](/reference/strata) — the data-driven dispatch model:
  how `@stratum` registrations turn into pipeline-phase handlers.
- [Strata authoring](/reference/strata-authoring) — step-by-step
  walkthrough for adding a new stratum.
- [Compiler API](/reference/compiler-api) — the `Compiler::*`
  surface that handlers call: `register::*`, `on::*`, `ir::*`,
  `module::*`, `diag::*`, `ast::*`, `type::*`.

## CaaS — the library API

- [Compiler-as-a-Service](/reference/caas) — Roslyn-style library
  surface; how to embed Silicon in your own tooling.
- [API surface](/reference/api) — generated from `etc/sigil.api.md`
  via api-extractor; every `@public` export with its signature.
- [API boundaries](/reference/api-boundaries) — which subsystems can
  import which; the rule book for internal vs public.

## Stability

See [Stability](/stability/) for what's promised stable, what's
unstable, what will *not* be added, and the per-surface versioning
rules.
