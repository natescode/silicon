# LSP completeness plan — what's left for a full language server

> **Status:** plan / tracker (the server already exists and ships 11 capabilities).
> **As of:** branch `v1-roadmap` (`045a46e`). Audited against `lsp/`,
> `compiler/src/caas/`, `plugins/`, and the trackers.
> **Companions:** [`caas-roslyn-parity.md`](caas-roslyn-parity.md) (the CaaS API
> tracker — semantic *primitives*, not LSP methods), [`lsp-completion-plan.md`](lsp-completion-plan.md)
> (completion design, still "not implemented"), [`v1-feature-status.md`](v1-feature-status.md).

## Where we are

The Silicon LSP (`lsp/src/index.ts`) is **real and substantial** — 11 capabilities,
each a thin adapter over the **incremental, cross-file CaaS Workspace**
(`compiler/src/caas/workspace.ts`), with ADR-0024 module awareness (`mod::`
completion, cross-file go-to-definition, file watchers, project-scoped
visibility). It is **alpha-grade for single-file / same-component editing**;
"full" is about closing **correctness, depth, missing methods, lifecycle, and
shipping** — not greenfield work.

Advertised today: `textDocumentSync(Incremental)`, `documentSymbol`,
`definition`, `hover`, `completion`, `references`, `rename`, `signatureHelp`,
`documentFormatting`, `codeAction`, `semanticTokens(full)`, watched-files.

## The 4 structural constraints that gate clusters of features

Fixing these unlocks many items at once — they are the real leverage:

| # | Constraint | Where | Caps that depend on it |
|---|---|---|---|
| **S1** | ✅ **RESOLVED — binding identity shipped.** A lexical binder (`ast/binder.ts`) assigns every local occurrence (param / local / `@match` pattern field) to its concrete binding; the SemanticModel surfaces those as Symbols with `containingSymbol` **populated**, and `findReferences`/`rename` consume them (a top-level rename skips occurrences a shadowing local claimed). Coverage: `caas/binding-identity.test.ts`. Remaining S1-adjacent niceties: scope-aware completion ranking, call hierarchy | `ast/binder.ts`, `ast/semanticModel.ts`, `caas/workspace.ts` | accurate **references** ✅, accurate **rename** ✅, scope-aware **completion** (ranking still open), **call hierarchy** (open) |
| **S2** | **`SourceSpan` is single-line** (multi-line collapses to length 0) | `errors/diagnostic.ts:24-30` | **foldingRange**, **selectionRange**, multi-line anchoring (must use `SyntaxNode` `_extents`/`PositionTable`) |
| **S3** | **Handwritten parser records no `FunctionCall` source spans** | `caas/workspace.ts:~1400` (signature-help uses a text scan) | **signature-help** robustness, **inlay** parameter hints, **call hierarchy** quality |
| **S4** | **Parser emits no `DocComment` trivia node** | `caas/workspace.ts:1386` (`docCommentForName` is a permanent stub) | documentation in **hover / completion / signature-help**, style-preserving **formatter** |

---

## Phase 1 — Correctness (the spine; do first)

These are the only *deep* blockers — without them, shipped features are subtly
wrong (rename can corrupt code; multi-file diagnostics go stale).

- [x] **Cross-file diagnostic invalidation** — DONE. `Workspace.refreshDocument`
      / `refreshDependents` re-check a document when its visible external-symbol
      surface changed (signature-driven — each compile stores its
      `externalSymbolsSignature`; no dependency graph to maintain); the
      diagnostics handler republishes every refreshed doc. Coverage:
      `caas/crossfile-diagnostics.test.ts` + `lsp/src/incremental.test.ts`.
- [x] **Binding-identity for references & rename (S1)** — DONE; see the S1 row
      above (`ast/binder.ts` + SemanticModel binding Symbols +
      scope-correct `findReferences`/`rename`).
- [ ] **`prepareRename`** — advertise `renameProvider:{prepareProvider:true}`;
      return the editable identifier range or `null` for non-user symbols
      (keywords, strata, implicit sum-variant ctors). Makes rename safe to
      invoke. *(must · S · `lsp/src/handlers/rename.ts`, `index.ts:64`)*
- [ ] **Fix the failing test** `incremental.test.ts:153` (E0000 parse-recovery
      mismatch). *(must · S)*

## Phase 2 — Cheap, high-value methods (the data already exists)

