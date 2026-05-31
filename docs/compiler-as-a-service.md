# Compiler as a Service — Sigil CaaS API

## Overview

Sigil is designed Roslyn-style: the compiler is a library, not a CLI. Every consumer
(the `sgl` binary, the LSP server, IDE plugins, formatters, linters, refactoring tools,
test runners) calls the same underlying API. The CLI is a thin driver that formats
results for a terminal; the LSP wrapper is a thin driver that translates JSON-RPC to
API calls. Neither is special-cased in the compiler.

This document describes the public API surface implemented in `src/caas/` and
re-exported from `src/api.ts`.

---

## Quick start

```typescript
import { compile } from './src/api'

const { wat, diagnostics } = compile('@fn answer:Int := { 42 };')
if (diagnostics.length) { /* handle errors */ }
// wat contains WebAssembly Text Format output
```

---

## Pipeline entry points

The compiler is invoked through composable entry points, each returning a stable
immutable result type. You can stop at any stage:

```typescript
// Parse Silicon source into a SyntaxTree.
// Never throws — parse errors appear in diagnostics.
function parse(source: string, options?: ParseOptions): ParseResult

// Build the strata registry from @stratum_* declarations in the tree.
// Reusable across multiple elaborate() calls on different trees.
function buildRegistry(tree: SyntaxTree, extraSources?: string[]): ElaboratorRegistry

// Elaborate — resolve operators and definition keywords via the registry.
// Returns a new SyntaxTree (never mutates input).
function elaborate(tree: SyntaxTree, registry: ElaboratorRegistry, options?: ElabOptions): ElabResult

// Typecheck — infer types for every expression.
// Returns a queryable SemanticModel.
function typecheck(tree: SyntaxTree, registry: ElaboratorRegistry, options?: CheckOptions): CheckResult

// Lower — emit WebAssembly Text Format from a typechecked tree.
function lower(tree: SyntaxTree, registry: ElaboratorRegistry, model: SemanticModel, options?: LowerOptions): LowerResult

// Full pipeline convenience — parse → elaborate → typecheck → lower.
// Stops at the first phase that produces diagnostics.
function compile(source: string, options?: ParseOptions & ElabOptions & LowerOptions): CompileResult
```

The typical full-pipeline call using individual stages:

```typescript
const { tree }              = parse(source)
const registry              = buildRegistry(tree)
const { tree: elab }        = elaborate(tree, registry)
const { tree: checked, model } = typecheck(elab, registry)
const { wat }               = lower(checked, registry, model)
```

All functions are **pure**: given the same inputs they always return the same outputs
and never throw on user errors. Failures are captured as `Diagnostic` records.

---

## Public types

### `SyntaxTree`

An immutable wrapper around a parsed Silicon program that carries the source text and
file name through each pipeline stage.

```typescript
class SyntaxTree {
    readonly program: Program       // internal AST; pass between pipeline stages
    readonly source:  string        // original source text
    readonly file:    string        // file name for diagnostic spans (default: '<input>')

    // Re-parse newSource without rebuilding the strata registry.
    // Returns a fresh ParseResult. The caller decides whether to reuse
    // the old registry or call buildRegistry() again.
    withText(newSource: string, options?: ParseOptions): ParseResult
}
```

`withText` is the incremental-reparse primitive used by the Workspace and LSP layers:

```typescript
const reg = buildRegistry(initialTree)

// ... user edits source in the editor ...

const { tree: newTree } = initialTree.withText(editedSource)
const { tree: elab }    = elaborate(newTree, reg)   // registry reused — no rebuild
```

### `ElaboratorRegistry`

The registry of operators and keywords resolved from `@stratum_*` declarations.
Built once per project. Reusable across any number of `elaborate()` calls.

### `SemanticModel`

A queryable overlay on top of a typechecked syntax tree. Answers questions about
types, symbols, and diagnostics without modifying the tree.

