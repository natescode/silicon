# HM-lite — Silicon's Type Inference

**Goal:** Roc-style type inference for Silicon: declared polymorphism on
`@fn[T]` / `@type[T]` plus unification at call sites, no let-generalisation
for locals, no rank-N, no polymorphic recursion.  The smallest piece of HM
that still feels like HM, scoped to grow into full Roc-style later.

**Status:** Shipped in `src/` as of 2026-05-22.  Not yet ported to `boot/`.

**Implementation files:**
- `src/types/unify.ts` — pure primitives (unify, applySubst, occursIn,
  instantiate, makeFreshGen, UnifyError).  No dependency on the typechecker.
- `src/types/types.ts` — `Scheme`, `SiliconType` (Sum gained optional `typeArgs`).
- `src/types/typechecker.ts` — wires unification into call-site checking,
  annotation reconciliation, and match-arm checking.
- `src/ast/matchArms.ts` — companion piece for the @match arm-expression form.

**Test coverage:** 38 unit tests in `unify.test.ts`, 33 integration tests in
`hm-lite.test.ts`.

---

## What HM-lite gives you, by example

```silicon
# Generic functions — call sites infer the type variable from args
@fn id[T] x:T := x;
@fn use_i:Int   := (&id 42);            # T = Int  inferred
@fn use_f:Float := (&id 3.14);          # T = Float inferred at this call site
                                        # (each call gets fresh ?Ti)

# Parametric sum types — `Option[Int]` and `Option[Float]` are distinct
@type Option[T] := $Some value:T | $None;
@fn give_int:Option[Int]     := (&Some 42);     # arg type pins T
@fn give_float:Option[Float] := (&Some 3.14);   # different T per call
@fn empty:Option[Int]        := (&None);        # annotation pins T (no arg)

# Generic functions over generic types — T flows through nested calls
@fn unwrap_or[T] opt:Option[T], dflt:T := dflt;
@fn use:Int := (&unwrap_or (&Some 42), 0);      # T = Int via Some arg
@fn use2:Int := (&unwrap_or (&None), 7);        # T = Int via dflt arg

# Pattern matching over generic types — field bindings get the right type
@fn unwrap_or_match[T] opt:Option[T], dflt:T := {
    &@match opt,
        $Some v => v,        # `v` binds as T, not hardcoded Int
        $None => dflt
};
```

Errors look like this:

```
@fn want_int x:Option[Int] := 0;
@fn give_float:Option[Float] := (&Some 1.0);
@fn bad:Int := (&want_int (&give_float));
                                ↑
        Mismatch: 'want_int' arg 0: expected Option[Int], got Option[Float]
```

---

## The data shapes

### `SiliconType` (extended)

```typescript
type SiliconType =
    | { kind: 'Int' | 'Int64' | 'Float' | 'String' | 'Bool' | 'Void' | 'Unknown' }
    | { kind: 'Array';    element: SiliconType }
    | { kind: 'Function'; params: SiliconType[]; result: SiliconType }
    | { kind: 'Distinct'; name: string; underlying: SiliconType }
    | { kind: 'Sum';      name: string; variants: string[]; typeArgs?: SiliconType[] }
    | { kind: 'Variable'; name: string }
```

The Sum's `typeArgs` field is the one thing that makes parametric sums work.
`Option[Int]` is `{ kind: 'Sum', name: 'Option', variants: [...], typeArgs: [{kind:'Int'}] }`.
Without `typeArgs`, two Sums with the same name are equal — that's the
non-parametric / legacy case.

### `Scheme`

```typescript
interface Scheme {
    tvars: string[]
    type:  SiliconType
}
```

A polymorphic type bound over a list of type variables.  `id : ∀T. T → T` is
`{ tvars: ['T'], type: FunctionOf([Variable('T')], Variable('T')) }`.  In
practice schemes don't have a dedicated runtime representation — the
typechecker recovers them on-the-fly from registered `FunctionSig`s by
walking for free `Variable`s.

### `Subst`

