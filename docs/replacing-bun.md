# Replacing Bun — migration plan

**Status:** proposal (interim) · **Date:** 2026-06-01 · **Motivation:** licensing + binary size

> **Chosen direction:** the long-term answer is the native self-host in
> [`qbe-self-host-plan.md`](qbe-self-host-plan.md). This document is the **cheap
> interim** — swap `bun build --compile` for `deno compile` to remove the LGPL
> obligation in ~2 files while keeping a ~80 MB V8 binary. Use it only as a bridge
> if the licensing fix is needed before the self-host lands.

## Why

`sgl` binaries are produced with `bun build --compile`, which embeds the Bun
runtime. Bun's own code is MIT, but Bun **statically links JavaScriptCore /
WebKit (LGPL-2)**. That single fact is the entire reason this plan exists:

- **Licensing.** LGPL-2 static linking imposes a relink obligation on everything
  we ship (see `cli/THIRD-PARTY-LICENSES.md`, `compiler/NOTICE.md`). A V8-based
  runtime (Node, Deno) carries no LGPL — V8 is BSD-3, OpenSSL is Apache-2.0.
- **Size.** The compiled binary is ~93 MB because the whole Bun runtime ships in
  every copy (see memory note *todo-slim-binary*).

The binary is the **only** place Bun reaches an end user. Bun as a dev/test/build
tool is internal — it ships nothing and carries no redistribution obligation.
That distinction is what makes this cheap.

## The key finding: the shipped runtime is already Bun-free

An audit of the **runtime code path** (`cli/src/**` + `compiler/src/**`,
excluding `*.test.ts` and `scripts/`) found:

| Surface | In the shipped path? |
|---|---|
| `Bun.*` APIs | **None** in `sigil_cli.ts`; only `Bun.write` in `compiler/src/index.ts` (the `bun run compile` dev driver, **not** the `sgl` entrypoint) |
| `bun:*` imports | None |
| `import.meta.dir` / `dirname` | None (all in scripts/tests) |
| `bun:test` | Tests only — never reached by the binary |
| `WebAssembly.Module` / `Instance` | **Yes** — `compiler/src/comptime/engine.ts` instantiates WASM at compile time. The replacement runtime **must** support standard WebAssembly. |

So the compiler is already a standard-JS + `node:`-API program. Bun appears in:

- **Build scripts** — `cli/scripts/build-binary.ts` (`Bun.build`, `bun build --compile`, `Bun.spawnSync`), `cli/scripts/package-release.ts` (`Bun.$`).
- **Tests** — 81 files import `bun:test`; `bun test` is the only runner.
- **Dev tooling** — playground dev server (`Bun.serve`, `Bun.file`), benches (`Bun.version`), running `.ts` directly via `bun run` / shebangs.

**None of those ship.** Removing Bun from the *artifact* therefore touches one
build step, not the compiler.

## Runtime choice for the shipped binary

Requirements: standalone single-file binary, cross-compile to
`{linux,macos}×{x86_64,aarch64}`, standard `WebAssembly`, `node:fs`/`node:path`/
`node:child_process`/`process`/`Buffer`, no LGPL.

| Candidate | License | WASM | Cross-compile | TS | Verdict |
|---|---|---|---|---|---|
| **Deno `compile`** | MIT + V8 (BSD) | yes | `--target` (4 we need) | native | **Recommended** |
| Node SEA | MIT + V8 (BSD) + OpenSSL (Apache) | yes | painful (one Node per target) + postject + codesign | needs transpile | fallback |
| QuickJS (qjs/txiki) | MIT, ~1 MB | **no WASM** | n/a | no | **blocked** — comptime needs WASM |
| Self-host → QBE | MIT, tiny ELF | n/a | yes | n/a | the endgame, **out of scope** (huge) |

**Recommendation: Deno `compile`.** Closest to Bun's model (runs `.ts`/bundles
directly, one cross-compile flag), kills the LGPL obligation outright. Binary
stays ~80 MB (still V8) — size is secondary to the licensing fix; the only path
to a *small* binary is the self-host rewrite, which this plan deliberately does
not attempt.

## Plan

Staged so the licensing win lands first and cheapest. Each stage is independently
shippable.

### Stage 1 — remove Bun from the shipped artifact (the actual goal)

Smallest change that ends the LGPL obligation. **Touches ~2 files.**

1. **`cli/scripts/build-binary.ts`** — keep the existing `Bun.build` step that
   inlines assets into a single bundle (build-time only; ships nothing), then
   replace the final
   `Bun.spawnSync(['bun','build','--compile','--target=bun-…', bundle, …])`
   with `deno compile`:
   - `deno compile --no-check --allow-read --allow-write --allow-run --allow-env
     --target <triple> --output <outfile> <bundle.js>`
   - target map: `linux-x86_64→x86_64-unknown-linux-gnu`,
     `linux-aarch64→aarch64-unknown-linux-gnu`,
     `macos-x86_64→x86_64-apple-darwin`, `macos-aarch64→aarch64-apple-darwin`.
