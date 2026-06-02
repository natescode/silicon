# CaaS Roslyn-Parity Tracker

Sigil is designed Roslyn-style (see [`compiler-as-a-service.md`](compiler-as-a-service.md)),
but a number of features present in Roslyn's public surface are not yet implemented.
This document tracks them as actionable work items, organized by tier.

**Scope:** IDE / tooling infrastructure only — language features, Strata, and codegen
are tracked separately.  Cross-document type checking is listed here because it is a
CaaS correctness issue, not a language issue.

**Status legend:** ✅ done · 🔄 in progress · 🔲 planned · ❌ out of scope

---

## Tier 1 — LSP features with no API surface yet

These are the gaps that block a real LSP server implementation.  None have
any surface in `src/caas/` today.

| # | Feature | Workspace method | Status | Notes |
|---|---------|-----------------|--------|-------|
| 1a | **Hover / quick-info** | `hoverInfo(uri, line, col): HoverInfo \| undefined` | ✅ | Implemented 2026-06-01. Resolves via local SemanticModel then workspace index fallback. `docComment` always `undefined` until `DocComment` AST nodes are emitted (parser gap). |
| 1b | **Completion** | `getCompletions(uri, line, col, prefix?): CompletionItem[]` | ✅ | Implemented 2026-06-01. Local symbols + cross-doc workspace index + built-in keywords. Prefix is case-insensitive substring match. Full scope-chain scoping requires `containingSymbol` (2c). |
| 1c | **Signature help** | `signatureHelp(uri, line, col): SignatureHelp \| undefined` | ✅ | Implemented 2026-06-01. Text-based backward scan (FunctionCall nodes lack spans in the handwritten parser). Active parameter from comma count. |
| 1d | **Rename** | `rename(uri, line, col, newName): WorkspaceEdit` | ✅ | Implemented 2026-06-01. Uses `findReferences` (cross-doc) + definition span. Returns `Map<string, TextEdit[]>`. |
| 1e | **Format document** | `formatDocument(uri): TextEdit[]` | ✅ | Implemented 2026-06-01. Whitespace-normalizing formatter (single whole-file edit). Lossy — preserves no user style. Full fidelity blocked on trivia (2e). |
| 1f | **Format range** | `formatRange(uri, range: SourceRange): TextEdit[]` | ✅ | Implemented 2026-06-01. Expands to whole lines, normalizes, returns a single edit for the range. Same trivia caveat as 1e. |

### Return types to add (Tier 1)

```typescript
interface HoverInfo {
    readonly symbol: Symbol
    readonly typeDisplay: string      // e.g. "(fn add) Int, Int → Int"
    readonly docComment?: string      // from adjacent \\ doc-comment node
    readonly range: SourceRange       // span to highlight on hover
}

interface CompletionItem {
    readonly label:   string          // identifier / keyword
    readonly kind:    'function' | 'variable' | 'type' | 'parameter' | 'keyword'
    readonly detail?: string          // type display string
    readonly docComment?: string
}

interface SignatureHelp {
    readonly name:           string
    readonly parameters:     readonly ParameterInfo[]
    readonly activeParameter: number  // 0-based index
}

interface ParameterInfo {
    readonly name:  string
    readonly type?: string            // display string
}
```

---

## Tier 2 — Partial or missing infrastructure

Features where a partial foundation exists but the public surface is incomplete.

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 2a | **`Symbol.displayString`** | ✅ | Implemented 2026-06-01. `readonly displayString: string` on `Symbol` interface; computed in `buildSymbolTable`. `typeDisplayString()` and `symbolDisplayString()` exported from `src/ast/semanticModel.ts` and re-exported from `src/api.ts`. |
| 2b | **`CodeAction` linked to `Diagnostic.code`** | ✅ | Implemented 2026-06-01. `diagnosticCode?: string` added to `CodeAction`; `getCodeActions` now stamps it. `listCodeActionCodes(): string[]` added to enumerate registered codes. |
| 2c | **`Symbol.containingSymbol`** | ✅ | Implemented 2026-06-01 (forward-compatible shape). `readonly containingSymbol?: Symbol` on `Symbol` interface; `undefined` for all current top-level definitions. Populating it for parameters requires adding params to the symbol table (planned typechecker enhancement). |
| 2d | **`Symbol.locations`** | ✅ | Implemented 2026-06-01. `readonly locations: readonly SourceSpan[]` on `Symbol` interface; computed as `[definitionSpan]` (or `[]`). Grows to multiple sites when partial definitions are supported. |
| 2e | **Trivia** (whitespace / comments on tokens) | ✅ | Implemented 2026-06-01. `TriviaItem { kind, text }` type; `SyntaxNode.leadingTrivia(source)` and `trailingTrivia(source)`. Source-text-based computation from span gaps. `DocComment` (`##`) trivia kind reserved; not yet emitted by the handwritten parser. |
| 2f | **`SyntaxWalker` / `SyntaxRewriter`** | ✅ | Implemented 2026-06-01 in `src/caas/syntaxWalker.ts`. `SyntaxWalker` — read-only depth-first visitor with typed overrides per node kind. `SyntaxRewriter` — produces `TextEdit[]` (text-level, not AST-clone, due to immutable tree design). |
| 2g | **Cross-document typechecking** | ✅ | Implemented 2026-06-01. `CheckOptions.externalSymbols?: ReadonlyMap<string, SiliconType>` threads workspace symbols into the typechecker. `Workspace.#buildExternalSymbols` populates it from all other open documents before each compile. Both the namespace resolver and the function-call checker consult `externalSymbols` as a last resort. |

