# Signature Lines — Migration Strategy

**Status:** companion to [`signature-lines.md`](signature-lines.md) (proposal,
not implemented). This is the plan for moving the existing `.si` corpus and the
compiler from inline parameter types to separate signature lines, without a
terrifying flag-day.

---

## 0. The corpus is smaller than it looks

Counts across `src/strata`, `src/stdlib`, `examples`, `src/platforms`,
`src/e2e`, `tests` (`*.si`), as of 2026-05-30:

| Shape | Count | Codemod treatment |
|---|---:|---|
| `@fn` definitions | 745 | strip inline param types → bare params |
| …with explicit return type | 41 | **synthesize full signature** (domain + range) |
| …generic (`name[T]`) | 17 | synthesize signature; **14 lack a return type → human fills the range** |
| `@extern` declarations | 226 | group per-file into `@extern { … }` blocks |
| inline `$fn` param types | **0** | — (the collision case lives only in `.ts` test strings) |
| `@struct` / `@type` defs | 11 / 7 | fields drop `:` → juxtaposition (rule F); function-typed fields also need parens |
| `@global`/`@local` inline types | (few) | → ascription keyword `&@as` (rule G), or dropped if unambiguous |

The headline: **~704 of 745 functions need only their inline param types
stripped** and rely on inference afterward — no signature at all. Signatures are
*synthesized* for the 41 with return types, and only **~14 generic functions
without an explicit return** require a human to write the range. The hard case
that started this whole design (`$fn` function-typed params) does not occur in
the corpus.

---

## 1. The load-bearing constraint: the compiler eats its own corpus

`strataLoader` loads `src/strata/*.si` and the stdlib loads `src/stdlib/*.si`
**at compiler startup**. If those files stop parsing, the compiler does not
boot. With a **flag-day changeover** (decided — no transition period, no
superset grammar, no window where both syntaxes coexist), the consequence is
sharp: the new grammar and the fully-migrated corpus must land **together**, and
there is no half-migrated state in which the toolchain runs.

This is a deliberate trade. The win is a clean end state — one grammar, no
dual-form bookkeeping in the typechecker, no deprecation tail. The cost is that
the changeover is **not bisectable in main's history**: a single bad splice in
745 edits bricks the toolchain, and you can't `git bisect` across the swap. The
discipline that replaces bisectability is: **do all the work on one branch, get
the *entire* suite green there, then merge as a single atomic change.** "All at
once" is about the *merge*, not about skipping validation.

---

## 2. The one ordering constraint: codemod runs against the *old* parser

The flag-day has exactly one hard sequencing rule, and it's a chicken-and-egg:

- The codemod must **read old syntax**, so it runs against the **current
  (pre-change) parser**.
- The moment the grammar is replaced, old-syntax `.si` no longer parses — so the
  codemod cannot run *after* the swap.
- But the new compiler cannot boot on the *old* corpus either.

Resolution: the codemod is a **standalone one-shot script bound to the current
parser** (`scripts/migrate-signatures.ts`, §3), run **once during branch prep
while the grammar is still old**. Its output — the migrated corpus — is what the
new compiler is validated against. Concretely, on the branch:

1. Write the new compiler (grammar replacement + AST + typechecker +
   def-expanders), validating it against a small **hand-written new-syntax
   fixture set** — *not* the real strata/stdlib, which still parse only under
   the old grammar at this point.
2. Run the codemod (old parser) over the whole corpus → new-syntax `.si`.
3. Drop in the new grammar, point the compiler at the migrated corpus, run the
   full suite. Iterate until green.
4. Squash to a single atomic commit and merge.

The codemod itself is throwaway after step 2, but keep it in the tree (and its
tests) until the merge lands, in case the corpus needs a re-run.

---

## 3. The codemod: CST-span-surgical, run against the *old* parser

Build `scripts/migrate-signatures.ts`. Design constraints, in priority order:

1. **Parse, don't regex.** Use the existing Ohm parser + `src/ast` to get
   structured `(name, generics, params:[{name,type}], returnType)` per
   definition and extern. 745 hand-edited regexes is how you corrupt a stdlib.
2. **Splice by source interval, don't reprint.** Ohm CST nodes carry
   `source` intervals (start/end offsets). Use them to (a) *insert* a signature
   line above the definition and (b) *delete* the `:Type` slices from the param
   list and the return slot. Everything else — comments, blank lines, doc
   comments, alignment — stays byte-identical. A full AST pretty-print would
   destroy the comments in the stdlib; do not reprint.
3. **Run against the OLD grammar, once, during branch prep.** The codemod reads
   old syntax and emits new, so it must run *before* the grammar is replaced
   (§2). It is bound to the current parser and is throwaway after the corpus is
   converted.