2. **`compiler/src/index.ts`** — replace `Bun.write(...)` with `node:fs`
   `writeFileSync` so the compiler core has *zero* `Bun.*` and runs unmodified
   under Deno/Node/Bun alike. (One-line, runtime-agnostic.)
3. **Verify** under Deno: `sgl init && sgl build && sgl run` on a project that
   exercises comptime (so the `WebAssembly` path is hit), structs, and a
   `wasm-gc` example. Confirm `node:` APIs and `process.*` resolve.
4. **Update** `cli/THIRD-PARTY-LICENSES.md` + `compiler/NOTICE.md`: swap the Bun
   section for Deno's license set (V8 BSD-3, MIT) — **no LGPL line**. Drop the
   WebKit relink pointer. This is the payoff: the third-party file shrinks and
   the LGPL obligation disappears.

Bun remains a *build* dependency (MIT, not shipped). That is fine and is the
whole point of "as little code as possible" — we change how the binary is
sealed, nothing else.

> **Decision gate:** if even the *build* must be Bun-free (e.g. CI without Bun),
> do Stage 2 first. Otherwise Stage 1 alone satisfies the licensing goal.

### Stage 2 — remove Bun from the build pipeline (optional)

Drop `Bun.build` and `Bun.$`. **Touches 2 scripts.**

1. **Bundling** — replace `Bun.build` with **esbuild** (MIT). Port the two
   `BunPlugin`s (`inline-builtin-assets`, `browser-source-swap`) to esbuild
   `onResolve`/`onLoad` plugins — same alias logic (`*.browser.ts` / `*.native.ts`
   swaps), ~40 lines each. Affects `cli/scripts/build-binary.ts`,
   `playground/web/build.ts`, `playground/web/verify.ts`.
2. **`cli/scripts/package-release.ts`** — replace `Bun.$\`tar …\`` /
   `Bun.$\`sha256sum …\`` with `node:child_process` `execFileSync` (or Deno
   `Deno.Command`).
3. Run the whole release build under Deno/Node end-to-end.

### Stage 3 — remove Bun from tests + dev (optional, largest churn)

This is the expensive one (81 files) and changes **nothing** about what ships, so
it is last and optional.

1. **Test runner.** `bun:test` → a runtime-native runner with a compatible API.
   - **Deno:** `node:test` + `node:assert` runs under `deno test`, or use Deno's
     built-in `Deno.test`. The `import { test, expect } from 'bun:test'` line is
     the only per-file change; a codemod rewrites all 81 files mechanically
     (`test`/`describe`/`beforeEach`/`afterEach` map 1:1; `expect` needs a small
     shim or a switch to `assert`). Budget this as a single codemod + manual
     fixups for `expect` matchers.
   - Update `bunfig.toml` (`[test] timeout`) → runner config; update the `test`
     scripts in `compiler/`, `cli/`, `lsp/` package.json.
2. **Playground dev server** (`playground/playground/server.ts`) — `Bun.serve` /
   `Bun.file` → `Deno.serve` (or `node:http`). Dev-only; the deployed playground
   is already static.
3. **Shebangs** (`#!/usr/bin/env bun` in 4 files) and `bin` fields
   (`sgl`, `silicon-lsp` → `./src/*.ts`) → `deno`/`node`, or ship transpiled JS
   for the npm-installed path.
4. **`import.meta.dir`** (15 script/test files) → `dirname(fileURLToPath(import.meta.url))`
   (already the dominant pattern in the repo).
5. Remove `@types/bun`, `bun.lock(b)`, `bunfig.toml`.

## What we are explicitly NOT doing

- **Not** rewriting the compiler in Silicon (self-host → QBE). That is the only
  route to a *small* binary and the real long-term Bun replacement, but it is a
  separate, large effort tracked under the archived bootstrap plans and the
  *todo-slim-binary* memory note. This plan is the cheap licensing fix, not that.
- **Not** changing the compiler's runtime code beyond the one `Bun.write` line.

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Deno `node:` compat gap hits a shipped code path | low | Stage 1 step 3 verifies the full `init/build/run` + comptime + wasm-gc path before release |
| Deno permission flags too narrow at runtime (file/exec) | medium | bake `--allow-read/write/run/env` into `deno compile`; tighten later |
| `deno compile` cross-target for macos from linux CI | medium | Deno supports it; if codesigning bites, build macos on macos CI |
| Binary not meaningfully smaller (~80 MB) | certain | accepted — size is a Stage-self-host concern; this plan targets licensing |
| Stage-3 `expect` matcher differences | medium | shim `expect` or codemod to `assert`; isolated, non-shipping |

## Definition of done (Stage 1)

- `sgl` binaries built with `deno compile`, no Bun in the artifact.
- `THIRD-PARTY-LICENSES.md` carries no LGPL/WebKit obligation.
- `init → build → run`, comptime, and a `wasm-gc` example pass on all 4 targets.
- Release tarballs re-published; install script unchanged.
