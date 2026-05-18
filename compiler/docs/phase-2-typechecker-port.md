# Phase 2 — Silicon-side Typechecker Port

> Briefing document for porting `src/types/*` to `boot/types/*.si`. Read this
> first before starting work; it captures everything a fresh session needs to
> hit the ground running without re-reading the TS source.

## Why this matters

This is the **biggest single remaining blocker** for deleting `src/`. Stage 1
today has no type checker — it compiles syntactically valid programs that the
Stage 0 TS typechecker would reject (wrong-arity calls, mismatched arg types,
unbound identifiers, etc.). Until stage1 can refuse those programs the same
way, "compile via stage1" gives weaker safety than "compile via TS".

## What lives in `src/types/` today

| File | LoC | Role |
|---|---|---|
| `types.ts` | 239 | `SiliconType` tagged union + helpers (`wasmTypeOf`, `typeEquals`, `formatType`, `parseTypeName`, `isNumeric`, `isComparable`, `isEqualityComparable`). |
| `errors.ts` | 144 | `TypeError` record + factories (`mismatch`, `invalidOperator`, `unbound`, `unknownType`, `heterogeneousArray`, `annotationMismatch`, `immutableAssignment`) + `formatTypeError` renderer. |
| `intrinsicSig.ts` | 106 | Maps `WASM::*` / `IR::*` intrinsic names → `(param types, result type)` via regex pattern-match on the name. |
| `typechecker.ts` | **1042** | The pass itself. Recursive walk over the AST that annotates `inferredType` on every expression and accumulates `TypeError`s into `Ctx`. |
| `typechecker.test.ts` | 534 | Unit tests — drives `typecheck()` with hand-built AST nodes, asserts specific errors. |
| `typecheck.integration.test.ts` | 455 | Integration tests — drives `typecheck()` with parser-produced AST from real Silicon source. |
| **Total non-test** | **1531** | What we need to port. |

## How it slots into the pipeline

```
parse → toAst → elaborate → typecheck → lowerProgram → emit
                              ^^^^^^^^^
                              this pass
```

Call site (`scripts/build-boot.ts:51`, `src/sigil_cli.ts:84`):

```ts
const { program: typed, errors: typeErrors, functions } =
    typecheck(elab, registry, moduleRegistry)
if (typeErrors.length > 0) {
    for (const e of typeErrors) console.error('  ' + formatTypeError(e))
    process.exit(1)
}
```

Output:
- Mutates AST in place — every expression node gets an `inferredType: SiliconType` field.
- Returns `{program, errors, functions, typeAliases}`. `functions` is consumed
  by codegen to resolve return types at call sites.

## The `SiliconType` ADT

The single most important data structure to port. Eight variants (see
`src/types/types.ts:34`):

```ts
type SiliconType =
  | { kind: 'Int' }
  | { kind: 'Int64' }
  | { kind: 'Float' }
  | { kind: 'String' }
  | { kind: 'Bool' }
  | { kind: 'Array';    element: SiliconType }
  | { kind: 'Function'; params: SiliconType[]; result: SiliconType }
  | { kind: 'Distinct'; name: string; underlying: SiliconType }
  | { kind: 'Sum';      name: string; variants: string[] }
  | { kind: 'Unknown' }
```

WASM lowering (`wasmTypeOf`):
- `Int`, `Bool`, `String`, `Array`, `Function`, `Sum`, `Unknown` → `i32`
- `Int64` → `i64`
- `Float` → `f32`
- `Distinct` → underlying's WASM type (recursive)

**Silicon-side encoding suggestion**: a flat record kind in an arena vec,
similar to how `boot/ir/nodes.si` does IR. Each `SiliconType` is an int
handle into the type arena. Fields by offset:
- field 0 = kind (1=Int, 2=Int64, 3=Float, 4=String, 5=Bool, 6=Array, 7=Function, 8=Distinct, 9=Sum, 10=Unknown)
- variable-arity payload follows

