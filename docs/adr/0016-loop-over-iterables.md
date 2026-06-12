# ADR 0016 — `@loop` over iterables: one keyword, syntactic dispatch, value-returning `IterStep[T,R]` protocol

- **Status:** Accepted — v1 surface implemented and shipped in v0.1.3 (the
  `..` lexer token, the arity-dispatch desugar, the `IterStep[T,R]` stdlib type;
  see **Implementation pointer**). The deferred items in **What v1 actually
  delivers** remain future work.
- **Date:** 2026-06-05 (proposed) · 2026-06-05 (accepted)
- **Deciders:** NatesCode
- **Related:** `docs/archive/loop-design.md` (the prior brainstorm this ADR formalizes and revises) · ADR 0013 (capability checker: comptime reflection + `on::check`; the structural-dispatch machinery the user protocol *waits on*) · ADR 0011 (rcaps `&`/`&mut`/`&uniq`/`&val` — how a stateful iterator advances) · ADR 0012 (effect lattice; loop purity rides on the iterator's certificate) · ADR 0001 (generics ship as bodies, monomorphize per consumer — how `IterStep[T,R]` specializes) · ADR 0015 (authority as values — why the protocol returns a *value*, not a control callback) · ADR 0014 (`@global`/`@local` — the bindings the desugars emit) · [[silicon-generics-strategy]] · [[silicon-mutability-capability-model]] memories · prior art: Rust (`Iterator::next -> Option<Item>`, external iteration, `for` desugar), Zig (`while`/`for` over slices and ranges, no hidden allocation), Python (`__next__` + `StopIteration` — value-vs-exception contrast), Ruby (`each` + block — the internal-iterator model deliberately *not* chosen), Roc (`Iterator` as a record of closures — needs the capture Silicon lacks).

## Context

Silicon has exactly **one** loop form today, a `while`:

```silicon
&@loop n < 5, { n = n + 1 };
```

`@loop` is a stratum (`compiler/src/strata/loop.si:6-20`): it registers an
expression keyword and an `on::lower` handler that allocates a unique loop id,
pushes it on a loop-stack, lowers `cond` and `body`, pops, and emits an
`IRLoop` node (`compiler/src/ir/nodes.ts:130-135`, `kind:'Loop', id, cond,
body`). `@break`/`@continue` (`compiler/src/strata/control.si:6-20`) read the
topmost loop id off that stack and lower to `(br $brk_N)` / `(br $cont_N)`. WAT
emission (`compiler/src/ir/emit.ts:259-272`) produces the textbook `(block
$brk_N (loop $cont_N (br_if $brk_N (i32.eqz cond)) body (br $cont_N)))`; QBE
(`compiler/src/codegen/qbe/lower.ts:924-945`) emits the head/body/exit-label
equivalent.

Four facts about the current compiler bound this design — each is the reason a
piece of the full design is *deferred* rather than shipped:

1. **Loops are statements, not expressions.** The wasm-type resolver hard-codes
   `void` for `Loop` (`compiler/src/ir/lower.ts:2228`); `IRLoop` carries no
   result slot. A loop cannot yet evaluate to a value.
2. **No comptime structural type-reflection.** Generics monomorphize through
   per-node strata hooks (`on::decl` captures a template; a wildcard
   `on::call_site` binds type args and emits the monomorph —
   `compiler/src/elaborator/generic-monomorph.test.ts`), but there is **no** way
   to ask "does this *type* expose `len`+`get`? a `next` returning a step?". ADR
   0013 is explicit: the strata hooks "are all per-node. There is no
   whole-program hook: `on::check` does not exist" — it is *proposed* (P1–P5),
   not built.
3. **Containers are i32-element-specialized.** `Vec` exposes `vec_len` /
   `vec_get_i32` / `vec_push_i32` and its header states it ships "specialised for
   i32-sized elements … Generic monomorphisation of `Vec[T]` … is a 1.x
   improvement" (`compiler/src/stdlib/vec.si:1-9`). `HashMap`
   (`compiler/src/stdlib/hashmap.si`) exposes only slot internals and i32→i32
   get/set — **no** iteration surface. `valueTypeByteSize` returns `null` for
   `String`/`Array`/`Sum`/records (`compiler/src/ir/lower.ts:~1856`), so a
   by-value struct element is not bindable through an i32 get.
4. **`@fnref` has no environment capture.** It is fixed i32→i32, table-index
   based, "adding it to the module's funcref table on demand"
   (`compiler/src/strata/control.si:45-51`). A callback cannot close over a
   surrounding accumulator — which is the real reason internal iteration is
   declined (Option C), and why combinators wait on closures.

The recurring product question — *does Silicon need a `for` or `foreach`?* — is
answered **no**: a `while` is the degenerate case of iterating a one-shot
condition, so one `@loop` keyword subsumes both, dispatching on the **syntactic
shape and arity of its arguments at elaboration time**, never on a runtime
iterator object. That is the direction `docs/archive/loop-design.md` reached.
This ADR pins what that brainstorm left open and revises three of its choices:

- it used a `(done, value, new_state)` **tuple** for `iter_next` (and called
  "death by tuple" a sharp edge) — we replace it with a **sum**, `IterStep[T,R]`,
  now that the language has first-class sums;
- it marked for-each with a new `<-` operator (flagged as needing lexer work) —
  we use **arity-based comma binds**, adding no operator;
- it proposed a **C-style 4-arg** form (`init; cond; step`) — we decline it in
  favor of a half-open `Range`.

## Decision

**One `@loop` keyword. The elaborator dispatches on the count and syntactic
shape of the pre-block operands, and every form lowers to the *same* `IRLoop`
primitive the bootstrap already emits — no runtime iterator object, no indirect
call, no per-iteration allocation unless the user explicitly built one.** The
iteration contract is a value-returning sum:

```silicon
@type IterStep[T, R] := $Item value T | $Done result R;
```

`@loop` is **external** (the loop drives `next` and decides whether to continue),
**eager-only** for v1 (no lazy/suspended producers, no lazy combinator
pipelines), and is, *as a target*, an **expression** evaluating to the
iterator's final `$Done result R`.

This Decision records the **design target**. What of it actually *dispatches and
ships in v1* is deliberately small and is enumerated in **What v1 actually
delivers** below — read the two together. The design points:

1. **A step is a value, never control.** `next` *returns* `$Item v` or `$Done r`;
   the loop reads it and decides. The iterator never reaches back into the loop
   to stop it. This "who drives" decision is the crux (Option C).

2. **`IterStep[T,R]` is a sum, not a record.** "Either an item or a result"
   makes done-vs-item mutually exclusive and illegal-when-mixed unrepresentable.
   A record `${value, isDone, returnValue}` has a `value` field that is garbage
   whenever `isDone`, pushing that invariant onto every consumer (Option B). The
   sum reuses the `Option`/`Result`/`@match` idiom already in `stdlib/option.si`
   and `result.si`. For `T = R = Int` its layout is `[tag:i32, payload:i32]` =
   `4 + 4*maxFields` = **8 bytes** (`compiler/src/strata/defExpanders.ts:137`)
   vs 12 for the three-field record.

3. **Loop-as-expression returns `R` (target).** The `$Done result R` payload is
   the loop's value. `while`, infinite, range, and indexable-container forms
   carry no accumulator, so their value is `Unit`; only the general `next` path
   yields a non-`Unit` `R`. `@break` does **not** carry a value in v1 (point 7);
   "fold / search / first-match as a value" is expressed either by mutating a
   body-side `@local` in place, or by an iterator that returns `$Done found`.

4. **Dispatch is a pure operand-count switch.** Let *k* = the number of
   comma-separated operands **before** the trailing `{ body }` block:

   | *k* | form | meaning |
   |----|------|---------|
   | 0 | infinite | `&@loop @true, body` — new sugar for the `&@loop 1, {…@break…}` idiom |
   | 1 | **while** | the lone operand is the Bool condition, re-evaluated each iteration |
   | 2 | iterate, 1 binder | `&@loop v, subj, body` — `v` ← each element |
   | 3 | iterate, 2 binders | `&@loop i, v, subj, body` — `i` ← position, `v` ← element |
   | ≥4 | reserved | v1 must reject |

   **A single pre-block operand is *always* a `while` condition**, whatever its
   shape (identifier, comparison, even a range literal). Iterating requires ≥1
   binder, so the *subject is never alone*. To iterate without naming the
   element, use the discard binder: `&@loop _, xs, body`. The binders are
   `operands[0..k-2]`; the subject is `operands[k-1]`. (The parser already
   flattens comma operands into one `args` array — `parser.ts::parseCallArgs` —
   so this is an integer switch in the stratum handler, no new grammar.)

   **Backward-compat:** `&@loop 1, {…}` and `&@loop cond, {…}` are *unchanged* —
   one operand ⇒ `while` ⇒ the bootstrap's `&@loop 1, {…@break…}` loop-forever
   idiom keeps compiling identically. This is *why* a lone operand must never be
   read as an iterate-subject.

5. **Half-open range syntax via `..`.** `0..n` is the canonical counter source:
   half-open (`n` excluded), so `0..len` is the full index set and `a..a` (and
   any `a >= b`) is empty. Requires one new lexer token (Sharp edges). Whether a
   `Range` is a *storable first-class value* (`@global r := 0..n`) is deferred —
   it has no `valueTypeByteSize` entry today; v1 treats `..` as syntactic only
   inside `@loop`.

6. **Syntactic dispatch now; structural dispatch when ADR 0013 lands.** v1
   recognizes `..` ranges syntactically and a fixed strata-known *i32-element*
   container name-list. The general user-defined `next -> IterStep` protocol is
   *specified here as a convention* but is **not** given `@loop` surface sugar in
   v1 — selecting it for an arbitrary `next`-bearing type needs the structural
   reflection ADR 0013 is bootstrapping. **Precedence (for the reflection era):**
   a type exposing `next -> IterStep` uses the general protocol *even if* it also
   has `len`+`get`; the indexed fast path is chosen only for allow-listed
   containers that do **not** expose `next` (so a map whose `next` iterates in
   insertion order is never silently re-ordered by a bucket-order `get`).

7. **`@break` exits the loop with `Unit`; it carries no value.** `@continue`
   re-enters. The three exit channels are orthogonal: `$Done` sets the loop's
   `R`; `@break` leaves with `Unit`; `@try` returns from the *enclosing function*
   (point below). A loop body uses at most one of these as its meaningful exit.

8. **Every form is a strata desugar to `IRLoop(cond, body)`.** The fast paths
   (range, indexable) desugar to a bare counter loop and **never materialize an
   `IterStep`**; the sum exists only on the general `next` path. The single
   net-new IR change the *target* needs is giving `IRLoop` a result slot
   (point 3) — the largest implementation item (Consequences).

9. **Eager-only; generators and lazy combinators are out of scope.** A
   suspending generator needs a continuation back into its consumer — the
   parent-pointer machinery of Option C-2, deferred wholesale.

## The protocol and its desugars

`IterStep[T,R]` monomorphizes per `(T,R)` (ADR 0001).

**Range form** — `..` makes it syntactic; no `IterStep` is built. General
`a..b`, arity-1 (`v` ← element):

```silicon
&@loop v, a..b, { … };
\\ ⇒
@local _i  := a;
@local _hi := b;
&@loop _i < _hi, {
    @local v := _i;
    … ;
    _i = _i + 1
};
```

Arity-2 over a range binds **position** then **element** (they diverge once
`a ≠ 0`):

```silicon
&@loop idx, v, 2..5, { … };   \\ idx = 0,1,2 ; v = 2,3,4
\\ ⇒
@local _i := 2; @local _hi := 5; @local _k := 0;
&@loop _i < _hi, {
    @local idx := _k;  @local v := _i;
    … ;
    _i = _i + 1; _k = _k + 1
};
```

**Indexable container form** — uses the real `vec_*` surface, *not* a
nonexistent `arr_*`.  The desugar emits the i32-default names below; since M1
container monomorphization, the generated `vec_len` / `vec_get_i32` calls are
*tagged*, and when the subject's inferred type is `Vec[Float]` / `Vec[Int64]`
the typechecker retargets them at the matching monomorph family
(`vec_len_f32`/`vec_get_f32`, `vec_len_i64`/`vec_get_i64`) so the element
binder is element-typed — on both targets (annotate the subject
`\\ v Vec[Float]` so the element type is known):

```silicon
&@loop idx, item, xs, { … };          \\ xs : Vec
\\ ⇒
@local _i := 0;
@local _n := &vec_len xs;             \\ → vec_len_f32 / _i64 when xs : Vec[Float] / Vec[Int64]
&@loop _i < _n, {
    @local idx  := _i;
    @local item := &vec_get_i32 xs, _i;   \\ → vec_get_f32 / _i64; binder typed by element
    … ;
    _i = _i + 1
};
```

Still no `IterStep` — a plain indexed loop, identical to hand-written.

**General `next` form** (specified; *no* `@loop` surface sugar in v1 — written by
hand until ADR 0013 reflection lands). This is the only path that materializes
the sum and the only one needing `@match`:

```silicon
@local _it     := it;
@local _result := 0;            \\ R seed; assigned only on $Done
&@loop @true, {
    @local _step := &Iter::next _it;     \\ advances _it (&mut), returns IterStep[T,R]
    &@match _step,
        $Done r => { _result = r; &@break },
        $Item v => { … }
};
\\ loop value = _result — well-defined ONLY if control left via $Done
```

The generated `@match` arms are **blocks**, sidestepping the parser quirk where
a bare binary arm body swallows the arm-separating comma (Sharp edges). The
synthesized inner `&@loop @true` pushes exactly **one** loop id per source-level
`@loop`, in source-nesting order; a user `@break`/`@continue` in the body and the
desugar's own `$Done`-`@break` therefore resolve to that same id (the `$Done`
break is emitted after the body is lowered, sharing the id). Synthesized
temporaries (`_it`, `_result`, `_step`, `_i`, `_n`, `_hi`, `_k`) are
compiler-hygienic (reserved namespace / gensym'd) and cannot collide with user
names; a user binder (`v`, `item`, `idx`) is a fresh `@local` scoped to the body
block, shadowing any outer binding of the same name per normal block scoping.

**Composition with `@try` — an independent channel, not cooperation.** `@try`
lowers to an early `@return` of the original `Result` pointer
(`compiler/src/ir/lower.ts:1635-1705`), so it returns from the **enclosing
function** (through `@defer` cleanup via `compiler_emitReturn`), *not* from the
loop. It does **not** compose with loop-as-expression: a successful run yields
the loop's `R`, while any failure abandons `R` by returning from the function.

```silicon
@fn process it := {
    \\ @try here exits `process` on the first Err (R is discarded);
    \\ on full success the loop runs to $Done and `process` returns Ok.
    &@loop v, it, { @try step v };       \\ used for effect; loop value unused
    &Ok unit
};
\\ Caveat: @try's propagated Err type is NOT checked against `process`'s
\\ declared E — HM-lite has no signature for @try (Sharp edges).
```

## Options considered

### Option A — value-returning `IterStep[T,R]` sum, external iteration (chosen)

`next` returns `$Item value T | $Done result R`; the loop drives and decides.
**Pros:** illegal states unrepresentable; 8 vs 12 bytes for `Int,Int`; reuses
`Option`/`Result`/`@match`; loop-as-expression falls out of `$Done`'s payload;
consistent with ADR 0015's "authority/values, not control"; the fast paths skip
the sum. **Cons:** the general path materializes and `@match`es a heap sum per
iteration; a sum whose payload type is itself heap is rejected today; and the
*dispatched* surface for arbitrary iterators waits on ADR 0013 (so v1 ships only
the value *shape*, not the dispatch). **Cost:** the `..` token, the
arity-dispatch strata, and (for non-`Unit` `R`) an `IRLoop` result slot.

### Option B — `${value, isDone, returnValue}` record

`next` returns a struct read field-by-field. **Pros:** terse field access; no
`@match`. **Cons:** `value` is garbage whenever `isDone`; the invariant lands on
every consumer; 12 vs 8 bytes; `isDone`+`returnValue` can encode states that
should not exist. The record wins only on terseness for a rare hand consumer —
and the common consumer is `@loop`'s generated code, where the fast paths build
no step at all. **Rejected.**

### Option C — internal iteration (two variants, both declined for v1)

**C-1, returning non-escaping callback.** `each(xs, body)` where `body(item) ->
KeepGoing` (or a fold value). This has *no* non-local control — the producer
calls `body`, reads its return, and decides; structurally it is the same "step
is a value" principle, with the loop body as callee. It is a legitimate design
(Rust's `try_fold`, Roc's consumers). **It is declined not for control reasons
but for capture:** `@fnref` is fixed i32→i32 with no environment capture
(`control.si:45-51`), so the callback body cannot close over the surrounding
accumulator (`total`) — making the internal form *strictly less expressive* than
the desugared external loop until closures exist.

**C-2, parent-pointer / control callback** (the spitballed "iterator holds a
pointer to call the parent so it stops"). This *does* introduce a non-local
control edge out of the iterator across the loop boundary — the Ruby-`each`
hazard — and it breaks the value channels: loop-as-expression needs a *value* to
carry `R`; `@try`/`@match` compose over values, not over "the parent got
called". The parent-pointer is real, but as the **implementation of a suspending
generator** (save a continuation, jump back on `yield`) — the deferred coroutine
layer (point 9), not eager v1. **Declined for v1.**

"Who drives" therefore favors external iteration on both: the loop reads a value
and decides.

### Option D — the archived `<-` marker and C-style 4-arg form

`docs/archive/loop-design.md` marked for-each with `x <- iter` and proposed
`&@loop init; cond; step, body`. **Cons:** `<-` is a new lexer token the archive
itself flagged (`<` and `-` are separate today); the 4-arg form duplicates
`0..n` + `while` and re-opens the `@continue`-skips-`step`? question. Arity binds
need no operator and `Range` is more legible. **Superseded by A.**

## Consequences

- **Positive:** one keyword covers while / counter / for-each; emitted wasm is
  what a human would hand-write (no iterator object, no indirect call, no
  per-iteration allocation on the fast paths); illegal step-states are
  unrepresentable; the design reuses `Option`/`Result`/`@match` rather than
  inventing machinery; it stays inside HM-lite + monomorphization with no rows,
  traits, or HKT; and it pins a single target so later work (reflection,
  closures, `Vec[T]`) converges instead of re-litigating loop shape.
- **Negative:** the *usable* surface in v1 is small (next section); the full
  protocol is gated on a conjunction of other work; loop-as-expression with a
  non-`Unit` `R` is a cross-cutting backend change; `..` needs hand-rolled lexer
  lookahead.
- **Loop-as-expression is the largest item, not "one slot".** Making a loop an
  expression adds a result local to `IRLoop`, threads a typed result through the
  wasm-type resolver (`lower.ts:2228`, today hard `void`), **both** emit-side
  `Loop` sites plus `emitLoop` (`emit.ts`), and the QBE backend's break/exit
  edges (`qbe/lower.ts:924-945`). It is one *concept* (model it on
  `IRBlock`'s existing `wasmType`, `nodes.ts:~107`) but a change touching every
  loop-aware site in both backends. v1 can ship the `Unit`-valued forms without
  it.
- **Follow-up work:**
  1. Lexer: `..` token (lookahead before `lexer.ts:163`) + a `Range` production
     and the empty/inverted-range semantics below.
  2. Arity-dispatch strata; the range + indexed-container desugars (`Unit`,
     no `IterStep`).
  3. `IRLoop` result slot + typed plumbing in both backends; loop-as-expression.
  4. `IterStep[T,R]` in stdlib + the general `next` desugar.
  5. ADR 0013 tie-in: detect "is iterable" by `on::check` shape, with point 6's
     precedence, to give arbitrary `next`-bearing types the for-each surface.
  6. `Vec[T]` monomorphization + a `HashMap` iteration surface so indexed
     iteration covers non-i32 elements and maps.  **(Shipped — M1:** typed-Vec
     `@loop` dispatch via the typechecker retarget; `hashmap_iter_*` cursor
     families, compact + wide, driven by a while-`@loop`.**)**

## What v1 actually delivers

The constraints above are listed once each; **summed**, the honest v1 surface
is deliberately minimal:

- **Ships and dispatches in v1:** `while` (exists); the 0-operand infinite sugar;
  `a..b` half-open ranges with arity-1/-2 binds (counter loops, `Unit`-valued);
  i32-element indexed iteration over the allow-listed container surface
  (`vec_len`/`vec_get_i32`) — element values are i32 (`Int`, `Bool`, or a
  pointer); **`Array[T]` subjects** (the `$[…]` literal type) via the same
  typechecker retarget, at the always-present prelude helpers (`arr_len` /
  `arr_load_i32`, `arr_load_f32` for `Array[Float]`) — no `@use` required,
  matching the literal.
- **Specified but NOT surfaced/dispatched in v1** (each gated on real machinery):
  - arity-binding for-each over an arbitrary `next`-bearing type — needs ADR 0013
    P2 structural reflection;
  - loop-as-expression carrying a non-`Unit` `R` — needs the `IRLoop` result slot;
  - heap-typed step payloads (`IterStep[String, _]`, `IterStep[Vec, _]`) — needs
    v1.1 trace-and-copy (heap-in-sum is rejected at lower-time today);
  - combinators (`map`/`filter`/`take`) as iterators — need closures/capture
    (`@fnref` cannot close over state);
  - iteration over by-value structs, floats/i64 elements, and `HashMap` — needs
    `Vec[T]` monomorphization and a map iteration surface;
  - `Range` as a storable first-class value — needs a `valueTypeByteSize` entry.

So the `IterStep` protocol ships in v1 as a **documented data shape and
hand-written convention**, *not* as a dispatched language feature: it becomes
usable through `@loop`'s for-each surface only once **(closures/capture) ∧ (ADR
0013 reflection) ∧ (v1.1 heap-in-sum) ∧ (`Vec[T]` monomorphization)** all land.
This is an intentional minimal core, recorded now so those four workstreams aim
at the same protocol.

## Sharp edges

Grounded in the current compiler.

- **Empty / zero-iteration.** Empty range (`a >= b`, including `a..a`) and empty
  container (`_n == 0`) run the body **zero** times; an inverted range like
  `5..3` is zero-iteration (not reversed, not a panic). A general `next` that
  returns `$Done` on the first call runs the body zero times and the loop value
  is that first `R`. For the `Unit`-valued fast paths the zero-iteration value is
  `Unit`.

- **`..` is not a free token.** `.` is **not** an operator glyph — the lexer's
  maximal-munch run covers only `=<>!+-*/%^|~?` (`lexer.ts:64`); `.` is a
  dedicated `nsSep` (`lexer.ts:163`). `..` needs a rule *before* that line that
  looks ahead for a second `.` (and must not perturb single-`.`-before-identifier
  namespace access). No float ambiguity: a float requires a digit after the dot
  (`lexer.ts:217`), so `0.` is `int` + `.`, and `1.0..n` lexes `float` then `..`,
  `1..5` as `int .. int`. Boundary cases the parser's range production must
  reject (the lexer only tokenizes): `1...5` is reserved → error (no
  spread/exclusive overload planned); `1..` and `..5` → error (v1 ranges need
  both bounds); `a..b..c` → error (`..` is non-associative). `-1..n` parses as
  `Range(-1, n)` — unary minus binds tighter than `..`.

- **`@match` arm bodies and the comma.** A bare binary arm body (`$A x => x + 1`)
  lets the operator parse swallow the arm-separating comma; the fix is parens
  (`=> (x + 1)`) — a **parser** quirk, not a codegen bug
  (`cross-target.test.ts:293`). The generated desugars emit **block** arm bodies,
  so they are immune; hand-written `next` consumers must mind it.

- **Indexed iteration dispatches on the subject's element type** *(updated —
  M1)*. The i32 default covers `Int`, `Bool`, and pointers (iterating a Vec of
  String pointers works at the pointer level); a subject inferred as
  `Vec[Float]` / `Vec[Int64]` retargets the desugared calls at the `_f32` /
  `_i64` monomorph family, typing the binder by the element. By-value
  **struct** elements remain inexpressible (no `Vec[StructT]` monomorph).
  `HashMap` iterates via the `hashmap_iter_*` cursor surface driven by a
  while-`@loop` (compact i32 cursor + `_i64` wide cursor + `_f32` value
  reads) — there is no direct `@loop h` map sugar.

- **Heap-typed step payloads are rejected.** Sum payloads that are themselves
  heap values are conservatively rejected at lower-time
  (`compiler/src/ir/lower.ts:~1838`; v1.1 adds trace-and-copy). So
  `IterStep[String, R]` / `IterStep[Vec, R]` — a general iterator over heap
  elements — does **not** compile yet. (The range/indexed fast paths sidestep
  this: they bind the i32 element directly, never wrapping it in a sum.)

- **Loop-value seed on a non-`$Done` exit.** In the general desugar `_result` is
  written only on the `$Done` arm; an early body `@break`, a `@try`
  function-exit, or an infinite iterator leaves `_result` at its seed. The
  contract: **loop-as-expression is well-defined only when control leaves via
  `$Done`.** Since heap-typed `R` is blocked anyway, the live seed is an `Int`
  `0`; consuming the value of a possibly-early-exited loop is the user's
  responsibility (mutate a body-side `@local` instead).

- **Subject is snapshotted.** `_hi := b` and `_n := &vec_len xs` are evaluated
  **once** at loop entry; mutating the container's length inside the body does
  not change the iteration count (and shrinking it can make `vec_get_i32` read
  out of bounds). Defining in-loop mutation is out of scope for v1.

- **`@break`/`@continue` are not validated outside a loop.** `loopStack_peek`
  returns `0` at file scope (`imports.ts:~746`) and the strata emit an
  out-of-range branch with no diagnostic. The desugars must preserve the
  push/pop order so siblings and nesting resolve.

- **`@try` E-type is unchecked.** `@try` has no registered HM-lite signature, so
  a propagated `Err` type is not checked against the function's declared `E`
  (`lower.ts:1635-1705`) — a mismatch compiles and miscarries the `Result`.

- **`@defer` inside a loop body** *(open question, flagged not decided).* Whether
  a `@defer` written in an iterate body runs per-iteration (at the synthesized
  body-block boundary) or once at function exit depends on `@defer`'s scope
  binding and is **not** settled here; the intended rule is per-iteration
  (body-block scope), to be confirmed against the `@defer` implementation before
  the iterate forms ship.

- **`@continue` skips the synthesized increment** *(confirmed in v1).* The
  range/indexed desugar places `_i = _i + 1` as the **last** statement of the
  body block, and `@continue` lowers to a branch to the loop head — so a
  `@continue` inside an iterate `@loop` re-checks the condition *without*
  advancing the counter, exactly as it would in the hand-written while loop the
  desugar produces (a non-advancing `@continue` over a fixed bound spins
  forever). This is the classic C `continue`-in-a-manual-`for` footgun; v1
  matches the published desugar rather than introducing a separate continue
  target. Prefer `&@if`-guarding the work over `@continue` in a ranged loop.

- **The 0-operand form depended on fixing a pre-existing crash.** `&@loop
  {body}` desugars to the `&@loop 1, {body}` loop-forever idiom — which, on the
  current compiler, **threw at lower-time** (`node is not an Object`) whenever a
  `SemanticModel` was present, because a zero-arg builtin keyword (`@break`,
  `@continue`) reached `lowerBuiltinCall` with `rawArgs[0] === undefined` and
  `inferredTypeOf` → `SemanticModel.typeOf` → `unwrap` tested `'_node' in
  <undefined>`. The CaaS/`compile` and CLI paths always build a model, so the
  idiom the ADR assumed "keeps compiling identically" was in fact broken; v1
  guards `inferredTypeOf` against non-object nodes (`lower.ts`).

- **The general `next` convention avoids two unrelated codegen/inference gaps.**
  A `@match` whose arm bodies are assignment-only blocks (no value) miscompiles
  to a wasm stack-type mismatch in **statement** position (a pre-existing
  `@match` limitation, reproducible on a plain `Result` match) — so a
  hand-written driver should branch with `&@if` + the `iter_*` predicates rather
  than `@match`-ing the step when the arms only mutate. Separately, building an
  `IterStep` from two different variant constructors across `@if` arms (`$Item
  v` gives `IterStep[Int, ?R]`, `$Done r` gives `IterStep[?T, Int]`) does not
  unify under HM-lite's branch rule; pin each arm with `&@as IterStep[Int, Int]`.
  `compiler/src/stdlib/iter.si` and the e2e tests use these workarounds.

## Known limitations / explicitly deferred

- **Lazy iterators and combinators** (`map`/`filter`/`fold` pipelines) — `@fnref`
  has no capture; deferred until closures exist. Transform in the loop body
  meanwhile.
- **Coroutine generators** (`yield`) — needs Option C-2's continuation machinery
  and stack manipulation Silicon lacks. Out of scope.
- **`&mut`/`&uniq` iterator semantics** — how a stateful `next` advances under the
  rcap model (ADR 0011), and whether an iterator hands out `&mut` elements.
  Specified there.
- **General `next` over heap element types** — blocked by heap-in-sum until v1.1.
- **Non-i32 / map iteration** — needed `Vec[T]` monomorphization + a `HashMap`
  iteration surface; **shipped with M1** (typed-Vec `@loop` dispatch +
  `hashmap_iter_*` cursors).  Struct-element Vecs remain out.
- **`Range` as a first-class storable value** — needs a `valueTypeByteSize`
  entry; v1 keeps `..` syntactic inside `@loop`.
- **C-style 4-arg `@loop`** — declined for `Range` (Option D).
- **Teaching surface** — the cookbook (`website/src/examples/control-flow.md`)
  and `docs/grammar.ebnf` need the new forms once shipped; out of scope for this
  ADR.

## Implementation pointer

**Landed in v0.1.3.** The v1 surface ships as an **AST→AST desugar that runs
before elaboration/typecheck**, so every form reduces to the existing
`while`-shaped `&@loop cond, {body}` the bootstrap already lowers — *zero* new
IR, *zero* typechecker rule, and `..` never reaches operator resolution. This
diverged from the proposed touchpoints in two deliberate ways:

- **No `IRLoop` result slot, no QBE/emit changes.** Because the desugar targets
  the existing while primitive (and v1 carries no non-`Unit` `R`), the largest
  proposed item — making a loop an expression — was not needed and was left
  deferred. `compiler/src/ir/nodes.ts` / `emit.ts` / `codegen/qbe/lower.ts` were
  untouched.
- **Desugar in TypeScript, not `loop.si`.** Arity dispatch + hygienic-temp
  synthesis + the indexed-`Vec` calls live in
  `compiler/src/elaborator/loopDesugar.ts` (wired into `elaborate()`), modelled
  on the existing TS desugars (`lowerTry`, `lowerWithArena`); the `@loop`
  stratum and `Loop_lower` are unchanged and still handle the resulting while.

Actual touchpoints:
- `compiler/src/parser/handwritten/lexer.ts` — `..` emitted as a 2-char `op`
  token before the single-`.` `nsSep` rule (so `a..b` parses as `BinaryOp('..')`
  for free).
- `compiler/src/elaborator/loopDesugar.ts` (new) + `elaborator.ts` — the
  arity-dispatch desugar and its diagnostics (arity ≥ 4, stray `..`, non-name
  binder).
- `compiler/src/stdlib/iter.si` (new) — `IterStep[T,R]` + `iter_is_item` /
  `iter_is_done` / `iter_item_or` (documented convention; not dispatched).
- `compiler/src/ir/lower.ts` — a one-line fix to `inferredTypeOf` (see Sharp
  edges: it guarded a *pre-existing* crash that made the `&@loop 1, {…@break…}`
  loop-forever idiom — and therefore the new 0-operand form — fail to compile
  whenever a `SemanticModel` was present).
- Tests: `compiler/src/e2e/loop-iterables.test.ts`. Example:
  `examples/loop_iterables.si`. Docs: `website/src/examples/control-flow.md`,
  `docs/overview.md`, `docs/grammar.ebnf`.
