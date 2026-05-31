# Sigil Diagnostics

Error records produced by the Sigil compiler.  Every diagnostic is a structured
`Diagnostic` object (defined in `src/errors/diagnostic.ts`) that can be rendered
as JSON or as human-readable pretty-print with optional Rust-style caret underlines.

---

## Diagnostic record shape

```typescript
interface Diagnostic {
    phase: 'parse' | 'elaborate' | 'typecheck' | 'lower' | 'emit'
    code: string          // E0001, S0001, …
    span: SourceSpan      // { file, line, col, length }
    message: string       // short, no "Error:" prefix
    hint?: string         // "did you mean …", "available choices: …"
    notes?: Diagnostic[]  // related sub-diagnostics
    snippet?: string      // verbatim source line for caret rendering
}
```

`span.col` is 1-based.  `span.length` is the byte count of the highlighted region
(0 for a point span, e.g. end-of-file).

When `snippet` is set, `renderPretty` draws a `^` underline below the source line:

```
E0004 [typecheck] main.si:7:5: unbound identifier 'aloc'
  alloc_array 1, 10
      ^^^^^
  hint: did you mean 'alloc'?
```

---

## Error codes

### Typecheck errors (E0001–E0099)

| Code  | Kind                | Meaning |
|-------|---------------------|---------|
| E0001 | UnknownType         | Type annotation references an unrecognised type name. |
| E0002 | Mismatch            | Expected type X but found type Y. |
| E0003 | InvalidOperator     | Operator not defined for the given operand types. |
| E0004 | UnboundIdentifier   | Reference to a name not in scope.  Carries a "did you mean" hint when a close candidate is known. |
| E0005 | HeterogeneousArray  | Array literal elements do not all share the same type. |
| E0006 | Annotation          | Initialiser type does not match the declared annotation. |
| E0007 | ImmutableAssignment | Assignment to a binding declared immutable (`@let`, `@fn`, `@extern`). |
| E0008 | MissingReturn       | Function with an explicit non-void return annotation has a body that may not produce a value. |
| E0009 | ArityMismatch       | Call site passed the wrong number of arguments. |

### Parse errors (E0100–E0199)

| Code  | Meaning |
|-------|---------|
| E0100 | Generic parse error.  The message includes the parser's description of what was expected. |

### Reserved ranges

| Range          | Phase     |
| -------------- | --------- |
| E0001 – E0099  | typecheck |
| E0100 – E0199  | parse     |
| E0200 – E0299  | elaborate |
| E0300 – E0399  | lower     |
| E0400 – E0499  | emit      |

### Strata errors (S0001–)

| Code  | Meaning |
|-------|---------|
| S0001 | Circular dependency in the strata T0 ordering.  The compiler breaks the lexicographically-first edge and continues. |

---

## "Did you mean" suggestions

On `UnboundIdentifier` (E0004) errors the typechecker computes the Levenshtein
edit distance from the unknown name to every symbol and function name currently
in scope.  If any candidate is within 3 edits, the closest one is attached as
the `hint` field:

```
E0004 [typecheck] main.si:3:1: unbound identifier 'lenght'
  hint: did you mean 'length'?
```

The helpers are exported from `src/errors/diagnostic.ts`:

```typescript
levenshtein(a: string, b: string): number
closest(query: string, candidates: string[], maxDist?: number): string | undefined
```

---

## Rendering

### JSON (`renderJson`)

Machine-friendly default: a JSON array of `Diagnostic` objects.

```json
[
  {
    "phase": "typecheck",
    "code": "E0004",
    "span": { "file": "main.si", "line": 7, "col": 5, "length": 5 },
    "message": "unbound identifier 'aloc'",
    "hint": "did you mean 'alloc'?"
  }
]
```

### Pretty-print (`renderPretty`)

Human-readable.  When `snippet` is present, emits a source line and `^` underline.

```
E0004 [typecheck] main.si:7:5: unbound identifier 'aloc'
  alloc x;
      ^^^^^
  hint: did you mean 'alloc'?
```

---

## CLI behaviour

```sh
sgl main.si            # JSON output on stderr (machine-friendly default)
sgl --pretty main.si   # human-readable pretty-print
```

---

## Why JSON by default

- Tests can assert `code === 'E0004'` instead of substring-matching prose,
  so tests don't break when wording changes.
- LSP support is free once Stage 1 ships — records are already structured.
- The bootstrap-plan §5 format-parity gate diffs `(phase, code, span)` tuples,
  not free-form strings.

---

## Conversion helpers

`src/errors/diagnostic.ts` ships two adapters:

- `toDiagnostic(typeError, file?)` — lifts a `TypeError` (typechecker's
  internal record) into a `Diagnostic`.  Threads `TypeError.hint?` into
  `Diagnostic.hint?`.
- `parseDiagnostic(err, file?)` — extracts line/col from `parser.ts` thrown
  errors.

---

## Adding a new error kind

1. Add the kind name to the `TypeErrorKind` union in `src/types/errors.ts`.
2. Add an `export function` factory that returns `TypeError`.
3. Add an `E0NNN` entry to `TYPE_ERROR_CODES` in `src/errors/diagnostic.ts`.
4. Update the code table in this file.
5. Add tests in `src/errors/diagnostic.test.ts` and `src/types/typechecker.test.ts`.

**Never reuse a code number.**  Stable codes are matched by tests and tooling.