- [ ] **`documentRangeFormatting`** — `Workspace.formatRange()` is **already
      implemented and unwired**. Add the handler + advertise it. *(must · XS · `caas/workspace.ts:782`, `lsp/src/handlers/formatting.ts`)*
- [ ] **`workspace/symbol`** (Ctrl+T) — expose the private cross-doc `#symbolIndex`
      via `Workspace.workspaceSymbols(query)` (fuzzy filter, `#isEntryVisible`
      scoped) + handler. *(must · S · `caas/workspace.ts:238`)*
- [ ] **`documentHighlight`** — reuse `findReferences`, filter to `span.file===uri`
      + the local def. *(must · S · `semanticModel.ts:199`)*
- [ ] **`foldingRange`** — walk `SyntaxNode` subtrees for `@fn`/`@type`/`@match`/
      `@loop`/`{…}` block extents (use `_extents`/`PositionTable`, not `SourceSpan` — S2). *(must · M)*
- [ ] **`textDocument/typeDefinition`** — resolve the expression's `SiliconType` →
      the `@type` symbol's def site (named/sum types only; primitives → null).
      *(must · S · `semanticModel.ts:80,148,167`)*
- [ ] **`textDocument/declaration`** — Silicon has no decl/def split; advertise
      `declarationProvider:true` aliased to `findDefinition`. *(should · XS)*

## Phase 3 — Depth in existing capabilities

- [ ] **Completion: stdlib / module-registry candidates** — thread `ModuleRegistry`
      + the preregistered std tables into `getCompletions` so `web::`/`console::`/
      `JSString::`/`option`/`result`/`vec` appear. *(must · M · `caas/workspace.ts:627-689`, `lsp-completion-plan.md` Feature 1)*
- [ ] **Completion: scope-awareness** — `getCompletions` currently ignores
      `(line,col)` (depends on **S1** `containingSymbol`); add `sortText` ranking.
      *(should · M)*
- [ ] **Completion: snippets + `completionItem/resolve`** — `insertText`/
      `insertTextFormat` (param expansion, `@fn` stub), advertise `resolveProvider`
      to lazily fill detail/docs. *(should · M)*
- [ ] **`inlayHint` (inferred types)** — emit a type hint after each unannotated
      `@local`/`let` binding via `typeOf` + `typeDisplayString`. **High value** —
      ADR-0020 signatures are *optional*, so inferred types are otherwise
      invisible. (Param-name hints need **S3**.) *(should · M · `semanticModel.ts:148`)*
- [ ] **Doc comments (S4)** — emit a `DocComment` (`##` / leading `\\` signature)
      trivia node so `docCommentForName` returns real text → hover / completion /
      signature-help gain documentation. *(should · M, unlocks a cluster)*
- [ ] **`semanticTokens` `range` + `full/delta`** — add the range provider (avoid
      full recompute on scroll) and delta (avoid resending all tokens each
      keystroke); consider token *modifiers* (legend is empty). *(should · M · `index.ts:66-69`)*
- [ ] **Pull diagnostics** — add `textDocument/diagnostic` + `workspace/diagnostic`
      (`diagnosticProvider`); data is identical to the push path. *(should · S)*
- [ ] **`signatureHelp` overloads + docs** — return multiple signatures; populate
      `documentation` (needs S4); harden call-detection (needs S3). *(should · M)*
- [ ] **More code actions** — today exactly one quick-fix ships (E0004
      "did-you-mean" rename). Add: add-missing-signature, fix/add `@use`,
      type-mismatch fixes; advertise `codeActionKinds` + `resolveProvider`.
      *(should · M · `caas/codeAction.ts:231-249`)*
- [ ] **`callHierarchy`** (prepare/incoming/outgoing) — incoming via
      `findReferences` grouped by enclosing symbol (needs S1 + S3). *(should · M)*
- [ ] **`selectionRange`** — ancestor-chain expand (needs S2 extents). *(should · S)*

## Phase 4 — Lifecycle & robustness (production-grade)

- [ ] **Request cancellation** — forward the LSP `CancellationToken` into the
      CaaS `CancellableOptions.cancel` (already supported, never wired). *(should · S · `caas/workspace.ts:96-103`)*
- [ ] **`shutdown` / `exit` + clean teardown** — add handlers; clear debounce
      timers; release open docs. *(should · S · `lsp/src/index.ts:49-78`)*
- [ ] **`positionEncoding` negotiation** — advertise/assert UTF-16 (compiler
      counts UTF-16 code units in `lexer.ts:296`; agrees today but undeclared). *(should · S · `lsp/src/lsp-convert.ts`)*