```typescript
class SemanticModel {
    /** Inferred SiliconType for any AST node. */
    typeOf(node: object): SiliconType | undefined

    /** Symbol that `node` resolves to (e.g. a Namespace reference). */
    symbolAt(node: object): Symbol | undefined

    /** Look up a symbol by declared name. */
    symbolNamed(name: string): Symbol | undefined

    /** All symbols defined in this tree. */
    get allSymbols(): IterableIterator<Symbol>

    /** All AST nodes that reference `symbol`. */
    referencesTo(symbol: Symbol): readonly object[]

    /** Source spans of all call sites / references for `symbol`. */
    referenceSpans(symbol: Symbol): readonly SourceSpan[]

    /**
     * Find the symbol whose definition or reference occupies `(line, col)`.
     * Coordinates are 1-based. Returns undefined when no symbol covers the position.
     */
    symbolAtPosition(line: number, col: number): Symbol | undefined

    /** Diagnostics whose span overlaps `range`. Pass undefined for all. */
    diagnosticsIn(range?: SourceRange): readonly Diagnostic[]

    /** All diagnostics from the typecheck phase. */
    readonly allDiagnostics: readonly Diagnostic[]
}
```

### `Symbol`

A definition site — a name introduced by `@let`, `@fn`, `@type`, `@var`, etc.

```typescript
interface Symbol {
    readonly name:           string
    readonly kind:           'function' | 'variable' | 'type' | 'parameter' | 'stratum'
    readonly definitionNode: object          // AST Definition node
    readonly type:           SiliconType | undefined
    readonly definitionSpan?: SourceSpan    // span of the name identifier; undefined for pre-Ohm ASTs
}
```

