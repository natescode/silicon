# ADR 0026 — Add conservative automatic semicolon insertion

- **Status:** Accepted — implemented on current branch
- **Date:** 2026-06-09
- **Deciders:** NatesCode
- **Related:** ADR 0010 (grammar targets LL(1)) · ADR 0020 (Odin-inspired grammar) · `docs/grammar.ebnf` · handwritten parser/lexer in `compiler/src/parser/handwritten/`

## Context

Silicon currently documents `Program = { Element }` where an `Element` is either
a signature line or an `Item ";"` (`docs/grammar.ebnf`). In practice, examples
and the ADR-0020 surface want a cleaner line-oriented style:

```silicon
x := 1
y := x + 2
print(y)
```

The parser is handwritten and the grammar target is LL(1), so semicolon
elision must not become a second expression grammar or a lexer-global rewrite
that changes meaning based on arbitrary token pairs. Signature lines add one
extra constraint: a normal `\\` signature attaches to the next definition, while
bodyless extern declarations such as `\\ @extern puts (String) -> Int;` are
complete declarations.

## Decision

Add conservative automatic semicolon insertion (ASI): a newline may act as a
virtual `;` only when the parser is already in a statement-terminator position.
Explicit `;` remains accepted forever.

The insertion rules are:

1. Insert a virtual `;` after a complete top-level item at newline or EOF.
2. Inside blocks, insert a virtual `;` only when the current item is complete
   and the newline is followed by another item start.
3. Do not insert before `}` by default; this preserves trailing block
   expressions as block values.
4. Do not insert after incomplete tokens such as `:=`, `=`, binary operators,
   commas, namespace separators, open delimiters, `\\`, or signature modifiers.
5. Do not insert before continuation tokens such as binary operators, commas,
   `.`, `::`, `)`, or `]`.
6. A call's `(` must remain on the same logical line as the callee.
7. A normal `\\` signature line attaches to the next definition. A bodyless
   `\\ @extern ...` signature may terminate at line end.

Implementation should prefer a parser-position helper such as
`consumeTerminator()` over lexer-global semicolon rewriting. The lexer may expose
newline metadata or newline tokens, but expression parsing should keep the same
semantic rules it has today.

## Options considered

### Option A — Keep explicit semicolons

Keep the current grammar exactly as documented. This is the lowest-risk parser
choice and keeps formatting mechanically obvious, but it makes common Silicon
code noisier than the ADR-0020 surface intends and pushes examples toward
punctuation that users will naturally try to omit.

### Option B — Parser-position ASI

Allow newline as a terminator only when the parser is consuming a terminator for
an `Element` or block item. This keeps the grammar LL(1), makes the insertion
sites auditable, and prevents newline from participating in arbitrary expression
disambiguation. This is the proposed option.

### Option C — Lexer-global ASI

Have the lexer rewrite newlines into semicolon tokens based only on previous and
next token classes. This can work in languages designed around that rule, but it
would spread statement knowledge into the lexer, make signature-line and block
value handling fragile, and risk changing expression grammar semantics outside
the parser's existing follow positions.

## Consequences

- **Positive:** Silicon examples can use a cleaner line-oriented style while
  preserving explicit `;` for dense or generated code.
- **Positive:** The parser keeps one source of truth for where statements may
  end.
- **Negative:** The lexer/parser interface needs newline awareness, which the
  current semicolon-only grammar does not require.
- **Negative:** Some visually plausible layouts remain invalid, especially
  moving a call's `(` to the next line.
- **Follow-up work:** Update the handwritten parser, lexer metadata, parser
  tests, formatter tests, and `docs/grammar.ebnf` if this ADR is accepted.

## Implementation pointer

Implemented on the current branch in the handwritten lexer/parser and grammar
tests:

- `compiler/src/parser/handwritten/lexer.ts`
- `compiler/src/parser/handwritten/parser.ts`
- `compiler/src/grammar/automatic-semicolon-insertion.test.ts`