```typescript
type Subst = Map<string, SiliconType>
```

Maps type-variable names to the types they've been unified with.  Threaded
through unification and applied via `applySubst`.

### `FreshGen`

```typescript
interface FreshGen {
    next(prefix?: string): SiliconType
}
```

Counter-backed generator for fresh type variables.  Each call to `instantiate`
needs its own fresh names so two independent calls to `id` don't share `T`.

---

## The five core operations

All live in `src/types/unify.ts` and are pure.

### `unify(a, b, subst) → subst | throw UnifyError`

Make `a` and `b` equal by extending the substitution.  Rules in order:
1. Apply current subst to both sides.
2. `Unknown` unifies trivially with anything (suppresses cascading errors).
3. A `Variable` unifies with anything (subject to occurs check) — bind it.
4. Same-kind primitives unify trivially.
5. Same-kind compound types (`Array`, `Function`, `Sum`, `Distinct`) unify
   structurally — same arity, then unify pointwise.
6. Anything else throws `UnifyError`.

### `applySubst(t, subst) → SiliconType`

Walk `t`, replacing every bound `Variable` with the type it's mapped to.
Resolves chains (`?T1 ↦ ?T2 ↦ Int` → `Int`).  Has a short-circuit for
identity bindings (`T ↦ T`) so they don't infinite-loop — see "Bugs avoided"
below.

### `composeSubst(s2, s1) → subst`

Right-to-left composition.  `(s2 ∘ s1)(t) = s2(s1(t))`.

### `occursIn(name, t) → bool`

True if `Variable(name)` appears anywhere inside `t`.  Used by unify's
bind-variable step to prevent `T = Array[T]` and similar infinite types.

### `instantiate(scheme, fresh) → SiliconType`

Replace each of the scheme's bound `tvars` with a fresh `?Ti` from the
generator.  Returns the substituted type.  Monomorphic schemes (`tvars: []`)
return the type unchanged.

---

## How the typechecker uses it

### Call sites — `checkPolymorphicCall`

For every call to a user-defined function, the typechecker:

1. Looks up the registered `FunctionSig` for the callee.
2. Walks the sig collecting free `Variable`s — these are the implicit tvars.
3. If there are no tvars, falls back to strict `typeEquals` (existing behaviour
   preserved for monomorphic code).
4. Otherwise: builds a fresh substitution `{ T → ?T1, U → ?U1, … }`, applies
   it to the sig's params and result.
5. Unifies each instantiated param with the corresponding arg type,
   accumulating the substitution.
6. Returns `applySubst(instResult, subst)` as the call's type.

Implementation: `src/types/typechecker.ts:checkPolymorphicCall`.

### Annotation reconciliation

When a definition has both an annotation and a body
(`@fn nothing:Option[Int] := (&None);`), the body type might be polymorphic
(`Option[?T1]`) and need to be pinned by the annotation.  The typechecker
calls `unify(annotated, bodyType)` instead of `typeEquals` — if they unify,
the body's free vars get bound; if not, an annotation-mismatch error fires.

Implementation: `src/types/typechecker.ts:checkDefinition`, around the
"Reconcile annotation with body" comment.

### `@match` arms — `typeOfMatchCall`

Match arms thread a local substitution through arm-by-arm:
- Each pattern unifies against the discriminant type.
- Each arm body unifies against the accumulated result type.

The substitution stays local to the match — once `typeOfMatchCall` returns,
the bindings learned inside don't propagate outward.  That's intentional for
HM-lite: each match instance gets its own type-variable scope, no
let-generalisation.

Implementation: `src/types/typechecker.ts:typeOfMatchCall`.

### Variant pattern field bindings — `resolveVariantFieldTypes`

`preRegisterRecordSumType` stashes per-variant schemes:

```typescript
ctx.variantSchemes: Map<string, { tvars: string[]; fields: { name: string; type: SiliconType }[] }>
```

