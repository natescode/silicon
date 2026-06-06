# ADR 0020 — Odin-inspired grammar: bare definitions, always-parens calls, drop the `&` call sigil

- **Status:** Proposed
- **Date:** 2026-06-05
- **Deciders:** NatesCode
- **Related:** ADR 0010 (grammar targets LL(1)) · ADR 0011 (borrow checker / capability model — the `@mut` sketch this realizes) · ADR 0014 (global/local bindings — partially superseded) · ADR 0016 (loop-over-iterables / control-flow-as-calls) · `docs/grammar.ebnf` (the contract this changes) · `compiler/CLAUDE.md` ("grammar changes are last-resort and need discussion first" — this ADR is that discussion) · [[silicon-line-independent-parsing]] · [[silicon-mutability-capability-model]] · [[silicon-gradual-memory-management-inspiration]] · `tools/migrate-adr0020.ts` (migration codemod)

## Context

Silicon's surface syntax leans on **leading sigils** to classify and disambiguate
each construct (`docs/grammar.ebnf`):

- `&` is the **call sigil**: every call is `&callee args` (paren-free,
  comma-separated args) — `&add 1, 2`, `&print 'hi'`, `&@if c, {a}, {b}`.
- `@`-keywords mark **definition kinds**: `@fn`, `@global`, `@local`, `@type`,
  `@struct`, `@enum`.
- `$` marks variant declarators and collection literals.
- `\\` carries the type signature on the preceding line; `:=` binds; `=` reassigns.

The grammar is already LL(1) (ADR 0010) and already supports paren-free comma
calls. The motivation for revisiting it is **cleanliness and consistency**: the
language really has only three core constructs — definitions, function calls, and
binary-operator expressions — and the sigil density (especially `&` on *every*
call, and an `@`-keyword on *every* definition) obscures that. The cited north
star is Odin, whose grammar reads cleanly.

A multi-agent investigation (recorded in the session that produced this ADR)
established the key facts that shaped the decision:

1. **Odin's cleanliness is not from leading sigils.** Odin has *zero* leading
   line markers. Its trick is an **infix** disambiguator: read an identifier,
   peek one token — `:` ⇒ declaration, else ⇒ expression. Calls are *always*
   parenthesized (`add(2,3)`). The leading-sigil instinct is the opposite of
   what makes Odin parse cleanly.
2. **Paren-free multi-arg calls are the real source of ambiguity.** With no
   parens, an argument list has no terminator, so `add 2,3 + 4` silently means
   `add(2, 3+4)`, and a nested call `f &g 1, 2` silently means `f(g(1,2))`.
   Every paren-free-application language (ML, Haskell, Nim) either keyword-guards
   definitions or restricts paren-free calls to dodge exactly this.
3. **An existing constraint:** Silicon parses each line independently (Zig-style)
   as the foundation for incremental/parallel parsing ([[silicon-line-independent-parsing]]).

