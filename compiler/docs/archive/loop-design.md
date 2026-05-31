# `@loop` design — unifying while / for / for-each

**Status:** brainstorming.  Captures a discussion about how a future
unified `@loop` could subsume while-loop, C-style for, and for-each
without falling into the "everything is a runtime iterator" rabbit
hole.  Not a spec.  No code in this doc is implemented today.

## Where we are today

Silicon currently has exactly one loop form:

```silicon
&@loop cond, body
```

A while-loop.  `cond` is re-evaluated at the top of each iteration;
the body runs while `cond` is truthy.  WAT emission
(`src/ir/emit.ts::emitLoop`):

```wat
(block $brk_N
  (loop $cont_N
    (br_if $brk_N (i32.eqz <cond>))
    <body>
    (br $cont_N)
  )
)
```

`&@break` and `&@continue` look up the innermost loop's id via a
small loop-stack the elaborator maintains, so nested loops work
without explicit labels.

Three idioms cover the for-loop space by convention:

```silicon
&@loop (i < n), { ... };                 # while

&@loop 1, {                              # infinite + internal exit
  &@if cond, { &@break };
  ...
};

@local i := 0;                           # C-style for, expanded
&@loop (i < n), {
  ...
  i = i + 1
};
```

The third is verbose for the most common case (counter loop), but
it works.

## The rabbit hole that motivated this doc

Earlier exploration tried to unify `for`, `while`, and `do-while`
into a single `@loop` whose first argument was *always wrapped into
an iterator*.  `&@loop coll, body` would for-each.  `&@loop 1, body`
would treat `1` as a single-shot iterator.  Etc.

The problem: forcing unification at the **runtime** level means every
loop materialises an iterator object, which needs a type, which
needs a protocol, which needs traits/typeclasses to extend, which
means you have to ship that infrastructure *before* you can ship
the unified `@loop`.

A worked-out version of `&@loop (i < n), body` under that scheme
would compile to roughly:

```
make_bool_iter(i < n)    # boxed
loop:
  call iter.next         # indirect
  br_if exit (i32.eqz)
  body
  br loop
```

— an indirect call and a heap allocation per iteration where there
should be `(loop ... br_if ...)`.  An aggressive optimiser could
recognise and unbox the iterator, but Silicon doesn't have one,
and the "the lowering is exactly what I'd write by hand" property
that makes the language readable from the WAT side would be lost.

## Proposed direction: unified keyword, syntactic dispatch

Keep the single `@loop` keyword.  Dispatch on the **syntactic shape
of its arguments at elaboration time, not on a runtime value**.
Every form lowers to the same `IR_LOOP(cond, body)` primitive
that exists today.  No iterator object exists in the emitted wasm
unless the user explicitly builds one.

### The four shapes

| Source syntax | Elaborator detects | Desugars to |
| --- | --- | --- |
| `&@loop body` (1 arg) | `n_args == 1`, body is a Block | `&@loop 1, body` (infinite with internal `@break`) |
| `&@loop cond, body` (2 args, cond is a Bool/Int expression) | what we have today | unchanged |
| `&@loop init; cond; step, body` (4 args) | `n_args == 4` | `{ init; &@loop cond, { body; step } }` |
| `&@loop x <- iter, body` (2 args, first is `<-` BinOp) | first arg is BinOp with operator `<-` | shape-specific (see below) |

Shapes 1-3 are pure source-level desugarings.  Shape 4 is the only
one that needs help from the type system, and even then only at
compile time.

### Why syntactic dispatch, not runtime tagging

When the elaborator sees `(i < n)` as a Bool-typed expression, it
emits the cond-form `IR_LOOP` directly — same machine code as
hand-written.  When it sees `0..n` (if `..` becomes a stratum
operator), it emits a counter loop.  When it sees `&my_iter args`
where `my_iter` returns a known iterator-type, it emits the
iterator-protocol path.  Each shape's emit cost is exactly what a
hand-written version would cost.

The compiler stays inline-friendly without needing an optimiser.

## The for-each / iterator path (form 4)

Two sub-shapes:

### (a) Known container types — strata desugar to inline counter loops

For `Array<T>`, `String`, `Range`, and any sum-type the strata know
about, the desugar emits a counter loop the user could have
written by hand:

```silicon
&@loop x <- arr, { ... }
# desugars to:
@local _i := 0;
@local _n := &arr_len arr;
&@loop (_i < _n), {
  @local x := &arr_load_i32 arr, _i;
  ...
  _i = _i + 1
}
```

Zero runtime iterator object.  Same emit cost as the indexed loop.

### (b) User-defined iterables — convention deferred until needed

Any value `v` whose type defines an `&T::iter_next` stratum
(signature roughly `(state:Int) -> (done:Int, value:Int, new_state:Int)`)
becomes iterable.  Desugar:

```silicon
&@loop x <- iter_expr, { ... }
# desugars to:
@local _s := &T::iter_init iter_expr;
&@loop 1, {
  @local _r := &T::iter_next _s;
  &@if (_r.done == 1), { &@break };
  @local x := _r.value;
  _s = _r.new_state;
  ...
}
```

This needs tuple-returning calls or an out-pointer convention.
WASM has multi-value results now but Silicon doesn't expose them;
the WASI extern convention (`out_ptr` parameters the host/callee
writes through) is the bridge that already exists in the
language (`src/stdlib/io.si` uses it for `fd_read`).

Critically, this protocol can be added *later*.  Ship (a) for
`Array`, `String`, and `Range` first.  Add (b) only once someone
needs a custom iterable that doesn't fit the built-ins.  The
bootstrap doesn't need iterators at all today.

## On `&@loop 1, body` continuing to mean "loop forever"

Don't break this.  Long-lived loops in the compiler use the
`&@loop 1, { ... &@break ... }` pattern; changing `1`'s meaning
to "single-shot iterator" would silently miscompile them.

The cleaner alternative: introduce the **1-argument form**
(`&@loop body`) as the canonical "loop until `&@break`/`&@return`"
spelling, and have it desugar to `&@loop 1, body`.  Both
spellings keep working; the new one reads better.

If a single-shot loop ever becomes useful, give it its own
spelling (e.g. `&@once body`) rather than overloading `1`.  Note
that single-shot is literally `body` though, so it may never
deserve a keyword.

## Build order

1. **`&@loop body`** — 1-arg infinite form.  A desugar stratum, ~5
   lines.  Eliminates the `&@loop 1, { ... }` boilerplate across
   the compiler.
2. **C-style 4-arg form** — `&@loop init; cond; step, body`.
   Another desugar stratum.  Now the most common counter loop is
   `&@loop i := 0; i < n; i = i + 1, { body }` without
   `@local`-and-increment boilerplate.  No new IR.
3. **`Range` stratum** — `0..n` as `&Range::new 0, n`.  Then
   `&@loop x <- 0..n, body` is the natural counter for-each.
4. **`Array` for-each** when arrays get used heavily.
5. **User iterator protocol (b)** only when (1)-(4) prove
   insufficient.  By then the actual ergonomic gaps will be
   visible and the design won't be speculative.

The principle: every form has to lower to *the same `IR_LOOP`
primitive* the bootstrap already emits.  Each new sugar is a
strata desugar, not a new compiler concept.  If a proposed form
can't be desugared without adding a new IR node, the design
isn't ready.

## Sharp edges

- **`<-` vs `=` ambiguity.**  If `<-` becomes the for-each marker,
  confirm the parser doesn't confuse it with `=`/`:=`.  Silicon
  uses `:=` for declaration and `=` for mutation, so `<-` should
  be unambiguous, but it needs lexer attention (currently `<` and
  `-` are separate tokens; `<-` would need to be a single token
  or grouped at parse time).

- **`@break` / `@continue` inside desugared bodies.**  With the
  4-arg `&@loop init; cond; step, body`, does `@continue` skip
  the rest of `body` AND `step`, or just `body`?  C semantics
  say "do the step before re-checking cond."  Pick a rule,
  document it, make sure the desugar respects it.  Simplest
  rule: `@continue` jumps to the start of the desugared body
  (which includes the step at the end), matching C.

- **Iterator protocol's death by tuple.**  Until Silicon exposes
  multi-value returns or a `@type` mechanism with field access,
  every `iter_next` either uses out-pointers (works today, ugly)
  or returns a packed `i64` (doesn't work today — Silicon-Core
  is `i32`/`f32` only).  Defer protocol (b) until there's a
  cleaner story.

- **Don't add a separate `for` keyword.**  The single-`@loop`,
  multiple-shape dispatch is the win.  Adding `@for` would
  duplicate the loop-stack machinery and force users to choose
  the right keyword based on shape, defeating the unification.

## What this design does NOT solve

- **Generators / coroutines.**  Yield-style iterators that pause
  execution mid-body need stack manipulation Silicon doesn't have.
  Out of scope.

- **Iterator combinators** (`map`, `filter`, `fold`).  These would
  build on top of the iterator protocol (b) once it exists.  Not
  needed for the bootstrap.

- **Parallel / concurrent loops.**  Same — wait until effects
  and capabilities land per the bootstrap-plan §7.

## TL;DR

One keyword, four shapes, dispatch at elaboration time, every shape
lowers to `IR_LOOP(cond, body)`.  Iterators are a strata-desugar
contract, not a runtime type, until proven otherwise by a use case
the built-in container strata can't handle.
