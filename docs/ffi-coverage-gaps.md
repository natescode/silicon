# FFI coverage gaps — the last ~7% (mostly closed)

> **Status:** categories 2–4 **IMPLEMENTED**; webiface `events:'closure'`
> **IMPLEMENTED** (the last fundamental skip with a real fix); categories 1 + 5
> documented as the permanent tail. Aggregate bind rate **90.1% → 96.8%** across
> the shipped platform modules (338→368 bindings, 37→12 skips).
> **Scope:** the host-API surface the bindgen adapters could not bind.
> **Companion docs:** [`js-string-builtins.md`](js-string-builtins.md) (tier model),
> the FFI sections of [`overview.md`](overview.md), and the bindgen source under
> `compiler/bindgen/`.

After flipping `events:'closure'` on `fs` / `crypto` / `global` (callbacks cross
as closure handles), aggregate bind rate sat at **90.1%** (338 bindings, 37
skips). This doc accounted for the remaining ~7% — what each skipped binding is,
*why* the adapter dropped it, and whether recovering it was worth doing — and the
worthwhile recoveries are now **shipped**. Bind rate is **96.8%** (368 bindings,
12 skips): the categories-2–4 classifier work lifted it to 96.5%, then porting
`events:'closure'` to the **Web-IDL** adapter recovered `AbortSignal.onabort` and
shipped a new `event_target` module (see the dedicated section below). The 12
that remain are 8 deliberate portability tradeoffs (keeping `path`/`os` portable
Tier-0) and 4 genuinely fundamental skips.

The headline finding held: **four of the five gap categories converged on a
single seam** — `tsTypeToSi` in `compiler/bindgen/src/adapters/dts.ts` (and its
strictly-narrower Web-IDL twin `classify` in
`compiler/bindgen/src/adapters/webiface.ts`). The guest side was already done:
the `js` module (`compiler/src/strata/modules/js.si` + the host `js:` object)
builds and reads every object/array/dictionary handle these bindings need. The
fix was almost entirely in the **type classifier**, not in codegen or the
runtime — the host shim and `Impl` shapes were untouched. The fifth category
(overload alternatives) is a genuine language fact and was left out of scope.

---

## Summary

| # | Category | Verdict | Status | Recovered | Seam |
|---|----------|---------|--------|-----------|------|
| 1 | Variadic rest params | glue | **not done** (no usable win) | 0 — `Bun.$`'s name is the bare `$` (invalid Silicon id); `path.join/resolve` would force `path` web/bun-only | — |
| 2 | Unrepresentable results | adapter-tweak | **done** | union-with-Promise (`Bun.readableStreamTo*`, `peek`), `bigint` results (`Bun.hash`), `fs.openAsBlob` | `dts.ts` `tsTypeToSi` |
| 3 | Object/buffer params not classified | adapter-tweak | **done** | generic constraints (`crypto.randomFill*`/`generateKeyPair*`/`getRandomValues`, `fs.writev`/`readv`), `bigint` unions (`crypto.checkPrime*`), `unknown` (`Bun.deepMatch`), `structuredClone` | `dts.ts` `tsTypeToSi` |
| 4 | webiface seq/`any`/dict | adapter-tweak | **done** | `FormData`/`URLSearchParams.getAll`, `Headers.getSetCookie`, `TextEncoder.encodeInto`, `AbortSignal.any`/`reason` | `webiface.ts` `classify`/`classifyName` |
| 5 | Overload alternatives | **fundamental** | **out of scope** | 0 new coverage (capability on already-bound names only) | `dts.ts` overload loop |

**Net result:** the categories-2–4 adapter tweaks recovered **24 directly-skipped
bindings** (37 skips → 13) with **no host-shim or runtime change** — all the work
was in two type classifiers plus one config flag (`fs` `async:'suspending'`).
`path`/`os` were deliberately **kept portable** (Tier-0, every host), so their 8
object/variadic skips stay — recovering them would make those modules web/bun-only.

