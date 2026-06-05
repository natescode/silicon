# ADR 0015 — Object capabilities: authority as unforgeable values, checked at comptime, no effect rows

- **Status:** Proposed (design exploration; no implementation timeline)
- **Date:** 2026-06-05
- **Deciders:** NatesCode
- **Related:** ADR 0011 (borrow checker: scopes + rcaps + actor isolation) · ADR 0012 (capability-driven optimization — the effect lattice; §5 "I/O performed only through a capability object passed in"; this ADR supplies the ocap half of `pure ≙ (no mutation rcap) ∧ (no effect ocap)`) · ADR 0013 (capability checker: `on::check` query, `capabilityOf`/`effectClassOf`, module-granular) · ADR 0001 (generics: ship bodies, monomorphize per consumer) · ADR 0003 (comptime engine) · `docs/silicon_standard_library_v_1.md` §8 (the aspirational `@requires FileSystem` sketch) · `docs/targets.md` (WASI) · [[silicon-mutability-capability-model]] · [[silicon-generics-strategy]] memories · prior art: **E** (Mark Miller — origin of object capabilities), **Pony** (rcaps + ocaps, `Env`/`AmbientAuth`), **Austral** (linear capabilities, no effect system — closest analogue), **Newspeak** (capability-secure, no globals), **WASI** (the host passes preopened capabilities — the execution model Silicon already lowers to), Deno permissions, Lua sandboxing. Deliberately *not* chosen: Koka/Frank/Eff (algebraic effects + handlers, effect rows), Haskell (monad transformers + HKT), Roc (purity via refcount uniqueness).

## Context

Silicon's capability story has two of three pillars specified and one undrafted:

- **rcaps (ADR 0011)** — *reference* capabilities (`&`, `&mut`, `&uniq`, `&val`) over scopes (`local`/`arena`/`Rc`). They govern **aliasing and mutation** — who may write, share, or send a value. Inferred in bodies, explicit at API seams.
- **effect lattice (ADR 0012)** — a **flat** classification `pure ⊑ mut ⊑ effectful`, read off each signature and serialized into `MetadataReference`. Explicitly "a set of effect tags, **not** polymorphic effect rows," to stay within HM-lite's budget.
- **ocaps — the undrafted third pillar.** rcaps say nothing about **authority**: whether code is *allowed to perform an effect at all* — I/O, the clock, randomness, the network, an `@extern` host call. ADR 0012 names this gap exactly: its purity rule is `pure ≙ (no mutation rcap) ∧ (no effect ocap)`, and §5 already sketches the answer — *"an effect like I/O is performed only through a capability object passed in. A function not passed the I/O capability cannot perform I/O."* This ADR drafts that pillar.

Three constraints from the rest of the design bound the solution space:

1. **HM-lite budget (ADR 0011/0012).** No let-generalisation, no rank-N, no rows. Authority must not require row variables or higher-kinded abstraction.
2. **Monomorphization is the power tool (generics strategy; ADR 0001/0013).** Generics ship as bodies and instantiate per consumer; expressiveness comes from comptime, not the type lattice. No HKT; traits deferred.
3. **The target is already capability-structured.** Silicon lowers to WASM/WASI, and WASI *is* an object-capability model: there is no ambient filesystem; a module receives **preopened** descriptors from the host. The language story should align with — not fight — the execution model it compiles to.

## Decision

**Object capabilities are ordinary, unforgeable Silicon values that confer authority to perform an effect. They are obtained only from a capability you already hold (rooted at the program entry point), governed by the existing rcap modes, and threaded explicitly. A function's *required* authority is a flat capability set — inferred in bodies, summarized on its signature at module seams (ADR 0012's certificate), and verified by the comptime `on::check` pass (ADR 0013). There is no ambient authority, no effect-row type, and no new type-system machinery: monomorphization makes the higher-order/generic cases concrete, so authority is never abstracted polymorphically.**

Eight design points:

1. **Capabilities are values — not types, not annotations-over-nothing.** A `Console`, `Clock`, `Net`, `FileSystem` is a value of a normal Silicon type. Authority is *held*, *passed*, *stored*, and *attenuated* like any value. (An effect *row* or a bare `@requires` annotation can be neither attenuated nor stored.)

2. **Unforgeable + rooted.** A capability cannot be conjured from nothing — only derived from one already held. The **root** authority enters at the entry point: `main` receives the host's capability set (Pony's `Env`; WASI's preopens). A library function not handed a capability holds *no* ambient authority. This is the principle of least authority (POLA), made static.

3. **Attenuation is ordinary code.** Narrow authority by constructing a weaker capability from a stronger one (`&fs_readonly fs`, `&net_for_host net, 'example.com'`). No language feature — just functions that take a capability and return a narrower one.

