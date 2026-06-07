# IR-Handle ABI — Phase B Continuation Design

**Status:** Design (D-B-1).  Implementation in D-B-2…D-B-13.
**Scope:** Phase 0 dissolution — comptime-via-compilation.
**Adjacent code:** `src/comptime/engine.ts`, `src/comptime/imports.ts`,
`src/comptime/handles.ts`.

This document specifies how a compiled strata handler (a `@fn` lowered
through the normal Sigil pipeline and instantiated as a WASM module)
constructs IR results and hands them back to the host so they can be
inserted into the lowered output of the user program.

Without this ABI, compiled handlers can only do "pure" computation —
return an `i32`, do arithmetic.  The whole point of a handler is to
*emit IR*: `@if` lowers to `IRIf`, `+` lowers to `IRBinOp`, `@export`
lowers to `IRExport`.  Every such handler needs to:

1.  Read fields of the AST node it's lowering.
2.  Lower sub-expressions to IR (calling the host's `lowerExpr`).
3.  Construct an IR result (calling host `ir.make*` builders).
4.  Return the IR result to the firing code.

This ABI gives all four mechanisms an i32-clean surface.

---

## 1.  Representation — IR handles

IR nodes (`IRExpr`, `IRStmt`, `IRFunction`, `IRGlobal`, `IRImport`,
`IRExport`, `IRLocal`, `IRParam`) are JS objects.  They cross the WASM
boundary as `i32` ids into a per-firing handle table.

```ts
interface ComptimeEnv {
    registry: ElaboratorRegistry
    handles: HandleTable<any>
    strings: StringPool
    irHandles: HandleTable<IRNode>     // NEW (D-B-2)
    testLog: any[]
}

type IRNode =
    | IRExpr | IRStmt
    | IRFunction | IRGlobal | IRImport | IRExport
    | IRLocal  | IRParam
```

A separate table for IR (rather than reusing the generic `handles`
table) lets us reset IR handles independently and gives us a cleaner
domain for leak checks in tests.

**Allocation policy.**  Each successful `ir_make*` import call returns
a fresh i32 id (monotonic from 1; 0 reserved for null/no-handle).
`HandleTable.fresh(value)` is the right primitive — we don't want
`intern` because two structurally-identical IR nodes are distinct in
the IR tree.

**Lifetime.**  Handles are released after the firing returns its
result.  The firing code calls `irHandles.get(resultHandle)` to recover
the JS IR object, inserts it into the lowered output, then calls
`irHandles.clear()` (or releases just the handles it allocated, when
nested firings make that finer-grained tracking worth the cost).

For Phase 0 the simple rule is: **clear at end of each handler
firing**.  Persistent IR lives in the lowered output, not in the
handle table.

---

## 2.  Return-value contract

Every `@fn` strata handler exports one function:

```wat
(func (export "<HandlerName>") (param $node i32) (result i32) ...)
```

- The parameter is an i32 handle (into `env.handles`) for the AST
  node being lowered.  See §4 for how the handler reads fields.
- The return value is an i32 handle (into `env.irHandles`) for the
  IR-node result, or `0` for "no IR" (`&IR::null` in legacy form;
  `Nop` equivalent).

The firing wrapper in `strataLoader.ts` does:

```ts
function fireCompiledHandler(node, env): IRExpr | null {
    const nodeId = env.handles.intern(node)
    const resultId = compiledInstance.invoke(nodeId)
    const result = resultId === 0 ? null : env.irHandles.get(resultId)
    env.handles.release(nodeId)
    env.irHandles.clear()              // single-firing lifetime
    return result as IRExpr | null
}
```

There is exactly one return path.  No side-channel result imports.
The function's i32 return value *is* the handle.

---

## 3.  Import surface — every IR builder

Each entry below lists:
- **WAT signature** — what the handler module imports.
- **Host wrapper** — TS function in `imports.ts` (always named
  `ir_<builder>`).
- **JS impl** — what the wrapper does (terse — it just calls the
  existing `IRBuilders.make*` function and interns the result).

All strings cross the boundary as `StringPool` ids.  All IR sub-nodes
cross as `irHandles` ids.  Numbers cross as raw i32 (sign-extended on
the WASM side; the host re-interprets via `| 0` where needed).

### 3.1 Constants and identifier reads (D-B-3)

| Name | WAT signature | JS impl |
|---|---|---|
| `ir_makeConst`     | `(i32 value, i32 wasmType_str) → i32 handle` | `irHandles.fresh(ir.makeConst(value, strings.get(wasmType_str) as WasmValType))` |
| `ir_makeLocalGet`  | `(i32 name_str, i32 wasmType_str) → i32 handle` | `irHandles.fresh(ir.makeLocalGet(s(name), s(wt) as WasmValType))` |
| `ir_makeLocalSet`  | `(i32 name_str, i32 value_h) → i32 handle` | `irHandles.fresh(ir.makeLocalSet(s(name), irHandles.get(value_h)))` |
| `ir_makeGlobalGet` | `(i32 name_str, i32 wasmType_str) → i32 handle` | analogous |
| `ir_makeGlobalSet` | `(i32 name_str, i32 value_h) → i32 handle` | analogous |
| `ir_makeBinOp`     | `(i32 instr_str, i32 left_h, i32 right_h, i32 wasmType_str) → i32 handle` | `irHandles.fresh(ir.makeBinOp(s(instr), get(left), get(right), s(wt) as WasmValType))` |
| `ir_makeBlock`     | `(i32 stmts_arr_h, i32 trailing_h, i32 wasmType_str) → i32 handle` | see §5 (arrays) |

### 3.2 Control flow (D-B-4)

| `ir_makeIf`       | `(i32 cond_h, i32 then_h, i32 else_h, i32 wasmType_str) → i32 handle` |
| `ir_makeLoop`     | `(i32 id, i32 cond_h, i32 body_h) → i32 handle` |
| `ir_makeBreak`    | `(i32 id) → i32 handle` |
| `ir_makeContinue` | `(i32 id) → i32 handle` |
| `ir_makeReturn`   | `(i32 value_h) → i32 handle` (pass `0` for void return) |

### 3.3 Module-level (D-B-5)

| `ir_makeExport`   | `(i32 alias_str, i32 internalName_str, i32 what_str) → i32 handle` — `what_str` is "func" or "global" |
| `ir_makeGlobal`   | `(i32 name_str, i32 wasmType_str, i32 mutable, i32 init_h) → i32 handle` |
| `ir_makeFunction` | `(i32 name_str, i32 params_arr_h, i32 returnType_str, i32 locals_arr_h, i32 body_h) → i32 handle` |
| `ir_makeImport`   | `(i32 env_str, i32 field_str, i32 name_str, i32 params_arr_h, i32 result_str_or_0) → i32 handle` |
| `ir_makeLocal`    | `(i32 name_str, i32 wasmType_str) → i32 handle` |
| `ir_makeParam`    | `(i32 name_str, i32 wasmType_str) → i32 handle` |
| `ir_null`         | `() → i32` — returns 0; equivalent to `&IR::null` legacy marker |

### 3.4 Call (deferred — handlers needing call IR can wait for D-B-3b)

| `ir_makeCall` | `(i32 callee_str, i32 args_arr_h, i32 wasmType_str, i32 callKind_str) → i32 handle` |

### 3.5 Utilities

| `ir_makeNop`         | `() → i32 handle` |
| `ir_makeUnreachable` | `() → i32 handle` |

---

## 4.  AST field accessor (D-B-7)

The handler reads fields of its node argument through a single import:

```
compiler_ast_field (node_h, field_path_str) → i32 result
```

`field_path_str` is a dotted path id from the string pool, e.g.
`"name.name"`, `"params.0.typeAnnotation.typename"`.

Return-value tagging is needed because the field can be many shapes:

| Tag (high bits)  | Meaning |
|---|---|
| `0x0000_0000` | id `0` — null/undefined field |
| `0x1xxx_xxxx` | a child AST node handle (low 28 bits is an `env.handles` id) |
| `0x2xxx_xxxx` | a string-pool id (low 28 bits is the string id) |
| `0x3xxx_xxxx` | a small integer literal value (low 28 bits is the int) |
| `0x4xxx_xxxx` | a boolean — low bit is 0 (false) or 1 (true) |

Handlers know what kind of field they're asking for, so the tag is a
correctness check, not a discriminant they branch on at runtime.

For values that don't fit (large ints, floats), a separate import
returns the raw i64 or f64 — but Phase 0 strata only inspect i32-shaped
fields (names, simple integer literals, child nodes).  Defer.

**Worked example.**  Reading `node.name.name` (string):

```silicon
# inside handler @fn:
@let name_path := 'name.name';
@let name_str_id := &compiler_ast_field(node_h, &compiler_intern_str(name_path));
# untag: low 28 bits = string id
@let name_str := &compiler_string_get(name_str_id & 0x0FFFFFFF);
```

The convenience macros `&Compiler::watId Node.name.name` get desugared
to this sequence by the lowerer when it sees a legacy `Node.x.y`
expression inside a strata-handler `@fn`.  See D-D-1 worked example
below.

---

## 5.  Arrays (D-B-3 / D-B-5)

`makeBlock`, `makeFunction`, `makeImport` take arrays.  Two options:

**A.  Array-builder imports** (chosen):

```
compiler_arr_new()                → i32 arr_h
compiler_arr_push(arr_h, val_h)   → void
```

`arr_h` is an `irHandles` id holding a JS `any[]`.  `val_h` is whatever
goes in the array (typically an IR handle, but also IRParam / IRLocal
records).  The builder unboxes when constructing the IR node.

**B.  Variadic imports.**  Rejected — WASM imports aren't variadic.

---

## 6.  Worked example: `makeIf` end-to-end

Legacy strata body (`src/strata/if.si`):

```silicon
@stratum_keyword IfStmt ('@if', Node) = {
    &IR::control_if;
    @local condN := &Compiler::arg Node, 0;
    @local thenN := &Compiler::arg Node, 1;
    @local elseN := &Compiler::arg Node, 2;
    @local cond  := &Compiler::lowerExpr condN;
    @local then  := &Compiler::lowerExpr thenN;
    @local else_ := &Compiler::lowerExprIfDefined elseN;
    &Compiler::ir::makeIf cond, then, else_;
};
```

After migration (`src/strata/if.si`):

```silicon
@stratum IfStmt := {
    Compiler::register::keyword('@if');
    Compiler::on::lower('@if', IfStmt_lower);
};

@fn IfStmt_lower node Int := {
    condN := compiler_arg(node, 0);
    thenN := compiler_arg(node, 1);
    elseN := compiler_arg(node, 2);
    cond  := compiler_lowerExpr(condN);
    then  := compiler_lowerExpr(thenN);
    else_ := compiler_lowerExprIfDefined(elseN);
    compiler_ir_makeIf(cond, then, else_, 0)   # 0 = wasmType inferred
};
```

Host side (`src/comptime/imports.ts`):

```ts
const ir_makeIf = (condH: number, thenH: number, elseH: number, wtStr: number): number => {
    const cond  = irHandles.get(condH)  as IRExpr
    const then  = irHandles.get(thenH)  as IRExpr
    const else_ = elseH === 0 ? undefined : irHandles.get(elseH) as IRExpr
    const wt    = wtStr === 0 ? undefined : strings.get(wtStr) as WasmType
    return irHandles.fresh(api.ir.makeIf(cond, then, else_, wt))
}
```

Firing wrapper:

```ts
const irHandle = compiled.invoke(env.handles.intern(node))
const irResult = env.irHandles.get(irHandle) as IRIf
// emit `irResult` into the lowered output
env.irHandles.clear()
```

---

## 7.  Decision: result-handle protocol

Two candidates were considered:

**A.  Single-return.**  Exported handler returns its result handle as
the function's i32 result.  *Chosen.*

**B.  `set_result` import.**  Handler calls `compiler_set_result(h)`
to record its result; export returns void.

Reason for A: simpler, lines up with how `@fn handler n Int := { ... }`
naturally compiles.  The trailing expression of the handler body lowers
to a return value already.  No side-channel needed.

---

## 8.  Implementation phasing

| Story | Adds |
|---|---|
| D-B-2 | `irHandles` field on `ComptimeEnv`; round-trip tests |
| D-B-3 | `ir_makeConst`, `ir_makeBinOp`, `ir_makeLocalGet`, `ir_makeLocalSet`, `ir_makeBlock`, `compiler_arr_new`, `compiler_arr_push` |
| D-B-4 | `ir_makeIf`, `ir_makeLoop`, `ir_makeBreak`, `ir_makeContinue`, `ir_makeReturn` |
| D-B-5 | `ir_makeExport`, `ir_makeGlobal`, `ir_makeFunction`, `ir_makeImport`, `ir_makeLocal`, `ir_makeParam`, `ir_null` |
| D-B-7 | `compiler_ast_field` with tagged returns |
| D-B-12 | `compiler_lowerExpr`, `compiler_lowerExprIfDefined`, `compiler_lowerParams`, `compiler_lowerFunctionBody`, `compiler_resolveFunctionReturnType` |
| D-B-13 | `compiler_watId`, `compiler_freshId`, `compiler_arg`, `compiler_choose`, `compiler_resolveType`, `compiler_isVarName` |

Each story is a strict additive change to `imports.ts` and its tests
— no behaviour change to existing strata until D-D migrations begin
flipping their bodies.

---

## 9.  Non-goals

- **No i64/f64 in this surface.**  All boundary ints are i32.  i64 IR
  values stay as IR handles (the IR node carries its `wasmType`).
- **No streaming.**  A handler builds its whole IR tree before
  returning.  This is fine — IR trees for a single statement are
  bounded.
- **No mutation of existing IR handles.**  IR nodes are immutable
  after construction.  Builders that "modify" an IR tree (e.g.
  `with_keyword` on a template) return a fresh handle.
