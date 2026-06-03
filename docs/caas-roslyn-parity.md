# CaaS Roslyn-Parity Tracker

Sigil is designed Roslyn-style (see [`compiler-as-a-service.md`](compiler-as-a-service.md)).
This document tracks the gaps against Roslyn's public surface as actionable work
items, organized by tier.

**Scope:** IDE / tooling infrastructure only — language features, Strata, and codegen
are tracked separately.  Cross-document type checking is listed here because it is a
CaaS correctness issue, not a language issue.

**Status legend:** ✅ done · 🔄 in progress · 🔲 planned · ⏸️ deferred (blocked) · ❌ out of scope

---

## Status at a glance (2026-06-02)

**Tiers 1–4 are complete.** Every remaining item is *deliberately* deferred, each
with a recorded rationale below — none are half-built.

| Tier | What | Status |
|------|------|--------|
| **1** | LSP features — hover, completion, signature help, rename, format doc/range | ✅ all done |
| **2** | Semantic infra — `displayString`, CodeAction↔Diagnostic, `containingSymbol`, `locations`, trivia, SyntaxWalker/Rewriter, cross-doc typecheck | ✅ all done |
| **3** | Architecture — 3a Project layer · 3b incremental parsing (M1+M3+M4) · 3c MetadataReference | ✅ in-scope done |
| **4** | Polish — 4a `isImplicitlyDeclared` · 4b doc · 4d `WorkspaceEdit` · 4e cancellable | ✅ done |

**Deferred (with reason):**

| Item | Why deferred |
|------|--------------|
| 3b-**M5** sub-element (statement-level) sharing | After M4 a single element reparses in O(element·tokens) — microseconds; ~2× for a major recursive-descent rewrite |
| 3d / 3e **CFG / data-flow** APIs | Their graph shape is defined by control-flow constructs Silicon lacks (exceptions, exhaustive match); building now means building the wrong thing. Revisit post-1.1 |
| 4c **opt-level / debug-info / target-triple** options | No codegen consumer (`lower()` runs no passes, emits no debug info, CaaS emits wasm not native) — would be no-op options |
| **M2** copy-on-write line fix-up | *Tried and reverted* — the suffix line-shift walk cost ≈ reparsing; M3's reference-sharing is the real win |

**Beyond the tracker — incremental semantics** (the next frontier, since
elaborate+typecheck dominate end-to-end edit latency; M3 is its substrate):
- **E1a ✅ (2026-06-02):** the `Workspace` now reparses edits incrementally
  (`existing.tree.withText(newSource)`) — it previously full-parsed every edit,
  ignoring the incremental parser entirely. Gated by an incremental≡full
  equivalence harness (`incremental-compile.test.ts`).
- **E1b ✅ (2026-06-02):** reuse per-element *elaboration* — element-local
  against a frozen registry, so the spliced elaborated tree is byte-identical to
  a full elaborate(). `incrementalReparse` exposes a per-element reuse diff;
  `src/caas/incrementalElaborate.ts` reuses cached per-element elaboration
  (shifting reused-suffix `elemBase`), re-elaborates only fresh elements, and
  rebuilds the frozen registry on a `@stratum` edit. Verified by an equivalence
  property suite (random edit chains over the corpus: structure + authoritative
  `model.typeOf` + diagnostics + symbols) and a reuse-by-reference proof.
  - **Adversarial verification (2026-06-02):** a 5-agent hunt (≈9 000 edit/compare
    cases across `@stratum` edits, `@extern` BlockDef blocks, element
    merge/split/delete, type-flip chains, and multi-document workspaces) found
    **one real defect in the parse layer** — `damageFromText` is a byte diff and
    is lexically blind to a *line-comment / `\\` signature marker* inserted before
    an element: the element's bytes stay byte-identical-but-shifted, so the damage
    region is a zero-width insertion that misses it, and the now-commented element
    was reused verbatim as a suffix (leaking its symbol + elaboration). **Fixed**
    (`incremental.ts` `suffixThreshold`): a reused suffix must begin on a line the
    edit did not bleed a marker into — checked in NEW coordinates, so a `## `
    prepended to an element forces it into the reparse window while a clean
    blank-line insertion still reuses it (M3 zero-copy preserved). Guarded by
    `tests/properties/incremental-{boundary,typeflip,multidoc}.property.test.ts`
    (the surviving adversarial suites) plus a comment-insertion edit added to the
    parse- and compile-equivalence fuzzers. The other four categories were clean.
