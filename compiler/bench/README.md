# Benchmarks

## Parser throughput

`parse-bench.ts` measures the hand-written parser (`parse` → `parseToAst`, in
`src/parser/handwritten/`) over generated Silicon programs of increasing size.
Programs come from a seeded PRNG so runs are comparable.

```sh
bun run --cwd compiler bench:parser
# or, from the compiler/ directory:
bun run bench:parser            # → bun run bench/parse-bench.ts
```

Typical throughput is ~30–36 MiB/s with linear scaling (one dev machine;
absolute numbers are hardware-dependent).

### History: it used to be ohm

The parser was originally PEG-based (ohm-js). The hand-written recursive-descent
parser replaced it and is now the only parser (`parse()` calls it directly; ohm
is removed). Before the swap, the hand-written parser benchmarked **292–3085×
faster than ohm** across 30–454 KiB — that comparison lives in git history
(see the `perf(parser):` and `feat(parser):` commits).

The big win was fixing an accidental **O(n²)**: `lineColumn` rescanned the
source from offset 0 on every call, and it's invoked per `Namespace`/`Definition`
node, so cost grew as *nodes × offset*. On a 206 KiB program it scanned 4.9
billion characters (23,000× the source). Two fixes:

1. **Precompute line starts once**, binary-search per lookup → O(log n).
   454 KiB: 10,335 ms → 17.3 ms.
2. **Lexer ASCII lookup tables + `charCodeAt`** in the hot per-char loops:
   17.3 ms → 12.2 ms.

Net: ~850× faster than the first (unoptimized) cut of the hand-written parser.

### Profile

`profile-parser.ts` splits a single large parse into tokenize vs. full
parse+AST and reports throughput — useful for spotting the next hotspot:

```sh
bun run compiler/bench/profile-parser.ts
```

## Correctness

The hand-written parser was developed against an AST-equivalence test that
deep-compared it to ohm over the whole `.si` corpus (removed when ohm was
deleted — there's no longer a second parser to diff against). Correctness is
now covered by the full compiler suite, which parses Silicon on every test:

```sh
bun test            # from the compiler/ directory
```