The recovered bindings are **handle bindings**, not typed ones: the guest
receives an opaque, engine-GC'd `JSValue` (a Tier-2 externref) and drives it
with the `js` module — exactly as it already does for `json::parse` output and
the `fetch` ecosystem. That is the consistent contract for "the host owns this
shape," and is why no host-side marshalling was needed.

### What shipped (the classifier changes)

- **`dts.ts` `tsTypeToSi`** — threaded the TS `checker` through; added a
  `TypeParameter` branch (resolve the base constraint and classify it; an
  unconstrained `T` → `JSValue` in `jsvalue` mode), `BigIntLike → JSValue`,
  `Unknown → JSValue`, and a union reducer that **drops `Promise` arms** so a
  `T | Promise<T>` union binds through its synchronous arm.
- **`webiface.ts`** — `classify` maps `sequence`/`FrozenArray`/`ObservableArray`
  generics to a `JSValue` array handle; `classifyName` maps the IDL `any`/`object`
  type and any **dictionary** (options bag) to `JSValue`. Static operations are
  now processed **last**, so a static factory (`Response.json(data)`) yields a
  name collision to the instance member of the same name (the `Body`-mixin
  `json()` body-reader) instead of evicting it.
- **`modules.ts`** — `fs` gained `async:'suspending'` (its one `Promise`-returning
  member, `openAsBlob`, now awaits to a `JSValue`).

---

## The single seam — why this is mostly one file

`tsTypeToSi` (`dts.ts:77`) is the function that maps a TypeScript type to a
Silicon type or `null` (drop). Today it handles scalars, strings, `Object →
JSValue` (`dts.ts:103`), and `any → JSValue` (`dts.ts:104`), then falls through
to `return null` (`dts.ts:105`). Every "result not bindable" / "param not
bindable" skip in categories 2 and 3 is a TS type-flag that reaches that final
`return null`:

- `TypeParameter` (unconstrained or object-constrained generic `T`)
- `BigIntLike` (a `bigint` arm inside an otherwise-bindable union)
- `Unknown` (as opaque as `any`, but the branch only catches `Any`)
- a union containing a `Promise<X>` arm (the whole union sinks even when the
  synchronous arm is bindable)

`webiface.ts`'s `classify` (`webiface.ts:53`) is the same idea but narrower: it
rejects **every** generic with `if (tn.generic) return null` (`webiface.ts:61`)
and never consults `ctx.dicts`, so `sequence<>`/`FrozenArray<>` returns, the IDL
`any` type, and dictionary (options-bag) params all drop. dts already maps all
of these; webiface just never got the parallel branch.

So the bulk of the recoverable 7% is: **teach two classifiers the branches they
are missing, gated on `objects:'jsvalue'`.** The host emitter (`generate.ts`)
needs zero changes — a `JSValue` param or result is pure pass-through at the
shim.

---

## Category 1 — Variadic rest params  *(glue · NOT DONE — no usable win)*

> **Outcome:** not implemented. In the `jsvalue`-mode modules the only variadic
> member is `Bun.$`, whose snake-cased binding name is the bare `$` — not a valid
> Silicon identifier (it is the data-shape sigil). `path.join`/`resolve` are in
> `path`, which is kept portable (`objects:'skip'`), so the gated spread emitter
> would skip them too. Net recovery is **zero usable bindings**, so the `spread`
> `Impl` shape was not added. The analysis below records why.

**What it is.** A host function whose last parameter is a JS rest param
(`...args`) — a true variadic call that one fixed-arity `@extern` cannot
express, so the whole overload is rejected.

**Root cause.** `dts.ts:186` hard-rejects inside `trySig`:

```ts
if (d && ts.isParameter(d) && d.dotDotDotToken != null)
    return { bad: `variadic rest param '${p.getName()}'` }
```

The deliberate policy (comment block at `dts.ts:151–160`, `183–185`): a rest
param is **not** droppable (omitting it changes meaning — `join()` ≠
`join(a,b)`) and its array type must **not** be smuggled as one `JSValue`,
because `path.join([a,b])` ≠ `path.join(a,b)` — the host must **spread**. The
current `kind:'call'` emitter (`generate.ts`) reconstructs `accessor.method(args)`
by string-joining params verbatim, with no `...`. Exactly 3 functions hit this:
`node:path.join`, `node:path.resolve`, `Bun.$`.