- **E2 ✅ Stage A+B (`src/caas/incrementalTypecheck.ts`, design in
  `docs/incremental-typecheck-design.md`):** incremental *type-checking* —
  **prefix-reuse engine**. A design-investigation workflow (5 agents probing the
  real typechecker) established that the shared fresh-type-variable counter
  (`ctx.fresh`) leaks order-dependent `?Tn` into `model.typeOf` (e.g.
  `@let x := &None` stores `Option[?T1]`; a preceding `&None` shifts it to `?T3`),
  and unannotated forward references make a caller's inferred types depend on
  check **order** — so byte-identical incremental type-checking must
  **reuse the unchanged prefix and replay the suffix in source order**, not
  node-level reuse of the edited element. The engine: builds a fresh ctx,
  re-runs (cheap) pre-registration over the whole element list, **replays** each
  verbatim-unchanged prefix group's cached write-set (finalized sigs, typeMap
  slice, reference edges, diagnostics) while advancing the shared fresh-var
  counter by what it consumed, then **re-checks** every group from the first
  change to EOF. A `preRegSig` gate falls back to a full re-check when any
  *declaration* changed (a prefix element may forward-reference a later
  declaration); cross-document/target changes gate on `externalSig`/`target`.
  The full `typecheck()` is refactored into reusable pieces but stays the
  byte-identical **oracle/fallback**; `SIGIL_E2_VERIFY=1` runs it beside every
  edit (reuse ON) as a discard-on-mismatch tripwire. Verified byte-identical to
  fresh on diagnostics + symbols + per-node `model.typeOf` by the equivalence,
  property (random edit chains), and adversarial suites, with a reuse-firing
  guard so the engine can't silently regress to full re-check.
  - **Stages C–E deferred** (forward-only finalized-sig propagation for *middle*
    edits, fresh-counter replay across leaks, per-symbol cross-doc invalidation):
    Stage B already reuses the unchanged prefix on the dominant edit (a function
    body), and full typecheck is sub-millisecond on the current corpus
    (~0.6 ms/100 fns), so the finer-grained reuse only pays off at larger scales.

---

## Roslyn parity diagram

```
 LAYER            ROSLYN (.NET)                       SILICON CaaS (src/caas, src/ast)         PARITY
══════════════════════════════════════════════════════════════════════════════════════════════════
 SYNTAX           CSharpSyntaxTree.ParseText          parse()                                    ✅
                  SyntaxNode / SyntaxToken            SyntaxNode  (leaves are typed nodes,       ✅
                                                        no separate token type)
                  SyntaxWalker / SyntaxRewriter       SyntaxWalker / SyntaxRewriter              ✅
                  SyntaxTrivia (leading/trailing)     TriviaItem  (leading/trailingTrivia)       ✅
                  ── Incremental parse ──             ── Incremental parse ──
                  WithChangedText: green/red tree,    withText / withChanges:                    ✅
                  reuse unchanged green subtrees        green/red via relSpan+elemBase           M1+M3+M4
                                                        (PositionTable), O(window) re-lex+parse,
                                                        zero-copy suffix reuse  (2–51×)
──────────────────────────────────────────────────────────────────────────────────────────────────
 COMPILATION      Compilation.Create / .Emit          buildRegistry+elaborate+typecheck+compile ✅
                  SemanticModel.GetSymbolInfo         model.symbolAtPosition                     ✅
                  SemanticModel.GetTypeInfo           model.typeOf                               ✅
                  Cross-file binding (Compilation)    cross-document typecheck (2g),             ✅
                                                        project-scoped (3a)
                  ISymbol:                            Symbol:
                    ToDisplayString()                   displayString                            ✅
                    ContainingSymbol                    containingSymbol  (fwd-compat)           🟡
                    Locations                           locations                                ✅
                    IsImplicitlyDeclared                isImplicitlyDeclared (4a)                ✅
                  CompilationOptions                  (opt/debug/triple)                         ⏸️ no codegen
                  GetControlFlowGraph                 —                                          ❌ deferred
                  GetDataFlowAnalysis                 —                                          ❌ deferred
──────────────────────────────────────────────────────────────────────────────────────────────────
 WORKSPACES       AdhocWorkspace                      Workspace                                  ✅
                  Solution / Project                  Project (+ dependency edges)               ✅ (3a)
                  ProjectReference                    Project.addDependency                      ✅
                  Document / WorkspaceChanged         Document / onDidChange                      ✅
                  MetadataReference                   MetadataReference (+ SymbolManifest)       ✅ (3c)
                  Workspace.TryApplyChanges           WorkspaceEdit.applyTo                       ✅ (4d)
──────────────────────────────────────────────────────────────────────────────────────────────────
 SERVICES         CompletionService                   getCompletions  (project-scoped)           ✅
                  QuickInfoService                    hoverInfo                                  ✅
                  SignatureHelpService                signatureHelp                              ✅
                  Renamer + WorkspaceEdit             rename → WorkspaceEdit                      ✅
                  Formatter                           formatDocument / formatRange               🟡 lossy¹
                  SymbolFinder.FindReferencesAsync    findReferences                             ✅
                  SymbolFinder.FindDefinition         findDefinition / findDefinitions           ✅
                  CodeAction / CodeFix                CodeAction / registerCodeAction            ✅
──────────────────────────────────────────────────────────────────────────────────────────────────
 ASYNC            CancellationToken (everywhere)      CancellableOptions { cancel?: AbortSignal }🟡 minimal²
                  Fully async (Task<T>)               synchronous pipeline                       — by design
══════════════════════════════════════════════════════════════════════════════════════════════════
 LEGEND   ✅ at parity   🟡 partial / minimal   ⏸️ deferred (blocked)   ❌ out of scope   — N/A

 ¹ formatter is whitespace-normalizing (lossy) until a parser trivia channel exists (2e reserves the kind).
 ² cooperative only — the pipeline is synchronous, so cancel aborts a *superseded* request, not a running one.
```