- [ ] **Error isolation** — `process.on('uncaughtException'/'unhandledRejection')`
      guards + handler try/catch so one bad request can't kill the server. *(should · S)*
- [ ] **`sgl.toml` parsing** — parse `[package]` entry + `[dependencies]` (today
      it's only a root *marker*) to resolve external deps + scope visibility. *(should · M · `lsp/src/workspace.ts:208`)*
- [ ] **Multi-root / `workspaceFolders`** — handle `didChangeWorkspaceFolders`;
      advertise support. *(nice · M)*
- [ ] **Progress reporting** — `window/workDoneProgress` for the initial
      component scan. *(nice · S)*
- [ ] **Real-JSON-RPC test coverage** — the smoke test only does
      initialize→open→symbol→def→hover. Add: cross-file-edit→B-rechecks,
      cancellation, shutdown/exit, watched-files. *(should · M · `lsp/src/_smoke-run.ts`)*

## Phase 5 — Ship the editors (works-on-my-machine → shippable)

- [ ] **VS Code: rebuild the `.vsix`** — the committed `silicon-vscode-0.2.0.vsix`
      bundles ~30 **removed `boot/*`** files + a stale vendored snapshot; fix
      `build:server` to copy from the current `compiler/src` and repackage. *(must · S · `plugins/vscode/`)*
- [ ] **VS Code: marketplace publishing** — `vsce publish` / `ovsx` + a CI
      workflow (none of the 16 `.github/workflows/*` touch the plugins). *(must · M)*
- [ ] **IntelliJ: version-sync + capability list** — bump `0.1.0`→current; the
      `plugin.xml` advertises only 4 features though the server does 11. *(should · S · `plugins/intellij/`)*
- [ ] **IntelliJ: standalone server launch** — `SiliconServerLocator` assumes the
      monorepo (`lsp/src/index.ts`); ship/point at the bundled binary for
      `sgl-init` users; publish to the JetBrains Marketplace via CI. *(should · M)*

## Phase 6 — Polish / nice-to-have

- [ ] `documentLink` for `@use '<path>'` (ctrl-click; `extractUses` already
      resolves targets). *(nice · S)*
- [ ] `codeLens` ("N references" / run-`@export`). *(nice · M)*
- [ ] `linkedEditingRange` (trivial once `documentHighlight` exists). *(nice · XS)*
- [ ] `willRenameFiles` (rewrite `@use` paths on file rename). *(nice · S)*
- [ ] On-type formatting (reuse `formatRange`; jarring until S4 lands). *(nice · S)*
- [ ] Style-preserving formatter (needs a parser **trivia channel** — S4-adjacent). *(nice · L)*
- [ ] tree-sitter grammar for Neovim/Helix/Zed highlighting. *(nice · M)*

## Not applicable (correctly skipped)

- **`implementation`**, **`typeHierarchy`** — Silicon has no traits/methods/
  inheritance (ADR-0023 non-goals); closed sum types are not a subtype lattice.
- **`documentColor`** — no color type / no hex literals.
- **`moniker`** (LSIF/SCIP) — code-indexing pipelines, not interactive editing;
  build only if a SCIP indexer becomes a goal.

---

## The 80/20 to "full"

In order:

1. **Phase 1** — the two correctness fixes + `prepareRename` + the failing test.
   *Nothing else matters if rename corrupts code and diagnostics go stale.*
2. **Phase 2** — the free/cheap methods (range formatting, `workspace/symbol`,
   `documentHighlight`, `foldingRange`, `typeDefinition`).
3. **Phase 3 head** — completion stdlib candidates + `inlayHint` + doc comments (S4).
4. **Phase 4** — cancellation, shutdown/exit, positionEncoding, error isolation.
5. **Phase 5** — rebuild the `.vsix`, version-sync IntelliJ, add a publish CI.

Phases 1–2 alone move it from "alpha, single-file-correct" to "trustworthy
multi-file server"; 1–5 is a shippable, marketplace-published full LSP.

> **Caveat on the parity tracker.** `caas-roslyn-parity.md` marks Tiers 1–4
> "complete" — but that measures the CaaS *semantic API surface*, not LSP method
> depth. Its own 🟡 flags (lossy formatter, unpopulated `containingSymbol`, no
> `DocComment` node, minimal cancellation) are exactly the structural constraints
> S1–S4 above.
