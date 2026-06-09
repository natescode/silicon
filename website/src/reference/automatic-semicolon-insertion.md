---
title: Automatic semicolon insertion
---

# Automatic semicolon insertion

::: tip Accepted
This page documents the accepted ADR 0026 behavior implemented by the
handwritten lexer/parser.
:::

Silicon should let a newline terminate a complete statement without turning
newline into expression syntax. ASI is accepted only where the parser already
expects a statement terminator.

## Motivation

ADR 0020 moved Silicon toward a bare, line-readable surface: definitions are
ordinary names, calls are parenthesized, and explicit sigils are reserved for
language forms. Requiring semicolons after every complete item keeps the grammar
simple, but it makes ordinary examples look heavier than the language intends.

The goal is not JavaScript-style recovery. The goal is a narrow rule: at
statement boundaries, a newline may do the same job as a semicolon.

## Final Insertion Rules

1. Explicit `;` stays valid everywhere it is valid today.
2. At the top level, a newline or EOF may terminate a complete item.
3. Inside a block, a newline may terminate a complete item only when the next
   token starts another item.
4. Do not insert before `}` by default; a trailing block expression remains the
   block value.
5. Do not insert after incomplete tokens: `:=`, `=`, binary operators, commas,
   `::`, open delimiters, `\\`, or signature modifiers.
6. Do not insert before continuation tokens: binary operators, commas, `.`,
   `::`, `)`, or `]`.
7. A call's `(` must stay on the same logical line as the callee.
8. Normal `\\` signature lines attach to the next definition. Bodyless
   `\\ @extern ...` signatures may terminate at line end.

## Examples

### Top-level items

```silicon
\\ add (Int, Int) -> Int
@fn add a, b := a + b

answer := add(20, 22)
print_int(answer)
```

### Block values

```silicon
\\ score (Int) -> Int
@fn score n := {
    doubled := n * 2
    capped := @if(doubled > 100, { 100 }, { doubled })
    capped
}
```

No semicolon is inserted before `}`, so `capped` remains the block's value.

### Multiline calls

```silicon
total := add(
    subtotal,
    tax
)

message := format_invoice(
    customer,
    total
)
```

### Binary continuations

```silicon
total := subtotal
    + tax
    + shipping

ready := subtotal
    + tax
    + shipping
```

### Signature lines

```silicon
\\ distance (Point, Point) -> Int
@fn distance a, b := abs(a.x - b.x) + abs(a.y - b.y)

\\ @extern puts (String) -> Int
puts("hello")
```

## Non-examples

### Call opener moved to the next line

```silicon
print
("hello")
```

The callee and call `(` are not on the same logical line.

### Assignment split after `:=`

```silicon
value :=
    compute()
```

No terminator is inserted after `:=`; the expression is incomplete.

### Comma as a continuation

```silicon
pair := make_pair(first,
    second)
```

No terminator is inserted after a comma.

### Namespace continuation

```silicon
value := math::
    abs(n)
```

No terminator is inserted after a namespace separator.

## Parser Implementation Shape

ASI should live at parser statement boundaries. A helper like
`consumeTerminator()` can accept either an explicit semicolon or a virtual
terminator when newline metadata says the current item is complete and the
following token is a valid follow token.

```text
parseElement():
    if next_is_signature_line():
        parseSignatureLine()
        consumeSignatureTerminatorIfExtern()
        return

    parseItem()
    consumeTerminator(topLevelFollow)

parseBlockTail():
    parseItem()
    if next_token_is("}"):
        keep_item_as_trailing_block_value()
    else:
        consumeTerminator(blockItemFollow)
```

The lexer can expose newline tokens or attach newline metadata to tokens. It
should not globally rewrite newlines into semicolons before the parser knows
whether it is at an `Element` or `BlockTail` follow position.

## Test Matrix

| Case | Expected result |
| --- | --- |
| Two top-level definitions separated by newline | Parses as two items |
| EOF after a complete top-level item | Parses without a trailing semicolon |
| Block with final expression before `}` | No virtual semicolon before `}`; expression is block value |
| Block with multiple newline-separated bindings | Virtual semicolons between item starts |
| Newline after binary operator, comma, `:=`, `=`, `::`, or open delimiter | No virtual semicolon |
| Newline before binary operator, comma, `.`, `::`, `)`, or `]` | No virtual semicolon |
| Callee newline before call `(` | Parse error |
| Normal `\\` signature followed by definition | Signature attaches to definition |
| Bodyless `\\ @extern ...` at line end | Signature line terminates without a following body |
