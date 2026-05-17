# Sigil Diagnostics

WS 4 of `docs/stage0-cleanup-plan.html`.

Errors flowing out of the compiler are emitted as structured `Diagnostic`
records, defined in `src/errors/diagnostic.ts`.  Rendering — JSON for tools,
a disposable pretty printer for humans — is the thin layer on top.

## The Record

```ts
interface Diagnostic {
  phase:   'parse' | 'elaborate' | 'typecheck' | 'lower' | 'emit';
  code:    string;       // stable identifier, e.g. 'E0002'
  span:    SourceSpan;   // { file, line, col, length }
  message: string;       // short human-readable summary
  hint?:   string;
  notes?:  Diagnostic[];
}
```

`SourceSpan.file` may be the empty string for synthesised nodes (no
originating source).  `SourceSpan.length === 0` denotes a point span; the
render layer is free to widen it.

## CLI Behaviour

```
sgl main.si            # JSON output on stderr (the default — machine-friendly)
sgl --pretty main.si   # disposable human renderer for terminal use
```

The pretty renderer is intentionally tiny (~50 LoC, throwaway).  Stage 1
will replace it with a real one in Silicon.

## Diagnostic Codes

Stable, machine-matchable identifiers.  Never reuse a number.

### Parse

| Code   | Trigger                                            |
| ------ | -------------------------------------------------- |
| E0100  | Any structured parser failure (raised by parser.ts) |

### Type Check

| Code   | Kind                | Trigger                                                |
| ------ | ------------------- | ------------------------------------------------------ |
| E0001  | UnknownType         | Type annotation referenced an unrecognised name        |
| E0002  | Mismatch            | Expected type X, got type Y                            |
| E0003  | InvalidOperator     | Operator not defined for these operand types          |
| E0004  | UnboundIdentifier   | Reference to an unknown identifier                     |
| E0005  | HeterogeneousArray  | Array literal elements do not share a type             |
| E0006  | Annotation          | Initialiser doesn't match declared annotation         |
| E0007  | ImmutableAssignment | Assignment to an immutable binding (@let, @fn, @extern)|

### Reserved Ranges

| Range          | Phase     |
| -------------- | --------- |
| E0001 – E0099  | typecheck |
| E0100 – E0199  | parse     |
| E0200 – E0299  | elaborate |
| E0300 – E0399  | lower     |
| E0400 – E0499  | emit      |

## Why JSON by Default

- The bootstrap-plan §5 format-parity gate becomes meaningful: instead of
  diffing prose, the gate diffs `(phase, code, span)` tuples.
- Tests can assert on `code === 'E0002'` instead of substring-matching
  free-form messages, so they don't break when wording is tweaked.
- LSP support is free once Stage 1 ships — the records are already
  structured.

## Conversion Helpers

`src/errors/diagnostic.ts` ships two adapters so existing error paths can
yield Diagnostic records without rewriting every call site:

- `toDiagnostic(typeError, file?)` — lifts a `TypeError` (the
  type-checker's internal record) into a Diagnostic.
- `parseDiagnostic(err, file?)` — extracts line/col from `parser.ts`
  thrown errors.

Future work (out of scope for WS 4):

- Replace every `throw new Error(...)` in `elaborator/`, `ir/`, and
  `codegen/` with `Diagnostic` emission.
- Add `--quiet` / `--verbosity` flags once we have more than two render
  modes worth distinguishing.
- Multi-line context, colour codes, "did you mean…" — all Stage 1.