Singletons for Int/Int64/Float/String/Bool/Unknown — preallocate once at
`types_init`, reuse handles.

## TypeError shape

```ts
type TypeErrorKind =
  | 'UnknownType' | 'Mismatch' | 'InvalidOperator'
  | 'UnboundIdentifier' | 'HeterogeneousArray'
  | 'Annotation' | 'ImmutableAssignment'

interface TypeError {
  kind: TypeErrorKind
  message: string
  sourceLocation?: SourceLocation
}
```

The message format is fixed (matches `formatTypeError`):

```
[Mismatch] 12:5: expected Int, got Float
[InvalidOperator] 8:3: operator '+' cannot be applied to (String, Int)
[UnboundIdentifier] 4:1: unbound identifier 'foo'
[UnknownType] 2:8: unknown type 'Widget'
[HeterogeneousArray] 9:14: array literal must be homogeneous: first element is Int, found Float
[Annotation] 3:1: 'x' declared as Int but initialiser has type String
[ImmutableAssignment] 7:1: 'foo' is immutable and cannot be reassigned
```

Locking in this string format is what enables the **byte-equal gate**:
stage1's emitted errors JSON should match TS's byte-for-byte.

## The typechecker walk

`typecheck()` runs **three sub-passes**:

1. **`preRegisterModules`** — seed `ctx.functions`/`ctx.symbols` from
   `ModuleRegistry` (user `@extern`-declared modules). Maps every
   `<module>::<fn>` → `FunctionSig`.

2. **`preRegisterStdFunctions`** — hardcoded list of std.wat helpers
   (`alloc`, `arr_load_i32`, `str_ptr`, `heap_get`, etc.) with their
   `FunctionSig`s.

3. **`preRegisterDefinitions`** — walk top-level definitions twice:
   - Pass 1: collect `@type_alias` and `@type_distinct` declarations into
     `ctx.typeAliases` (so subsequent `@fn` annotations can reference them).
   - Pass 2: collect `@fn`/`@let`/`@var`/`@extern` signatures into
     `ctx.functions`/`ctx.symbols`; mark `@let`/`@fn`/`@extern` names in
     `ctx.immutable`.

4. **Main walk** — for each top-level element, call `checkNode(element, ctx)`.

`checkNode` is a big switch on `node.type`:
- Literal types (`IntLiteral`, `FloatLiteral`, etc.) → return their singleton.
- `Namespace` → symbol-table lookup (with `::`-joined key), else `unbound`.
- `BinaryOp` → recurse on operands, look up operator stratum in
  `ctx.registry`, validate operand types, return result type.
- `FunctionCall` → recurse on each arg, look up callee's `FunctionSig`,
  validate arity + per-arg types.
- `Block` → withScope: recurse on stmts, return type of trailing expression.
- `Assignment` → check target is mutable, recurse on value, ensure type match.
- `Definition` → register name (in inner scopes), check binding type matches
  annotation.
- `If`/`Loop`/`Return`/etc. (via `FunctionCall` with `@keyword` callee) →
  validate per-keyword shape.
- `ArrayLiteral`/`TupleLiteral`/`ObjectLiteral` → recurse on elements,
  homogeneity check.

Mutates each visited node: `node.inferredType = <result>`.

## Intrinsic signature derivation

`intrinsicSig.ts:intrinsicSignature(fullName)` derives a `TypeSig` by
pattern-matching the intrinsic name. Examples:

```
WASM::i32_add        → ([Int, Int],   Int)
WASM::i32_eq         → ([Int, Int],   Bool)
WASM::f32_convert_i32_s → ([Int],     Float)
WASM::i32_load       → ([Int],        Int)
WASM::i32_store      → ([Int, Int],   Unknown)  // void
```

Regex patterns:
- Binary arith/bitwise/compare: `^(i32|i64|f32)_(add|sub|mul|div(_[su])?|rem(_[su])?|and|or|xor|shl|shr_s|shr_u|rotl|rotr|eq|ne|lt(_[su])?|gt(_[su])?|le(_[su])?|ge(_[su])?)$`
  - Comparisons return `Bool`; arithmetic returns the operand type.
