# WASM Binary Emitter Plan

**Goal:** Sigil emits a `.wasm` binary directly from IR by default. A new
`--wat` flag selects the existing text emitter as opt-in. Both backends
consume the same `vec<IR_*>` produced by `lower_program`; nothing
upstream of `emit/*` changes.

**Verification gate:** for every fixture (and ultimately for the
self-host bundle itself), `wat2wasm <wat-emitter-output>` must produce
**byte-equal** output to the new direct binary emitter. This is the
single regression test that proves the new backend is faithful.

---

## Pipeline (after)

```
Source → Parser → AST → Strata → Elaborator → [Typecheck] → IR Lower
                                                                │
                                            ┌───────────────────┴───────────────────┐
                                            ▼                                       ▼
                                  boot/emit/wasm.si  (default)            boot/emit/wat.si  (--wat)
                                            │                                       │
                                            ▼                                       ▼
                                        stdout (binary)                       stdout (text)
```

The IR is the contract. Anything a backend needs that isn't in IR today
gets added to IR, never inferred by sniffing text in the emitter.

---

## Why this is harder than "encode the WAT"

`wat2wasm` (wabt) is the de-facto canonical reference for the bootstrap.
To stay byte-equal with it we have to match its conventions, not just
produce *some* valid binary:

| Concern | Decision |
|---|---|
| Section order | Spec-mandated (1,2,3,5,6,7,10,11). Match exactly. |
| Type-section dedup | wabt dedupes function types. We must dedupe in the same order they're first seen during emission. |
| Function/import index space | Imports come before defined funcs in the func index space. Index assignment must mirror wabt's walk order. |
| LEB128 | Canonical minimal encoding (already unique per value). Free byte-equality. |
| Active data segments | wabt emits `0x00` (memidx 0 + i32.const offset + end) variant. Match. |
| Memory limits | `1` minimum / no max → `0x00 0x01`. Match wabt's flag byte. |
| Name section | Today's WAT relies on `(export "...")` for naming; no custom name section. Skip. |
| Export ordering | wabt emits exports in declaration order. The IR currently has memory + per-function exports; mirror the WAT emitter's order. |
| `(memory (export "memory") 1)` | Emit a memory entry **and** an export of it — same as today's WAT shape. |

The inlined `$alloc / $scratch_alloc / $str_ptr / $str_len / $heap_get /
$heap_set` prelude in `emit_std_prelude` is the single largest source of
drift risk: it's text today and will become bytes tomorrow. Plan
forces this into IR (Slice 3) so both backends emit it the same way.

---

## Slices

### Slice 0 — Audit (no code change)

- Dump `stage1.wasm` via `wasm-tools dump` / `wabt`'s objdump and
  document section ordering, per-section item ordering, and the exact
  bytes wat2wasm emits for the prelude. This becomes the reference
  the new emitter targets.
- Identify every place in `wat.si` where IR is augmented with
  WAT-specific text (e.g. `$g_<n>` global names, `$exit_<id>` labels).
  Labels are a WAT concern — the binary form uses depth indices for
  `br` / `br_if`, so the binary emitter needs its own label→depth
  resolver, **not** an IR change.

### Slice 1 — Prelude reified into IR

Replace `emit_std_prelude` (lines 190–219 of `wat.si`) with IR builders
the lowerer emits at the head of the program:

- `$heap` becomes an existing IR_GLOBAL with init=`LITPOOL_NEXT`.
- `$alloc / $scratch_alloc / $str_ptr / $str_len / $heap_get / $heap_set`
  become real `IR_FUNCTION` records produced by a new
  `lower_runtime_prelude` step run once per program.
- The current WAT emitter, fed the new IR, must produce **the same
  byte sequence** for the prelude as it does today. This is asserted by
  the existing `./build.sh check` self-host gate — if it passes, the
  reification is faithful. If it doesn't, we bless a one-time seed
  re-roll and document it in the commit.

This slice is a no-op functionally; it's a refactor that gives both
backends a single source of truth.

### Slice 2 — CLI plumbing

- `boot/cli.si`: add `CLI_EMIT_WAT:Int` (default 0). `--wat` sets it.
  Update `--help`. Reject `--emit=wat` style (separate concern).
- `boot/stage1.si`: dispatch on `cli_emit_wat` between
  `emit_program_wasm fns` (default) and `emit_program fns` (existing).