keyed by `"Option::Some"`.  At pattern-bind time, `resolveVariantFieldTypes`
looks up the variant's scheme, builds a substitution from the discriminant's
typeArgs (e.g. `T → Int` when matching on `Option[Int]`), and applies it to
each declared field type.  That's what makes `$Some v` bind `v:Int` for
`Option[Int]` and `v:Float` for `Option[Float]`.

Implementation: `src/types/typechecker.ts:resolveVariantFieldTypes`,
`preRegisterRecordSumType`.

---

## Bugs avoided (documented for future-you)

### Identity-binding infinite recursion

`applySubst` resolves chains recursively.  If a substitution contains
`{ T → Variable('T') }`, naive recursion loops forever.  This legitimately
arises when a parametric variant scheme's tvar shares the name of the
discriminant's own type-arg variable — `resolveVariantFieldTypes` builds
exactly that substitution.

Fix: short-circuit in `applySubst`'s `Variable` case when `bound.kind ===
'Variable' && bound.name === t.name`.  Regression test:
`unify.test.ts:'identity binding T ↦ T does not infinite-loop'`.

### Variant field bindings hardcoded as `Int`

Before the variant-scheme fix, `checkMatchArgs` set every pattern-bound
field as `TypeInt`.  This worked for `Option[Int]` by accident but broke
`Option[Float]`.  Fixed by routing through `resolveVariantFieldTypes`.

---

## What's deliberately NOT in HM-lite

- **Let-generalisation.**  `@let id := \x. x; …` would NOT make `id`
  polymorphic.  Schemes only come from syntactic `[T]` declarations.
- **Rank-N polymorphism.**  No `(∀T. T → T) → Int`-style higher-rank.
- **Polymorphic recursion.**  A recursive call inside `@fn foo[T] …`
  uses the same instantiation as the outer call.
- **Value restriction.**  Not implemented; relevant once we have side-effects
  in expression position.
- **Row polymorphism.**  Records-as-extensible aren't a thing yet.

These are all Roc-style restrictions — keeps the inference algorithm small,
errors predictable, and the path to "full Roc" open without architectural
churn.

---

## Extension path toward full Roc

When the constraints above start to bite:

1. **Let-generalisation:** after typechecking a definition, generalise its
   inferred type by quantifying over any free vars not in the surrounding
   environment.  Store the resulting scheme.  Maybe 50–100 lines.
2. **Value restriction:** restrict generalisation to syntactically-pure
   expressions to keep ML-style mutable refs sound.  ~30 lines.
3. **Opaque types:** Roc-style abstraction.  Touches `Distinct`-like
   constructs; ~100 lines.
4. **Abilities (Roc's type class equivalent):** the big add.  Constraint-
   based extension to unify; weeks of work.

None of these break the existing primitives in `unify.ts` — they extend the
typechecker's usage of them.  HM-lite is the foundation, not the destination.

---

## Adding a new typed form

If you're adding a new strata-driven keyword or operator that should
participate in type inference, the recipe is:

1. **Register the form's scheme** in the stratum's `on::decl` handler (or
   in `preRegister*` if it's a built-in).  Use `Variable('T')` for type
   parameters in the sig.
2. **At call/use sites**, the existing `checkPolymorphicCall` path will
   detect free Variables and route through unification automatically.  No
   per-form work needed.
3. **For pattern-binding forms** (like `@match` variant destructure), stash
   field types in `ctx.variantSchemes` (or an equivalent side-table) and
   resolve them at bind time using the discriminant's typeArgs.

The point is: HM-lite is plumbing.  New language forms shouldn't need to
re-implement inference.

---

## See also

- `docs/strata-2.0-spec.html` — the Strata 2.0 spec.  HM-lite is the type-
  system layer that lets generic strata (`@generic`, `@type[T]`) typecheck.
- `docs/comptime-via-compilation.md` — the dissolution plan for the strata
  body interpreter.  HM-lite is orthogonal: it's how user code typechecks,
  not how strata bodies execute.
- `src/types/hm-lite.test.ts` — the lived spec.  Read these tests for
  worked examples of every claim above.