4. **Idempotent + report-producing.** Re-running on already-migrated files is a
   no-op. Every function it cannot fully migrate is written to a report
   (§5), not silently mangled.

### Per-shape transform rules

Signatures and fields use **juxtaposition** (no `:` — proposal §3); `:` is
deleted corpus-wide.

```silicon
# A. typed params, explicit return  →  full synthesized signature (juxtaposed)
#    @fn vec_new:Int initial_capacity:Int := { ... }
\\ vec_new (Int) -> Int
@fn vec_new initial_capacity := { ... }

# B. typed params, NO return  →  strip only, no signature (inference recovers it)
#    @fn vec_push v:Int, x:Int := { ... }
@fn vec_push v, x := { ... }

# C. generic, explicit return  →  generics + full signature
#    @fn option_unwrap_or[T] opt:Option[T], dflt:T := { ... }   (return type present)
\\ option_unwrap_or[T] (Option[T], T) -> T
@fn option_unwrap_or opt, dflt := { ... }

# D. generic, NO return  →  domain synthesized, range = HOLE, flagged for human (§5)
#    @fn map[T,U] f:..., xs:Vec[T] := { ... }
\\ map[T, U] (<f's type>, Vec[T]) -> __FILL_RETURN__
@fn map f, xs := { ... }

# E. externs  →  grouped per file into one block (order preserved)
#    @extern InitWindow width:Int, height:Int, title:String;
#    @extern WindowShouldClose:Bool;
@extern {
    \\ InitWindow (Int, Int, String) -> Void
    \\ WindowShouldClose () -> Bool
}

# F. struct / variant fields  →  drop the ':' (juxtaposition)
#    @struct Rect w:Int, h:Int;
@struct Rect w Int, h Int;

# G. local with inline type  →  ascription keyword (':' is gone)
#    @global x:Option[Int] := &None;
@global x := &@as Option[Int], (&None);
```

- **`:` is removed corpus-wide.** Every `:` type-annotation site is migrated —
  params (→ signature, rule A/C), return slot (→ signature range), **struct /
  variant fields** (rule F, juxtaposition), and **`@global`/`@local` inline types**
  (rule G, ascription keyword). The only `:`-bearing token left in the corpus
  afterward is the namespace `::`. This makes the parser's removal of `:` safe:
  nothing in the migrated corpus uses it.
- **Void range.** A definition/extern with no return slot maps to range
  **`Void`** (the built-in one-value type; proposal §2). The empty *domain*
  (nullary function) stays `()`, e.g. `() -> Bool`.
- **Extern grouping.** Collect all `@extern` nodes in a file, emit one
  `@extern { … }` block at the position of the *first* one, delete the rest.
  Preserve declaration order and any interleaved comments by attaching them to
  the nearest signature.
- **Struct / `@type` fields** are now *touched* (rule F — a `:`→space edit;
  11 structs + 7 sum types). A function-typed field additionally needs a
  parenthesized domain (none in the corpus today — a guard, not a bulk edit).
- **`@global`/`@local` inline types** (rule G) are rare; each becomes an ascription.
  Count them in the report (§5) — if any initializer is *not* ambiguous, the
  annotation can simply be dropped instead.

---

## 4. Compiler changes (all on one branch, merged together)

These are *build steps*, not separate releases — they land as one atomic change
(§6). Order them so each is independently testable against the new-syntax
fixture set before the codemod runs.

1. **Grammar (clean replacement)** — in `silicon-official.ohm`: add
   `AttachedSig`, `SignatureBlock`, arrow `TypeExpr`/`TypeAtom`; and in the same
   change **delete** the old forms — `sigilFnType` / `sigilFnTail` /
   `sigilFnParenForm` / `sigilFnParams`, the return-type-on-name slot
   (`typedIdentifier` → `identifier` in `Definition`), inline `type` in `Params`,
   and the per-line `@extern` definition. No superset, no deprecation tail.
2. **AST** (`src/ast/toAst.ts`) — produce a `Signature` node and thread its
   positional types + range onto the owning definition; bare params produce
   typeless `ParamLiteral`s. Remove the AST paths for the deleted inline forms.
3. **Typechecker** (`src/types/typechecker.ts`) — param types come from the
   signature by position, the return type from its range; **arity-check**
   signature vs. param count (new diagnostic). No dual-form reconciliation
   exists — there is only one source of annotations. Preserve HM-lite
   optional-signature behavior (no signature → inference).
