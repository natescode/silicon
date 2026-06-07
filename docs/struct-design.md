# `@type` — Product Types in Silicon

Silicon's `@type Name := { ... }` form declares a product type (record) with named fields.

## Syntax

```silicon
@type Point := { x Int, y Int };
```

Fields are declared as the definition's param list — the same positional syntax as `@fn` params, so no new grammar is needed.

## Semantics

- A struct is a heap-allocated record: a contiguous block of memory holding each field in declaration order.
- The struct name (`Point`) becomes a constructor function that takes one argument per field and returns an `i32` pointer to the allocated record.
- Fields are laid out at sequential byte offsets. `Int` and `Bool` fields occupy 4 bytes (`i32`); `Float` fields 4 bytes (`f32`); `Int64` fields 8 bytes (`i64`).
- The constructor calls `alloc(totalSize)` to bump-allocate the record, stores each field at its offset, and returns the pointer.

## Constructor

`@type Point := { x Int, y Int };` generates:

```wat
(func $Point (param $x i32) (param $y i32) (result i32)
  (local $__rec i32)
  (local.set $__rec (call $alloc (i32.const 8)))
  (i32.store (local.get $__rec) (local.get $x))
  (i32.store (i32.add (local.get $__rec) (i32.const 4)) (local.get $y))
  (local.get $__rec)
)
```

## Field Access

```silicon
p := Point(3, 7);
p.x   ;; reads field x
p.y   ;; reads field y
```

`p.x` lowers to `(i32.load (local.get $p))`.  
`p.y` lowers to `(i32.load (i32.add (local.get $p) (i32.const 4)))`.

Field reads at offset 0 elide the `i32.add` for efficiency.

## Field Write

```silicon
p.x = 10;
```

Lowers to `(i32.store (local.get $p) (i32.const 10))`.

## Type Annotation

Struct locals must carry the struct type name in their annotation:

```silicon
p := Point(3, 7);   ;; field access resolves via inferred struct type
```

The type system tracks which locals hold which struct type via `structLocals` (in lower.ts) and `ctx.structFields` (in the typechecker). Without the annotation, field access is not resolvable.

## Type Checking

The typechecker registers each `@type` struct definition as a `DistinctOf(name, TypeInt)` type alias. This means:
- `p := Point(3, 7)` is accepted without an `[UnknownType]` error.
- `p.x` is resolved by looking up `p`'s type, extracting the struct name, and finding the field's Silicon type in `ctx.structFields`.
- The constructor function signature (`Point : (Int, Int) → Point`) is registered for call-site checking.

## Implementation

| Layer | File | What it does |
|---|---|---|
| Stratum registration | `src/strata/struct.si` | Registers `@type` struct form and `on_lower` hook |
| Struct expander | `src/strata/defExpanders.ts` | `structExpander`: builds constructor `IRFunction`, registers `StructLayout` |
| Layout registry | `src/elaborator/registry.ts` | `StructLayout` / `StructFieldLayout` types; `structTypes` map on `ElaboratorRegistry` |
| Compiler API | `src/compiler-api/index.ts` | Exposes `ctx.structTypes` to the comptime engine |
| Comptime import | `src/comptime/imports.ts` | `compiler_expandStruct`: calls `structExpander.expand` from Silicon handler |
| Lowering | `src/ir/lower.ts` | `structLocals` map; field read in `lowerNamespace`; field write in `lowerBinaryOp` |
| Type checking | `src/types/typechecker.ts` | `preRegisterStructType`; struct field lookup in `typeOfNamespace`; `ctx.structFields` |

## Limitations (current `src/` implementation)

- No nested structs (struct fields of struct type) — field lowering assumes all fields are scalar wasm types.
- No struct-typed function return values in the typechecker (return type is `DistinctOf('Point', TypeInt)` which is `i32` at the WASM level — this is correct).