---

## Tier 3 — Architecture / project model

Larger structural additions. None block day-to-day LSP use but are required
for multi-project workspaces and production editor performance.

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 3a | **`Project` layer** | 🔲 | `Workspace` is flat today. A `Project` groups `Document`s with a shared name, output target, and dependency edges to other `Project`s. Needed for monorepos and library-consumer builds. Rough shape: `workspace.addProject(name, opts)`, `project.addDocument(uri, source)`. |
| 3b | **Incremental parsing** | 🔲 | `SyntaxTree.withChanges()` applies text edits then full-reparses. Roslyn reuses unchanged subtrees. This is a significant perf win for large files. Requires a stable node-identity scheme in the parser. No public API change needed — it's an internal optimization. |
| 3c | **`MetadataReference`** | 🔲 | Consuming a pre-compiled Silicon library (`.wasm` + symbol manifest) without its source. Required for package-registry integration. Shape mirrors Roslyn: `workspace.addReference(path)` loads the manifest into the symbol index. Blocked on the package format being finalized. |
| 3d | **Control-flow graph API** | ❌ | `GetControlFlowGraph` on Roslyn. Useful for linters and analyzers. Out of scope until Silicon has more complex control flow constructs (exceptions, exhaustive match, etc.). Revisit post-1.1. |
| 3e | **Data-flow analysis API** | ❌ | `GetDataFlowAnalysis` on Roslyn. Same rationale as 3d. |

---

## Tier 4 — Nice-to-have / polish

Small additions that round out the surface. None are blocking.

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 4a | **`Symbol.isImplicitlyDeclared`** | 🔲 | Marks synthetic symbols (e.g. generated constructors for `@type` sum variants). |
| 4b | **`Workspace.findDefinitions` in public doc** | ✅ | Added 2026-06-01 (multi-definition collision fix). Update `compiler-as-a-service.md` to document the method. |
| 4c | **Richer `CompilationOptions`** | 🔲 | Optimization level, debug-info flag, target triple — currently only `ParseOptions` and per-phase options exist. |
| 4d | **`WorkspaceEdit`** | 🔲 | A tracked set of `Map<uri, TextEdit[]>` changes that can be applied atomically. Rename (1d) should return this rather than a raw `Map`. |
| 4e | **Async / cancellable API** | 🔲 | Roslyn is fully async. Silicon is synchronous — fine until files get large. A `cancel?: AbortSignal` option on long-running calls (`getCompletions`, `findReferences`) is the minimal step. |

---

## Recommended implementation order

```
2a  Symbol.ToDisplayString()          — unblocks 1a; pure SemanticModel change
1a  hoverInfo                         — immediate LSP value; depends on 2a
2b  CodeAction ↔ Diagnostic link      — small, high value for the linter workflow
1c  signatureHelp                     — depends on SyntaxNode walk, no new infra
2c  Symbol.containingSymbol           — enables accurate scoping
1b  getCompletions                    — depends on 2c
1d  rename                            — findReferences already works; map to TextEdit
4d  WorkspaceEdit                     — clean up 1d's return type
2f  SyntaxRewriter                    — needed for non-trivial refactoring
2e  Trivia                            — largest piece; unlock 1e/1f
1e  formatDocument                    — depends on 2e
1f  formatRange                       — depends on 2e
2g  Cross-document typechecking       — correctness; post-formatting
3a  Project layer                     — multi-project workspaces
3b  Incremental parsing               — perf; transparent to callers
3c  MetadataReference                 — package registry integration
```

---

## Already implemented (reference)

| Feature | Roslyn equivalent | Where |
|---------|------------------|-------|
| `parse / elaborate / typecheck / lower / compile` | `CSharpSyntaxTree.ParseText`, `CSharpCompilation.Create`, `.Emit` | `src/caas/index.ts` |
| `SyntaxNode` walking | `SyntaxNode`, `SyntaxWalker` (read-only) | `src/caas/syntaxNode.ts` |
| `SemanticModel.symbolAtPosition` | `SemanticModel.GetSymbolInfo` | `src/ast/semanticModel.ts` |
| `SemanticModel.typeOf` | `SemanticModel.GetTypeInfo` | `src/ast/semanticModel.ts` |
| `SemanticModel.referenceSpans` | `SymbolFinder.FindReferencesAsync` (single-doc) | `src/ast/semanticModel.ts` |
| `Workspace.findDefinition` | `SymbolFinder.FindSourceDefinitionAsync` | `src/caas/workspace.ts` |
| `Workspace.findDefinitions` | (no exact equivalent; Roslyn assumes unique names in scope) | `src/caas/workspace.ts` |
| `Workspace.findReferences` | `SymbolFinder.FindReferencesAsync` (cross-doc) | `src/caas/workspace.ts` |
| `Workspace.onDidChange` | `Workspace.WorkspaceChanged` event | `src/caas/workspace.ts` |
| `TextChange` / `withChanges` | `VersionedTextDocumentIdentifier` + incremental sync | `src/caas/textChange.ts` |
| `CodeAction` / `applyEdits` | `CodeAction`, `Workspace.TryApplyChanges` | `src/caas/codeAction.ts` |
| Symbol index (cross-doc name lookup) | `SymbolFinder` + compilation-wide symbol table | `src/caas/workspace.ts` (in-memory, name-keyed) |