- `build.sh` / `build.ps1`: stage1 now writes `.wasm` to stdout. The
  pipeline drops the `wat2wasm` step on the **default** path. For
  `./build.sh check`, the self-host gate compares the new `.wasm`
  to the seed directly — no intermediate `.wat` round-trip. The
  `--wat` path remains for humans inspecting output and for the
  equivalence test (Slice 5).
- `test.sh`: tests run `wasmtime --dir . stage1.wasm < bundle > out.wasm`,
  then `wasmtime out.wasm` directly (no wat2wasm). Keep a single
  `--wat`-driven path for the equivalence test.

### Slice 3 — LEB128 + binary write helpers

New `boot/emit/leb.si`:

- `leb_u32 v:Int` → writes ULEB128 to `EW_OUT`
- `leb_i32 v:Int` → writes SLEB128
- `leb_i64 hi:Int, lo:Int` → SLEB128 for split-int64 (we don't have a
  native i64 in IR globals, so pass the two halves)
- `write_u8 b:Int`, `write_u32_le v:Int` (only for magic/version)
- All emit to fd 1 via `write_byte`.

New `boot/emit/buf.si`: a length-prefixed write buffer in linear memory
so each section can be written into a scratch arena, then its length
LEB-prefixed and flushed to stdout. Sections nest (e.g. code section
contains per-function size-prefixed bodies), so this needs a small stack
of buffer offsets.

### Slice 4 — `boot/emit/wasm.si`

`emit_program_wasm functions:Int := { ... }` mirrors `emit_program`:

1. Magic `\0asm` + version `01 00 00 00`
2. **Type section (1)** — walk functions + externs, dedupe signatures
   in first-seen order, emit each as `0x60 <n_params> <ptype>* <n_results> <rtype>*`
3. **Import section (2)** — one per `IR_EXTERN`
4. **Function section (3)** — type index per defined function
5. **Memory section (5)** — single entry `0x00 0x01`
6. **Global section (6)** — `$heap` + user globals, all mutable i32
   with `i32.const <init> end` init exprs
7. **Export section (7)** — `"memory"` (memory 0) + one per defined
   function in declaration order
8. **Code section (10)** — per function: size-prefixed
   `(local_decl_count, (n, type)*, body_bytes, 0x0B)`. Local groups are
   compressed wabt-style (consecutive same-type locals share a count).
9. **Data section (11)** — one active segment per literal-pool entry

A new `emit_expr_wasm` mirrors `emit_expr` in `wat.si`, walking IR and
appending opcode bytes:

| IR kind | Bytes |
|---|---|
| `IR_I32_CONST n` | `0x41 <sleb i32 n>` |
| `IR_I64_CONST n` | `0x42 <sleb i64 n>` (sign-extend the i32 IR field) |
| `IR_LOCAL_GET i` | `0x20 <uleb i>` |
| `IR_LOCAL_SET i` | `<val>; 0x21 <uleb i>` |
| `IR_GLOBAL_GET i` | `0x23 <uleb i>` |
| `IR_GLOBAL_SET i` | `<val>; 0x24 <uleb i>` |
| `IR_BINOP op …` | per-op opcode table mirroring `emit_binop_mnemonic` |
| `IR_UNOP op …` | per-op opcode table mirroring `emit_unop_mnemonic` |
| `IR_STORE op …` | opcode + align + offset (`0x02 0x00` for word, `0x00 0x00` for byte) |
| `IR_RETURN` | `0x0F` |
| `IR_IF cond t e` | `<cond>; 0x04 <blocktype>; <then>; 0x05; <else>; 0x0B` |
| `IR_LOOP cond body` | `0x02 <bt>; 0x03 <bt>; <cond>; 0x45; 0x0D <depth-to-block>; <body>; [drop]; 0x0C <depth-to-loop>; 0x0B 0x0B` |
| `IR_BREAK` | `0x0C <depth-to-innermost-block>` |
| `IR_CONTINUE` | `0x0C <depth-to-innermost-loop>` |
| `IR_BLOCK …` | sequence; mid-block produced values get `0x1A` drop |
| `IR_CALL …` | args; `0x10 <uleb funcidx>` (or `call_indirect` later) |

A separate label-stack tracks `(block_id, kind∈{block,loop})` so
`IR_BREAK / IR_CONTINUE` resolve to **relative depths** at emission time
(WAT used labels — those go away in binary).

