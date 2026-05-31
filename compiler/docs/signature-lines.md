# Separate Signature Lines — Design Proposal

**Status:** proposal, not implemented. Captures a grammar change that moves a
function's *type* out of its parameter list and onto a preceding **signature
line**, leaving parameters as bare names. Resolves the long-standing mess of
function-typed parameters colliding with the comma-separated parameter list.

**Motivation.** Today a parameter carries an inline type, and a function-typed
parameter must spell that type inline with `$fn`:

```silicon
@fn run cb:$fn _:Int _:Int, _:Float, _:Bool := 0;
```

The function type's own (comma-separated) parameter list collides with the
enclosing parameter list — the inner `sigilFnParams` greedily eats every
following comma, so a function-typed parameter effectively swallows every
parameter after it. There is no delimiter-free way to say "this comma ends the
callback's domain and starts the next parameter."

The fix is to stop forcing a function's *type* and its *definition* to share one
grammar. A function's type is a contract; its definition is code. Stated
separately — as in Haskell / Elm / PureScript — parameters become bare names
with no inline types, and the collision simply cannot occur.

---

## 1. The core idea

A function is introduced by an **optional** signature line followed by a
definition whose parameters are bare identifiers:

```silicon
\\ apply ((Int -> Int), Int) -> Int
@fn apply func, x := &func x;
```

