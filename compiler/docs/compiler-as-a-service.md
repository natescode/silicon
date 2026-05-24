# Compiler as a Service — Sigil CaaS API

## Overview

Sigil is designed Roslyn-style: the compiler is a library, not a CLI. Every consumer
(the `sgl` binary, the LSP server, IDE plugins, formatters, linters, refactoring tools,
test runners) calls the same underlying API. The CLI is a thin driver that formats
results for a terminal; the LSP wrapper is a thin driver that translates JSON-RPC to
API calls. Neither is special-cased in the compiler.

This document defines the public API surface for the CaaS layer: what it exports, what
invariants hold, and what the stability contract is.

---

## Pipeline entry points

The compiler is invoked through four composable entry points, each returning an
immutable result type. You can stop at any stage:

```typescript
// Parse Silicon source into an immutable syntax tree.
function parse(source: string, options?: ParseOptions): ParseResult

// Elaborate — attach strata semantics to operator and definition nodes.
// Returns a new tree (never mutates the input).
function elaborate(tree: SyntaxTree, registry: StrataRegistry, options?: ElabOptions): ElabResult

// Typecheck — infer types for every expression.
// Returns a SemanticModel; the tree itself is not mutated.
function typecheck(tree: SyntaxTree, registry: StrataRegistry, options?: CheckOptions): CheckResult

// Lower elaborated + typechecked tree to IR, then emit WAT.
function lower(tree: SyntaxTree, model: SemanticModel, options?: LowerOptions): LowerResult
```

The most common full-pipeline call:

```typescript
const { tree }  = parse(source)
const { tree: elab } = elaborate(tree, registry)
const { model } = typecheck(elab, registry)
const { wat }   = lower(elab, model)
```

---

## Public types

### `SyntaxTree`

An immutable, structurally-shared representation of a parsed Silicon program
(the "green tree" in Roslyn terminology). Two trees parsed from the same source are
byte-equal. A tree never changes after construction — "edits" produce new trees that
share unchanged subtrees.

```typescript
interface SyntaxTree {
    readonly root: SyntaxNode
    readonly source: string
    readonly diagnostics: readonly Diagnostic[]  // parse errors only
    withText(newSource: string): SyntaxTree      // incremental reparse
}
```

`SyntaxNode` carries no parent links (those live in the red tree — see §Internals).
All field access is read-only.

### `StrataRegistry`

The registry of operators and keywords resolved from `@stratum` declarations. Built
once per compilation unit. Reusable across multiple `elaborate` calls on different
trees.

```typescript
interface StrataRegistry {
    readonly operators: ReadonlyMap<string, StrataEntry>
    readonly keywords:  ReadonlyMap<string, StrataEntry>
}

function buildRegistry(tree: SyntaxTree): StrataRegistry
```

### `SemanticModel`

A queryable overlay on top of a typechecked syntax tree. Answers questions about types,
symbols, and diagnostics without modifying the tree. Computed lazily and cached per
tree version.

```typescript
interface SemanticModel {
    /** Inferred SiliconType for the expression at `node`. */
    typeOf(node: SyntaxNode): SiliconType | undefined

    /** The symbol (definition site) that `node` resolves to, if any. */
    symbolAt(node: SyntaxNode): Symbol | undefined

    /** All diagnostics whose span overlaps `range`. */
    diagnosticsIn(range: SourceRange): readonly Diagnostic[]

    /** All reference sites for `symbol` within this tree. */
    referencesTo(symbol: Symbol): readonly SyntaxNode[]

    /** All diagnostics for the whole tree. */
    readonly allDiagnostics: readonly Diagnostic[]
}
```

### `Symbol`

A definition site — a name introduced by `@let`, `@fn`, `@type`, `@var`, etc.

```typescript
interface Symbol {
    readonly name: string
    readonly kind: 'function' | 'variable' | 'type' | 'parameter' | 'stratum'
    readonly definitionNode: SyntaxNode
    readonly type: SiliconType | undefined
}
```

### `Diagnostic`

The `Diagnostic` type defined in `src/errors/diagnostic.ts` is the canonical
record. The `phase`, `code`, `span`, `message`, and optional `hint` / `notes` fields
are the complete public shape. Diagnostic codes (E0001…) are stable and never reused.

### `SourceRange`

```typescript
interface SourceRange {
    start: SourcePosition   // { line: number, col: number }
    end:   SourcePosition
}
```

