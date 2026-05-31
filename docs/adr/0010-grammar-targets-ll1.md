# ADR 0010 — Silicon's grammar targets LL(1)

- **Status:** Accepted
- **Date:** 2026-05-27
- **Deciders:** NatesCode
- **Related:** `docs/grammar.ebnf` §LL(1) · `src/grammar/silicon-official.ohm` · [[silicon-ll1-target]] memory · [[silicon-no-postfix]] memory · commit `c4dfb99` (left-factor sigilFnType)

## Context

Silicon's grammar was already small and prefix-sigil-heavy (`&@`, `$`, `@`), which made it incidentally close to LL(1) but never formally committed to. The recent grammar audit (after the boot/ removal, when planning the future self-hosted rewrite) made two things explicit:

1. The grammar is LL(1) modulo standard left-factoring — three small spots needed parser-side rework (`sigilFnType` four-alt redundancy; `Item` assignment vs. expression; `Block` trailing expression). The `$X` literal-vs-VariantDecl decision is LL(1) at the tokenized level.
2. The future self-hosted bootstrap will need a parser written in Silicon. Recursive-descent is the natural target language for that — and recursive-descent works best on LL(1) grammars.

The question: commit to LL(1) as a hard design constraint, or treat it as a happy accident and let it drift if a future feature wants more grammar power?

## Decision

**Silicon's grammar is LL(1).** New grammar changes must preserve this property. The natural form of the grammar in `src/grammar/silicon-official.ohm` may use Ohm/PEG-style ordered alternatives for readability, but `docs/grammar.ebnf` documents the left-factored form a strict LL(1) parser would consume, and that left-factored form is the binding contract.

When a proposed feature appears to need more than LL(1), the default response is to **redesign the feature** (typically via a prefix sigil that makes FIRST sets disjoint, or by routing through the strata system instead of a grammar change). Reaching for LL(k), LL(*), or PEG/backtracking is a last resort that requires explicit ADR justification.

## Options considered

### Option A — Commit to LL(1) *(chosen)*

Treat LL(1) as a stability-class invariant alongside "no postfix operators" and "no grammar changes for new keywords — use strata."

- **Pro:** the future self-hosted parser ports as one recursive-descent function per non-terminal, straight from `grammar.ebnf`. Days of work, not weeks.
- **Pro:** error messages benefit — the parser always knows what it was expecting because the parser state directly encodes the production. Roc/Elm/Rust-quality diagnostics become tractable.
- **Pro:** sharp design constraint with teeth. "Does this change stay LL(1)?" is a yes/no question that catches accidental ambiguity and unbounded-lookahead constructs before they ship.
- **Pro:** predictable linear-time parsing with no memoization, no backtracking. Matters more for the self-hosted bootstrap (one large parse on each build) than for user programs.
- **Pro:** tree-sitter grammars that are also LL(1) work better in practice — fewer ambiguities to resolve, faster incremental reparse. Pays off for IDE tooling.
- **Con:** restricts grammar expressiveness. Some natural constructs need workarounds (which Silicon already uses — see Consequences).

Cost today: ~0 (the grammar already qualifies, post-`sigilFnType` left-factoring).

### Option B — Treat LL(1) as nice-to-have, drift if needed

Document the current shape as informally LL(1) but don't bind future grammar changes to it.

- **Pro:** maximum freedom for future feature design.
- **Con:** undoes the connection to the self-hosted port. A non-LL(1) grammar means the Silicon-side parser needs either backtracking (slower, worse errors) or a parser generator (extra tooling dependency in the bootstrap).
- **Con:** "informally LL(1)" rots. Without a hard gate, the next grammar change that needs 2-token lookahead lands, and the next, and the property is gone.
- **Reject.**

### Option C — Go further than LL(1) (require strict LL(1) in the natural form too)

Rewrite `silicon-official.ohm` so even the natural form is strict LL(1) — left-factor `Item` and `Block` in the source grammar.

- **Pro:** maximum purity. The Ohm file IS the LL(1) parser shape.
- **Con:** uglier grammar source for ~0 practical gain. `Item = Statement | Expression` is more readable than the left-factored equivalent.
- **Con:** the C/Java/most-real-languages convention is "LL(1) modulo standard left-factoring." Going stricter than common practice has no audience benefit.
- **Reject.**

## Consequences

- **Positive: future self-hosted parser ports cleanly.** Recursive-descent function-per-non-terminal mapping from `grammar.ebnf`. Estimated days of work for the parser pass once the rewrite begins.
- **Positive: error message quality.** The parser state always knows what production it's in and what tokens are valid next — the foundation for `expected <X> after <Y>` diagnostics.
- **Positive: load-bearing design constraints stay load-bearing.** The prefix-sigil discipline (`&@`/`$`/`@`/`$Variant`) and the [[silicon-no-postfix]] ban (`expr?`/`expr!` would force lookahead past the operand) are now explained by *this* ADR rather than being aesthetic-only choices. Future contributors have a written reason to keep them.
- **Positive: stability contract gains a checkable property.** "Does this preserve LL(1)?" is a binary question, unlike most language-design tradeoffs.
- **Negative: feature designs constrained.** Some natural surface forms are off the table. Concrete examples:
  - Optional trailing commas in lists work, but trailing-comma-as-significant-token would not.
  - Postfix operators (`expr?`, `expr!`) remain banned — already an independent rule, now also LL(1)-required.
  - Type ascription via postfix `: T` works because it's part of `typedIdentifier`, not a free-floating expression operator.
- **Negative: language-design discussions get a new gate.** Any feature proposal that touches the grammar now needs an LL(1) check before serious design work. Slight tax on creativity; saves much-larger cost of un-shipping a misdesigned feature.
- **Follow-up work:**
  - Grammar PR template should ask: "Does this preserve LL(1)? If natural form isn't LL(1), provide the left-factored form for `grammar.ebnf`."
  - When the self-hosted bootstrap rewrite begins, the Silicon parser is the validation: if it can be implemented as straight recursive descent from `grammar.ebnf`, the property held; if it can't, this ADR was violated somewhere and we need to find where.
  - Consider a CI lint that runs the Ohm grammar against a smoke set of strict-LL(1) properties (no two alternatives sharing a FIRST token after left-factoring). Defer until a violation actually almost-ships.

## Implementation pointer

Commit `c4dfb99` (left-factor `sigilFnType`; document LL(1) form in `docs/grammar.ebnf`). The grammar.ebnf §LL(1) appendix is the canonical reference; `silicon-official.ohm` is the implementation.
