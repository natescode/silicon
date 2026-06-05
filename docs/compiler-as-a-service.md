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
// Never throws — parse errors appear in diagnostics.  The parser also *recovers*:
// a syntax error in one top-level element becomes a `ParseError` node, so the
// well-formed elements around it still parse (with their extents intact).  The
// returned tree is therefore usable even mid-edit — the basis for keeping the
// LSP's semantic model alive while typing.
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

**Incremental reparse (tracker 3b).** `withText` / `withChanges` reuse the
top-level elements an edit didn't touch and reparse only the damaged window —
exploiting the parser's Zig-like property that top-level declarations parse
independently. Positions use a relative encoding (each node's `relSpan` is
relative to its element's `elemBase`), so unchanged suffix elements are reused
**by reference** even across newline-changing edits — only the element-level base
shifts. This is a transparent internal optimization: the returned tree is
**byte-identical** to a full reparse (guaranteed by a full-reparse fallback and a
`SIGIL_INCREMENTAL_VERIFY=1` correctness tripwire), and the public API is
unchanged. Only the damaged byte window is re-lexed and reparsed, so an edit is
**O(window), not O(file)** — 17–51× faster than a full reparse on medium/large
files. See `src/caas/incremental.ts` and `src/ast/positionTable.ts`; benchmark
with `bun run bench:incremental`. (Only the parse phase is incremental; elaborate
+ typecheck still run fully per edit.)

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

A definition site — a name introduced by `@global`, `@fn`, `@type`, `@local`, etc.

```typescript
interface Symbol {
    readonly name:           string
    readonly kind:           'function' | 'variable' | 'type' | 'parameter' | 'stratum'
    readonly definitionNode: object          // AST Definition node
    readonly type:           SiliconType | undefined
    readonly definitionSpan?: SourceSpan    // span of the name identifier
}
```

`definitionSpan` is populated by the parser, which computes source line/column itself. All coordinates are 1-based.

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

## Tree walking — `SyntaxNode`

`SyntaxTree.root` returns the root `SyntaxNode`, a stable public wrapper around
every AST node.  Use it to traverse or query the tree without touching the
unstable `program` field.

```typescript
class SyntaxNode {
    /** Node type discriminant — 'Definition', 'FunctionCall', 'IntLiteral', … */
    readonly kind: string

    /** Source span (1-based), if the parser recorded location info. */
    readonly span: SourceRange | undefined

    /** Parent node, or undefined for the root. */
    readonly parent: SyntaxNode | undefined

    /** True when this node has no child nodes (leaf). */
    readonly isLeaf: boolean

    /** Direct child nodes.  Lazily built and cached. */
    children(): readonly SyntaxNode[]

    /** All descendants in depth-first pre-order. */
    descendants(): Generator<SyntaxNode>

    /** Ancestor chain from immediate parent to root. */
    ancestors(): Generator<SyntaxNode>

    /** All descendants whose `kind` equals the given string. */
    descendantsOfKind(kind: string): Generator<SyntaxNode>

    /** First descendant whose `kind` equals the given string, or undefined. */
    firstDescendantOfKind(kind: string): SyntaxNode | undefined

    /** @internal — raw AST node.  Not stable. */
    readonly _node: object
}
```

### Tree walking example

```typescript
import { parse } from './src/api'

const { tree } = parse('@fn add x, y := { x + y };\n@global result := &add 1, 2;')

// All definitions in the file:
for (const node of tree.root.descendantsOfKind('Definition')) {
    console.log(node.kind, node.span)
}

// The first binary operator:
const binop = tree.root.firstDescendantOfKind('BinaryOp')

// Walk ancestor chain:
if (binop) {
    const kinds = [...binop.ancestors()].map(n => n.kind)
    console.log(kinds)  // e.g. ['Block', 'Binding', 'Definition', 'Program']
}
```

---

## Incremental text changes

`SyntaxTree.withChanges(changes)` applies a list of range-based edits and
reparses.  Use this for LSP `textDocument/didChange` integration where the
editor sends only the changed ranges, not the full file.

```typescript
interface TextChange {
    readonly range: SourceRange   // 1-based; endLine/endCol are exclusive
    readonly newText: string
}

// Apply changes and reparse — returns a fresh ParseResult.
// Throws if any two changes have overlapping ranges.
// The file name and strata registry are preserved.
tree.withChanges(changes: readonly TextChange[], options?: ParseOptions): ParseResult

// Apply changes to a string without reparsing.
applyTextChanges(source: string, changes: readonly TextChange[]): string
```

`TextChange` differs from `TextEdit` (used by code actions):

| | `TextEdit` | `TextChange` |
|---|---|---|
| Span type | `SourceSpan` (`line/col/length`) | `SourceRange` (`startLine/startCol/endLine/endCol`) |
| Multi-line | No | Yes |
| Use case | Code action fix-its | LSP incremental sync |

### Incremental example — LSP didChange handler

```typescript
import { parse, buildRegistry, elaborate } from './src/api'

let tree = parse(initialSource).tree
const registry = buildRegistry(tree)

function onDidChange(lspChanges: LspTextChange[]) {
    // Map LSP changes to TextChange (LSP uses 0-based lines; Silicon uses 1-based)
    const changes = lspChanges.map(c => ({
        range: {
            startLine: c.range.start.line + 1,
            startCol:  c.range.start.character + 1,
            endLine:   c.range.end.line + 1,
            endCol:    c.range.end.character + 1,
        },
        newText: c.text,
    }))
    const { tree: newTree } = tree.withChanges(changes)
    tree = newTree
    // Re-elaborate with the existing registry (no rebuild needed for
    // edits that don't touch stratum declarations).
    const { tree: elab } = elaborate(newTree, registry)
    // ... typecheck, update diagnostics ...
}
```

---

### Silicon vs Roslyn

Silicon has no separate `SyntaxToken` type.  Silicon's lexical leaves are already
typed AST nodes (`IntLiteral`, `FloatLiteral`, `StringLiteral`, `BooleanLiteral`,
`Namespace`, `GenericParams`, `DocComment`).  Leaf nodes simply return an empty
`children()` array.  The trivia layer (whitespace/comments attached to tokens) does
not exist yet.

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

    // Projects (tracker 3a) — named, dependency-scoped document groups
    addProject(name: string, options?: ProjectOptions): Project   // { target? }
    getProject(name: string): Project | undefined
    projectOf(uri: string): Project | undefined
    readonly projects: ReadonlyMap<string, Project>

    // Inspection
    readonly documents: ReadonlyMap<string, Document>
    readonly registry:  ElaboratorRegistry | undefined

    // Change subscriptions
    onDidChange(listener: ChangeListener): () => void  // returns unsubscribe fn

    // Navigation (CaaS-5) — 1-based line/col matching editor conventions
    findDefinition(uri: string, line: number, col: number): Symbol | undefined
    findDefinitions(uri: string, line: number, col: number): Symbol[]   // all candidates (same-named cross-file)
    findReferences(uri: string, line: number, col: number, opts?: CancellableOptions): readonly SourceSpan[]

    // LSP Tier 1 — 1-based line/col
    hoverInfo(uri: string, line: number, col: number): HoverInfo | undefined
    getCompletions(uri: string, line: number, col: number, prefix?: string, opts?: CancellableOptions): CompletionItem[]
    signatureHelp(uri: string, line: number, col: number): SignatureHelp | undefined
    rename(uri: string, line: number, col: number, newName: string): WorkspaceEdit  // applyTo(ws) to apply
    formatDocument(uri: string): TextEdit[]
    formatRange(uri: string, range: SourceRange): TextEdit[]
}
```

Each `Document` holds the compiled state for one source file:

```typescript
interface Document {
    readonly uri:         string
    readonly source:      string
    readonly version:     number              // increments on each edit
    readonly projectName?: string             // owning project, if any (tracker 3a)
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

### Project layer (tracker 3a)

By default a `Workspace` is **flat** — every open document can resolve symbols
defined in every other open document. A `Project` partitions the workspace into
named groups, each with its own compile `target` and dependency edges to other
projects. Cross-document type checking is then **scoped**: a document sees only
symbols from its own project plus the transitive closure of that project's
dependencies.

```typescript
class Project {
    readonly name:   string
    readonly target: LowerTarget               // 'host' | 'wasix' | 'wasm-gc'

    addDocument(uri: string, source: string): Document
    addDependency(other: Project): void        // idempotent; cycle-safe

    readonly dependencies: readonly Project[]   // direct edges
    readonly documentUris: readonly string[]
    readonly documents:    Document[]
}
```

```typescript
const ws = new Workspace()

const core = ws.addProject('core')
const app  = ws.addProject('app', { target: 'wasm-gc' })
app.addDependency(core)                         // app → core

core.addDocument('core/math.si', '\\ add (Int, Int)\n@fn add x, y := { x + y };')
const main = app.addDocument('app/main.si', '@global r := &add 1, 2;')

main.projectName                                // 'app'
main.model.symbolNamed('r')?.type?.kind         // 'Int' — resolved across the edge
```

Scoping rules:

- **No projects created** → flat workspace, every document sees every other
  (fully backward-compatible).
- **Document in project P** → sees P plus P's transitive (cycle-safe) dependency
  closure. Visibility follows dependency direction: if B depends on A, B sees A's
  symbols but not vice versa.
- **Unassigned document** (opened via `openDocument` while projects exist) → sees
  only other unassigned documents.

Adding a dependency does not retroactively re-check already-compiled documents;
edit a consumer to pick up newly-visible symbols. `getCompletions` is
project-scoped — it offers only symbols visible to the document's project
(dependency closure + in-scope references). `findDefinition` / `findReferences`
remain workspace-global by design (jump-anywhere is the useful behavior there).

### Metadata references (tracker 3c)

A `MetadataReference` exposes a **precompiled library's symbols** — its public
surface without source — for type checking, hover, and completion. A
`SymbolManifest` is plain JSON-serializable data (a `SiliconType` is a plain
union), so a package ships its manifest beside its `.wasm`.

```typescript
const ws = new Workspace()

const manifest: SymbolManifest = {
    name: 'mathlib',
    symbols: [{ name: 'add', kind: 'function',
                type: { kind: 'Function', params: [INT, INT], result: INT } }],
}

ws.addReference(manifest)                       // global — visible to every document
ws.openDocument('main.si', '@global r := &add 1, 2;')
// `add` resolves through the reference; no "unbound identifier" error.

// or scope it to a project (+ its dependents):
const app = ws.addProject('app')
app.addReference(manifest)
```

- `Workspace.addReference(manifest)` → global; `Project.addReference(manifest)` →
  scoped to that project plus the projects that depend on it (same dependency
  closure as cross-document symbols).
- Open-document symbols **shadow** library symbols of the same name (source wins).
- Reference symbols appear in hover / completion / `findDefinition`;
  `findDefinition` returns the symbol with **no `definitionSpan`** (there is no
  source to jump to).
- `serializeManifest` / `parseManifest` are the JSON on-disk form. (Actual `.wasm`
  linking is a codegen concern, outside the CaaS symbol surface.)

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

Cross-document symbol resolution (CaaS-5) is implemented — see `findDefinition` /
`findReferences` above. Cross-document **type checking** is scoped per project
(tracker 3a); see [Project layer](#project-layer-tracker-3a).

---

## Lifecycle summary

```
ElaboratorRegistry  — built once per project; reused across all elaborations
SyntaxTree          — one per source version; cheap to recreate via withText()
SemanticModel       — one per (SyntaxTree, registry) pair; built by typecheck()
Workspace           — owns the registry + all open Documents
Project             — named group of Documents with a target + dependency edges
Document            — snapshot of one file's compiled state at a given version
```

---

## Immutability invariant

Every type returned by the pipeline functions is **structurally immutable** after
construction. No field is assigned after construction. `withText` and `editDocument`
return new objects — they never mutate existing ones.

---

## Stability contract

The CaaS API is part of the surface Silicon intends to stabilize; the 1.0
stability promise takes effect at the first `1.0.0` tag (Silicon is currently
at 0.1 / pre-1.0).  The authoritative policy is in
[`docs/stability.md`](stability.md); this section is a summary.

### What is stable

Every name exported from `src/api.ts` is the intended-stable surface; the
promise takes effect at 1.0:

```
parse()   buildRegistry()   elaborate()   typecheck()   lower()   compile()
SyntaxTree   SemanticModel   Symbol   Diagnostic   SourceSpan
Workspace   Project   Document
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
@global result:Int := &add 1, 2;
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
