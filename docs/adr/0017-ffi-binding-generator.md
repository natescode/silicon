# ADR 0017 — FFI binding generator: machine-generate Web / Node / Bun `@extern` bindings from upstream specs

- **Status:** Accepted — first milestone implemented (2026-06-09). The Web `Math`/clock surface is generated from `compiler/bindgen/` and spliced into all three sites between markers; `bun bindgen/cli.ts --check` + `bindgen.test.ts` enforce lockstep. **The `webidl2` adapter landed (2026-06-09):** `Performance.now()` is now generated from genuine Web IDL spec text (`adapters/webidl.ts` — typedef resolution + the `double`→`Float` / `unsigned long`→`Int` type map), while `Math.*`/`Date.now()` are correctly sourced from the hand-authored ECMAScript table (they have no Web IDL definition) — the multi-source "one IR, an adapter per source" design, byte-identical output. Remaining: the `@webref/idl` bulk-IDL bundle (+ per-spec pinning), Tier-1 strings, and the Node/Bun `.d.ts` adapters — additive on this proven pipeline.
- **Date:** 2026-06-05
- **Deciders:** NatesCode
- **Related:** ADR 0016 (`@loop`/iterables — established the FFI ceiling reasoning and the closures/coroutine deferral) · ADR 0011 (rcaps) · ADR 0012 (effect lattice) · **ADR 0018 (async/Promise FFI — the work that lifts this generator's coverage ceiling from ~10% toward 100%)** · the JS/Browser/Bun API-coverage audit (this repo currently binds ~54 host functions across `web::`/`JSString::`/`console::`) · [[silicon-js-string-builtins]] memory · prior art: `wasm-bindgen` (Rust), Emscripten Embind, `TypeScript-DOM-lib-generator`, Deno/Node type packages.

## Context

Silicon's JS host surface is **hand-written and hand-maintained in three places that must agree**:

1. the `.si` `@extern` declaration (`compiler/src/strata/modules/web.si`, `JSString.si`, `console.si`; web features under `compiler/src/platforms/web/*.si`);
2. the **Bun** host shim (`cli/src/host/js-host.ts` → `buildImports`, the `{env, 'js-bridge', console, web}` import object);
3. the **browser** host shim (`playground/playground/web-env.js` → `createWebEnv`).

A binding that exists in one but not the others is dead: the wasm import is keyed by `(env, field)` where `env = IMPORT_ENV_OVERRIDE[module] ?? module` (`compiler/src/ir/lower.ts:35-36`) and `field` = the bare extern name, so the *identical* `{env:{field:fn}}` shape must appear in both hosts. Today this lockstep is maintained by hand and drifts silently — `compiler/src/modules/loader.ts:77` even **swallows a malformed `@extern`** (`catch { /* skip */ }`), so a broken binding passes `sgl check` unnoticed unless a caller references it.

Two forces make a generator attractive:

- **Anti-drift / correctness.** One source of truth emitting all three artifacts, with a CI check that the shims stay in lockstep, removes a whole class of silent bugs.
- **Upstream tracking.** Web/Node/Bun APIs have machine-readable definitions; we should be able to regenerate against a newer upstream on demand rather than transcribe by hand.

But the **FFI ceiling bounds what is even expressible** (verified in the coverage audit and `compiler/src/ir/lower.ts:1424-1433`, `modules/loader.ts:40-44`): only `i32`/`i64`/`f32` scalars, an `i32` linear-`String` pointer, `JSString` (externref), and `CharCodeArray` (a GC `array (mut i16)`) cross the boundary. **There is no JS-object handle type, no `Promise`, and no callback/funcref-at-boundary.** Most of every platform API is object-, Promise-, or callback-shaped, so it is *structurally* unbindable until ADR 0018 lands. This ADR therefore scopes a generator that is honest about that ceiling: it emits what is provably bindable today and **records — never silently drops** — what is not.

## Decision

Build a generator, `compiler/bindgen/`, as a **hybrid** of the three architectures weighed below:

- **Spine — one Binding IR + per-source adapters + a `bindgen.lock` + a CI `check-shims` test.** This is the only design with a testable lockstep guarantee and per-binding provenance.
- **Default scope — the scalar+string tier only.** It is correct-by-construction (every emitted type is a verified-valid boundary type) and the only tier that runs on *every* target.
- **Deferred — the object handle-table tier**, behind an explicit `--objects=handles` flag, not default: it injects un-GC'd stateful runtime into both shims (a leak footgun), so its cost stays visible. The general object/callback/async unblocking is ADR 0018's job, not a flag here.

### Sources (verified 2026-06-05)

| Platform | Primary source | IDL? | Key property |
|----------|----------------|------|--------------|
| **Web** | `@webref/idl` (MIT, weekly) parsed with `webidl2` | ✅ Web IDL | **Only** source that preserves integer-vs-float (`unsigned long` vs `double`), nullable, true overloads, statics, `Promise`/callback flags. TS `.d.ts` collapses every number to `number` — fatal for picking an `Int` vs `Float` representation. |
| **Node** | `@types/node` `.d.ts` via the TypeScript compiler API; `nodejs.org/api/all.json` as a secondary for int-hints/docs | ❌ no IDL | TS `number` is opaque → int/float is a reviewed **heuristic** (logged low-confidence). |
| **Bun** | `bun-types` `.d.ts` via the TS compiler API (compiled *without* `lib.dom` so web fallbacks resolve) | ❌ no IDL | Bun re-implements Web+Node — **dedupe** to `Bun.*`/`bun:*` natives only. |

`typescript@^5`, `@types/node`, and `@types/bun` are already dependencies (`compiler/package.json:34,40`), so the TS adapters add no new heavy tooling.

### Bindability tiers (emit vs skip — with the structural reason)

| Tier | Rule | Emit | Why |
|------|------|------|-----|
| **0** | every param + result ∈ {`Int`, `Int64`, `Bool`, `Float`, `String`} | default, **all platforms** (native too with `--strings=linear`) | every type is a proven-valid boundary type (`loader.ts:40-44`) |
| **1** | a string mapped to `JSString` (externref) | gated `web`\|`bun` | crosses via `wasm:js-string` builtins; rejected on native (`lower.ts:1426-1433`) |
| **2** | object/interface param → `i32` handle + host handle-table + generated `_release` | **opt-in** `--objects=handles` | no JS-object boundary type exists; leaks without manual release |
| **skip** | `Promise` return · callback param · struct/Vec by value · variadic | never — logged to `<Module>.skipped.json` | structurally uncrossable until ADR 0018 |

Type map highlights: WebIDL `unsigned long`→`Int`, `long long`/`bigint`→`Int64`, `double`/`float`→**`Float` (f32 — lossy for `double`; flag money/time APIs)**, `DOMString`→`String` (linear, default) or `JSString` (`--strings=jsstring`), `void`→drop the `-> Ret` (`loader.ts:71`). `@extern` has no overloading, so overloads flatten to **arity-suffixed siblings**.

### Architecture

```
compiler/bindgen/
  src/  ir.ts                       # BindingIR { module, decls:[{name,params,result,tier,reason,jsdoc,source}] }
        adapters/{webref,node,bun}.ts
        tier.ts  typemap.ts  emitSi.ts  emitShim.ts  report.ts  cli.ts
  bindgen.lock                      # pinned @webref/idl, webidl2, @types/node, bun-types
  generated/{web,node,bun}/         # *.si + *.skipped.json — never hand-edited
  shims/{bun.fragment.ts, web.fragment.js}   # spliced into the two host files at marker comments
  test/{golden/, checkShims.test.ts}
```

Pipeline: **pin → adapt-to-IR → normalize/dedup overloads → tier-classify → type-map → emit `.si` + both shim fragments → validate.** A built-in module is copied to `compiler/src/strata/modules/<M>.si` (auto-bundled by `gen-web-assets.ts:49`); a web *feature* goes to `compiler/src/platforms/web/` + a `platform.json` entry.

**Dual-shim lockstep.** `emitShim(target)` produces the Bun and browser fragments from one IR pass — the only axes that vary are output syntax and what each runtime supplies natively (Bun gets `wasm:js-string` for free at `WebAssembly.compile(binary, {builtins:['js-string']})`, `js-host.ts:88`). Both decode/encode linear strings with the existing `readLenString`/`allocLenString` helpers (`js-host.ts:24,31`; `web-env.js:36,127`). Fragments splice into marker-delimited regions so regeneration is idempotent. `checkShims.test.ts` fails CI if the `(env, field, arity)` key set diverges between the two shims (modulo Bun's native js-string set).

**Validation** (each generated module): `bun run cli/src/sigil_cli.ts check` on the `.si` *and a generated round-trip caller* (because `loader.ts:77` silently skips a malformed `@extern` otherwise); a `--platform=bun` build to fire the JSString/platform gate; `bun run compiler/scripts/gen-web-assets.ts` for built-ins/features; then a golden-file diff of `.si` + both fragments + `.skipped.json`.

### Manually-triggered GitHub Action

A new `.github/workflows/bindgen.yml` modeled on the existing `workflow_dispatch` precedent (`acceptance.yml`, `docs.yml`):

```yaml
on:
  workflow_dispatch:
    inputs:
      platform: { type: choice, options: [web, node, bun, all], default: all }
      strings:  { type: choice, options: [linear, jsstring],    default: linear }
      objects:  { type: choice, options: [off, handles],        default: off }
permissions: { contents: write, pull-requests: write }
```

Steps: `setup-bun` + `bun install --frozen-lockfile` → run the generator with the inputs → validate (`sgl check` + `--platform=bun` build + `gen-web-assets`) → compute a **coverage-diff** (per-platform Tier-0/1/2/skipped counts vs the committed `.skipped.json`) → open a PR via `gh pr create` with that table as the body. Tag-independent; never touches the tag-triggered `release.yml`.

## Options considered

- **A — Unified TS `.d.ts` for all three** (one pipeline via the TS compiler API). Simplest, but `.d.ts` destroys the integer-vs-float distinction even for Web, where a faithful source exists. **Rejected as the Web source of truth** (kept for Node/Bun, which have no IDL).
- **B — Per-source best-of-breed into a common IR** (webref IDL for Web; `all.json`/`.d.ts` for Node; `bun-types` for Bun). The chosen spine: one IR, three adapters, lockfile, `check-shims`. **Adopted.**
- **C — Minimal Tier-0-only generator.** Smallest and correct-by-construction, but caps coverage at ~5–12%. **Adopted as the default scope inside B**, with Tiers 1–2 layered on.
- "Handle table on by default" (the most aggressive proposal) is **rejected**: it bakes in leaky stateful runtime and an inflated ~40% headline that includes async APIs the boundary cannot express.

## Consequences

- **Positive:** one source of truth for the `.si` + both shims; CI-enforced lockstep; auditable coverage (`.skipped.json`); on-demand regeneration against pinned upstream; no new heavy deps.
- **Honest coverage ceiling (the headline):** clean, correct, *default* output binds **~10% of each surface today** (Web ~3–6%, Node ~8–15%, Bun ~10–20%) — concentrated in compute/text/encoding/time/console. `--objects=handles` reaches ~45–60% but those bindings are leak-prone handle-threading. **~40–55% is structurally blocked regardless of tooling** — async (`Promise`), callbacks/events, structs-by-value — and is unreachable until **ADR 0018** adds async + object-handle + funcref-at-boundary support. The ceiling is the language's FFI, not the generator.
- **Risks:** `Float` is f32, so every `double` narrows (fine for graphics, lossy for money/time — needs an `f64` boundary type); Node/Bun int-vs-float is a reviewed heuristic; upstream packages churn weekly (mitigated by `bindgen.lock` + golden diffs + the PR coverage-diff); the `loader.ts:77` silent-skip trap (mitigated by the generated round-trip caller).

## First milestone (smallest end-to-end slice)

**Regenerate today's hand-written `web.si` Math + clock surface from `@webref/idl`, byte-for-byte, with both shims and full validation.** All Tier-0, already known-good, exercises every stage (acquire → adapt → tier → typemap → emit-`.si` → dual-shim → `sgl check` → `gen-web-assets` → PR) at zero risk. Success = the generated `WebMath.si` reproduces the existing `math_*`/`performance_now`/`date_now` decls (`web.si:9-26`) and both host shims exactly, with `checkShims.test.ts` green. Every later step (Tier-1 strings, the Node/Bun adapters, the opt-in handle tier) is then additive on a proven pipeline.

## Implementation pointer

First milestone landed. As built:
- `compiler/bindgen/src/spec.ts` — the hand-authored Tier-0 `BindingSpec[]` (Web Math/clock). A future `@webref/idl` adapter produces this same shape.
- `compiler/bindgen/src/generate.ts` — `BindingSpec[] → Binding IR → { si, bunShim, webShim }`, with tier classification + the `siToWasm` boundary map.
- `compiler/bindgen/cli.ts` — `--check` (CI) / `--write` (regen); splices each fragment between `// === bindgen:web math+clock === … // === /bindgen:web math+clock ===` markers in the three sites.
- `compiler/bindgen/bindgen.lock.json` — pinned content hash + provenance (the silent-skip + drift tripwire).
- `compiler/bindgen/bindgen.test.ts` — byte-for-byte golden, cross-site (module, field, arity) key parity, lock-hash, and a round-trip compile of `web::math_sqrt` (defeats the `loader.ts` silent-skip).
- Marker regions inserted into `compiler/src/strata/modules/web.si`, `cli/src/host/js-host.ts`, `playground/playground/web-env.js`. Generating collapsed the prior drift (js-host ordered `math_random` last; web.si had a stray CRLF) into one canonical order/format.
- `.github/workflows/bindgen.yml` — `workflow_dispatch` (regen-PR) + push/PR `check-shims`.