### Slice 5 — Equivalence test

New file `scripts/test-wasm-equiv.sh` driven from `test.sh` (or a new
`./test.sh --equiv`):

```
for fixture in equiv_fixtures/*.si:
  wasmtime stage1.wasm --wat < fixture > a.wat
  wat2wasm a.wat -o a.wasm
  wasmtime stage1.wasm        < fixture > b.wasm
  cmp -s a.wasm b.wasm   # MUST be byte-equal
```

Fixtures, smallest → largest, each isolating one binary-format concern:

| Fixture | Exercises |
|---|---|
| `equiv/01_const.si` | Empty `_start` + one `i32.const`. Tests magic/version/type-section/code-section minimum. |
| `equiv/02_arith.si` | All `i32` binops. Opcode table. |
| `equiv/03_locals.si` | Local-group compression. |
| `equiv/04_globals.si` | Globals + `$heap` prelude function. |
| `equiv/05_extern.si` | One WASI extern. Imports + index-space ordering. |
| `equiv/06_string.si` | Data segment escape parity. |
| `equiv/07_loop.si` | block/loop/br relative depths. |
| `equiv/08_if_value.si` | `if (result i32)` blocktype encoding. |
| `equiv/09_i64.si` | `i64.const` + i64 binops. |
| `equiv/10_self_host.si` | The full stage1 bundle. If this passes byte-equal, we re-bless the seed and remove `wat2wasm` from `build.sh` entirely. |

Failure of any fixture is the regression signal during development.
Fixture `10` is the acceptance criterion for cutting over.

### Slice 6 — Cut over

When 1–9 pass: switch `test.sh` default to the binary path; keep the
`--wat` round-trip available behind a flag.

When 10 passes: drop `wat2wasm` from `build.sh` (default path).
`build.sh check` now compares directly: rebuilt `.wasm` vs seed. Update
docs (`CLAUDE.md`, `bootstrap-plan.html`) to reflect that the
`wat2wasm` dependency is gone for the default build.

The `--wat` path stays as a debugging convenience and as the
equivalence-test driver; it is no longer on the critical path.

---

## Risks & mitigations

- **Self-host fixed point breaks during Slice 1 (prelude reification).**
  Acceptable: re-bless seed in that single commit. Document in commit
  message. All later slices must hold the new fixed point.
- **wabt convention quirks we missed cause Slice 5 fixtures to diverge.**
  Each fixture isolates one concern, so the diff localises the gap.
  Worst case: ship Slice 5 with `wasm-tools print` semantic comparison
  as a fallback, but the bar is byte-equal.
- **i64 emission.** Today `IR_I64_CONST` stores an i32-range value.
  Binary emitter sign-extends in SLEB128 and matches wat2wasm's encoding
  of `(i64.const N)`. Wider i64 literals are a separate stratum, not in
  this plan.
- **`emit_std_prelude`'s `$alloc` uses `memory.size`, `memory.grow`,
  `i32.shl`, `i32.shr_u`, `i32.and`, `if/then/else`, early `return`.**
  These ops/forms must all be available in IR after Slice 1. Audit
  before starting Slice 3; add missing IR kinds *first* (Slice 1.5)
  if anything is missing.

---

## Slice 0 audit results — `wasm-bin/stage1.wasm`

Dumped with wabt 1.0.36's `wasm-objdump`. The audit confirms the
binary emitter can be byte-equivalent to `wat2wasm(emit_wat(ir))` if it
follows the spec layout strictly **and** mirrors a small set of wabt
conventions, all listed below.

### Section layout (must reproduce)

| Section | id | start | size | count |
|---|---|---|---|---|
| Type     | 1  | `0x0a`  | `0x7c`   | 16  |
| Import   | 2  | `0x89`  | `0x129`  | 8   |
| Function | 3  | `0x1b5` | `0x2f0`  | 750 |
| Memory   | 5  | `0x4a7` | `0x3`    | 1   |
| Global   | 6  | `0x4ad` | `0x1a7`  | 84  |
| Export   | 7  | `0x657` | `0x327d` | 745 |
| Code     | 10 | `0x38d8`| `0xb667` | 750 |
| Data     | 11 | `0xef43`| `0x55d8` | 341 |

Standard spec order. **No name section, no custom section** —
keep it that way. `wasm-objdump -h` confirms.

### Function index space + ordering

