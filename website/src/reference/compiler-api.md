---
title: "Compiler API"
---
# `&Compiler::*` — Sigil Compiler API for Strata

This is the reference for the `&Compiler::*` namespace exposed to Silicon
strata bodies. The API is the only seam between user-defined strata and the
compiler's internal lowering machinery; every definition kind and every
control-flow keyword in the standard library is implemented on top of it.

> **Audience:** authors of `.si` strata files (built-in or user-supplied).
> **Stability:** the surface listed here is stable across patch releases.
> Anything not listed is internal and may change.

---

## 1. How a stratum body is compiled

A strata definition has three parts: the dispatch header, the dispatch
marker, and (optionally) a rich body.

```silicon
@stratum_keyword LetDef ('@global', Node) = {
  &IR::def_function;                              # 1. dispatch marker
  @local name := &Compiler::watId Node.name.name; # 2. rich body
  @local body := &Compiler::lowerExpr Node.binding.expression;
  &Compiler::ir::makeFunction name, [], 'void', [], body;
};
```

1. **Dispatch marker** — the first `&IR::xxx` or `&WASM::xxx` call. The
   strata loader uses it to identify the codegen kind (`function`, `global`,
   `local`, `export`, …) or the intrinsic this body handles. It is a
   *runtime no-op*; it carries no semantics during body execution.

2. **Rich body** — any sequence of `@local := …` bindings and
   `&Compiler::*` calls. The final expression's value is the result the
   compiler stores (typically an IR node from `&Compiler::ir::*`, or
   `&IR::null` for definitions that emit no WAT).

The body interpreter evaluates statements top-to-bottom. There is **no
control flow inside a body** — no `@if`, no `@loop`, no recursion. When you
need branching, use `&Compiler::choose`; when you need iteration, call one
of the helpers that does the iteration internally
(`lowerParams`, `lowerExternParams`, `expandMatchChain`, …).

Each call's arguments are evaluated **left-to-right, eagerly**. Field
access on a JS object via the namespace path is allowed:
`Node.name.typeAnnotation`, `funcResult.body`, etc.

---

## 2. The `Node` parameter

The third token of the strata header (`Node` in the examples above) is the
parameter name your body uses to refer to the AST node being processed.
What it is bound to depends on the strata type:

| Strata header                          | `Node` is …                                |
| -------------------------------------- | ------------------------------------------ |
| `@stratum_keyword`  (def-kind body)    | the `Definition` AST node                  |
| `@stratum_keyword`  (builtin-call body)| the rawArgs array (use `&Compiler::arg`)   |
| `@stratum_operator` (rich body — rare) | the rawArgs array                          |

For builtin-call expanders the body interpreter also exposes
`inferredType` as an identifier, holding the type-checker's `SiliconType`
for the call site.

---

## 3. API reference

All APIs live under `&Compiler::*`. Nested namespaces (`Compiler::ctx::*`,
`Compiler::ir::*`) are how the surface is organised; they are dispatched
by walking the path against the JS API object.

### 3.1 `Compiler::ctx::*` — lowering context

The current lowering context. Most calls have side effects — they mutate
the locals / globals / loop-stack the compiler will use when assembling
the rest of the module.

| Call                                           | Effect                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| `&Compiler::ctx::locals::get(name)`            | Read a local's WASM type, or undefined.                                 |
| `&Compiler::ctx::locals::set(name, type)`      | Record a local in the locals map.                                       |
| `&Compiler::ctx::globals::get(name)`           | Read a global's WASM type, or undefined.                                |
| `&Compiler::ctx::globals::set(name, type)`     | Record a global in the globals map.                                     |
| `&Compiler::ctx::varNames::has(name)`          | True if `name` is a real WAT global (a `@local` / sum-type variant).      |
| `&Compiler::ctx::varNames::add(name)`          | Mark `name` as a real WAT global.                                       |
| `&Compiler::ctx::pendingLocals::push(local)`   | Hoist an `IRLocal` to the current function's preamble.                  |
| `&Compiler::ctx::loopStack::push(id)`          | Push a loop ID — needed when nesting `@break` / `@continue` targets.    |
| `&Compiler::ctx::loopStack::pop`               | Pop the innermost loop ID.                                              |
| `&Compiler::ctx::loopStack::peek`              | Peek the innermost loop ID without popping (undefined if empty).        |
| `&Compiler::ctx::nextLoopId`                   | Allocate a fresh monotonic loop ID.                                     |
| `&Compiler::ctx::functionSigs::get(name)`      | Look up a `FunctionSig` recorded by the type-checker.                   |

