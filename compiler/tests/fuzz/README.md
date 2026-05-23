# Parser Fuzz Suite

Per `docs/stage0-cleanup-plan.html` WS 6.

## Running locally

```bash
bun test tests/fuzz/parser.fuzz.test.ts            # 60s budget per target
SIGIL_FUZZ_BUDGET_MS=180000 bun test ...           # extended local run
```

Environment overrides (per fast-check `numRuns` and time budget):

| Variable                  | Default | Purpose |
| ------------------------- | ------- | ------- |
| `SIGIL_FUZZ_BUDGET_MS`    | 60000   | Total local budget, split across 3 targets |
| `SIGIL_FUZZ_BYTES_RUNS`   | 800     | Max runs for random-bytes target |
| `SIGIL_FUZZ_TOKEN_RUNS`   | 800     | Max runs for random-token target |
| `SIGIL_FUZZ_ROUNDTRIP_RUNS` | 400   | Max runs for generative round-trip target |

## Three Targets

1. **Random bytes** — arbitrary `Uint8Array` decoded as UTF-8. Parser must
   never throw an unstructured exception, never crash, never loop, never
   allocate unbounded memory. Structured "Parse error: ..." messages are fine.

2. **Random token streams** — sequences of valid token strings joined by
   spaces. Parser either succeeds or returns a structured error.

3. **Generative round-trip** — generates small, syntactically-valid Silicon
   programs over a narrow subset (integer literals, identifiers, `@let`,
   bin-ops). Parses, pretty-prints, re-parses, expects parse-tree equality.
   The pretty-printer is a no-op today (generated source is already canonical)
   and becomes a real AST → source step once the bootstrap parser lands.

## Corpus

`corpus/*.si` holds minimised reproducers found by the fuzzer.  Every seed
runs as a regression test on every CI run.  Add new seeds whenever a fuzzer
failure surfaces a real bug.

## Nightly CI

A separate workflow (planned) bumps the budget to 30 minutes per target.
Failures auto-file an issue with the minimised input.