- `\\ name <type>` is a signature line — name then type by **juxtaposition**, no
  `:` (§3). The `\\` sigil is free — comments are `#` / `##` (grammar lines
  95–96); `\` single-backslash is left in reserve for a future lambda spelling.
- The signature **carries the name** (decided), so it associates with its
  definition by name — not by adjacency. This is what later lets a signature
  exist *detached* from a body (interfaces / protocols / externs, §6).
- Parameter types are read off the signature **by position**: `func` is
  `Int -> Int`, `x` is `Int`, return `Int`.

### The rule that scopes everything: bindings infer, declarations annotate

This is the conceptual line the whole proposal rests on:

| Kind | Form | Types |
|---|---|---|
| **Bindings** — function params, `@let`, `@var` | bare names | inferred; signature line optional (functions only) |
| **Declarations** — struct fields, sum-type variant payloads | `name Type` (juxtaposed) | mandatory — the pair *is* the definition |

The type-carrying `name Type` pair is **not** removed globally. It is removed
from *parameter lists* and the *return-type-on-name* slot. It stays everywhere a
type annotation literally defines a data shape, because there is no separate
"behavior" to hang a signature line on (§5).

---

## 2. The function-type syntax

Signature types use an **arrow** with a parenthesized, tuple-style domain that
matches Silicon's multi-argument call form (`&f a, b`). There is **no
currying / partial application** — consistent with the current "function
pointers, not closures" stance.

```
() -> Bool                  # nullary
Int -> Bool                 # single arg — parens optional
(Int, Int) -> Int           # two args
((Int -> Int), Int) -> Int  # higher-order: a function-typed domain element
(Int, Int) -> Void          # side-effecting — returns Void
```

**Nesting rule (unchanged from prior discussion):** a function type used as a
*domain element* must be parenthesized, so the enclosing comma can never be
mistaken for that inner type's range boundary. This is the *only* place parens
survive — and now they live in the type grammar where arrows read naturally,
never tangled inside a parameter list.

### `Void`, and parens as a pure delimiter (decided)

"Returns nothing" is the built-in type **`Void`** — *not* `()`. This keeps `(`
**strictly a grouping delimiter**: it groups a function domain (`(Int, Int)`),
groups a nested type for the nesting rule (`(Int -> Int)`), groups an expression,
or carries an ascription (§ proposal). It is **never** an atom in its own right.
An empty domain is still written `()` (zero parameters: `() -> Bool`), which is
delimiting zero elements — not denoting a type. A bare `()` is therefore only
valid *as a function domain* (before `->`); standing alone it is an error.

`Void` is a **built-in atom type with exactly one value, also named `Void`**
(the type name and its sole value coincide; no `$` sigil, unlike `@type`
variants — so it is a compiler built-in, not `@type Void := $Void`). It is
zero-width: a `-> Void` function lowers to a WASM/QBE function with no result,
and a block with no trailing expression has type `Void` implicitly — so existing
void code needs no body change, only a `-> Void` in its signature.

> **Naming note.** This is *unit* semantics (one inhabitant) under the name
> `Void`. In ML/Rust/Haskell that type is `Unit`/`()`; C/TS `void` means "no
> value." A future *bottom* type (non-returning `exit`/`panic`) would take the
> name **`Never`**, kept free deliberately.

Generics ride the signature:

```silicon
\\ map[T, U] ((T) -> U, Vec[T]) -> Vec[U]
@fn map f, xs := { ... };
```

---

## 3. Grammar delta

### Removed / changed

- **`:` is deleted as the type-annotation marker, everywhere.** Types are now
  written by **juxtaposition** — a name immediately followed by its type, with
  no separator (Go-style). This frees `:` for a future expression-land use
  (§9). The old `type` rule (`":" …`) is gone; a type is just a `TypeExpr`
  parsed in the position where one is expected.
- `Definition` loses the return-type slot on the name: `typedIdentifier` →
  `identifier`.
- `Params` loses the optional parens (no surrounding `( … )` — keeps `(` a pure
  grouping delimiter, no `()` empty-param-list to collide with the domain
  syntax). It stays *one* comma-list production shared by every def-kind; the
  **type is optional at the grammar level** and the def-kind decides (next bullet).
- `sigilFnType` / `sigilFnTail` / `sigilFnParenForm` / `sigilFnParams` are
  **deleted**. The inline `$fn _:T _:T` form ceases to exist.
- `typedIdentifier` becomes `ParamLiteral = identifier TypeExpr?` (juxtaposition,
  no `:`; type optional). The def-kind enforces the shape, so the asymmetry is
  data-driven, not two grammars:
  - **`@fn`** → every entry must be **bare** (no type). A juxtaposed type is a
    diagnostic: "function params are bare; put the type on a `\\` signature line."
    This is a one-canonical-form choice, *not* a parsing limitation — the
    parenthesized-domain arrow type would parse inline fine.
  - **`@struct` / `@type` variant** → every entry must be **typed** (`name Type`).
    The field declaration has no separable body, so the type is inline (§1, §5).

### Added

```ohm
# A signature is either an ATTACHED prefix of a definition (structurally
# adjacent — no floating signatures possible) or lives inside a block (§6).
Definition =
  | AttachedSig? defKw identifier GenericParams? Params Binding?  -- with body
  | defKw identifier? GenericParams? SignatureBlock               -- block-bodied (@extern/@interface)
AttachedSig    = "\\" namespace GenericParams? TypeExpr  -- juxtaposition: name then type, no ":"
SignatureBlock = "{" AttachedSig* "}"

# Arrow as an optional *suffix* on a type atom keeps this LL(1):
# every TypeExpr starts by parsing a TypeAtom (FIRST = identifier | "("),
# then one-token lookahead on "->" decides function-vs-value.
TypeExpr = TypeAtom ("->" TypeExpr)?
TypeAtom =
  | identifier typeArgs?              -- simple / generic   e.g. Int, Vec[T]
  | "(" ListOf<TypeExpr, ","> ")"     -- domain tuple, or grouping for nesting

# One shared param/field list; the def-kind constrains each entry (above):
#   @fn                      → every ParamLiteral BARE  (TypeExpr absent)
#   @struct / @type variant  → every ParamLiteral TYPED (TypeExpr present)
Params       = ListOf<ParamLiteral, ",">     -- no surrounding parens
ParamLiteral = identifier TypeExpr?          -- juxtaposition; type optional in grammar

# Expression-level ascription is a keyword form (NOT juxtaposition, which is
# ambiguous after an expression; NOT ":", which is now free). Type comes first
# so the parser is unambiguously in type position right after the keyword.
AscribeExpr = "&@as" TypeExpr "," ExpressionStart   # e.g. &@as Option[Int], (&None)
```

Juxtaposition is LL(1) in declaration position: after a field name, one-token
lookahead decides "type follows" (next is `identifier` or `(`) vs. "no type"
(next is `,` / `->` / `:=` / `;` / end). A comma or arrow always closes the
preceding type, so a typed field never bleeds into the next.

Making `AttachedSig` a *prefix of the definition* is what enforces placement
structurally: an attached signature is grammatically glued to its `@fn`, and a
detached signature can appear **only** inside a `SignatureBlock`. A bare
floating `\\` is unparseable — there is no production for it — so the
typo-masking footgun (a misspelled definition name silently becoming an extern)
cannot occur.

A `( … )` atom is only meaningful as a function **domain** (immediately before
`->`) or as grouping of a nested function type; standing alone it is an error
(there is no unit-as-`()` — that role is `Void`, §2). Empty `()`, single
`(T)`, and multi `(T, U)` are one production; which role applies is a semantic
check after parse, not a grammar branch — so the `(` FIRST-set conflict that
would break LL(1) never arises.

`@extern` / `@interface` are **not** hardcoded in the grammar — they are
ordinary def-kinds (`defKw`) whose meaning (external symbol vs. interface
requirement) resolves in the def-expander registry, exactly like `@fn`. The
grammar only knows "a def-kind may take a brace block of signatures."

The LL(1) target (top-down, single-token lookahead, disjoint FIRST sets) is
preserved: signature lines start with `\\`, definitions with `@`, and the arrow
is a suffix decision, never a leading one.

---

## 4. Signature ↔ definition association & checking

- **By name.** A signature `\\ apply …` binds to the definition `@fn apply …`.
- **Arity check.** The signature's domain arity must equal the definition's
  parameter count. Mismatch is a new diagnostic, e.g.
  `E00xx: signature for 'apply' declares 2 parameters, definition binds 3`.
- **Optional (decided).** No signature → the function is fully inferred from
  body and call sites. **HM-lite caveat:** with no let-generalization, a
  *top-level generic* function generally cannot infer a principal polymorphic
  type without its signature. Net effect: signatures are optional for
  monomorphic functions, effectively required for generic ones — which nudges
  annotation onto exactly the functions that benefit.
- **One or the other.** A function uses *either* a signature line (bare params)
  or — transitionally, see §7 — nothing. The two never mix; there is no inline
  param-type form left to mix with.

---

## 5. What keeps a juxtaposed type — and the relocated collision

Struct fields and sum-type variant payloads keep a `name Type` pair
(juxtaposed, no `:`), because the annotation *is* the data definition:

```silicon
@struct Rect w Int, h Int;
@type Shape := $Circle r Int | $Rectangle w Int, h Int;
```

**Watch-out:** a function-typed *field* re-creates the original comma collision,
because it once again sits inside a comma-separated list:

```silicon
@struct Widget onClick (Int, Int) -> Void, label String;
#                      └── parens REQUIRED so this comma can't read as a field separator
```

So inline function types (in fields / payloads) must use the **parenthesized
domain** form. The bare comma-domain shorthand is legal *only* on a signature
line, where nothing encloses it. Same nesting rule as §2, applied consistently.

---

## 6. Signature placement: attached, or in a block (decided)

A signature with no body needs an explicit *reason* it has none. So there are
three placements, each unambiguous:

| Placement | Form | Why no body |
|---|---|---|
| **Attached** | `\\ name type` immediately above its `@fn` | — (has a body) |
| **Extern** | inside `@extern { … }` | symbol is external (FFI) |
| **Interface** | inside `@interface Name[T] { … }` | the *implementer* supplies it |

A bare floating `\\` that is neither attached nor in a block is a **parse
error** (§3 makes it unparseable). Extern-ness is therefore never silently
inferred from a missing body — this is what closes the typo-masking footgun.

### Attached

`AttachedSig` is a grammatical *prefix* of the definition, so it is structurally
glued to its `@fn` — placement and adjacency are enforced by the grammar, not a
lint. The name is repeated (Haskell-style) and must match the definition; the
redundancy doubles as a copy-paste check.

```silicon
\\ apply ((Int -> Int), Int) -> Int
@fn apply func, x := &func x;
```

### Extern — `@extern { … }`

Externs keep an explicit keyword (decided), now as a *block* of detached
signatures rather than a per-line `@extern`:

```silicon
# before
@extern InitWindow width:Int, height:Int, title:String;
@extern IsKeyDown:Bool key:Int;
@extern wasi_snapshot_preview1::fd_write:Int fd:Int, iovs:Int, len:Int, n:Int;

# after
@extern {
    \\ InitWindow (Int, Int, String) -> Void
    \\ IsKeyDown Int -> Bool
    \\ wasi_snapshot_preview1::fd_write (Int, Int, Int, Int) -> Int
}
```

The signature **name** is the external symbol; a `namespace::` name supplies the
wasm import module (as today). Native linkage stays in `sgl.toml [native]`.

### Interface — `@interface Name[T] { … }`

A detached set of required signatures, parameterised by the implementing type:

```silicon
@interface Show[T] {
    \\ show T -> String
}
```

**Scope note:** this proposal lands the interface *block syntax* only — the
hard half (how an implementation is selected and dispatched) is a separate
design HM-lite does not support today (no typeclasses / abilities yet).
`@extern` is the first real consumer of the block form; `@interface` is laid
down now so the grammar doesn't have to change again when dispatch arrives.

### 6.5. What `\\` means, and what params look like (decided)

`\\` is **the signature sigil** — "here is the type/interface of this named
thing" — and it is used for, and *only* for, two namespaces of named
declarations:

| `\\` applies to | Form | Status |
|---|---|---|
| **functions** | `\\ name <type>`, attached or as a block member | **B1** (concrete) |
| **modules** | a module's interface = a block of `\\` member signatures (`@extern { … }`, `@interface { … }`) | **B1** (concrete) |

One consequence is now locked:

- **`\\` is kept uniform inside blocks.** A module's signature literally *is* a
  block of `\\` member signatures, so dropping `\\` inside `@extern` /
  `@interface` would contradict that. One signature grammar everywhere;
  copy-paste a member in or out of a block with no edit.

`\\` is **not** used for types (dropped — no consumer; an abstract/associated
type would only matter once interfaces gain dispatch, and can be revisited
then), nor for locals (inferred) or expression-level annotation (see the
type-annotation-separator decision, §9).

**Parameters are bare-only.** A definition's params are a comma-list of bare
identifiers — `@fn apply func, x := …` — with no surrounding parens. This
matches the paren-free call form (`&f a, b`) and preserves the pure-delimiter
`(` invariant from §2 (optional param parens would resurrect `()` as an empty
parameter list). It is also the reversible choice: optional parens could be
added later without breaking code; removing them after use could not.

---

## 7. Forward-compatibility with `@fn`-as-expression

A separate discussion proposes making `@fn params := body` an anonymous
function *expression* (lambda), with `@fn name …` as sugar for
`@let name := @fn …`. These compose cleanly:

- Signature lines serve **named** functions (the common case — and where the
  collision lived).
- **Anonymous** `@fn` lambdas lean on inference; the rare case that needs an
  explicit type uses an arrow type in an ascription `(expr : Int -> Bool)`.
- The arrow type from §2 is exactly the inline form lambdas would annotate
  with — but it no longer has to coexist with a parameter list, so it stays
  clean.

This proposal does **not** depend on the lambda work and can land first.

---

## 8. Migration

Full plan in [`signature-lines-migration.md`](signature-lines-migration.md).
In brief — this is cross-cutting, not a localized tweak:

1. **Grammar** (`src/grammar/silicon-official.ohm`) — §3.
2. **AST** (`src/ast/toAst.ts`) — new `Signature` node; `Params` → bare
   identifiers; thread the signature's positional types onto the definition.
3. **Elaborator / def-expanders** (`src/strata/defExpanders.ts`,
   `src/elaborator/`) — `@fn` / extern lowering reads param types from the
   associated signature rather than the param list.
4. **Typechecker** (`src/types/typechecker.ts`) — resolve signature → param
   types by position; arity-check signature vs definition; preserve the HM-lite
   optional-signature behavior in §4.
5. **Corpus rewrite** — **every `.si` file** under `src/strata/` and
   `src/stdlib/`, plus `examples/` and `.si` test fixtures, is written in
   inline-type syntax and must be migrated. Large but mechanical; worth a
   codemod.
6. **Docs** — `grammar.ebnf`, `struct-design.md`, `targets.md` (extern
   patterns), `extern-out-pointer.md`, `getting-started.md`.

---

## 9. Open decisions

Resolved:

- **Signature placement** — attached-prefix or block (§6).
- **Extern footgun** — closed; detached signatures exist only inside
  `@extern` / `@interface` blocks.
- **Unit spelling** — the "returns nothing" type is the built-in **`Void`**
  (one inhabitant, itself), *not* `()`, keeping `(` a pure grouping delimiter
  (§2).
- **Optional param parens** — **bare-only** (§6.5); preserves the pure-delimiter
  `(` invariant and is the reversible choice.
- **`\\` inside blocks** — **kept uniform** (§6.5); a module's signature *is* a
  block of `\\` members.
- **`\\` scope** — the signature sigil applies to **functions and modules
  only** (§6.5). Types dropped.

- **Type-annotation separator** — **`:` is removed entirely** as the
  type-annotation marker, replaced by:
  1. **signatures** → juxtaposition `\\ name type`,
  2. **struct / variant fields** → juxtaposition `name Type`, and
  3. **ascription** → keyword `&@as Type, expr` (§3; juxtaposition is ambiguous
     in expression position, and `:` is now free).
  `:` is reserved for a future **expression-land** use (object/map literals,
  labelled args — see the literals note below); it cannot collide with
  juxtaposed types, which live only in declaration/signature position.

Deferred (not blocking B1):

- **Interface dispatch** — block syntax lands now; the selection/dispatch
  mechanism is a later design (no typeclasses in HM-lite today).
- **Literal syntax revisit** — with `:` freed, object/map literals (currently
  `key = value`) may move to `key: value`, and labelled args become possible.
  Out of scope for this proposal; its own future change.

---

## 10. Before / after

```silicon
# ── before ───────────────────────────────────────────────
@fn option_unwrap_or[T] opt:Option[T], dflt:T := { ... };
@extern InitWindow width:Int, height:Int, title:String;
@fn run cb:$fn _:Int _:Int, _:Float, _:Bool := 0;   # the collision

# ── after ────────────────────────────────────────────────
\\ option_unwrap_or[T] (Option[T], T) -> T
@fn option_unwrap_or opt, dflt := { ... };          # attached signature

@extern {                                            # detached, explicit keyword
    \\ InitWindow (Int, Int, String) -> Void
}

\\ run ((Int) -> Bool, Float, Bool) -> Int           # no collision: domain is parenthesized
@fn run cb, f, b := 0;
```