### 3.2 `Compiler::ir::*` — IR node constructors

Build a typed IR node without writing object literals. The wasmType is
either passed explicitly or inferred from the inputs.

| Call                                                                                       | Returns        |
| ------------------------------------------------------------------------------------------ | -------------- |
| `&Compiler::ir::makeConst(value, wasmType)`                                                | `IRConst`      |
| `&Compiler::ir::makeLocalGet(name, wasmType)`                                              | `IRLocalGet`   |
| `&Compiler::ir::makeLocalSet(name, value)`                                                 | `IRLocalSet`   |
| `&Compiler::ir::makeGlobalGet(name, wasmType)`                                             | `IRGlobalGet`  |
| `&Compiler::ir::makeGlobalSet(name, value)`                                                | `IRGlobalSet`  |
| `&Compiler::ir::makeBinOp(instr, left, right, wasmType)`                                   | `IRBinOp`      |
| `&Compiler::ir::makeCall(callee, args, wasmType, callKind?)`                               | `IRCall`       |
| `&Compiler::ir::makeBlock(stmts, trailing?, wasmType?)`                                    | `IRBlock`      |
| `&Compiler::ir::makeIf(cond, then, else?, wasmType?)`                                      | `IRIf`         |
| `&Compiler::ir::makeLoop(id, cond, body)`                                                  | `IRLoop`       |
| `&Compiler::ir::makeBreak(id)` / `makeContinue(id)`                                        | `IRBreak/Continue` |
| `&Compiler::ir::makeReturn(value?)`                                                        | `IRReturn`     |
| `&Compiler::ir::makeNop` / `makeUnreachable`                                               | `IRNop/Unreachable` |
| `&Compiler::ir::makeExport(alias, internalName, what)` where `what` is `'func' \| 'global'` | `IRExport`     |
| `&Compiler::ir::makeGlobal(name, wasmType, mutable, init)`                                 | `IRGlobal`     |
| `&Compiler::ir::makeFunction(name, params, returnType, locals, body)`                      | `IRFunction`   |
| `&Compiler::ir::makeImport(env, field, name, params, result?)`                             | `IRImport`     |
| `&Compiler::ir::makeLocal(name, wasmType)`                                                 | `IRLocal`      |
| `&Compiler::ir::null`                                                                      | `null`         |

### 3.3 AST traversal

| Call                                       | Effect                                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `&Compiler::lowerExpr(node)`               | Recursively lower an expression AST node to `IRExpr` using the bound context.                       |
| `&Compiler::lowerBlock(node)`              | Lower a `Block` AST node to `IRBlock`.                                                              |
| `&Compiler::lowerParam(param)`             | Lower one function parameter to `IRParam`, or `null` for literal / untyped params.                  |
| `&Compiler::lowerParams(node)`             | Iterate `node.params`, lower each entry, return the `IRParam[]`.                                    |
| `&Compiler::lowerExprIfDefined(node)`      | Like `lowerExpr` but returns `undefined` when `node` itself is null/undefined.                      |
| `&Compiler::lowerFunctionBody(node, params)` | Create a child scope with `params` added to locals, lower `node.binding`, return `{body, locals}`. |
| `&Compiler::lowerGlobalInit(node, defaultType)` | Lower a `@local` initialiser or fall back to `(const 0 : defaultType)`; refines wasmType from init. |
| `&Compiler::lowerExternParams(node)`       | Extract the WASM param types of an `@extern`.                                                       |
| `&Compiler::lowerExternResult(node)`       | Extract the WASM result type of an `@extern`, or undefined.                                         |
| `&Compiler::expandMatchChain(args, type)`  | Build the nested `if`/`else` chain for `@match`. Used by `match.si`.                                |
| `&Compiler::unwrapNode(node)`              | Strip `Element` / `Item` / `Statement` wrappers from an AST node.                                   |

