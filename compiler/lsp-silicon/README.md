# lsp-silicon

Language Server Protocol implementation for the
[Silicon programming language](https://github.com/natescode/sigil).
Standalone Node package so it works in any editor that speaks LSP
(vim, emacs, helix, neovim, sublime, zed, vscode).

> **TODO: extract to its own repository.** This package only lives in
> the `sigil` monorepo for development convenience while the compiler
> frontend it imports from `../src/` is still churning.  Once the
> backend switches to `stage1.wasm` (see Architecture below), it has
> no further reason to share a tree with the compiler — move to
> `natescode/lsp-silicon`, publish to npm.

Plan: [`docs/language-server-plan.html`](../docs/language-server-plan.html).

## v1 alpha capabilities

- **Diagnostics** — parser + elaborator + typechecker errors as
  `publishDiagnostics`, debounced 200 ms on change.
- **Document symbols** — outline pane and breadcrumb for every
  `@let` / `@fn` / `@var` / `@extern` / `@type` / `@stratum_*`,
  with hoisted `@local`s and params nested under each `@fn`.
- **Go-to definition** — `textDocument/definition` resolves local
  references, top-level names in the same file, and cross-file
  names via the `@use` graph.
- **Hover** — markdown popup with keyword + signature + the first
  line of the preceding `##` doc comment.

## Run

```bash
bun run src/index.ts --stdio       # talk LSP over stdio
```

The server is wired into the VS Code extension at `../vscode-silicon`;
that extension spawns this server automatically on `.si` activation.

## Smoke test

```bash
bun test src/smoke.test.ts
```

Spawns the server, walks initialize → didOpen → documentSymbol →
definition → hover, and asserts the four capabilities respond as
expected.

## Architecture

`src/index.ts` wires the handlers.  Each handler is a separate file
under `src/handlers/`:

```
src/
├── index.ts                          stdio entry + handler registry
├── workspace.ts                      per-doc parse/elaborate/typecheck cache
├── symbol-index.ts                   regex-based symbol extractor
├── handlers/
│   ├── diagnostics.ts                debounced publishDiagnostics
│   ├── document-symbol.ts            outline + breadcrumb
│   ├── definition.ts                 F12 / Ctrl-click
│   └── hover.ts                      markdown popups
├── smoke.test.ts                     bun:test wrapper
└── _smoke-run.ts                     standalone test runner script
```

The compiler frontend (parse / elaborate / typecheck) is imported
directly from `../src/`.  Future versions will switch the backend
to `stage1.wasm` once it exposes a "give me diagnostics" surface.

See `docs/language-server-plan.html` for the full design and the
post-alpha roadmap (completion, references, rename, strata-aware
semantics, project-config awareness).