**Work needed** (three coordinated edits; guest side already covered by
`js::array`/`js::push`/`js::from_str`):

1. **`spec.ts`** — new `Impl` shape carrying accessor + method *structurally*
   (like `construct`/`static`, so the emitter never re-parses an expr):
   ```ts
   | { readonly kind: 'spread'; readonly accessor: string; readonly method: string }
   ```
2. **`dts.ts` `trySig`** — when a param is the **last** one and has a
   `dotDotDotToken`, end the loop, push a single trailing
   `{ name: 'args', type: 'JSValue' }` (the array handle), and flag the spec
   `spread`. Choose `impl` by the flag at the spec push:
   ```ts
   impl: chosen.spread
       ? { kind: 'spread', accessor: src.accessor, method: name }
       : { kind: 'call', expr: /* … */ }
   ```
3. **`generate.ts` `emitHostModule`** — add the spread case:
   ```ts
   case 'spread':
       call = outWrap(`${d.impl.accessor}.${d.impl.method}(...${d.params[0].name})`, d.result)
       break
   ```

A guest then writes `@mut a := js::array(); js::push(a, js::from_str(p)); path::join(a)`.

**Caveat — tier regression.** `path` is configured `strings:'linear'`
(`modules.ts:37`) — its host entries are pure portable linear marshalling. A
spread binding forces a `JSValue` param (externref, Tier-2, **web/bun only**),
so `path.join`/`resolve` would silently stop being portable-to-any-host like the
rest of `path`. `Bun.$` is already Tier-2, so no shift there.

**Recommendation.** Worth gating spread emission behind a per-module
`objects:'jsvalue'` opt-in. Under that gate `path` stays portable and only
`Bun.$` recovers (1 fn); flip `path` to `jsvalue` only if its web/bun-only
regression is acceptable. Ergonomics are poor either way — callers hand-build a
`js::array` of boxed values for what reads as a simple join.

---

## Category 2 — Unrepresentable results  *(adapter-tweak · ✅ IMPLEMENTED)*

**What it is.** A host function whose **return** type `tsTypeToSi` can't map
(returns `null`), dropping the whole binding with reason `"non-Tier-0 result"` /
`"awaited type not bindable"`.

**Root cause.** `tsTypeToSi` (`dts.ts:77–105`) maps an object result to
`JSValue` (`:103`) and `any` (`:104`) but has **no branch** for
`TypeParameter` — so an unconstrained generic result `T` (`structuredClone`,
`crypto.randomFillSync`/`getRandomValues`) falls to `return null` (`:105`). Two
sub-causes share the path:

- **Union with a Promise arm** — `T | Promise<T>` (`Bun.readableStreamTo*`,
  `Bun.peek`): the Promise arm classifies to `null`, so the union's
  `parts.every(p => p !== null)` gate fails and the *whole* union sinks even
  though the synchronous arm is bindable.
- **`Promise<T>` result in a module with no async mode** — `fs.openAsBlob`,
  because the `fs` config omits `async:'suspending'`; the `asyncMode ===
  'suspending'` guard (`dts.ts:172`) is false, so it falls to plain
  `tsTypeToSi(Promise<Blob>)` → `null`.

> `os.cpus`/`loadavg`/`userInfo`/`networkInterfaces`, `path.parse`, `json.parse`
> are **not** adapter gaps — they're object/`any` results already handled by
> `:103`/`:104`. They only skip because their module ships `objects:'skip'`.
> Flipping those configs to `objects:'jsvalue'` recovers them with **zero code
> change**.

**Work needed** — three small classifier changes, all gated `objects==='jsvalue'`:

1. Map a generic result to `JSValue` (add after the `Any` branch, `:104`):
   ```ts
   // A generic result `T` (structuredClone, randomFillSync) is an opaque host
   // value at runtime — bind it as a JSValue handle (objects:'jsvalue' only).
   if (objects === 'jsvalue' && (f & ts.TypeFlags.TypeParameter)) return 'JSValue'
   ```
   Recovers `structuredClone` + the two crypto getters (their first param is
   already `JSValue` via `:103`).
2. Drop the Promise arm in the **union reducer** instead of nulling the union
   (in the union block `:83–99`):
   ```ts
   const nonThenable = t.types.filter(p => !isThenable(p))
   const parts = nonThenable.map(p => tsTypeToSi(p, numberType, objects))
   // existing every/some checks run on `parts`
   ```
   Recovers `Bun.readableStreamToArrayBuffer`/`Array`/`Bytes` + `peek`.
3. **Config only:** add `async:'suspending'` to the `fs` config
   (`modules.ts:163`, already `objects:'jsvalue'`) → `fs.openAsBlob` awaits to
   `JSValue`. Flip `path` (`modules.ts:36`) and `os` (`modules.ts:43`) from
   `objects:'skip'` → `'jsvalue'` to recover their object/`any` results.

**Stays unbound (fundamental):** `Bun.hash` (`number | bigint` — needs a
`bigint → Int64` ABI, separate gap); `Bun.plugin` (`ReturnType<T["setup"]>` — a
conditional type, genuinely unrepresentable).

---

## Category 3 — Object/buffer params not classified  *(adapter-tweak · ✅ IMPLEMENTED)*

**What it is.** Node/Bun members whose object/buffer-typed **params** are dropped
by `tsTypeToSi`.

**Root cause.** The intuitive hypothesis — "the `Object`-flag check is too
narrow" — is **false** (verified by a TS-checker probe: `fs.writevSync`'s
`readonly ArrayBufferView[]` is `flags=[Object] objFlags=[Reference]` and already
binds). The real drops are three missing branches:

1. **`TypeParameter`** — `fs.writev buffers:TBuffers`,
   `crypto.randomFill buffer:T`, `crypto.generateKeyPair options:T` are
   `<T extends …>` generics; no branch matches → `null`.
2. **`BigInt`** — `crypto.checkPrime value:LargeNumberLike` is a union whose 15
   buffer arms are `Object → JSValue`, but the `bigint` arm hits no branch →
   `null`, and the require-all-non-null union gate (`:98`) is poisoned by that
   one arm → the whole union drops.
3. **`Unknown`** — `Bun.deepMatch subset:unknown`/`a:unknown` is
   `flags=[Unknown]`; `:104` only catches `Any` → `null`.

**Work needed** — thread the `checker` into `tsTypeToSi` (signature becomes
`tsTypeToSi(t, checker, numberType, objects)`; update the recursive call and the
3 call sites — the checker is already in scope in `dtsToSpecs`) and add three
branches:

```ts
// (A) resolve a generic param to its constraint, then classify THAT.
//     <T extends ArrayBufferView> → ArrayBufferView (Object/union → JSValue).
if (f & ts.TypeFlags.TypeParameter) {
    const base = checker.getBaseConstraintOfType(t)
    return base ? tsTypeToSi(base, checker, numberType, objects) : null
}
// (B) bigint crosses as a handle (no linear-memory bigint ABI) — unblocks the
//     LargeNumberLike union (15 buffer arms + bigint).
if (objects === 'jsvalue' && (f & ts.TypeFlags.BigIntLike)) return 'JSValue'
// (C) `unknown` is as opaque as `any` — same handle treatment (next to :104).
if (objects === 'jsvalue' && (f & ts.TypeFlags.Unknown)) return 'JSValue'
```

JSValue params are pass-through externrefs (`generate.ts`) — the guest builds
them via `js::`/typed-array handles. No host work. `generateKeyPair`'s
`options:T → JSValue` is correct (the guest passes a real options object, not
lossy); `checkPrime`/`randomFill` stay correct (the buffer/value *is* the
handle).

