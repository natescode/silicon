---
title: "Positioning"
---
# Positioning — what Silicon is for, and where it wins

This is the outward-facing companion to [ADR 0023](https://github.com/NatesCode/silicon/blob/main/docs/adr/0023-language-identity-and-non-goals.md)
(the inward-facing *identity & non-goals*). ADR 0023 says what Silicon **is**; this
page says **who it's for** and **where it's competitive** — honestly, including
where it isn't.

## Elevator pitch

> **Silicon is a systems language built for WebAssembly.** It gives you Zig-level
> control and ML-level ergonomics — sum types, pattern matching, type inference —
> with a *gradual, multi-mode memory model* that's no-GC when you need raw speed and
> garbage-collected (wasm-gc) when you don't. First-class JavaScript/host interop
> means it fits where WASM actually runs: the browser, the edge, and plugin
> sandboxes. And because its operators and keywords are defined *in Silicon itself*,
> you extend the language from within.

**Taglines:**
- *The language designed for WebAssembly — systems control, ML ergonomics, GC optional.*
- *Zig's control, ML's types, built for the web.*
- *Memory-safe systems programming for WASM — pay for safety, and for GC, only when you want to.*

## The competitive sweet spot

**WebAssembly-targeted code where you want systems-level control *and* ergonomic
host interop *and* the freedom to choose GC or no-GC.** That combination is the
open quadrant — today you get to pick *one*, not all three:

- Control + safety on wasm → **Rust** (heavy: borrow checker, traits, toolchain, compile times).
- Ergonomics on wasm → **AssemblyScript / TinyGo / Go** (GC-only, larger binaries, weaker control, rough host interop).
- A small/simple systems language → **Zig** (native-first, no-GC-only, no sum types/inference, DIY JS interop).

Silicon's bet is the middle: **Zig-class control + ML-class data modeling + a memory
model that's no-GC when you need speed and wasm-gc when you don't + first-class
JS/host FFI.**

## Where Silicon competes

| Niche | Incumbents | Why Silicon competes |
|---|---|---|
| **Web / browser WASM** | Rust + wasm-bindgen, AssemblyScript, Emscripten, MoonBit, Grain | WASM-*first* (not a port target); 100% web/bun FFI is a hard v1.0 gate; real JS strings via externref / JS String Builtins (no marshalling); GC-optional fits the wasm-gc era |
| **Edge / serverless** (Fastly, Cloudflare, Spin, wasmCloud) | Rust, JS, TinyGo | small no-GC binaries → fast cold start; ergonomic host interop; managed mode where convenient |
| **Plugins / sandboxed extensions** (Extism, Envoy, app plugin systems) | Rust (ceremony), TinyGo (size/GC), AssemblyScript (limited) | small + safe + comptime bindgen + capability / object-capability model aligns with sandboxing |
| **Embeddable / DSL host** | Lua, embedded interpreters | strata = operators/keywords as data → extend the language from within; compiles to wasm |
| **"Rust-curious, Rust-is-too-much" developers** | Zig, Go, Rust | gradual safety (arena-safe first, borrow checker opt-in), simpler model, ML ergonomics — memory safety without the full borrow-checker tax |

The nearest *direct* rivals are the other WASM-first newcomers — **MoonBit** and
**Grain** — and Silicon differentiates by being **systems-capable (no-GC mode,
arenas, comptime), not functional**.

## Where Silicon does *not* compete (yet)

Being clear-eyed protects the pitch:

- **Native-only systems / OS / embedded** — Zig/Rust/C own it; Silicon's WASM-first
  focus and still-maturing borrow checker don't beat them on native turf.
- **Large application backends / rich-ecosystem work** — Go/TS/Java/Rust have the
  libraries and maturity; Silicon is pre-1.0 with a small stdlib and no package
  ecosystem yet.
- **Pure functional / correctness-critical** — OCaml/Haskell/Roc; Silicon is not
  functional by design (ADR 0023).
- **Anything needing stability *today*** — it's pre-1.0, still has breaking changes,
  and the ecosystem is small.

## How it differs from its neighbours

See the full table in [ADR 0023](https://github.com/NatesCode/silicon/blob/main/docs/adr/0023-language-identity-and-non-goals.md#how-silicon-differs-from-its-neighbours).
In one line each:

- **vs C** — memory-safe, with sum types / inference / comptime; WASM-first.
- **vs Zig** *(closest)* — adds sum types + pattern matching + inference, a GC-optional multi-mode memory model, and syntax-level metaprogramming (strata).
- **vs Rust** — gradual/additive safety (not borrow-checked by default), no traits, GC-optional, smaller surface.
- **vs OCaml** — systems-first (manual/gradual memory, no GC), HM-*lite*, not functional.
- **vs Roc** — systems vs. functional: Roc is pure-ish + auto-managed + abilities; Silicon is imperative + gradual memory + comptime, no typeclasses.

## What has to be true for the pitch to hold

The positioning is credible only if the roadmap lands:

1. The **v1.0 100%-web/bun-FFI gate** — bindgen → async/Promise → closures
   (ADR 0017–0019).
2. A **package / ecosystem** story.
3. The **borrow checker** maturing (ADR 0011) so "gradual safety" is real, not
   aspirational.
4. The **wasm-gc world materializing** — already happening (JSC/Bun, V8 ship it).

**Strategic focus:** bet on niches 1–3 (web / edge / plugins), where the WASM-first
+ host-interop + GC-flexibility combination is genuinely unique. Don't fight
Zig/Rust on native ground.