- Unary i32: `clz`, `ctz`, `popcnt` → `Int → Int`.
- Unary f32: `abs`, `neg`, `sqrt` → `Float → Float`.
- Specific conversions: `i32_trunc_f32_s`, `f32_convert_i32_s`, `i64_extend_i32_s`, `i32_wrap_i64`.
- Memory: `i32_load*`, `i64_load`, `f32_load`, `i32_store*`, `i64_store`, `f32_store`.
- Misc: `data_memory`, `mem_grow`.
- Anything else (`control_*`, `def_*`, `meta_*`) → `undefined` (no surface
  type).

**Silicon port** — Silicon doesn't have regex. The port will need to be
written as a series of byte-prefix and suffix string comparisons (similar
to how `boot/ir/lower.si:type_name_to_kind` already does TYPE_* parsing).
Maybe ~200 LoC for the full table.

## Suggested staging (multi-session)

Each slice ships behind a byte-equal-vs-Stage-0 gate on the existing test
corpus. Pattern from earlier Silicon-only work: dump `JSON.stringify(errors)`
from both compilers, `cmp`-compare the bytes.

### Slice 2a — Types module + arena (200 LoC, 1 session)

Port `types.ts`:
- `SiliconType` arena (`TYPE_VEC`)
- Singletons (`TYPE_INT_H`, `TYPE_INT64_H`, …) initialised once
- `wasm_type_of(h)` → TYPE_* tag
- `type_equals(a, b)` recursive
- `format_type(h)` → write bytes to a scratch buffer (for error messages)
- `parse_type_name(off, len, aliases)` — substring match against `'Int'`,
  `'Int32'`, `'Int64'`, `'Float'`, `'String'`, `'Bool'`, `'Void'`, `'i32'`,
  `'i64'`, `'f32'`; lookup in aliases table.
- `is_numeric`, `is_comparable`, `is_equality_comparable`

Gate: small unit test exercising each helper.

### Slice 2b — Errors module (100 LoC, 1 session)

Port `errors.ts`:
- Error arena (`ERR_VEC`) with kind + message + source-location fields
- Factories (`err_mismatch`, `err_invalid_operator`, `err_unbound`, etc.)
  that format the message into a string-pool entry
- `format_type_error(err_h)` → writes the canonical
  `[Kind] LINE:COL: message` string to a scratch buffer
- JSON dumper for the byte-equal gate

Gate: unit test that creates each error variant and checks the formatted
output matches Stage 0.

### Slice 2c — Intrinsic signature derivation (200 LoC, 1 session)

Port `intrinsicSig.ts`:
- `intrinsic_signature(name_off, name_len)` returns a TypeSig handle (or -1
  for unrecognised).
- Implementation: prefix-match `'WASM::'` or `'IR::'`, then dispatch on the
  short name via substring tests for each pattern family.

Gate: byte-equal JSON dump of `(intrinsic_name, params, result)` triples
for every `WASM::*` and `IR::*` op the strata bundle references.

### Slice 2d — Pre-registration passes (200 LoC, 1 session)

Port `preRegisterModules`, `preRegisterStdFunctions`, `preRegisterDefinitions`:
- ModuleRegistry equivalent in Silicon — read `boot/strata/builtin/modules/*.si`
  into a per-module `(fn_name → TypeSig)` map.
- Hardcoded std.wat function signatures table (same list as
  `preRegisterStdFunctions`).
- Walk program elements, find `Definition` nodes, fill `ctx.functions`,
  `ctx.symbols`, `ctx.immutable`, `ctx.typeAliases`.

Gate: byte-equal JSON dump of `ctx.functions` after pre-registration on
the full bootstrap source.

### Slice 2e — `checkNode` switch (400+ LoC, multi-session)