### 3.4 Type resolution

| Call                                            | Returns                              |
| ----------------------------------------------- | ------------------------------------ |
| `&Compiler::resolveType(annotation)`            | `WasmValType` from a type-annotation AST node (`Float` → `'f32'`, else `'i32'`). |
| `&Compiler::resolveTypeName(name)`              | Same, takes a raw string.            |
| `&Compiler::resolveExprType(expr)`              | The `WasmType` of an already-lowered IR expression.                              |
| `&Compiler::resolveFunctionReturnType(node, name, body)` | Three-priority lookup: annotation → function-sig → body refinement.        |
| `&Compiler::isVarName(name)`                    | True if `name` is a real WAT global (delegates to `ctx.varNames.has`).           |

### 3.5 Utility

| Call                                       | Returns                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| `&Compiler::watId(name)`                   | Sanitise a Silicon identifier to a valid WAT identifier (`::` → `_`).    |
| `&Compiler::freshId(prefix?)`              | Allocate a unique synthetic identifier — e.g. `tmp_3`.                   |
| `&Compiler::resolveIntrinsic(name)`        | Resolve an `IR::foo` or `WASM::foo` name to its WAT instruction string.  |
| `&Compiler::choose(cond, ifTrue, ifFalse)` | Eager ternary. Both branches are evaluated; pick one to return.          |
| `&Compiler::arg(node, index)`              | `node[index]` — for stepping through the `rawArgs` array.                |

### 3.6 Errors

| Call                                       | Behaviour                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| `&Compiler::assertDefined(value, msg)`     | Throws `CompilerAPIError` if `value` is `null` / `undefined`.              |
| `&Compiler::error(msg, node?)`             | Always throws `CompilerAPIError`. Optional `node` is used for source loc.  |

---

## 4. Lifecycle hooks on `IRDefExpander`

Definition-kind strata may register all three callbacks. Built-in
strata only implement `expand`; the others are opt-in.

| Hook         | When it fires                                                  | Typical use                                              |
| ------------ | -------------------------------------------------------------- | -------------------------------------------------------- |
| `preScan`    | Before the main lowering loop, once per definition AST node.   | Pre-register names so forward references resolve.        |
| `expand`     | During the main loop, once per definition AST node.            | Emit the IR for that definition.                         |
| `postExpand` | After the main loop, once per registered defExpander.          | Emit module-level items derived from cross-def state.    |

The body interpreter currently exposes only `expand` as a rich-body hook.
`preScan` and `postExpand` are TypeScript hooks on the
`builtinDefExpanders` registry.

---

## 5. Common patterns

### 5.1 Guarded operation

```silicon
@stratum_keyword Break ('@break', Node) = {
  &IR::control_break;
  @local id := &Compiler::ctx::loopStack::peek;
  &Compiler::assertDefined id, '@break outside @loop';
  &Compiler::ir::makeBreak id;
};
```

### 5.2 Optional argument

```silicon
@stratum_keyword Return ('@return', Node) = {
  &IR::control_return;
  @local valN  := &Compiler::arg Node, 0;
  @local value := &Compiler::lowerExprIfDefined valN;
  &Compiler::ir::makeReturn value;
};
```

`lowerExprIfDefined` returns `undefined` rather than a Nop, so the
downstream `makeReturn` correctly emits a `return` with no value.

### 5.3 Branching with `choose`

```silicon
@stratum_keyword ExportDecl ('@export', Node) = {
  &IR::meta_export;
  @local sname := &Compiler::watId Node.name.name;
  @local isVar := &Compiler::isVarName sname;
  @local kind  := &Compiler::choose isVar, 'global', 'func';
  &Compiler::ir::makeExport sname, sname, kind;
};
```