- Imports occupy func[0..7] in `@extern` declaration order from the
  bundle: `fd_write, fd_read, args_get, args_sizes_get, proc_exit,
  path_open, fd_prestat_get, fd_prestat_dir_name`.
- Prelude funcs follow at func[8..13]:
  `$alloc, $scratch_alloc, $str_ptr, $str_len, $heap_get, $heap_set`
  (in that emission order — matches `emit_std_prelude`).
- User-defined funcs start at func[14] = `argv_load`.

The binary emitter must walk the function vec in the same order
`emit_program` does today: imports → prelude → user funcs → synth `_start`
(if present).

### Type-section dedup

16 distinct signatures dedupe 758 functions. Confirmed by inspection of
`Type[16]` — e.g. sig 5 = `(i32) → i32` is shared by every prelude
helper plus most accessors. The new emitter MUST dedupe in
**first-seen** order during a single walk of imports+functions, or the
sig-index references in the Function section will diverge.

### Memory section

`Memory[1]: memory[0] pages: initial=1` → bytes `01 00 01`
(count=1, flags=0x00 = no max, min=1). Match exactly.

### Global section

84 globals, all `i32 mutable`. global[0] is `$heap`, init `i32=20096`
(= today's `LITPOOL_NEXT`). Globals 1..83 are user globals, all
init=0. Bytes per global: `7f 01 41 <sleb init> 0b` (i32, mut=1,
i32.const init, end). Match.

### Export section

745 entries. Memory FIRST (`"memory" → memory[0]`), then user funcs in
function-index order (NOT alphabetical — wabt preserves emission order).
Prelude funcs (8..13) are **not exported**. The synthesized `_start`,
if present, is exported under its index. Match this exact ordering or
the export section diverges.

### Code section conventions (binary-only surprises)

Disassembly of func[8] (`$alloc`) confirms:

- **Local-group compression:** `04 7f` at body start = "4 locals of type
  i32" (one group of 4). The emitter must group consecutive
  same-type locals.
- **`if` blocktype:** `0x04 0x40` = `if` with empty result. The trailing
  `0x40` is the empty-blocktype encoding; `if (result i32)` would be
  `0x04 0x7f`.
- **Memory load/store:** `28 02 00` = `i32.load align=2 offset=0`. Both
  the alignment and offset are ULEB128, both required.
  - `i32.load`     → `0x28 0x02 0x00`
  - `i32.load8_u`  → `0x2d 0x00 0x00`
  - `i32.store`    → `0x36 0x02 0x00`
  - `i32.store8`   → `0x3a 0x00 0x00`
  - The align value wabt picks is `log2(natural)` — 2 for word, 0 for
    byte. Matching wabt means matching these exact values.
- **`memory.size` / `memory.grow`:** trailing memidx byte (always 0
  in MVP): `0x3f 0x00`, `0x40 0x00`.
- **Function end marker:** every body ends with `0x0B`. Implicit return
  on fall-through (the prelude funcs rely on this for the trailing
  `local.get $a` result).

### Data section

341 active segments, all variant 0:
`00 41 <sleb offset> 0b <uleb size> <bytes…>`.
Order is registration order (= `litpool_addr` order). Match.

### Import section

Each import: `<uleb mod_len> <mod_bytes> <uleb field_len> <field_bytes>
0x00 <uleb type_idx>`. Module = bytes before `::`, field = bytes after.
The `0x00` is "func" descriptor — externs only today.

### What this means for the equivalence test

All of the above is deterministic per spec + wabt's conventions. No
fields require guessing. The Slice 5 fixtures isolate each one:

| Fixture | Pins which convention |
|---|---|
| 01_const | Magic + version + minimal type/code sections |
| 02_arith | Binop opcode table |
| 03_locals | Local-group compression |
| 04_globals | Global init bytes + `$heap` placement at global[0] |
| 05_extern | Import name encoding + func-index alignment with imports first |
| 06_string | Active-data-segment variant 0 |
| 07_loop | `block`/`loop` blocktype + `br` depth resolution |
| 08_if_value | `if (result i32)` blocktype `0x7f` vs empty `0x40` |
| 09_i64 | i64.const SLEB encoding |
| 10_self_host | Type-section dedup + 750-func index space + 341 data segs |

If fixture 10 passes byte-equal, the new emitter has reproduced every
wabt convention listed in this audit and `wat2wasm` can be dropped
from the default build.