### `LowerResult`

```typescript
interface LowerResult {
    readonly wat: string                       // WebAssembly Text Format
    readonly diagnostics: readonly Diagnostic[]
}
```

---

## Lifecycle of long-lived state

```
StrataRegistry     — built once per project/workspace; reused across files
SyntaxTree         — one per source document version; cheap to reparse
SemanticModel      — one per (SyntaxTree, StrataRegistry) pair; lazily computed
```

A `Workspace` (Phase 8.5) will own the registry and a map of open documents, each
holding its current `SyntaxTree` and optionally its `SemanticModel`. The CaaS
primitives here are the building blocks; the `Workspace` layer adds change
notifications and incremental invalidation.

---

## Immutability invariant

Every type returned by the four entry points is **structurally immutable** after
construction. No field is ever assigned after the constructor returns. This gives:

- Safe concurrent read from multiple threads / async tasks.
- Incremental compilation: compare tree versions by identity, not deep equality.
- Predictable memory: no hidden mutation through shared references.

The `withText` method on `SyntaxTree` is the only way to "modify" a tree; it returns
a new tree, sharing subtrees that are unchanged.

---

## Thread-safety expectations

The four pipeline functions are **pure** given the same inputs they return the same
outputs. They are safe to call concurrently from multiple threads on disjoint inputs.
A `SemanticModel` is safe to read concurrently once constructed; construction itself is
not yet synchronized (the caller should ensure only one thread triggers computation).

---

## Relationship between public types and internal data structures

| Public type     | Internal representation                              |
|-----------------|------------------------------------------------------|
| `SyntaxTree`    | Green tree (`GreenNode[]`) + source string           |
| `SyntaxNode`    | Red-tree view: thin handle into the green tree       |
| `SemanticModel` | `Map<nodeId, SiliconType>` + symbol table            |
| `Symbol`        | Entry in the elaborator's def-kind registry          |
| `Diagnostic`    | `Diagnostic` from `src/errors/diagnostic.ts` (same) |

Callers never see `GreenNode` or the raw `ASTNode` union — those are internal.

---

## Position on LSP

The CaaS API is **richer than LSP**. LSP speaks JSON-RPC and constrains responses to
protocol-defined shapes. The CaaS API returns typed Silicon objects directly, exposes
strata-aware symbol resolution that has no LSP equivalent, and allows queries by
`SyntaxNode` reference rather than just line/column.

An LSP wrapper (`sgl lsp`, Phase 9b) adapts the CaaS API to the LSP wire protocol as
a downstream concern. The CaaS API has no knowledge of or dependency on LSP. A project
that wants IDE support without LSP (e.g. a custom editor plugin, a CI analysis tool)
uses the CaaS API directly.

---

## Stability contract

The CaaS API is part of the Silicon 1.0 stability promise:

- **Adding** new methods to existing interfaces: always permitted.
- **Changing** a method signature or removing a method: requires a major version bump.
- **Changing** `Diagnostic` codes: existing codes are never removed or reassigned.
  New codes are always additive.
- **Internal** data structures (`GreenNode`, `IRExpr`, etc.): not stable; may change
  between any releases without notice.

---

## Worked example

Parse, typecheck, and query a Silicon snippet using only the public API:

```typescript
import { parse, elaborate, typecheck, buildRegistry } from 'sigil'

const source = `
@let add x:Int, y:Int := x + y;
@let result := &add 1, 2;
`

// 1. Parse
const { tree, diagnostics: parseDiags } = parse(source)
if (parseDiags.length) { console.error(parseDiags); process.exit(1) }

// 2. Build registry (resolves @stratum declarations in the tree + builtins)
const registry = buildRegistry(tree)

// 3. Elaborate
const { tree: elab } = elaborate(tree, registry)

// 4. Typecheck
const { model } = typecheck(elab, registry)

// 5. Query semantic info
const allDiags = model.allDiagnostics
if (allDiags.length) {
    for (const d of allDiags) {
        console.error(`${d.code} ${d.span.file}:${d.span.line}:${d.span.col}: ${d.message}`)
    }
    process.exit(1)
}

// Find the symbol defined by @let add
const addSymbol = [...model.referencesTo(model.symbolAt(elab.root)!)][0]
console.log('add returns type:', model.typeOf(addSymbol))
// → { kind: 'Int' }
```

This example uses no internal imports — only the four stable entry points.