Silicon's CaaS is at functional Roslyn parity for the **syntax, compilation,
workspaces, and services** layers; the incremental parser's relative-position
green tree gives an O(window) re-lex+reparse. The remaining gaps are the
**analysis layer** (CFG / data-flow) and **deep async**, both deferred above.

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
| 3b | **Incremental parsing** | ✅ | **M1 + M3 implemented 2026-06-02.** `SyntaxTree.withText()` / `withChanges()` reuse unchanged top-level elements and reparse only the damaged window (exploits Zig-like element independence — `src/caas/incremental.ts`). **M3 relative-position model:** positioned nodes carry an element-relative `relSpan`, each element root its absolute `elemBase`; a `PositionTable` (`src/ast/positionTable.ts`) reconstructs absolute spans on demand. Both are plain fields, so they survive elaboration's spread-cloning — the typechecker stamps `sourceLocation` from the table at typecheck start (no on-node absolute span on caas trees). Reused suffix elements shift only their O(elements) `elemBase` (shallow root clone); descendants are shared **by reference** → true zero-copy reuse, including across **newline-changing** edits. **M4 incremental lexing:** `parseProgramFragment` now tokenizes only the damaged byte window (not the whole file), so incremental reparse is **O(window), not O(file)** — the O(n) full lex was the prior ceiling. **17–51× faster on medium/large files, 95–99% reuse** for intra-line, newline, and append edits (`bun run bench:incremental`). Internal-only — public API unchanged; byte-identical to a full reparse, guaranteed by a fallback + `SIGIL_INCREMENTAL_VERIFY=1` tripwire + an equivalence/zero-copy/fuzz harness. **M2** (copy-on-write line fix-up) was tried and **reverted** — the suffix walk cost ~as much as reparsing; M3's reference-sharing is the real win. **M5 (sub-element / statement-level sharing) — declined:** after M4 a single damaged element already reparses in O(element·tokens) — microseconds for any normal function — so statement-level sharing would save a ~2× factor on an already-sub-0.1ms reparse, while requiring a major recursive-descent subtree-splice (mid-parse cached-subtree insertion + reuse-point detection + sub-element position rebasing). Cost/risk ≫ benefit; revisit only if profiling shows a real pathological case. Note: only the parse phase is incremental — the Workspace re-elaborates + re-typechecks fully each edit; M3 is the substrate for future incremental *semantics*, which is where the end-to-end win actually is. |
| 3c | **`MetadataReference`** | ✅ | Implemented 2026-06-02. `src/caas/metadataReference.ts`: a `SymbolManifest` (`{ name, symbols: [{ name, kind, type, doc? }] }`) is a precompiled library's public symbol surface — plain JSON-serializable data (`serializeManifest`/`parseManifest`), the on-disk form that ships beside the `.wasm`. `Workspace.addReference(manifest)` adds a **global** reference (visible to every document); `Project.addReference(manifest)` scopes it to that project + its dependents. Reference symbols flow into cross-document type checking (`#buildExternalSymbols`, project-closure scoped; open-document symbols shadow library ones) and into the global navigation index (hover / completion / `findDefinition` — the latter returns the symbol with no `definitionSpan`, since there is no source). 12 tests in `metadataReference.test.ts`. (Actual `.wasm` linking is a codegen concern, out of CaaS scope; this is the symbol/typecheck surface.) |
| 3d | **Control-flow graph API** | ❌ | `GetControlFlowGraph` on Roslyn. Useful for linters and analyzers. Out of scope until Silicon has more complex control flow constructs (exceptions, exhaustive match, etc.). Revisit post-1.1. |
| 3e | **Data-flow analysis API** | ❌ | `GetDataFlowAnalysis` on Roslyn. Same rationale as 3d. |

