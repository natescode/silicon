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
| 3a | **`Project` layer** | ✅ | Implemented 2026-06-02. `Workspace.addProject(name, { target? })` → `Project`; `project.addDocument(uri, source)`, `project.addDependency(other)`. Cross-document typechecking is now **scoped per project** — a document sees only symbols from its own project plus the transitive (cycle-safe) closure of that project's dependencies. The project's compile `target` is threaded into the typechecker. With no projects created the workspace stays flat (every doc sees every other) — fully backward-compatible. Documents opened through the flat API stay unassigned and, once any project exists, see only other unassigned docs. `Document.projectName` records membership. **Completion is project-scoped** — a document is offered only symbols visible to its project (its dependency closure + global/in-scope references); go-to-definition and find-references remain workspace-global by design (jumping anywhere in the workspace is the useful behavior there). |
| 3b | **Incremental parsing** | ✅ | **M1 + M3 implemented 2026-06-02.** `SyntaxTree.withText()` / `withChanges()` reuse unchanged top-level elements and reparse only the damaged window (exploits Zig-like element independence — `src/caas/incremental.ts`). **M3 relative-position model:** positioned nodes carry an element-relative `relSpan`, each element root its absolute `elemBase`; a `PositionTable` (`src/ast/positionTable.ts`) reconstructs absolute spans on demand. Both are plain fields, so they survive elaboration's spread-cloning — the typechecker stamps `sourceLocation` from the table at typecheck start (no on-node absolute span on caas trees). Reused suffix elements shift only their O(elements) `elemBase` (shallow root clone); descendants are shared **by reference** → true zero-copy reuse, including across **newline-changing** edits. **M4 incremental lexing:** `parseProgramFragment` now tokenizes only the damaged byte window (not the whole file), so incremental reparse is **O(window), not O(file)** — the O(n) full lex was the prior ceiling. **17–51× faster on medium/large files, 95–99% reuse** for intra-line, newline, and append edits (`bun run bench:incremental`). Internal-only — public API unchanged; byte-identical to a full reparse, guaranteed by a fallback + `SIGIL_INCREMENTAL_VERIFY=1` tripwire + an equivalence/zero-copy/fuzz harness. **M2** (copy-on-write line fix-up) was tried and **reverted** — the suffix walk cost ~as much as reparsing; M3's reference-sharing is the real win. **Remaining (M5):** sub-element (statement-level) sharing — a recursive-descent subtree-splice, deferred (large change, and one element already reparses in O(window·tokens)). Note: only the parse phase is incremental — the Workspace re-elaborates + re-typechecks fully each edit; M3 is also the substrate for future incremental semantics. |
| 3c | **`MetadataReference`** | ✅ | Implemented 2026-06-02. `src/caas/metadataReference.ts`: a `SymbolManifest` (`{ name, symbols: [{ name, kind, type, doc? }] }`) is a precompiled library's public symbol surface — plain JSON-serializable data (`serializeManifest`/`parseManifest`), the on-disk form that ships beside the `.wasm`. `Workspace.addReference(manifest)` adds a **global** reference (visible to every document); `Project.addReference(manifest)` scopes it to that project + its dependents. Reference symbols flow into cross-document type checking (`#buildExternalSymbols`, project-closure scoped; open-document symbols shadow library ones) and into the global navigation index (hover / completion / `findDefinition` — the latter returns the symbol with no `definitionSpan`, since there is no source). 12 tests in `metadataReference.test.ts`. (Actual `.wasm` linking is a codegen concern, out of CaaS scope; this is the symbol/typecheck surface.) |
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
| `Workspace.addProject` / `Project` | `AdhocWorkspace.AddProject`, `Project`, `ProjectReference` | `src/caas/workspace.ts` |
| `TextChange` / `withChanges` | `VersionedTextDocumentIdentifier` + incremental sync | `src/caas/textChange.ts` |
| `CodeAction` / `applyEdits` | `CodeAction`, `Workspace.TryApplyChanges` | `src/caas/codeAction.ts` |
| Symbol index (cross-doc name lookup) | `SymbolFinder` + compilation-wide symbol table | `src/caas/workspace.ts` (in-memory, name-keyed) |