**Caveats (why Med, not Low).** (A) is broad — it maps *any* unconstrained-or-
object-constrained generic param to `JSValue` across crypto/fs/bun, likely
recovering **more** than the 5 measured (re-run the skip log to count — could be
10–15+). Over-binding a generic whose constraint is itself a callback/thenable
is mitigated because the recursive classify still returns `null` for those
(`isCallable`/`isThenable` gates fire on the resolved constraint). A constraint
that reduces to an array-of-objects (`TBuffers → ArrayBufferView[]`) crosses as
**one** `JSValue` array handle — correct for `writev`, but worth a test
asserting the guest passes a `js::array` handle, not element-by-element.
**Recommended:** add the branches, then diff each module's `skipped[]`
before/after to get the exact recovered count and catch unintended over-binding.

---

## Category 4 — webiface non-bindable members + dictionaries  *(adapter-tweak · ✅ IMPLEMENTED)*

**What it is.** The Web-IDL adapter drops members whose type is a
`sequence<>`/`FrozenArray<>` (a JS array), the IDL `any` type, or a dictionary
(options bag) — even though the guest already has the `js` module to build/read
all three.

**Root cause.** `webiface.ts`'s classifier is strictly narrower than dts's:

1. **Sequence/FrozenArray returns** die at `classify` (`webiface.ts:61`):
   `if (tn.generic) return null` rejects *every* generic. → `"return type not
   bindable"` for `FormData.getAll`, `URLSearchParams.getAll`,
   `Headers.getSetCookie`.
2. **IDL `any`** falls through `classifyName` (`:69–78`) → `null` →
   `AbortSignal.reason` (attribute) and `Response.json`'s required `any data`
   arg drop.
3. **Dictionary params** — `ctx.dicts` is populated (`:168`) but **never
   consulted** in `classifyName`, so a dict name → `null` and `buildParams`
   skips the member when the dict arg is required.

dts already maps all of these (`:103`/`:104`); webiface just never got the
parallel branch.

**Work needed** — three small edits in `webiface.ts`, mirroring `dts.ts:103–104`.
The host emitter needs **zero** changes (a JSValue param/result is pure
pass-through; getter/method/static impls already work with a JSValue result):

```ts
// (A) classifyName (~:71)
if (name === 'any' || name === 'object') return 'JSValue'
if (ctx.dicts.has(name)) return 'JSValue'   // options bag → handle; guest builds via js::object/js::set

// (B) classify (:61) — replace the blanket generic reject with an array case
if (tn.generic) {
    if (tn.generic === 'sequence' || tn.generic === 'FrozenArray' || tn.generic === 'ObservableArray')
        return 'JSValue'   // a JS array handle; guest reads via js::len/js::get_index
    return null            // record<> / Promise<> handled elsewhere
}
```

`Promise` is still intercepted earlier in `classifyResult` (`:86`) before
`classify` runs on results, so the `@suspending` path is undisturbed; `record<>`
stays `null`.

**Recovered (6):** `FormData.getAll`, `URLSearchParams.getAll`,
`Headers.getSetCookie` (sequence returns), `TextEncoder.encodeInto` (dictionary
result + buffer destination), `AbortSignal.reason` getter (`any` attribute),
`AbortSignal.any` static (`sequence<AbortSignal>` arg). `AbortSignal.abort` also
gained its `reason` arg (the `any` param now binds), matching the WHATWG
signature.

**Did NOT recover — and that's the correct outcome (2):**
`Response.json` *static factory* (`Response.json(data)`) now classifies (`any →
JSValue`), but its snake-name `json` **collides** with the established `Body`-mixin
instance body-reader `json()` (the suspending `response::json(resp)` everyone
uses). Static operations are now processed **last**, so the instance reader keeps
the name and the static collides-and-drops — a category-5 overload-tail skip, not
a regression. `AbortSignal.onabort` (`EventHandler` callback) was skipped here at
the time (webiface had no callback path) — it is now **recovered** by the
`events:'closure'` work described in its own section below.

**Compounding win.** The dict-param branch unblocks any future module that takes
an options bag (hundreds of dictionaries exist in the corpus), so the recovery
grows as more Web interfaces ship.

