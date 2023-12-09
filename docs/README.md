# The Silicon Language Specification

## Table of Contents

### [Grammar](./grammar.md)

### [Types](./types.md)

### [Basics](./basics.md)

### [Modules](./modules.md)

### [Advanced](./advanced.md)

## Goals

- WASM compilation target
- Full-Stack web dev
- blazingly fast compilation
- interpreted for fast dev cycles
- Algebraic Data Types
- Pattern Matching
- Type inference
- Co-routines (no colored functions)
- ARC (no GC)
- 100% Web API compatability
- 100% Node API compatability

## Non-Goals

In my opinion, non-goals are just as important as goals. They prevent scope-screep and keep the language and toolchain _great_ at specific use-case instead of
mediocre at everything.

\*Not a direct goal but other tools will be used
\*\*A future, much less important goal to think about

- Native Compilation\*
- LLVM / other native backends\*
- ~~Variadic functions~~
- ~~Function over-loading~~
- Game dev
- Systems dev (Yes, even though Silicon has no GC and is fairly "low-level")
- Operator overloading
- Functionally Pure
- Borrower Checker / compile-type memory safety\*\*
## SI puts the SI in Simple.

- no unary operators
- no operator overloading
- no inheritance
- no function / method overloading
- no modifier keywords (just annotations)
- few keywords that are prepended with `@`
- no garbage collector: reference counting / borrower checker (optional)
- ONE looping construct `@loop` (for, while and do/while)
- ONE condition construct `@when` (if and switch/case)

## What SI DOES have

- Traits (because they're awesome)
- Annotations (for flexiblity)
- UFCS (no real methods)
- TDNR (fake overloading)
- ADT (the best type of type)
- SIMPLE and consistent syntax
- coroutines: no locks, semaphores or runtime to schedule
- Pattern matching
- Full type inference!
- Full lifetime inference!
- Cross-Compilation!
- C interop!
- 100% Web API coverage
- 100% Node API coverage