4. **Governed by rcaps, not a second aliasing discipline (ADR 0011 free-rider).** A capability is a value with an rcap. A non-shareable resource handle is `&uniq` (move-only); a shareable authority is `&val`/`&`. Sending a capability to an actor obeys the *same* send rule as any `&uniq`/`&val`. ocaps add *what authority exists*; rcaps already govern *how it may be aliased and sent*.

5. **Required authority is a flat *set*, computed bottom-up, summarized at seams.** A function's required-capability set is the union of its callees' sets (plus any `@extern` ⇒ the corresponding effect tag). Within a module the union is a fixpoint over the call graph (ADR 0013); across a module it is a signature read (the `MetadataReference` certificate, ADR 0012). Set-union is decidable and cheap — this is "flat, not rows" realised for authority.

6. **No ambient authority — the checker's core invariant.** The `on::check` pass (ADR 0013) rejects any operation requiring capability `C` unless `C` is reachable at that point (threaded in as a parameter, or held in a binding derived from one that is). `capabilityOf(fn)` / `effectClassOf(fn)` are the pure queries; a violation is a `diag_error`. The optimizer's purity rule then closes: **`pure ≙ (no mutation rcap) ∧ (no effect ocap)`** — a function reachable-from no effect capability is `pure` w.r.t. that effect (ADR 0012 §5).

7. **Erased vs. runtime representation is per-capability.** Pure *authority* (the right to do X, carrying no data) lowers to a **zero-sized comptime witness** — present for the checker, erased at runtime (a proof token). A *resource* (an `fd`, a socket) is a **real value** called through. Both wear the same surface; the optimizer already needs this distinction ("a function not passed the I/O capability is `pure`").

8. **Monomorphization retires effect-row polymorphism — the same fact that retires HKT.** The only case that would force a row is a higher-order/generic function that "requires whatever its callback requires." Because the effect class lives *on the function's signature type*, and generics ship as bodies and monomorphize per consumer (ADR 0001/0013), each instantiation sees a *concrete* callback with a *concrete* required-set; the function's set is a concrete union, never an abstract `ρ`. A row would be forced only at a **sealed** generic boundary — and the compilation model seals none. Effect-monomorphization rides type-monomorphization at zero extra code. HKT, effect-rows, and typeclass dictionaries are one family — "name the unknown so one body serves many shapes"; monomorphization removes the unknown at every use, retiring the whole family at a stroke.

## Options considered

### Option A — Capabilities as values + comptime check (chosen)
Above. **Pros:** no type-system extension (stays in HM-lite); free-rider on rcaps (0011) and the optimizer certificate (0012); rides the `on::check` substrate (0013); aligns with WASI; yields capability-safety/POLA as a security property; monomorphization dissolves the polymorphic case. **Cons:** explicit threading is verbose without sugar; dynamic dispatch over stored closures forces a conservative `effectful` default; no sealed-binary precise-effect-polymorphic generics. **Cost:** rides ADR 0013's P0–P4 — incremental.

### Option B — Effect rows (Koka, PureScript, OCaml objects)
Effects as a row `<io, st | ρ>` unified structurally. **Pros:** precise inferred effect polymorphism, including over dynamic dispatch. **Cons:** the single largest inference-budget jump (row unification + lacks constraints), structural where Silicon is nominal+monomorphized, already rejected in ADR 0012 on the "HM-lite budget." **Rejected.**

### Option C — Algebraic effects + handlers (Koka, OCaml 5, Eff, Frank)
Effects as operations with user-defined handlers (resumption / delimited control). **Pros:** effect *injection* (mock I/O, custom schedulers) — the most powerful option. **Cons:** a heavy *runtime* (continuation capture / CPS / stack copying) that fights "low runtime overhead," and it answers a different question — *handling*, not *authority*. **Deferred and orthogonal:** if Silicon ever wants pluggable effect interpreters, handlers sit as a runtime feature *below* the capability story, not in place of it.

### Option D — Monad transformers / tagless-final (Haskell, Scala)
Effects threaded through `Monad`/typeclass dictionaries. Requires HKT + typeclasses — both deliberately off the table (generics strategy). **Rejected.**

### Option E — Annotation-only `@requires C` with no underlying value
The aspirational stdlib sketch (`silicon_standard_library_v_1.md` §8): a function *declares* the capability it needs; the checker verifies the call graph. **Pros:** lightest surface, no threading. **Cons:** the capability is then *ambient-but-checked* — you cannot **attenuate** (hand out a narrower cap), **store** one, or **pass a different implementation** (no mockability, no sandbox). **Subsumed:** keep `@requires C` as *sugar* for "this function takes a `C` witness," desugaring to Option A so the annotation is reconciled against real flow — terse surface *and* first-class capabilities.

