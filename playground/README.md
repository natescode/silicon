# Silicon Playground

Browser playground for the **Silicon** programming language. A Bun HTTP
server compiles Silicon source to WAT + WASM and serves an interactive
editor + runner UI.

This repo is a snapshot of the playground extracted from
[natescode/sigil](https://github.com/natescode/sigil) at commit
`b08f6c4c` — the last point at which the main Sigil repo still carried
the TypeScript compiler pipeline. The main Sigil repo has since gone
100% self-hosted (no TypeScript, no Bun); the playground continues to
live here on the older pipeline because the browser UX depends on
having a TS-side WAT-to-WASM path (`wabt-npm`) and the existing
typechecker integration for `/compile` diagnostics.

## Prerequisites

- [Bun](https://bun.sh/) ≥ 1.0 — the HTTP host runtime
- A modern browser (the UI is plain HTML + vanilla JS)

## Run

```sh
git clone https://github.com/natescode/silicon-playground.git
cd silicon-playground
bun install
bun run start
```

Then open <http://localhost:3001/>.

`PORT=8080 bun run start` to bind a different port.

## Repository layout

```
playground/        UI assets (index.html, web-env.js) + Bun HTTP server
src/               TypeScript compiler pipeline — parser, AST, elaborator,
                   typechecker, IR, codegen, modules, platforms
boot/strata/       Silicon-side strata source loaded at compile time by
                   src/strata + src/modules — operator/keyword definitions
                   and platform module declarations
```

## API

- `GET  /` — playground HTML
- `GET  /<path>` — static asset relative to `playground/`
- `POST /compile` — JSON request: `{ source: string, platform?: string, features?: string[] }`
  - Response: `{ success, wat, wasm (base64), exports, platform, features }` on success,
    `{ success: false, error: string }` otherwise

## Relationship to the main Sigil repo

| Concern | silicon-playground (this repo) | natescode/sigil (main) |
|---|---|---|
| Compiler | TypeScript pipeline (Bun host) | Silicon-in-Silicon (`stage1.wasm`) |
| Adding a stratum | Edit `boot/strata/builtin/*.si` | Edit `boot/strata/builtin/*.si` + regen embedded bundle |
| Tests | None bundled | `./test.sh` (20 Silicon tests) |
| Production target | Browser playground | CLI compiler (`wasmtime stage1.wasm`) |

When the main repo's `boot/strata/builtin/` source meaningfully changes,
this repo's copy can be refreshed by pulling those files over and
re-running the playground.

## License

MIT.