---

## Category 5 — Overload alternatives (the fundamental tail)  *(fundamental · OUT OF SCOPE)*

**What it is.** A TS/IDL member with multiple overloads binds as **one**
`@extern` (monomorphic). The best-bindable overload is chosen, and every *other*
bindable shape — different arities, result types, sync-vs-callback, receiver
types — becomes unreachable.

**Root cause.** `dts.ts:208–247` — the per-property loop scores each bindable
signature with `[handleCount, -concreteCount]` and emits exactly **one**
`BindingSpec` for the single `chosen` signature. There is no mechanism to emit a
second name. Critically: the `'no bindable overload'` skip only fires when
**zero** overloads bind, and across all 7 shipped dts modules
(219 specs / 29 skips) that count is **0** — so this category produces **no
entries in the skipped list at all**. The loss is *silent* (a chosen-but-less-
capable signature), not a logged skip. webiface is worse: it doesn't enumerate
overloads, and a name collision is dropped at `webiface.ts:185`.

**Work needed (if pursued).** At the single-emit tail (`dts.ts:236–247`), dedup
all bindable shapes (key on `JSON.stringify([params.map(p=>p.type), ret,
suspending])`) and emit the rest under suffixed names (`…_alt2`, `…_alt3`),
gated behind a per-module `overloads?: 'best' | 'all'` flag (default `'best'`).
The impl expr already only references `r.params`, so each alt's host call is
correct by construction — no new marshalling.

**Recommendation — largely OUT OF SCOPE.** Honest accounting: ~73 alternative
overload shapes across 61 members *could* become callable, but **every one of
those 61 members already binds today** — the gain is added *capability* on
already-bound names (e.g. `json_stringify_alt2(value, replacer, space)` restores
indentation; `bun.color`'s JSValue/Float result variants; sync-vs-callback
`crypto.randomBytes`), not new coverage in the 93%/7% sense. The `_altN` naming
is opaque and un-discoverable (no signature hint), and many alts are near-
duplicates (one extra optional arg). The genuinely valuable slice is *lossy
result* cases (JSON.stringify spacing, `Bun.color` formats, `fs.readFileSync`
String-vs-Buffer) — better served case-by-case via `numberType`/`objects` tuning
than a blanket `_altN` scheme. `@extern` monomorphism is a language fact; the
workaround trades correctness-neutral capability for namespace noise.

---

## What was implemented (and what was left)

Done — categories 2, 3, 4, all in the two type classifiers + one config flag,
verified by re-running `bun bindgen/cli.ts --check` and diffing each module's
`skipped[]` before/after (`adapters.test.ts` locks the specific recoveries):

- **Category 4** (webiface seq/`any`/dict) and **Category 2** (unrepresentable
  results) — the low-risk bulk; the `js` module + Tier-2 externref contract carry
  every recovered handle, so the host shim was untouched.
- **Category 3** (object/buffer params) — same seam; the before/after `skipped[]`
  diff confirmed the recovered set and caught no over-binding (the recursive
  classify still nulls callback/thenable constraints).

Left out, deliberately:

- **Category 1** (variadic) — **not implemented**: no usable win (`Bun.$` →
  invalid name `$`; `path` kept portable). The `spread` `Impl` shape was not added.
- **Category 5** (overload alternatives) — **out of scope**: a consequence of
  `@extern` monomorphism, correctness-neutral, and `_altN` naming is noise.
- **`path` / `os` object + variadic results** — **not recovered, on purpose**:
  these modules stay Tier-0 portable (every host); binding their object results
  would require `objects:'jsvalue'`, making them web/bun-only.

## webiface `events:'closure'` — the EventHandler / listener path (IMPLEMENTED)

Category 5's lone fixable item — porting the dts adapter's `events:'closure'`
callback path to the **Web-IDL** adapter — is now done. The dts adapter already
mapped a callable param to the `Callback` closure handle; webiface had no callback
case at all, so `EventHandler` attributes and listener arguments were silently
skipped. The whole downstream machinery (`Callback` SiType → `Vec[Int]` → the
`__closure_invoke_<k>` trampoline → `closureToFn` at the host) already existed, so
this was a **classifier-only** change (zero emitter/host edits).

