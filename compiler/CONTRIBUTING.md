# Contributing to Sigil / Silicon

Sigil is the reference compiler for the Silicon programming language.
This document is the short version of how to contribute. The longer story
lives in [`docs/`](./docs/) and the architectural decisions in
[`docs/adr/`](./docs/adr/).

## Getting started

```sh
git clone https://github.com/NatesCode/sigil
cd sigil
bun install
bun test
```

You need:

- **Bun ≥ 1.0** — runs the TypeScript compiler and the test suite
- **wasmtime** — executes compiled WASI binaries (only needed if you
  run the `sgl run` integration tests locally)
- **wat2wasm** (from WABT) — for `.wat → .wasm` assembly outside the
  embedded `binaryen` pipeline; install with `scripts/install-wat2wasm.sh`

## Where things live

- `src/` — the TypeScript compiler (production)
- `src/strata/*.si` — built-in language constructs as Silicon source
- `src/stdlib/*.si` — Silicon standard library
- `src/caas/` — Compiler-as-a-Service public API (see
  [`docs/compiler-as-a-service.md`](./docs/compiler-as-a-service.md))
- `docs/` — architectural notes, ADRs, language reference

Adding a language feature? Read
[`docs/strata.md`](./docs/strata.md) first — the grammar is intentionally
tiny and stable; new keywords should ride the existing `Definition` and
`FunctionCall` forms via a new stratum, not a grammar change.

## Reporting bugs / requesting features

Open an issue at https://github.com/NatesCode/sigil/issues. Include:

- A minimal Silicon program that reproduces the problem
- What you expected and what happened instead
- `bun --version`, OS, and `sgl --version` if relevant

For security reports, see [`docs/security.md`](./docs/security.md) — do
not file them as public issues.

## Pull requests

- Fork, branch, commit, push, open the PR. Conventional-style commit
  messages (`feat:` / `fix:` / `docs:` / etc.) are appreciated.
- `bun test` must pass. Add tests for new behaviour.
- New TypeScript files start with `// SPDX-License-Identifier: MIT`.
- New `src/strata/**/*.si` / `src/stdlib/**/*.si` files start with
  `# SPDX-License-Identifier: MIT`.
- Add a changeset entry if your change is user-visible:
  `bun run changeset`.

There is no Contributor License Agreement for v1.0 — by opening a PR
you agree your contribution is licensed under the MIT License (see
`LICENSE.md`).

## Style

- Read `CLAUDE.md` at the repo root for the conventions the maintainer
  follows.
- Prefer editing existing files over creating new ones.
- Don't add error handling or fallbacks for scenarios that can't happen.
- Don't add features beyond what the change requires.

## Releases

Releases are cut from `main` by the maintainer using
[Changesets](https://github.com/changesets/changesets):

```sh
bun run changeset version    # consume .changeset/ entries
git tag v<version>
git push origin v<version>   # triggers .github/workflows/release.yml
```

See [`docs/release/`](./docs/release/) for the full workflow.