4. **Def-expanders** (`src/strata/defExpanders.ts`) — `@fn` lowering reads
   param/return types from the associated signature; teach the registry the
   `@extern { … }` block form (and `@interface` as a no-op-dispatch stub).
5. **Codemod** (`scripts/migrate-signatures.ts`) — §3; built and unit-tested,
   then run once (old parser) to convert the whole corpus.

---

## 5. The human-review report

The codemod emits `migration-report.md` listing every function it could not
fully migrate automatically. Expected contents, from the counts:

- **~14 generic functions with no explicit return type** (rule D) — domain is
  synthesized, range is `__FILL_RETURN__`; a human supplies the return type.
  These are concentrated in `src/stdlib` (`option.si`, `result.si`, `vec.si`,
  `slice.si`, `hashmap.si`, `rc.si`).
- **Any function-typed parameter** (rule from the proposal §5 — parenthesized
  domain) — none expected in `.si`, but flagged if found.
- **Any extern with an out-pointer convention** — cross-check against
  [`extern-out-pointer.md`](extern-out-pointer.md); the ABI is unchanged but the
  signature spelling should be reviewed by hand.

Target: the report is short enough (~14 + edge cases) to clear in one sitting.

---

## 6. Branch build-order, then one atomic merge

All steps happen on a single branch; nothing reaches `main` until the whole
suite is green. The order is a build sequence, not a release schedule.

| Step | Work | Local checkpoint |
|---|---|---|
| **B1** | New compiler (grammar replacement + AST + typechecker + def-expanders, §4) | green against a hand-written **new-syntax fixture set** |
| **B2** | Codemod tool + its unit tests (§3) | round-trips fixtures; idempotent |
| **B3** | Run codemod (old parser) over the **whole** corpus; hand-clear the report (§5) | `migration-report.md` empty of unresolved holes |
| **B4** | Point the new compiler at the migrated corpus; run everything | **full suite green** — incl. `test:selfhost`, `test:qbe`, `test:backends`, `src/e2e` |
| **B5** | Squash → single commit; regenerate `grammar.ebnf`; update docs | full suite green on the squashed commit |
| **Merge** | One atomic change to `main` | — |

B4 is the moment of truth — the first time the compiler parses its *own*
strata/stdlib in the new syntax (§1). Because there is no superset, the only
"revert" is reverting the entire merge; that's acceptable precisely because
nothing partial ever lands. Keep the branch's pre-codemod commit (old corpus +
old grammar) intact so the codemod can be re-run if B4 surfaces a bad splice.

---

## 7. Verification

- **Behavioral, not byte-equal.** Output WASM/native need not be identical, but
  every existing test must stay green. The suites that matter most:
  `bun test` (unit + integration), `src/e2e/` (pipeline), `test:selfhost`,
  `test:qbe`, `test:backends`.
- **Parser fuzz** (`test:fuzz`, `test:properties`) re-run at B4 to confirm the
  grammar replacement didn't open ambiguities — especially the arrow-suffix
  `TypeExpr` and the `(` domain/grouping disambiguation (proposal §3).
- **Boot check** asserted explicitly in B4 CI: a trivial `sgl build` of a
  hello-world proves strata + stdlib parsed and loaded under the new grammar.

---

## 8. Risks & mitigations

The flag-day concentrates risk into the merge, so the mitigations are about
making the branch trustworthy *before* it lands, not about recovering after.

| Risk | Mitigation |
|---|---|
| No bisectable history across the swap | Entire suite green on the squashed commit before merge (B5); the merge is the unit of revert |
| A bad splice bricks the compiler (it loads its own strata) | CST-span-surgical, idempotent codemod (§3); keep the pre-codemod branch commit to re-run; B4 boot check catches it on the branch, never in `main` |
| Inference fails for a stripped pass-through param (rule B) | Surfaces as a type error at B4; fix by promoting that function to rule A (add a signature). The report counts how often it bites |
| Comments/formatting lost in 745 edits | Splice by source interval, never reprint (§3.2) |
| Generic functions can't infer a principal type post-strip | Rules C/D *always* synthesize a signature for generics — they never rely on inference |
| New compiler can't be tested before the corpus moves | Validate B1 against a hand-written new-syntax fixture set, independent of strata/stdlib (§2) |

---

## 9. Open items inherited from the proposal

Resolved: unit spelling → built-in **`Void`**; **bare-only** params; `\\` kept
uniform inside blocks; `\\` scoped to functions / modules / (reserved) types
(proposal §2, §6.5). The **only** item still blocking the B1 grammar is **local
ascription** — confirm `(expr : Type)`. Interface dispatch and `\\`-on-types are
deferred, not blocking. See [`signature-lines.md`](signature-lines.md) §9.