**What it does** (`webifaceToSpecs(iface, corpus, 'closure')`):

- Collects a `callbacks` Set from every `callback` / `callback interface` def in
  the corpus. A callback name → the `Callback` SiType — **only in `'closure'`
  mode** (the default `'skip'` keeps the prior behaviour; verified the callback
  Set is disjoint from `ifaces`/`dicts`/`enums`/`typedefs`, so skip-mode output is
  byte-identical across all 11 prior modules).
- **Asymmetry guard** — a callback crosses *only* guest→host. So `Callback` is
  allowed only in param / setter-value position; it sinks to `null` in a result
  (`classifyResult`), in a getter, and as any union arm. A host function can't be
  handed back to the guest as a Silicon closure.
- An `EventHandler` attribute (`onabort`) → a **setter-only** binding
  `set_onabort(self, Callback) -> Void` (no getter — reading a handler back is
  meaningless). `EventHandler` resolves through the existing typedef recursion
  (`EventHandler → EventHandlerNonNull`, a `callback` def).
- A listener **argument** (`EventListener`, a *callback interface*) → a `Callback`
  param.

**Shipped** — `abort_signal` opts into `'closure'` (recovers `set_onabort`), and a
new **`event_target`** module: `add_event_listener` / `remove_event_listener`
(Callback listener) + `dispatch_event` + `create`. A guest registers a listener
with `event_target::add_event_listener(target, "abort", @export_callback(@closure(…)))`;
`target` is any `EventTarget` handle (an `AbortSignal` handle works too, so you get
`addEventListener` on signals without an inheritance walk).

**Two limitations (honest scope):**

1. **A fired listener must not consume its `Event` argument.** The closure
   trampoline (`__closure_invoke_<k>`) types every callback arg as `i32`, but when
   the host dispatches an event it calls the listener with the `Event` *externref*
   — a boundary mismatch that traps. **Registration and no-arg / arg-ignoring
   firing are safe; reading the event is not** until the trampoline ABI accepts an
   externref param (a future story). The tests exercise registration only.
2. **`event_target::when`** (the WICG Observable proposal) is bound from
   `observable.idl` but is **unimplemented on Bun's `EventTarget`** → it traps at
   call time. It's a faithful reflection of the IDL; treat it as a not-yet-on-this-host
   member, like any host API a given runtime hasn't shipped.

`removeEventListener` is bound but of limited use: each `@export_callback` produces
a fresh host function, so you can't pass back the *same* reference you registered.

## What stays unbound — the 12 remaining skips

**Portability tradeoff (8)** — recoverable only by making the module web/bun-only;
deliberately left portable:

- `path.parse`, `path.format`, `path.join`, `path.resolve`
- `os.cpus`, `os.loadavg`, `os.userInfo`, `os.networkInterfaces`

**Genuinely fundamental (4)** — permanent skips:

- **`Bun.plugin`** — `ReturnType<T["setup"]>`, a conditional type.
- **`Bun.serve`** — its `options` is an intersection type carrying an embedded
  `fetch` handler; needs a closure inside a handle, not a plain `JSValue`.
- **`Bun.$`** — variadic, and its binding name would be the bare `$` (the Silicon
  data-shape sigil — not a valid identifier).
- **`Response.json`** *static factory* — collides with the instance body-reader
  `json()`; `@extern` monomorphism keeps the instance form (the useful one).

> `AbortSignal.onabort` was the 5th fundamental skip; it is now **recovered** by
> the webiface `events:'closure'` path above (as `set_onabort`).
>
> Note: `Bun.hash` (`number | bigint`) is no longer skipped — the union's `bigint`
> arm now crosses as a `JSValue` handle, so it binds (the numeric value is opaque
> to the guest, but the binding exists). A native `bigint → Int64` ABI remains
> future work if a scalar result is wanted.