`docs/grammar.ebnf` declares the syntactic skeleton **fixed** (§"What this is
NOT", lines 339–347, and the strata boundary, lines 349–382): "The grammar will
NOT be extended to add new keyword tokens… New language features ride the
existing Definition and FunctionCall forms." It even names `@global x := …`
vs `x = …` as a purity change it deliberately did *not* make. This ADR is a
**deliberate, scoped exception** to that freeze — it changes the skeleton — which
is why it exists as an ADR rather than a strata entry.

## Decision

Adopt an Odin-inspired surface governed by one principle:

> **Bare is the common case; a `@`-prefixed keyword is the reserved special
> case.** Every reserved word is `@`-prefixed, so every *bare* identifier is
> freely the user's.

Concretely:

1. **Definitions are the default, unified, and keyword-free.** One form:
   `name params? := value`. The *kind* is inferred — params present (or a lambda
   RHS) ⇒ **function**; otherwise ⇒ **value** (a module constant at top level, a
   local inside a block). Drop `@fn`, `@global`, `@local`, `@struct`, `@enum`.
2. **Calls are always parenthesized.** `add(2, 3)`. `(` after a primary is a
   call; `(` in primary position is grouping. **Paren-free calls are removed.**
3. **The `&` call sigil is removed entirely.** A bare expression is a legal
   statement; calls carry their own parens; nothing needs `&`. (Always-parens
   makes `&` redundant — see Options.)
4. **Function parameters are bare-only** (`add a, b := …`). The parenthesized
   param form is removed, so `name(...)` is *unambiguously* a call and
   `name a, b` is *unambiguously* a definition with parameters.
5. **Immutable by default; `@mut` marks a mutable binding.** `x := 0` is
   immutable; `@mut x := 0` is mutable; `x = x + 1` reassigns (legal only on a
   `@mut` binding). Position decides *storage* (top-level global vs in-block
   local), never *mutability*. This realizes ADR 0011's `@mut` and supersedes
   ADR 0014's `@global`/`@local` surface.
6. **`@type` marks a type definition** and switches the RHS into *type context*.
   In type context `{ x Int, y Int }` is a struct, `$A … | $B …` is a variant
   sum, and a bare `TypeExpr` is an alias (`@type Meters := Int`). In value
   context `{ … }` is always a block. One marker resolves type-vs-value,
   struct-vs-block, and restores bare aliases — no `rec{}`/`sum{}` formers needed.
7. **`@` stays for built-in intrinsics / control flow.** `@if(c, {a}, {b})`,
   `@loop(cond, {b})`, `@match(x, …)`, `@return`, `@defer`, `@break`,
   `@continue`. These are ordinary parenthesized calls (per ADR 0016 they already
   desugar from `FunctionCall`); keeping `@` marks them as language builtins and
   prevents a user definition from shadowing them.
8. **`@extern` / `@export` / `@platform` are modifiers on the `\\` signature
   line.** `\\ @extern puts (String) -> Int;` is a complete, body-less
   declaration; `@extern` documents that the implementation is supplied
   externally. `@export`/`@platform(...)` prefix a normal signature.
9. **Indexing uses `[]`.** `xs[i]` reads; `xs[i] = v` assigns. This gives
   element/map assignment a home that does not collide with call syntax.

**Type annotations are space-separated, no colon** — `\\` signature lines carry
function types positionally (`\\ add (Int, Int) -> Int`); struct fields and variant
payloads are `name Type` (`x Int`, `$Some value T`); params are bare with the type on
the `\\` line. `:` stays reserved for `:=` and `::` only — consistent with the
"minimal sigils" ethos. This is exactly what `docs/grammar.ebnf` and all existing code
already do; note that the current `sgl fmt` formatter emits `:Type` (which the parser
rejects, so its output does not re-parse) — that is a pre-existing formatter bug, not
the canonical form. See §Migration.

The **line-independence foundation is reframed** from "byte-1 O(1) line
classification" to **statement-local, single-pass, no-backtrack, no-symbol-table
classification** (the property that actually enables sharded/incremental
parsing). Byte-1 holds for the `@…`/`\\`/`##`/`{`/`}` kinds; bare identifier-led
lines resolve def/reassign/expression with one token of left-factored lookahead
past the LHS — exactly today's `ItemTail`/`BlockTail` behaviour. Byte-1 O(1) is
*not* pursued: it would require re-adding a leading sigil to every bare line, and
its only marginal benefit (lexer-free pre-pass classification) is already covered
by the brace-matching shard scan.

### What it looks like

```silicon
\\ Option[T]
@type Option[T] := $Some value T | $None;

\\ Point
@type Point := { x Int, y Int };

\\ unwrap_or [T] (Option[T], T) -> T
unwrap_or opt, default := @match(opt,
    $Some v => v,
    $None   => default);

\\ fizzbuzz (Int) -> Int
fizzbuzz n := {
    @mut i := 1;
    @loop(i <= n, {
        by3 := i % 3 == 0;
        by5 := i % 5 == 0;
        @if(by3,
            { @if(by5, { print("FizzBuzz") }, { print("Fizz") }) },
            { @if(by5, { print("Buzz") }, { print_int(i) }) });
        i = i + 1
    });
    0                 # block value — trailing expression, no ';'
};

\\ @extern puts (String) -> Int;   # body-less: implementation is external

main := { fizzbuzz(15) };
main();
```

## Options considered

### Disambiguator: leading `&`/`$` vs infix `:=` vs keep current

- **Leading-sigil (the original instinct):** mark each line kind with a leading
  sigil. *Rejected as the primary mechanism* — it is the opposite of Odin, and
  with always-parens it is redundant (below).
- **Infix `:=` (chosen, Odin-style):** the token after the name classifies the
  line (`:=` def, `=` reassign, `(` call, operator/none expression). Clean,
  keyword-free, single-pass. *Chosen.*
- **Keep current grammar:** least churn; honors the `grammar.ebnf` skeleton
  freeze. *Rejected* — it does not deliver the cleanliness goal; `&`-on-every-call
  and `@`-on-every-def remain.

### Calls: always-parens vs paren-free vs paren-for-multi-arg

- **Always-parens (chosen):** `add(2,3)`. Eliminates the arg-terminator
  ambiguity, the greedy-arg trap, and comma overloading **and** makes the `&`
  sigil unnecessary — a call is recognizable by its `(`, a definition by `:=`.
  *Chosen.* It is the single decision that makes "drop `&`" safe.
- **Paren-free (status quo):** clean-looking but reintroduces unbounded lookahead
  and the silent `add(2, 3+4)` mis-parse. *Rejected.*
- **Parens only for ≥2 args (Nim):** middle ground. *Rejected* for being a
  special case where a uniform rule is cleaner.

### Drop `&` vs keep `&` on expression-statements

- **Drop `&` (chosen):** once calls are always-parenthesized, `&` classifies
  nothing the post-LHS token doesn't already classify. Removing it yields the
  Odin-clean surface and removes `&` from every call site. *Chosen.*
- **Keep `&` on bare expression-statements:** preserves a "runs for effect" cue
  and a byte-1 hint for those lines. *Rejected* — the cue is marginal and the
  byte-1 hint is not worth a sigil on every statement (see §Decision reframe).

### Mutability: `@mut` vs keep `@local`/`@global` vs infer

- **Immutable default + `@mut` (chosen):** completes ADR 0011's sketch; keeps
  the common (immutable) def bare; mutability is explicit and line-local.
  *Chosen.* (Spelled `@mut`, not bare `mut`, to keep the invariant that every
  reserved word is `@`-prefixed and every bare identifier is user-ownable.)
- **Keep `@local`/`@global` (ADR 0014):** smallest semantic change but re-adds a
  keyword to every binding and undercuts "definitions are bare." *Rejected.*
- **Infer mutability from later reassignment:** breaks statement-locality (a
  binding's mutability would depend on other lines) and makes mutability a
  function of nesting depth. *Rejected.*

### Type-vs-value: `@type` marker vs `sum{}`/`rec{}` formers vs constructor fns

- **`@type` marker (chosen):** one keyword puts the whole RHS in type context,
  resolving type-vs-value (`$A|$B` vs `$Some(x)`), struct-vs-block (`{…}`), and
  restoring bare aliases — all at once. *Chosen.*
- **`sum{}`/`rec{}` formers:** symmetric and keyword-light but adds two new
  formers and still needs a value/type cue for aliases. *Rejected* in favor of
  the single `@type` switch.
- **Constructors via generated functions only:** removes bare `$` values; larger
  semantic change. *Rejected.*

## Consequences

- **Positive:** the three core constructs become visually obvious; `&` leaves
  every call site and `@fn`/`@local`/`@global` leave every definition. On the
  three real files rewritten during exploration the sigil count fell ~25%
  (fizzbuzz 27→20, calculator 33→28, vec 64→50), and the win grows once nested
  calls stop carrying `&`. The surface reads like Odin/Rust. `@mut` completes the
  ADR 0011 capability arc; `@type` collapses three disambiguation problems into
  one marker.
- **Negative / cost:**
  - This is a **syntactic-skeleton change**, contradicting the `grammar.ebnf`
    freeze and the strata boundary. It is a one-time, deliberate reset of the
    contract, not a precedent for routine grammar edits.
  - **Whole-corpus migration:** every `.si` file (stdlib, strata, examples,
    playground, docs, tests) must be rewritten. Unlike ADR 0014, this is *not* a
    behaviour-preserving rename — call sites lose `&`, defs lose `@fn`/`@local`,
    types gain `@type`/lose `@struct`. A mechanical codemod **exists**
    (`tools/migrate-adr0020.ts`, §Migration) and runs clean over the stdlib.
  - **New lexer tokens:** `\` (lambda opener, distinct from `\\`), and `[` `]`
    in value/lvalue position for indexing. `&` is freed (could become a bitwise
    BinOp later; out of scope here).
  - **Soft-keyword shadowing** of `@if`/`@loop`/etc. is prevented semantically
    (the strata registry reserves the names), not grammatically — unchanged from
    today, since they were already strata keywords.
  - **Byte-1 O(1) is explicitly dropped** as an advertised property (reframed to
    statement-locality). [[silicon-line-independent-parsing]] should be updated
    to match.
- **Deferred / open (must be settled before the relevant feature lands):**
  - **Element/index assignment semantics** (`xs[i] = v`, `m[k] = v`): syntax is
    decided (`[]`); the lowering and capability rules are deferred until mutable
    collections (`Vec`/`HashMap`) land.
  - **`=>` does triple duty** (lambda arrow, match arm, generic BinOp). It parses
    unambiguously but a stray `=>` is never a syntax error, only a semantic one —
    document this.
  - **`@extern` placement:** confirmed as a `\\`-line modifier producing a
    body-less declaration; the parser must treat such a signature as a complete
    Element (no following def).
  - **`@local` → `@mut` is conservative:** the codemod marks every migrated local
    `@mut` (preserving today's mutable-capable semantics); locals never reassigned
    could be bare-immutable. A follow-up linter should demote them — the codemod
    cannot without dataflow.
- **Follow-up work:** (1) the codemod (`tools/migrate-adr0020.ts`, §Migration) now
  preserves comments; remaining nicety is to demote never-reassigned `@mut` to bare;
  (2) fix the `sgl fmt` formatter's `:Type` bug (its output does not
  re-parse) and rewrite `docs/grammar.ebnf` to the EBNF-diff form on acceptance;
  (3) reconcile with ADR 0011 when the
  borrow checker lands (`@mut` + region capabilities); (4) update
  `docs/overview.md`, the tour, and the playground.

## EBNF diff against `docs/grammar.ebnf`

Notation as in the existing file. `[-]` removed, `[~]` replaced, `[+]` added,
`[=]` unchanged.

```ebnf
(* ── Top level ────────────────────────────────────────────────────────── *)
[=] Program   = { Element } ;
[=] Element   = SignatureLine | Item ";" | DocComment ;

[~] Item      = Definition | Assignment | Expression ;   (* same 3-way, new members *)

(* ── Definitions (UNIFIED, keyword-free) ──────────────────────────────── *)
[-] def-kw      = "@" identifier ;                        (* @fn/@global/@local/... GONE *)
[-] Definition  = def-kw [ identifier ] [ GenericParams ] ( SignatureBlock | Params [ Binding ] ) ;

[+] Definition  = [ "@mut" ] BareDef                      (* value or function *)
[+]             | "@type" TypeDef                          (* type, RHS in type context *)
[+]             ;
[+] BareDef     = Namespace [ GenericParams ] [ Params ] ":=" Rhs ;
[+] TypeDef     = Namespace [ GenericParams ] ":=" TypeRhs ;
[+] Rhs         = Lambda | Expression ;                   (* lambda ⇒ FUNCTION, else VALUE *)
[=] Binding     = ":=" Expression ;                       (* retained inside BareDef *)

(* KIND inference (semantic, post-parse):
     Params present  OR  Rhs is Lambda            -> FUNCTION
     "@type"                                       -> TYPE
     otherwise                                     -> VALUE
                                                       (top level ⇒ global const,
                                                        in block ⇒ local)
     "@mut" legal only on a VALUE binding.                                      *)

(* ── Parameters: BARE ONLY (parens are calls/grouping now) ─────────────── *)
[~] Params      = Param { "," Param } ;                   (* dropped the "(" … ")" form *)
[~] Param       = identifier [ TypeExpr ] ;               (* bare, or space 'name Type'; Literal-param form dropped *)

(* ── Type RHS (only reachable after "@type", i.e. in type context) ─────── *)
[+] TypeRhs     = StructType | VariantSum | TypeExpr ;
[+] StructType  = "{" [ TypedField { "," TypedField } ] "}" ;   (* {…} = struct HERE only *)
[+] VariantSum  = VariantCase { "|" VariantCase } ;             (* "|" reuses the BinOp token *)
[+] VariantCase = "$" identifier [ TypedField { "," TypedField } ] ;
[+] TypedField  = identifier TypeExpr ;                         (* "name Type" — space (matches the parser) *)
[-] VariantDecl = "$" identifier { Param } ;                    (* folded into VariantSum/VariantCtor *)

(* ── Reassignment (now with index targets) ────────────────────────────── *)
[~] Assignment  = LValue "=" Expression ;
[+] LValue      = Namespace { IndexSuffix } ;            (* x = v ; xs[i] = v ; m[k] = v *)

(* ── Expressions / calls (ALWAYS-PARENS, no "&") ──────────────────────── *)
[=] Expression  = ExprEnd { BinOp ExprEnd } ;
[~] ExprEnd     = Primary { CallSuffix | IndexSuffix } ; (* postfix call/index chaining *)
[+] CallSuffix  = "(" [ Expression { "," Expression } ] ")" ;
[+] IndexSuffix = "[" Expression "]" ;
[~] Primary     = Literal
[~]             | VariantCtor                            (* $Some ; args via CallSuffix *)
[~]             | Lambda
[~]             | Keyword                                (* @if/@loop/… ; args via CallSuffix *)
[~]             | Namespace
[~]             | Block
[~]             | "(" Expression ")"
[~]             ;
[+] VariantCtor = "$" identifier ;                       (* $None ; $Some(42) via CallSuffix *)
[+] Lambda      = "\" [ Param { "," Param } ] "=>" Expression ;
[=] Keyword     = "@" identifier ;
[-] FunctionCall     = "&" FunctionCallBody ;            (* the "&" call sigil — GONE *)
[-] FunctionCallBody = Keyword CallArgs | Namespace CallArgs ;
[-] CallArgs         = Expression { "," Expression } | (* empty *) ;

(* ── Signature line: optional modifiers; @extern ⇒ body-less decl ─────── *)
[~] SignatureLine = "\\" { Modifier } Namespace [ GenericParams ] TypeExpr ;
[+] Modifier      = "@extern" | "@export" | "@platform" "(" identifier ")" ;
[-] SignatureBlock = "{" { SignatureLine } "}" ;         (* @extern/@interface brace form GONE *)

(* ── Blocks, namespaces, literals, types, identifiers, comments ───────── *)
[=] Block       = "{" { Item ";" } [ Expression ] "}" ; (* trailing expr = block value, no ';' *)
[=] Namespace   = identifier { ("::" | ".") identifier } ;
[=] Literal / ArrayLiteral / ObjectLiteral / TupleLiteral / String/Int/Float/Bool — unchanged
[=] TypeExpr / TypeAtom / TypeArgs / TypedIdentifier — unchanged; type syntax is
[=]     space-separated / positional, NO colon ('\\' lines, 'name Type' fields/payloads).
[=]     ':' stays reserved for ':=' and '::'. (The 'sgl fmt' formatter's ':Type' output
[=]     is a bug — it does not re-parse; the canonical form is space-separated.)
[=] BinOp / operator-char — unchanged ("&" remains a non-operator; now simply free)
[=] DocComment "##", line-comment "#", whitespace — unchanged
```

### LL(1) note (extends `grammar.ebnf` §LL(1))

The `Item` three-way (definition / reassignment / expression-statement) is
left-factored on the leading `Namespace`, generalizing the existing `ItemTail`:

```ebnf
Item       = [ "@mut" ] Namespace ItemTail
           | "@type" TypeDef
           | NonNamespacePrimary { CallSuffix | IndexSuffix } { BinOp ExprEnd }
           ;
ItemTail   = [ GenericParams ] [ Params ] ":=" Rhs           (* definition *)
           | { IndexSuffix } "=" Expression                   (* reassignment *)
           | { CallSuffix | IndexSuffix } { BinOp ExprEnd }   (* expression-statement *)
           ;
```

After the leading `Namespace`, one token decides: a bare `identifier`/`[`(generic)/
`:=` ⇒ definition; `(` ⇒ call (expression-statement); `[`…`]`-then-`=` or `=` ⇒
reassignment; a `BinOp` ⇒ expression. Single token of lookahead past the LHS,
no backtracking — statement-local, as required.

### New tokenizer obligations

`\` (single backslash, lambda — distinct from the `\\` signature token) must be
emitted as its own token; it is legal only after `:=`/in expression position.
`[` `]` are already lexed (generics/type args) and are reused for indexing. The
`@mut`/`@type`/`@extern`/`@export`/`@platform` keywords lex as ordinary
`@identifier`. The `&` token loses its call role and is otherwise unreserved.

## Migration

A codemod is drafted at **`tools/migrate-adr0020.ts`** (non-destructive — writes to
`build/adr0020/`, never touches sources). It is a **parse-then-re-emit** transpiler:
a fork of the production formatter (`compiler/src/fmt/formatter.ts`) that parses each
file with the real parser (`parseToAst`) and re-emits the AST under ADR 0020 rules.
Regex rewriting is not viable for `&name a, b` → `name(a, b)` — the paren-free
argument list has no terminator, so the argument structure must come from the parsed
tree.

Three emit changes vs the formatter; everything else passes through unchanged:

1. **Definition keyword** — `@fn`/`@global` → bare; `@local`/`@var` → `@mut`;
   `@struct` → `@type Name := { fields }`; `@type` kept.
2. **Calls** — `&name a, b` → `name(a, b)`, uniformly for user calls, zero-arg
   (`&print` → `print()`), namespaced (`&WASM::i32_store …`), and intrinsics
   (`&@if …` → `@if(…)`).
3. **BinOp** — drops the call-operand paren reconstruction the formatter needed for
   paren-free calls (always-parens makes it unnecessary); keeps the no-precedence
   grouping parens.

**Comments are preserved.** Although the lexer strips all `#`/`##` comments before they
reach the AST, the codemod scans them from source and re-interleaves them by position:
every node carries `sourceLocation`, so before each element/block-item it flushes the
source comments / blank lines / `@use` lines that precede it (deep-searching the subtree
for the line, since statement nodes like `FunctionCall` lack their own location), and a
trailing inline comment is re-attached to the line it sat on. On the stdlib this preserves
**498/498 comments** plus `@use` lines and blank-line structure. (Edge: a comment buried
inside a single multi-line *non-block* expression, or directly before a block's closing
`}`, may shift to the next statement boundary — preserved, lightly repositioned.)

**Result of a full run over the stdlib:** all 13 `.si` files migrate with 0
parse/emit failures and balanced delimiters. Representative output:

    @type Option[T] := $Some value T | $None;
    \\ option_unwrap_or[T] (Option[T], T)
    option_unwrap_or[T] opt, dflt := { @match(opt, $Some v => v, $None => dflt) };
    @mut v := alloc(12);
    WASM::i32_store(v + 4, cap);
    @if(n < 0, { r = 0 - n }, {});
    @type Slice[T] := { ptr Int, len Int };

(Note the reconstructed `\\` line + bare params — function/value types are carried on a
`\\` signature line, including for `\\`-annotated locals inside blocks, because there is
no inline return-type syntax and the parser merges `\\` into the def.)

**Findings / limitations (surfaced by building it):**

- **Type syntax is space-separated** (`name Type`, `\\` lines) — exactly as
  `grammar.ebnf` says and all real code uses. The parser *rejects* `:Type` on
  params/fields/returns (only variant payloads also accept colon). The `sgl fmt`
  formatter emits `:Type`, so its output **fails to re-parse on 12/13 stdlib files** —
  a pre-existing formatter bug, independent of ADR 0020. The codemod sidesteps it by
  reconstructing `\\` lines.
- **Comments are preserved** (498/498 on the stdlib) via the source-scan + position
  re-interleave described above — including trailing inline comments and blank-line
  structure. (Earlier passes dropped them; that limitation is resolved.)
- **`@local` → `@mut` is conservative** (see Consequences) — a follow-up linter
  should demote never-reassigned locals to bare-immutable.
- **`@struct` conversion is flagged** for review — the type-context struct grammar
  is unimplemented, so those lines cannot be validated yet.
- **Round-trip validation is gated on the new parser** (the output is *new* syntax);
  structural + delimiter sanity is checked instead.

Run it:

    bun run tools/migrate-adr0020.ts            # whole stdlib -> build/adr0020/
    bun run tools/migrate-adr0020.ts --check    # report only, write nothing
    bun run tools/migrate-adr0020.ts --stdout compiler/src/stdlib/vec.si

## Implementation pointer

Once Accepted: commit SHA / PR that lands the codemod (`tools/migrate-adr0020.ts`,
already drafted — §Migration) + parser/lexer changes + the `docs/grammar.ebnf`
rewrite. Representative files to update:
`compiler/src/parser/handwritten/{lexer,parser}.ts`,
`compiler/src/strata/defkinds.si` (drop def-kw entries; add `@mut`),
`compiler/src/stdlib/*.si`, `examples/*.si`, `docs/grammar.ebnf`,
`docs/overview.md`, `website/src/guide/tour.md`.