### Option F — Ambient authority + dynamic permission check (Deno-runtime style, thread-locals, exceptions)
Authority is global; a runtime check (or host policy) gates effects. **Pros:** zero ceremony. **Cons:** no *static* guarantee — the safety/security property evaporates; a library reaches any authority the process holds. **Rejected** as the primary mechanism (it is what ocaps exist to replace), though the WASI host still enforces a runtime backstop beneath the static story.

## Consequences

- **Positive:**
  - **One discipline, three payoffs.** Authority (security/POLA), the ocap half of the optimizer's purity certificate (ADR 0012), and effect *tracking* all come from the same "capabilities are rcap-governed values, required as a flat set" mechanism — no separate effect type system.
  - **No HM-lite extension.** Stays within the budget 0011/0012 fixed; no rows, no HKT, no typeclasses.
  - **Aligns with the target.** WASI already passes capabilities; Silicon threads + checks them and lowers naturally.
  - **Testability/sandboxing for free.** Because capabilities are values, a test passes a mock `Console`/`Clock`; a sandbox passes an attenuated `FileSystem`. (The practical win Options E/F can't give.)
- **Negative / explicit non-goals:**
  - **Threading verbosity.** Passing capabilities by hand is noisy; needs sugar (a capability *context*, or implicit-but-*checked* threading — kept checked so it never becomes ambient).
  - **Dynamic dispatch over stored closures.** Where the concrete callback isn't visible (heterogeneous `any`/vtable dispatch), the required-set is the **conservative `effectful`** default (ADR 0012). The precision lost there is exactly what Silicon already forgoes by choosing "no first-class dynamic dispatch" — not a new gap.
  - **No sealed-binary precise-effect-polymorphic generics.** The model distributes generic source/IR (Zig/Rust-flavored); a closed-binary library wanting opaque generics *and* precise effect-polymorphic signatures is the one ecosystem traded away. Deliberate.
  - **No effect *handlers*.** This ADR tracks and grants authority; it does not let user code *intercept/reinterpret* an effect. That is Option C, deferred.
- **Follow-up work:**
  - The root-capability bootstrap: what `main` receives, and the WASI preopen → capability mapping.
  - The erased-witness vs. runtime-handle lowering, and its hook into ADR 0012's in-placing.
  - `@requires C` sugar desugaring to a witness parameter; a checked capability-context to cut threading noise.
  - `@extern` ⇒ which effect tag(s); how host imports acquire their authority.
  - The actor-send rule for capabilities (ADR 0011 isolation): which caps are `&uniq`-sendable vs `&val`-shareable vs non-sendable.
  - Whether algebraic-effect handlers (Option C) are ever added beneath this.

## Illustrative surface (not normative)

```silicon
# Root authority enters at the entry point; nothing else is ambient.
\\ main (Env) -> Int
@fn main env := {
    @local con := &env_console env;          # obtain a Console capability
    &greet con, 'Silicon';                   # pass it explicitly
    0
};

# A function that performs I/O must be handed the capability — its required
# set is { Console }, summarized on its signature; it is NOT pure.
\\ greet (Console, String) -> Int
@fn greet con, name := {
    &console_print con, ('Hello, ' ++ name ++ '!')
};

# Attenuation is just a function; `audit` can log but not read user input.
\\ run_plugin (Console) -> Int
@fn run_plugin con := {
    @local audit := &console_write_only con;  # narrower capability
    &plugin_main audit
};

# pure_sum holds no effect capability → checker certifies it `pure`.
\\ pure_sum (Int) -> Int
@fn pure_sum n := { @local s := 0; @local i := 1; &@loop i <= n, { s = s + i; i = i + 1; }; s };
```

`@requires Console` (Option E sugar) would desugar to the `con` parameter above; the surface stays terse while the capability remains a real, attenuable value.

## Implementation pointer

Rides ADR 0013's P0–P4 plan unchanged — the ocap analysis *is* the cap/effect analysis behind `on::check`. **Minimal first slice** (proves the mechanism end-to-end): one capability — `Console` (or `IO`) — entering at `main`; an `on::check` pass computing the required-set per function (union over callees; `@extern`/cap-holding ⇒ `effectful`); rejection of I/O whose capability isn't reachable; certification of the rest as `pure`. That is literally `pure ≙ (no mutation rcap) ∧ (no effect ocap)` made real, and the dogfood seed for `src/strata/capabilities.si` (ADR 0013 P4b). No code lands until this ADR is Accepted.
