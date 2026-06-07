# LSP completion plan — stdlib & module autocomplete, third-party libraries, snippets

**Status:** Plan / proposal (not implemented). Grounded in the current code as of
the ADR-0020 grammar migration. Phases are independent and additive.

This document plans three improvements to Silicon's LSP completion:

1. **Standard-library & built-in module** autocomplete (`web::`, `JSString::`,
   `console::`, `option` / `result` / `vec`, …).
2. **Third-party library** autocomplete (`@use`'d files; future dependency
   manifests).
3. **Snippets** — function-call parameter expansion, and construct stubs (e.g.
   selecting `@fn` stubs out a whole function skeleton).

---

## Current state (what already exists)

Completion **works today**, but minimally. `lsp/src/handlers/completion.ts` calls
`Workspace.getCompletions(uri, line, col, prefix)`
(`compiler/src/caas/workspace.ts:588`), which collects exactly three sources:

1. **document-local** symbols — `doc.model.allSymbols`;
2. **cross-document** symbols from `#symbolIndex`, scoped by project visibility
   (`#isEntryVisible`);
3. **`SILICON_KEYWORDS`** (`compiler/src/caas/workspace.ts:1394`) — `@fn`, `@mut`,
   `@type`, `@enum`, `@extern`, `@export`, `@if`, `@loop`, `@match`, …

…filtered by case-insensitive substring. Each item is
`{ label, kind, detail, docComment }` (`workspace.ts:82`). The LSP advertises
`completionProvider: { triggerCharacters: ['&','@',':'] }` (`lsp/src/index.ts:48`)
— **no `resolveProvider`, no snippets** — and `docComment` is always `undefined`
(`docCommentForName` is stubbed pending a `DocComment` AST node).

### Gaps that matter here

- **Stdlib / built-in module functions are not offered at all.** `getCompletions`
  only sees *document* symbols, never the **module registry** or the preregistered
  std tables — so `web::log`, `JSString::concat`, `console::log`, and the bundled
  `option`/`result`/`vec` modules never appear.
- **No snippet support** anywhere in the LSP or CaaS.
- **No scope-awareness** — `getCompletions` ignores `(line, col)` and returns
  workspace-global candidates.

### Data sources we can build on (already present)

- `ModuleRegistry = Map<string, { functions: Map<string, { siliconParams: string[]; siliconResult?: string }> }>`
  (`compiler/src/modules/registry.ts`) — every `module::fn` and its signature.
- `preRegisterStdFunctions` (`compiler/src/types/typechecker.ts:637`) — low-level
  `std.wat` builtins (`alloc`, `vec_*`, `str_*`, …).
- Bundled stdlib via `stdlibSource` (`readStdlibModule` / `hasStdlibModule`) —
  bare-name `@use 'option'` etc.
- `CheckResult._functions: Map<string, FunctionSig{ params, result }>`, plus
  `formatType` / `typeDisplayString` for rendering signatures.
- `SemanticModel`: `allSymbols`, `symbolNamed`, `symbolAtPosition`, `typeOf`;
  `Symbol { name, kind, type, displayString, definitionSpan }`
  (`compiler/src/ast/semanticModel.ts`).

---

## Feature 1 — Standard-library & module autocomplete

**Goal:** offer `web::`, `JSString::`, `console::`, and the bundled stdlib.

1. **Thread the `ModuleRegistry` into `getCompletions`.** The workspace already
   builds the registry per compile; pass it in. Enumerate its entries → for each
   `module::fn`, emit `CompletionItem { label: 'module::fn', kind: 'function',
   detail: <signature> }`, where the signature is rendered from
   `siliconParams` → `siliconResult`.
2. **Namespace-context detection.** `:` is already a trigger character. Add a
   helper `namespaceContextAt(source, line, col)` that looks back from the cursor
   for an `ident::` prefix; when present, offer **only that module's** functions,
   labeled *unqualified* (`concat`, not `JSString::concat`). Shared with Feature 2.
