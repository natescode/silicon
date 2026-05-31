# Parens as Optional Grouping for Param Lists

A grammar refinement that closes the last source of comma-disambiguation
ambiguity in Silicon's surface syntax. **Parens become an optional
grouping operator** for any function-shaped param list — function
definitions, `$fn` type annotations, and any future construct that has a
comma-separated param list following a typed-identifier slot.

## Motivation

Silicon's grammar uses `,` as the universal list separator: function-call
args, array literals, object literals, tuple literals, generic params,
type args, and function-definition params all separate items with commas.
For all but one of these, the list is bounded by explicit delimiters
(`[]`, `${}`, `$()`, `$[]`), so PEG parsing is unambiguous. The exception
is function-definition params, which have no surrounding delimiters — the
list is "everything between the typed-identifier and the `:=` binding."

The Phase 5 grammar revision (commit `68cbf2a`) added the `$fn`
sigil-type annotation so function types can be expressed as
`:$fn _:R _:T1, _:T2`. The shape mirrors function definitions exactly,
which is good for regularity but inherits the same undelimited-list
property — and now the `,` is overloaded across nesting levels:

```silicon
@fn run a:$fn _:Int _:Int, b:$fn _:Bool _:Float := 0;
```

PEG greedy-matches the inner `sigilFnParams` rule, consuming
`_:Int, b:$fn _:Bool _:Float` as continuation of `a`'s function type
rather than as a separator between outer params. The result: `run`
parses with a single param `a` whose `$fn` signature is wrong.

## Design

Add an **optional paren-wrapped alternative** to every place a
comma-separated param list appears. The grammar tries the paren form
first; absent parens, it falls back to the existing bare form. The AST
shape is identical between the two — `ParamLiteral[]` either way — so
downstream code (typechecker, lowerer, strata) doesn't care which form
the user wrote.

Parens are a **pure grouping operator**: they introduce no new semantics,
they don't change the AST, and they're optional everywhere they appear.
Users opt into them only when they want explicit delimiters — usually for
disambiguation in nested-list contexts, occasionally for readability.

This matches Silicon's existing use of parens for expression precedence
(`"(" ExpressionStart ")"`): a pure grouping operator that the AST
flattens away.

## Grammar Changes

Two productions gain a paren alternative.

### Function definitions

```ohm
Definition = defKw typedIdentifier GenericParams? Params Binding?

Params =
  | "(" ListOf<ParamLiteral, ","> ")"   -- paren
  | ListOf<ParamLiteral, ",">           -- bare
```

The PEG ordering (paren first) means the parser prefers the paren form
whenever the next non-whitespace token after the typedIdentifier is `(`.
When it isn't, the bare form matches as today.

### `$fn` type annotations

```ohm
sigilFnType =
  | "$" identifier space+ typedIdentifier space+ "(" sigilFnParams ")"  -- parenParams
  | "$" identifier space+ typedIdentifier space+ sigilFnParams          -- bareParams
  | "$" identifier space+ typedIdentifier                                -- nullary

sigilFnParams = typedIdentifier (space* "," space* typedIdentifier)*
```

The three alternatives cover: paren-delimited param list, bare param
list (the current Phase 5 syntax), and no params (nullary function type).
PEG-ordered so paren wins when present.

### Optional nullary parens

For consistency, both Params and sigilFnType also accept an empty paren
pair `()` to denote "no params explicitly":

```silicon
@fn empty:Int () := 0;
@let cb:$fn _:Int () := some_thunk;
```

This is the same one-form-fits-all property the rest of the grammar
already has (a 0-element ListOf matches nothing).

## AST and toAst Changes

The factory shape for both forms is identical — a flat `ParamLiteral[]`
for function definitions, a `TypedIdentifier[]` for `$fn` types. The
toAst handlers for the new paren alternatives just unwrap the
delimiters and produce the same AST as the bare form.

```ts
Params_paren(_lp, list, _rp) {
    return list.asIteration().children.map(c => c.toAst())
},
Params_bare(list) {
    return list.asIteration().children.map(c => c.toAst())
},

sigilFnType_parenParams(_dollar, ident, _ws1, retSlot, _ws2, _lp, params, _rp) {
    return buildFnTypeAnnotation(ident, retSlot, params.toAst())
},
sigilFnType_bareParams(_dollar, ident, _ws1, retSlot, _ws2, params) {
    return buildFnTypeAnnotation(ident, retSlot, params.toAst())
},
sigilFnType_nullary(_dollar, ident, _ws1, retSlot) {
    return buildFnTypeAnnotation(ident, retSlot, [])
},
```