`definitionSpan` is populated by the parser (via Ohm's `getLineAndColumn`). All coordinates are 1-based.

### `Diagnostic`

The canonical error record used by every pipeline phase.

```typescript
interface Diagnostic {
    readonly phase:   'parse' | 'elaborate' | 'typecheck' | 'lower' | 'emit'
    readonly code:    string          // stable E-code, e.g. 'E0003'
    readonly span:    SourceSpan      // { file, line, col, length }
    readonly message: string
    readonly hint?:   string
    readonly notes?:  Diagnostic[]
    readonly snippet?: string         // source line for caret rendering
}
```

Diagnostic codes are **stable and never reused**. The full registry is in
`docs/diagnostics.md`.

### Result types

All pipeline functions return one of these:

```typescript
interface ParseResult   { tree: SyntaxTree;  diagnostics: readonly Diagnostic[] }
interface ElabResult    { tree: SyntaxTree;  registry: ElaboratorRegistry; diagnostics: readonly Diagnostic[] }
interface CheckResult   { tree: SyntaxTree;  model: SemanticModel; diagnostics: readonly Diagnostic[] }
interface LowerResult   { wat: string;       diagnostics: readonly Diagnostic[] }
interface CompileResult { wat: string;       model: SemanticModel | undefined; diagnostics: readonly Diagnostic[] }
```

---

## Workspace — multi-document project state (CaaS-4)

`Workspace` owns a shared registry and a set of open `Document`s. It is the entry
point for editor integrations and any tool that works with more than one file.

```typescript
class Workspace {
    constructor(options?: WorkspaceOptions)   // { registry? }

    // Document lifecycle
    openDocument(uri: string, source: string): Document
    editDocument(uri: string, newSource: string): Document
    closeDocument(uri: string): void
    getDocument(uri: string): Document | undefined

    // Inspection
    readonly documents: ReadonlyMap<string, Document>
    readonly registry:  ElaboratorRegistry | undefined

    // Change subscriptions
    onDidChange(listener: ChangeListener): () => void  // returns unsubscribe fn

    // Navigation (CaaS-5) — 1-based line/col matching editor conventions
    findDefinition(uri: string, line: number, col: number): Symbol | undefined
    findReferences(uri: string, line: number, col: number): readonly SourceSpan[]
}
```

Each `Document` holds the compiled state for one source file:

```typescript
interface Document {
    readonly uri:         string
    readonly source:      string
    readonly version:     number              // increments on each edit
    readonly tree:        SyntaxTree          // parse output
    readonly elabTree:    SyntaxTree          // elaborate output
    readonly model:       SemanticModel       // typecheck output
    readonly diagnostics: readonly Diagnostic[] // all phases combined
}
```

Change events:

```typescript
interface DocumentChangeEvent {
    readonly kind:     'opened' | 'changed' | 'closed'
    readonly uri:      string
    readonly document: Document | undefined   // undefined when kind === 'closed'
}
```

### Workspace example

```typescript
import { Workspace } from './src/api'

const ws = new Workspace()

// Subscribe to changes before opening documents.
const unsub = ws.onDidChange(({ kind, uri, document }) => {
    const count = document?.diagnostics.length ?? 0
    console.log(`[${kind}] ${uri} — ${count} diagnostics`)
})

// Open two files; registry is built from the first.
const main = ws.openDocument('src/main.si', mainSource)
const lib  = ws.openDocument('src/lib.si',  libSource)

// Later: user edits main.si.
ws.editDocument('src/main.si', updatedSource)  // fires 'changed' event

ws.closeDocument('src/lib.si')   // fires 'closed' event
unsub()                          // stop listening
```

### Registry lifecycle in Workspace

The Workspace builds the shared registry from the **first** document opened (unless
one is passed to the constructor). The registry is then reused for all subsequent
documents. This means strata declared in later-opened documents are **not** reflected
in the shared registry until a registry is explicitly rebuilt.

For projects where strata only appear in dedicated strata files, open those files first:

```typescript
const ws = new Workspace()
ws.openDocument('strata/core.si', strataSource)  // registry built here
ws.openDocument('src/main.si',    mainSource)     // uses the strata registry
```

Cross-document symbol resolution is tracked as CaaS-5 (not yet implemented).

---

## Lifecycle summary

```
ElaboratorRegistry  — built once per project; reused across all elaborations
SyntaxTree          — one per source version; cheap to recreate via withText()
SemanticModel       — one per (SyntaxTree, registry) pair; built by typecheck()
Workspace           — owns the registry + all open Documents
Document            — snapshot of one file's compiled state at a given version
```

---

## Immutability invariant

Every type returned by the pipeline functions is **structurally immutable** after
construction. No field is assigned after construction. `withText` and `editDocument`
return new objects — they never mutate existing ones.

---

## Stability contract

The CaaS API is part of the Silicon 1.0 stability promise.  The authoritative
policy is in [`docs/stability.md`](stability.md); this section is a summary.

### What is stable

Every name exported from `src/api.ts` is covered by the 1.0 promise:

```
parse()   buildRegistry()   elaborate()   typecheck()   lower()   compile()
SyntaxTree   SemanticModel   Symbol   Diagnostic   SourceSpan
Workspace   Document
ParseResult   ElabResult   CheckResult   LowerResult   CompileResult
```

### Change rules

| Change | Policy |
|---|---|
| Add a new export or optional option field | Minor release |
| Add a method to an existing class/interface | Minor release |
| New diagnostic code | Minor release |
| Change a function signature or remove an export | Major release |
| Retire or reassign a diagnostic code | Never |

### What is not stable

- `_`-prefixed fields (`CheckResult._functions`) — internal pipeline contract.
- Any import from `src/elaborator/`, `src/ir/`, `src/types/`, `src/parser/`,
  `src/ast/`, `src/codegen/`, `src/grammar/`, `src/modules/`, or `src/fmt/`.
  These are internal and may change between any releases, including patches.
- AST node shapes (`Program`, `Definition`, `IRExpr`, etc.)
- WAT output layout

---

## Worked example — full pipeline

```typescript
import { parse, buildRegistry, elaborate, typecheck, lower } from './src/api'

const source = `
@fn add x:Int, y:Int := { x + y };
@let result:Int := &add 1, 2;
`

// 1. Parse
const { tree, diagnostics: parseErrs } = parse(source, { file: 'add.si' })
if (parseErrs.length) { console.error(parseErrs); process.exit(1) }

// 2. Registry
const registry = buildRegistry(tree)

// 3. Elaborate
const { tree: elab, diagnostics: elabErrs } = elaborate(tree, registry)
if (elabErrs.length) { console.error(elabErrs); process.exit(1) }

// 4. Typecheck
const { tree: checked, model, diagnostics: typeErrs } = typecheck(elab, registry)
if (typeErrs.length) { console.error(typeErrs); process.exit(1) }

// 5. Query semantic info
const addSym = model.symbolNamed('add')
if (addSym) console.log('add type:', addSym.type)

// 6. Lower to WAT
const { wat, diagnostics: lowerErrs } = lower(checked, registry, model)
if (lowerErrs.length) { console.error(lowerErrs); process.exit(1) }

console.log(wat)
```