3. **Bundled stdlib (`@use`'d).** Once `@use 'option'` is present, the pre-parse
   inliner turns those functions into document symbols, so they already flow
   through `allSymbols`. Pre-`@use` *discovery* is handled by Feature 3.
4. **`std.wat` builtins** (`alloc`, `vec_*`, …) are mostly internal — tag them and
   **omit by default** (or gate behind a setting) to avoid noise.
5. **Signature detail.** Populate `detail` (and `labelDetails.detail` for a nicer
   secondary label) from the rendered signature.

**Touches:** `getCompletions` (+ a `moduleRegistry` field/param), a new
`namespaceContextAt` helper, `formatType` reuse. Purely additive.

---

## Feature 2 — Third-party library autocomplete

**Reality check:** there is **no package manager** today. "Third-party" means local
files pulled in via `@use 'path.si'`, plus bundled stdlib via bare-name `@use`.
`@use` is a **pre-parse inliner** (`compiler/src/modules/useResolver.ts`).

**Partly works already:** the LSP adapter opens `@use`'d dependency documents into
the workspace, and their symbols flow into the cross-document index — so `@use`'d
library functions **already appear** when the dependency is open and project-visible
(`#isEntryVisible`).

**Plan:**

1. **`@use` path / string completion.** Detect the `@use '…'` string-literal
   context and complete (a) project-relative `.si` paths and (b) bundled stdlib
   names (`hasStdlibModule` / the stdlib manifest). This is the real "discover a
   library" entry point.
2. **Eager dependency indexing.** Ensure *path*-`@use` deps are opened and indexed
   even before a symbol is referenced (verify the LSP adapter does this for path
   `@use`, not only bare-name).
3. **Module-style third-party libs** (any lib that registers a `module::`) ride
   Feature 1's registry enumeration for free.
4. **Extension point (future).** If a dependency manifest lands (e.g.
   `sgl.toml [dependencies]`), index each dependency's *exported* symbols here.
   Depends on a mechanism that does not exist yet — out of initial scope.

---

## Feature 3 — Snippets (incl. `@fn` → function stub)

Two distinct snippet kinds:

**(a) Function-call parameter expansion.** Completing `add` inserts
`add(${1:a}, ${2:b})$0` instead of `add`. Driven from `FunctionSig.params`. Param
*names* aren't reliably in the symbol table yet, so use `p1`/`p2` placeholders or
the best-effort source-scraped names (`paramNameForPosition`).

**(b) Construct snippets — the `@fn` stub.** Selecting the `@fn` completion expands
a full skeleton. Per ADR-0020 syntax:

```
@fn ${1:name} ${2:params} := {
	$0
}
```

A small keyword→template table covers `@fn`, `@type` (`@type ${1:Name} := { $0 }`),
`@enum`, `@match`, `@loop`, `@if`, `@extern`.

**Plan:**

1. **CaaS-side (keep templates in the compiler — reusable + testable).** Extend
   `CompletionItem` (`workspace.ts:82`) with `insertText?: string` and
   `insertTextFormat?: 'plaintext' | 'snippet'`. Populate snippets for the
   `function` kind (call expansion) and for the keyword table (the `@fn` stub etc.).
2. **LSP-side.** In `lsp/src/handlers/completion.ts`, map those onto the LSP item:
   set `insertText` + `insertTextFormat: InsertTextFormat.Snippet`.
3. **Client-capability gate.** Read
   `capabilities.textDocument.completion.completionItem.snippetSupport` in
   `onInitialize`, store it, and **fall back to the plain `label`** when the client
   (some Neovim setups) doesn't support snippets. No *server* capability change is
   needed — snippet is a client capability.
4. *(Optional)* advertise `resolveProvider: true` to populate heavy fields (docs,
   large snippets) lazily — a perf optimization, not a requirement.

---

## Cross-cutting foundations (quality, not blockers)

- **Scope-awareness.** `getCompletions` ignores `(line, col)`, so it suggests
  workspace-global names with no lexical scoping. A
  `SemanticModel.symbolsAtPosition(line, col)` (walk the elaborated tree for the
  enclosing function/block, filter by containment) gives "locals first, hide
  out-of-scope." This is the biggest *quality* lever; it can land after Features 1–3.
  Needs `Symbol.containingSymbol` populated during typechecking (planned per a
  comment in `semanticModel.ts`).
- **Ranking** via `sortText`: locals → project → stdlib/modules → keywords.
- **Doc comments.** `docCommentForName` is stubbed pending a `DocComment` AST node
  — a separate workstream that enriches both hover and completion.

---

## Suggested phasing

| Phase | Delivers | Effort |
|---|---|---|
| **1** | Module-registry enumeration + namespace (`::`) context → **stdlib/module autocomplete** | S–M |
| **2** | CaaS `insertText`/snippet field + `@fn`/keyword stubs + call-param expansion + client-capability gate → **snippets** | M |
| **3** | `@use` path/string completion + eager dependency indexing → **third-party discovery** | M |
| **4** | Scope-aware `symbolsAtPosition`, `sortText` ranking, doc comments, lazy `resolve` | M–L |

---

## Risks & decisions

- **Keep snippet templates in CaaS, not the LSP** — reusable across editor
  front-ends and unit-testable without an LSP harness.
- **Gate snippets on the client capability** — degrade to plain labels for clients
  without `snippetSupport`.
- **Hide `std.wat` builtins by default** — they're internal; surfacing them is noise.
- **Param-name quality is bounded** until parameters land in the symbol table; until
  then call-expansion uses placeholder names.
- **Don't couple completion to a non-existent package manager** — third-party
  support targets `@use` today; the manifest path is a clearly-marked future hook.

---

## Test plan

- **CaaS** (`compiler/src/caas/*.test.ts`): `getCompletions` includes module
  functions; namespace (`M::`) context narrows to one module; snippet templates and
  call-param expansion are emitted on the `CompletionItem`; `std.wat` builtins are
  hidden by default.
- **LSP** (`lsp/src/*.test.ts`): `insertTextFormat` is set when the client supports
  snippets and omitted otherwise; `completion.ts` maps CaaS snippet fields onto LSP
  items; `@use '…'` string-context completion returns stdlib + path candidates.

---

## Related

- [caas-roslyn-parity.md](caas-roslyn-parity.md) — the IDE-API gap tracker this
  feeds into.
- [compiler-as-a-service.md](compiler-as-a-service.md) — the CaaS surface
  (`getCompletions`, `SemanticModel`).
- [optional-signatures-inference.md](optional-signatures-inference.md) — why
  function signatures (and thus completion detail) may be inferred.
- [stdlib.md](stdlib.md) — the standard library being surfaced.
- [js-string-builtins.md](js-string-builtins.md) — the `web::` / `JSString::` /
  `console::` modules.
