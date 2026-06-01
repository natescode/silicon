# Benchmarks

## Parser: ohm vs. the hand-written parser

`parse-bench.ts` compares the two parsers — ohm (`parse` → `addToAstSemantics`
→ `toAst`) vs. the dependency-free hand-written recursive-descent parser
(`parseToAst`, in `src/parser/handwritten/`) — over generated Silicon programs.
Programs are produced from a seeded PRNG (so runs are comparable) and each size
is **gated on AST-equality** between the two parsers before timing, so we only
ever benchmark inputs that produce identical output.

### Run

```sh
bun run --cwd compiler bench:parser
# or, from the compiler/ directory:
bun run bench:parser            # → bun run bench/parse-bench.ts
```

### Results

Illustrative numbers (one dev machine; absolute ms are hardware-dependent, the
ratios are the point). AST is byte-identical at every size.

| tier   | source   | ohm        | hand-written | speedup  | throughput |
|--------|----------|------------|--------------|----------|------------|
| small  | 30.5 KiB | 274.7 ms   | 0.9 ms       | **292×** | 31.7 MiB/s |
| medium | 153.5 KiB| 4,706.8 ms | 5.0 ms       | **932×** | 29.7 MiB/s |
| large  | 454.0 KiB| 37,636.6 ms| 12.2 ms      | **3085×**| 36.3 MiB/s |

The hand-written parser is ~30–36 MiB/s with linear scaling.

### How it got there

The first cut of the hand-written parser was accidentally **O(n²)**: `lineColumn`
rescanned the source from offset 0 on every call, and it's invoked per
`Namespace`/`Definition` node, so cost grew as *nodes × offset*. On a 206 KiB
program it scanned **4.9 billion characters** (23,000× the source).

Two fixes (both preserve byte-identical AST — see the equivalence test below):

1. **Precompute line starts once**, then binary-search per lookup → O(log n).
   On the 454 KiB program: **10,335 ms → 17.3 ms**.
2. **Lexer ASCII lookup tables + `charCodeAt`** in the hot per-char scan loops
   instead of string compares / `Set.has`: **17.3 ms → 12.2 ms**.

Net vs. the original hand-written parser: **~850× faster** (10,335 → 12.2 ms).

### Profile

`profile-parser.ts` splits a single large parse into tokenize vs. full
parse+AST and reports throughput — useful for spotting the next hotspot:

```sh
bun run compiler/bench/profile-parser.ts
```

## Equivalence test

The hand-written parser is verified node-for-node against ohm over the whole
`.si` corpus + inline programs (the contract that lets the benchmark compare
apples to apples):

```sh
bun test compiler/src/parser/handwritten/equivalence.test.ts
```