`choose` is eager — both branches must be safe to evaluate. For lazy
branching, pre-bind both branches as `@local` values first, then choose
between the bindings.

### 5.4 Child-context lowering

When a strata needs to lower a sub-expression in a fresh locals scope
(e.g. function bodies), use `lowerFunctionBody` rather than mutating
the outer locals map:

```silicon
@stratum_keyword LetDef ('@global', Node) = {
  &IR::def_function;
  @local name       := &Compiler::watId Node.name.name;
  @local params     := &Compiler::lowerParams Node;
  @local funcResult := &Compiler::lowerFunctionBody Node, params;
  @local body       := funcResult.body;
  @local locals     := funcResult.locals;
  @local returnType := &Compiler::resolveFunctionReturnType Node, name, body;
  &Compiler::ctx::globals::set name, 'i32';
  &Compiler::ir::makeFunction name, params, returnType, locals, body;
};
```

`lowerFunctionBody` returns a struct with `body` (the lowered body) and
`locals` (the locals collected during body lowering — anything pushed
through `pendingLocals::push` inside the body).

---

## 6. Booleans, strings, and other gotchas

- **Booleans** are `@true` / `@false`, not `true` / `false`.
  `true` parses as a namespace lookup and throws "Unknown identifier".
- **Strings** use single quotes: `'global'`, `'@break outside @loop'`.
- **Argument parsing has no parens by default.** `&Compiler::watId
  Node.name.name` works because the call ends at `;`. When passing a
  function-call result as an argument, bind it to an `@local` first to
  avoid the comma in `args, n` being read as the *outer* call's separator.
- **Field access** uses `.` — `Node.name.typeAnnotation`. Index access
  on arrays uses `&Compiler::arg Node, i` because the grammar does not
  allow numeric segments in a namespace path.
- **`&IR::xxx` and `&WASM::xxx`** calls inside a rich body are silent
  dispatch markers. They are *not* invokable at runtime; build IR with
  `&Compiler::ir::*` instead.

---

## 7. Worked example: `@local`

The complete strata, end to end, for the `@local` definition kind:

```silicon
@stratum_keyword LocalDef ('@local', Node) = {
  &IR::def_local;
  @local wasmType := &Compiler::resolveType Node.name.typeAnnotation;
  @local sname    := &Compiler::watId Node.name.name;
  @local decl     := &Compiler::ir::makeLocal sname, wasmType;
  &Compiler::ctx::pendingLocals::push decl;
  &Compiler::ctx::locals::set sname, wasmType;
  &IR::null;
};
```

What happens when a `\\ x Int` annotated `@local x := 5;` is encountered:

1. `Node` is the `Definition` AST node (`{type: 'Definition', keyword: '@local', name: {name: 'x', typeAnnotation: {typename: 'Int'}}, binding: …}`).
2. `wasmType` ← `'i32'` (from `resolveType` of the `Int` annotation).
3. `sname` ← `'x'` (no `::` to sanitise).
4. `decl` ← `{ name: 'x', wasmType: 'i32' }`.
5. The pending-locals list and locals map are updated — `x` is now a known local for the rest of the current function body.
6. `&IR::null` returns `null` — the definition itself emits no top-level WAT node. The initialiser (`5`) is emitted as an `IRLocalSet` statement when the surrounding block is lowered.

---

## 8. Where to look in the source

- `src/compiler-api/index.ts` — interface + factory for `CompilerAPI`.
- `src/elaborator/strataBody.ts` — the body interpreter (`isRichBody`, `evalExpr`, `evalCall`).
- `src/elaborator/strataLoader.ts` — wires rich bodies into `registry.defExpanders` / `registry.expanders`.
- `src/strata/*.si` — built-in strata; read these as living examples.
- `src/ir/lower.ts` — the helpers exposed via the API (`lowerParams`, `lowerFunctionBody`, …) live here.