---

## Tier 4 — Nice-to-have / polish

Small additions that round out the surface. None are blocking.

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 4a | **`Symbol.isImplicitlyDeclared`** | ✅ | Implemented 2026-06-02. `readonly isImplicitlyDeclared: boolean` on `Symbol`; `false` for user-written definitions, `true` for compiler-synthesized symbols. `@type` sum-variant constructors (`Circle`, `Rectangle`, …) — previously registered only in `ctx.functions`/`ctx.symbols`, not the public table — are now surfaced as implicit symbols (so they're navigable in hover/completion), with no `definitionSpan` (no source declaration). |
| 4b | **`Workspace.findDefinitions` in public doc** | ✅ | Added 2026-06-01 (multi-definition collision fix); documented in `compiler-as-a-service.md` (Workspace surface) 2026-06-02. |
| 4c | **Richer `CompilationOptions`** | ⏸️ | **Deferred — blocked on codegen.** Optimization level, debug-info flag, and target triple have **no consumer** in the pipeline today (`lower()` runs no optimization passes, emits no debug info, and the CaaS path produces WAT/wasm, not native — `LowerOptions` is just `target` + `maxHeapPages`). Adding these as options now would be no-op knobs that silently do nothing — misleading. Revisit when codegen implements opt-levels / debug-info emission (mirrors 3c having been blocked on the package format). |
| 4d | **`WorkspaceEdit`** | ✅ | Implemented 2026-06-02. `class WorkspaceEdit extends Map<string, TextEdit[]>` (so `.get`/`.set`/iteration stay backward-compatible) + `changeCount`, `uris`, and `applyTo(workspace): string[]` for applying the whole edit via `editDocument` (per-file edits applied bottom-up). `rename` now returns it. |
| 4e | **Async / cancellable API** | ✅ | Implemented 2026-06-02 (the minimal step). `CancellableOptions { cancel?: AbortSignal }` on `getCompletions` / `findReferences`; the query calls `signal.throwIfAborted()` at its checkpoints. Cooperative — Silicon's pipeline is synchronous, so this lets an async LSP front end abort a superseded request, not preempt a running one. |

---

## Delivery history (2026-06-01 → 06-02)

All of the above shipped in dependency order; recorded here for traceability.

```
2a displayString → 1a hover → 2b CodeAction↔Diagnostic → 1c sigHelp
2c containingSymbol → 1b completion → 1d rename → 2f SyntaxRewriter
2e trivia → 1e/1f format → 2g cross-doc typecheck            [Tier 1+2: 67b9af5]
3a Project layer                                              [4da3d99, +completion scoping ea7aff5]
3b incremental parsing:
   M1 element reuse                                           [7d80f40, fix 013e80c]
   M2 line fix-up  → REVERTED (walk ≈ reparse)
   M3 relative-position model (relSpan+elemBase+PositionTable)[4614b5d, c1e2b1c, b0de587]
   M4 incremental lexing — O(window) reparse, up to 51×       [4953e16]
   M5 sub-element sharing → DECLINED                          [62f138a]
3c MetadataReference                                          [6a814ac]
4a isImplicitlyDeclared · 4d WorkspaceEdit · 4e cancellable   [537801b]
4c CompilationOptions → DEFERRED (no codegen consumer)
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
| `Workspace.addReference` / `MetadataReference` | `Compilation.AddReferences`, `MetadataReference` | `src/caas/metadataReference.ts` |
| `WorkspaceEdit.applyTo` | `Workspace.TryApplyChanges` | `src/caas/workspace.ts` |
| Incremental reparse (`PositionTable`, relative spans) | green/red tree, `WithChangedText` | `src/ast/positionTable.ts`, `src/caas/incremental.ts` |
| `SyntaxWalker` / `SyntaxRewriter` / trivia | `SyntaxWalker`, `SyntaxRewriter`, `SyntaxTrivia` | `src/caas/syntaxWalker.ts`, `src/caas/syntaxNode.ts` |
| `TextChange` / `withChanges` | `VersionedTextDocumentIdentifier` + incremental sync | `src/caas/textChange.ts` |
| `CodeAction` / `applyEdits` | `CodeAction`, `Workspace.TryApplyChanges` | `src/caas/codeAction.ts` |
| Symbol index (cross-doc name lookup) | `SymbolFinder` + compilation-wide symbol table | `src/caas/workspace.ts` (in-memory, name-keyed) |