Where `buildFnTypeAnnotation` is a small helper that assembles the
`TypeAnnotation` with `fnReturn` + `fnParams`. No new factory entries
in `astNodes.ts` are needed — the existing `ASTFactory.fnTypeAnnotation`
and the existing typedIdentifier/Parameter shapes work unchanged.

The current `Definition` handler in toAst.ts that builds the
`params` array already accepts a `ParamLiteral[]`; it just sources from
either `Params_paren` or `Params_bare`.

## Surface Forms

Existing bare forms continue to work unchanged.

```silicon
;; Function definitions
@fn add:Int a:Int, b:Int := a + b;            ;; existing — still valid
@fn add:Int (a:Int, b:Int) := a + b;          ;; new paren form, same meaning
@fn nullary:Int := 0;                         ;; existing — no params
@fn nullary:Int () := 0;                      ;; new paren form

;; $fn type annotations
@let cb:$fn _:Int _:Int := some_fn;            ;; existing
@let cb:$fn _:Int (_:Int) := some_fn;          ;; new paren form
@let thunk:$fn _:Int := zero;                  ;; existing — nullary
@let thunk:$fn _:Int () := zero;               ;; new explicit nullary parens

;; Disambiguation case — the entire reason this exists
@fn dispatch (a:$fn _:Int (_:Int), b:$fn _:Bool (_:Float)) := 0;
@fn dispatch a:$fn _:Int (_:Int), b:$fn _:Bool (_:Float) := 0;
;; Either is fine; the inner parens are what disambiguate.
```

## Migration

**Zero forced rewrites.** Every existing `.si` file in `src/` continues
to parse and produce the same AST. The paren form is purely additive —
users opt into parens where they want them.

This is a deliberate non-goal: making parens mandatory everywhere would
be more "regular" in one sense but creates a large mechanical migration.
The optional-grouping design is regular in a
different sense: parens are a *universal* grouping operator — the same
operator that already groups expressions for precedence — applied
consistently to any list-shaped construct that wants explicit delimiters.

## Test Plan

Add to `src/grammar/grammar-revision.test.ts` (or a sibling
`parens-grouping.test.ts` if the count grows):

- `@fn name:R (a:T, b:U) := body` parses with two params; AST shape
  matches the bare-form equivalent byte-for-byte.
- `@fn nullary:R () := body` parses with zero params.
- `:$fn _:R (_:T1, _:T2)` produces a Function([T1, T2], R) SiliconType.
- `:$fn _:R ()` produces a Function([], R) (nullary with explicit parens).
- **Disambiguation regression test:** the multi-callback case
  `@fn dispatch a:$fn _:Int (_:Int), b:$fn _:Bool (_:Float) := 0`
  parses with two outer params, each carrying a one-param $fn type.
  This is the test that *only* passes with the paren form — proves the
  feature delivers the disambiguation it promises.
- Redundant single-param parens: `@fn add:Int (a:Int) := a` and the
  bare equivalent produce identical ASTs.
- Mixed forms in one program (some functions with parens, some
  without) all parse cleanly.

## Estimated Effort

~45 minutes end-to-end:

| Step | Time |
|------|------|
| Grammar edits (silicon-official.ohm) | 5 min |
| toAst handlers for new alternatives | 10 min |
| Tests (6-8 new cases) | 15 min |
| 5d-3 doc note retraction in v1-user-stories | 5 min |
| Single commit + suite run for regressions | 10 min |

No AST shape changes, no factory additions, no downstream
typechecker/lowerer changes. The risk surface is contained to the
parser layer.

## Out of Scope

- **Parens in the future self-hosted compiler.** The Silicon-in-Silicon
  bootstrap will inherit this grammar when it is rewritten; until then
  the `src/` TypeScript compiler ships the refinement standalone.
- **Required parens (the "perfect regularity" variant).** Discussed and
  intentionally deferred — the migration cost is high and the optional
  form is already regular in a different sense (parens are the universal
  grouping operator applied consistently).
- **Parens around type annotations themselves** (e.g. `:(Result[Int, Int])`).
  Type args already have their own delimiters (`[]`); wrapping the whole
  annotation in parens is redundant and not addressed here.