This is the bulk of the work. Implement type inference for each AST kind:
- Literals (trivial)
- `Namespace` (symbol lookup)
- `BinaryOp` (recurse + operator-strata lookup + arity check)
- `FunctionCall` (recurse + signature lookup + arg-type validation)
- `Block` (withScope + stmt walk + trailing-expr type)
- `Assignment` (mutability check + type match)
- `Definition` (annotation check vs binding type)
- `ArrayLiteral` (homogeneity check)
- `TupleLiteral`, `ObjectLiteral` (structural inference)
- Keyword calls (`@if`, `@loop`, `@return`, `@match`, etc.) — each has its
  own shape rules.

Gate: byte-equal JSON dump of `{program: <inferred-types-by-node-position>,
errors: [...]}` for every fixture in `src/types/typecheck.integration.test.ts`
and `tests/properties/` corpus.

### Slice 2f — Wire into stage1 + remove TS reliance (50 LoC, 1 session)

- `boot/stage1.si` calls `typecheck` between elaborate and lower
- On non-empty errors: write JSON to stderr, `proc_exit 1`
- Update `tests/wasix-smoke.test.ts` STAGE 1 PIPELINE fixtures to assert
  type-error scenarios fail consistently with TS

## Key risks

1. **`typeEquals` for Sum/Distinct identity** — TS uses `===` on
   pre-allocated objects for Sum/Distinct singletons (name-based equality).
   Silicon arena needs to ensure two declarations of the same sum name
   produce the SAME handle, or `type_equals` compares names.
2. **Symbol table scoping** — TS uses `Map<string, SiliconType>` with
   `withScope` saving and restoring. Silicon needs a parallel-vec scope with
   save/restore (like `boot/elab/body_scope.si`'s `bs_truncate` pattern).
3. **Forward references** — `preRegisterDefinitions` is critical; without
   it, calls to functions defined later in the file fail with
   `UnboundIdentifier`. Bootstrap source has many such cases.
4. **Error message byte-equality** — the formatted message strings ARE
   the byte-equal gate. Any deviation (extra space, different quote, etc.)
   breaks the gate. Port carefully, character-by-character.
5. **`Unknown` propagation** — TS uses `Unknown` as a poison value so a
   single error doesn't cascade. Silicon port needs the same discipline.

## What stage1 already has (free for Silicon-side typecheck)

- AST arena in `P_AST` with field accessors (`ast_kind`, `ast_field`)
- Source span access via `P_SRC + off`
- Strata registry (`registry_kw_lookup`, `registry_op_lookup`, etc.) —
  needed for operator/keyword type lookup
- Body interpreter (`body_rich`) — useful for some Compiler::*-style
  typecheck-time evaluation if needed
- `boot/std/vec.si` — generic i32 vec for arenas/scopes
- `boot/compiler_api/ctx.si` — would extend to host `Ctx`-equivalent state

## Estimated total effort

~1500 LoC of Silicon across 5-6 focused sessions. Slices 2a-2c can land
independently in any order; 2d builds on them; 2e is the cliff; 2f is
mechanical.

## Once Phase 2 is done

The TS-deletion checklist becomes:
- ✓ Shell build pipeline
- ✓ stage1.wasm seed
- ✓ Codegen correctness
- ✓ Strata regen
- ✓ Add-new-keywords in pure Silicon (`@nz`, `@const`, `@loc` prove it)
- ✓ Typechecker (this phase)
- Pending: `@use` resolver in Silicon (Phase 3 — small)
- Pending: expanded Silicon-side test runner (Phase 6 — medium)
- Pending: definition keywords (`@let`/`@fn`/`@var`/`@extern`/`@export`)
  fully wired through body_rich (continuation of the work that proved out
  with `@const` and `@loc`)

After all of those: `rm -rf src/ scripts/*.ts tests/ package.json bun.lockb
tsconfig.json node_modules/`. The repo continues to build via `./build.sh`
and test via `./test.sh`.
