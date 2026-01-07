# Silicon Intrinsics

> **Status:** Draft  
> **Audience:** Silicon language users, standard library authors, and compiler contributors  
> **Scope:** What intrinsics are, how they are exposed, and how they are intended to be used

---

## Overview

**Intrinsics in Silicon are not language features.**  
They are *compiler-exposed primitives* provided by **Sigil** (the Silicon compiler) and made available to Silicon code through a tightly controlled interface.

From the perspective of Silicon code:

- Intrinsics look like *ordinary functions*
- They are *not keywords*
- They are *not syntax*
- They have *no special privileges at the language level*

From the perspective of the compiler:

- Intrinsics are *lowering hooks*
- They map directly to **WebAssembly (WASM) instructions**, runtime services, or compiler-known operations
- They form the **bedrock on which the standard library is built**

This design keeps Silicon **simple, analyzable, and portable**, while still allowing full access to WASM’s capabilities.

---

## Design Goals

Silicon’s intrinsic model is shaped by the following goals:

1. **Silicon defines no magic**
2. **All power comes from explicit exposure**
3. **The standard library is not special**
4. **The compiler stays small and honest**
5. **WASM is the semantic ground truth**

Intrinsics exist so Silicon can be:

- A *systems language for the web*
- A *zero-overhead abstraction layer over WASM*
- A language where *semantics are visible, inspectable, and replaceable*

---

## What Intrinsics Are

An **intrinsic** is:

- A function defined *outside* Silicon
- Exposed by the compiler
- Known during elaboration and lowering
- Ultimately compiled to specific WASM instructions or runtime operations

Examples of intrinsic categories:

- Integer arithmetic
- Floating-point operations
- Memory load/store
- Control flow primitives
- Reference and pointer-like operations
- WASM host imports

Intrinsics are **not implemented in Silicon**, but **used from Silicon**.

---

## What Intrinsics Are Not

Intrinsics are explicitly **not**:

- Keywords
- Built-in syntax
- AST nodes created by the grammar
- Macros
- Runtime reflection hooks

Silicon code cannot define new intrinsics.  
It can only *use* those exposed by the compiler.

---

## Exposure Model

Intrinsics are exposed through a **well-known module**, typically the *prelude* or a compiler-owned namespace.

```silicon
Wasm::i32_add
Wasm::i32_sub
Wasm::i32_mul
```

These names are:

- Ordinary identifiers
- Resolved during elaboration
- Subject to normal scoping rules
- Replaceable or wrap-able like any other function

---

## Relationship to Elaboration

Silicon’s grammar does **not** define semantics.

Instead:

1. The grammar produces a **CST**
2. Elaboration hooks interpret meaning
3. Intrinsics are resolved during elaboration
4. The resulting AST is lowered to WASM

Example:

```silicon
1 + 2
```

- `+` is not intrinsically meaningful
- Elaboration resolves `+` to a function
- That function may eventually call `Wasm::i32_add`
- The compiler lowers it to:

```wat
(i32.add)
```

This keeps **syntax, semantics, and lowering fully decoupled**.

---

## Minimal Intrinsic Set (Philosophy)

Silicon intentionally starts with a **minimal intrinsic surface**.

The guiding rule:

> If it can be written *in Silicon*, it should be.

Early intrinsics should roughly cover:

### Numeric Primitives

- `i32.add`, `i32.sub`, `i32.mul`, `i32.div_s`
- `i64.*`
- `f32.*`, `f64.*`

### Comparison

- `i32.eq`, `i32.lt_s`, etc.
- Floating-point comparisons

### Control Flow

- Unconditional branch
- Conditional branch
- Return
- Unreachable

### Memory

- Load / store
- Allocation hooks
- Pointer arithmetic (explicit and constrained)

Everything else builds on top.

---

## Intrinsics and Safety

Intrinsics are where **unsafety lives**.

Silicon handles this by:

- Not exposing intrinsics directly to users
- Routing access through:
  - The standard library
  - Capabilities
  - Protocols and rewrites (future)

This allows:

- Safe defaults
- Explicit opt-in to low-level power
- Static analysis over unsafe boundaries
- Eventual verification of memory safety

---

## Intrinsics vs Macros

| Intrinsics | Macros |
|-----------|--------|
| Compiler-defined | User-defined |
| Fixed semantics | Arbitrary semantics |
| Lower to WASM | Rewrite syntax |
| Statically known | Often opaque |
| Auditable | Often dangerous |

Intrinsics are **foundational**.  
Macros (if present) are **derivative**.

---

## Intrinsics and Portability

Because intrinsics map to **WASM**, Silicon gains:

- Deterministic semantics
- Cross-platform consistency
- Predictable performance
- A stable ABI target

Future native backends (e.g. Zig IR, x86, ARM) can re-implement the same intrinsic set without changing Silicon code.

---

## Why This Matters

This model allows Silicon to:

- Avoid special cases in the language
- Keep the compiler honest
- Make optimization explicit
- Prevent accidental complexity
- Enable tooling like:
  - Semantic diffing
  - Protocol verification
  - Capability-based effects
  - Timing-attack mitigation

Intrinsics are not a hack.  
They are the *contract* between Silicon and the machine.

---

## Summary

- Silicon has **no built-in intrinsics**
- Sigil exposes **compiler intrinsics**
- Intrinsics are **ordinary functions**
- Semantics are defined during elaboration
- WASM is the ultimate execution model
- Safety is enforced *above* intrinsics, not inside them

> **Silicon is simple on purpose.  
> Intrinsics are how it stays powerful without becoming magical.**
