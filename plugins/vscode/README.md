# Silicon for VS Code

Syntax highlighting, the **Sigil Dark** color theme, and a built-in
**language server** for the
[Silicon programming language](https://github.com/natescode/sigil) — a
bootstrappable language that targets WebAssembly Text Format (WAT)
and runs under WASI.

The language server (LSP) is bundled directly in the VSIX. No
separate clone, no extra `bun` install — `node` is enough.

## What's in here

- **Silicon language grammar** (`syntaxes/silicon.tmLanguage.json`) —
  TextMate scopes for `.si` files: definition keywords (`@let`, `@fn`,
  `@var`, `@type`, `@extern`, `@stratum_*`), control flow (`@if`,
  `@loop`, `@match`, `@return`, `@break`, `@continue`), function calls
  (`&name`, `&mod::fn`), primitive types (`Int`, `Float`, `Bool`,
  `String`, `Void`), string literals with `\n` / `\t` / `\\` escapes,
  numeric literals (decimal, hex, binary, octal, float), and `#` line
  comments / `##` doc comments.
- **Sigil Dark color theme** (`themes/sigil-dark-color-theme.json`) —
  the same palette the Sigil playground uses, ported to VS Code's
  full UI surface (editor, sidebar, tabs, status bar, terminal).
- **Language configuration** (`language-configuration.json`) —
  bracket pairs, auto-closing single quotes, line-comment toggle.
- **Language server** (`lsp/`) — diagnostics, document symbols
  (outline / breadcrumb), go-to-definition, and hover for any `.si`
  file in the workspace.  The extension spawns this server as a
  `node` child process on `.si` activation; the bundled
  `lsp/dist/index.js` is included in the VSIX.
- **VS Code client** (`client/`) — thin wrapper that wires the
  language server into the editor.

## Language server settings

| Setting | Default | What it does |
| --- | --- | --- |
| `silicon.lsp.enabled` | `true` | Turn the language server on / off. |

Command: **`Silicon: Restart LSP`** in the command palette
(`Ctrl/Cmd-Shift-P`) restarts the server without reloading the window.

## Install (Marketplace)

Coming soon — for now, install locally per the section below.

## Install (local development)

```bash
git clone https://github.com/natescode/silicon-vscode.git
cd silicon-vscode
bun install
bun run build              # builds client + server bundles
# Run the extension in a fresh VS Code window:
code --extensionDevelopmentPath="$(pwd)"
```

Or symlink into `~/.vscode/extensions/`:

```bash
ln -s "$(pwd)" ~/.vscode/extensions/silicon-vscode
```

Then in VS Code:

1. Open any `.si` file — syntax highlighting kicks in automatically.
2. **Cmd/Ctrl + K, Cmd/Ctrl + T** → pick **Sigil Dark**.

## Build + test

```bash
bun run build               # bundles client/dist/extension.js + lsp/dist/index.js
bun run test:server         # LSP smoke test (dev mode, runs under bun)
bun run scripts/smoke-bundled.ts   # LSP smoke test against the bundled artifact under node
```

## Repository layout

```
client/                 VS Code extension client
  src/extension.ts      Spawns lsp/dist/index.js on .si activation
  dist/extension.js     Bundled output (.vsix)
lsp/                    Language Server Protocol implementation
  src/
    index.ts            stdio entry + handler registry
    workspace.ts        per-doc parse/elaborate/typecheck cache
    handlers/           diagnostics, document-symbol, definition, hover
    smoke.test.ts       bun:test wrapper around _smoke-run.ts
  dist/                 Bundled output (.vsix)
    index.js
    std.wat             runtime asset (read by the bundled compiler)
    silicon-official.ohm
src/                    Vendored snapshot of the Sigil compiler frontend
                        (parser, AST, elaborator, typechecker, IR,
                        codegen, modules, platforms).  Frozen at
                        natescode/sigil commit b08f6c4c — the last
                        point before sigil went 100% self-hosted.
                        Imported by lsp/src/* via `../../src/...`
                        relative paths.
boot/strata/builtin/    Silicon strata source loaded at request time
                        by the bundled server.
syntaxes/, themes/      TextMate grammar + color theme
scripts/                Dev scripts (bundled-artifact smoke runner)
```

## Why the LSP is bundled here

The language server source used to live in its own repo
(`natescode/silicon-lsp`) on the theory that vim / emacs / helix
users might want to use it standalone.  In practice, every real
user was going through VS Code, and the separate repo just added
ceremony to releases without buying anything.  Bundled distribution
gives end users a single Marketplace install, no `bun` requirement,
no extra clones.

If you actually want to drive the LSP from another editor: the
bundled `lsp/dist/index.js` is a standalone `node`-runnable LSP
binary.  Point your editor's LSP client at
`node /path/to/lsp/dist/index.js --stdio`.

## Roadmap

Right now, syntax highlighting for `.si` files only works in VS Code,
because it's driven by the TextMate grammar in
`syntaxes/silicon.tmLanguage.json`. Other editors that consume the
bundled LSP (Neovim, Helix, Emacs `lsp-mode`, …) get diagnostics,
go-to-definition, document symbols, and hover, but no highlighting —
each editor would need its own hand-written grammar (a Vim syntax
file, a Tree-sitter parser, etc.) duplicating what the compiler
frontend already knows.

There are two complementary fixes planned. They are not substitutes;
the strongest editor setups use both.

### 1. Semantic tokens over LSP

Extend the language server to implement
[`textDocument/semanticTokens`](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_semanticTokens),
producing token classifications directly from the elaborator's AST.

Why: tree-sitter and TextMate only see syntax — they can tell `Foo`
is PascalCase, but not whether it's a type alias vs sum constructor
vs imported module vs shadowed local. The LSP has the elaborated AST
and name resolution, so it can. Semantic tokens are also free in
terms of grammar maintenance: walk the AST that already exists, emit
the delta-encoded array the spec requires.

Scope sketch:

- Advertise `semanticTokensProvider` in the `initialize` response
  with a legend covering the existing TextMate scope set
  (`storage.type`, `keyword.control`, `entity.name.function`,
  `entity.name.type`, `variable`, `string`, `constant.numeric`, …).
- Add a handler under `lsp/src/handlers/semantic-tokens.ts` that
  walks the cached elaborated AST in `Workspace` and emits the
  delta-encoded token array.
- Keep the TextMate grammar as a fallback for editors that don't
  consume semantic tokens, and for the initial paint before the
  server has parsed the file.

Blocked on stabilising the elaborator snapshot vendored under `src/`
— semantic-token output is only as good as the AST it reads from.

### 2. Tree-sitter grammar (`tree-sitter-silicon`)

Write a [Tree-sitter](https://tree-sitter.github.io/tree-sitter/)
grammar for Silicon, published as its own repo / package so
Neovim (`nvim-treesitter`), Helix, Zed, and GitHub's code-nav can
all consume it.

Why tree-sitter even though semantic tokens exist:

- **First-paint latency.** Tree-sitter parses incrementally,
  in-process, on every keystroke. Semantic tokens require an LSP
  round-trip; on a cold open of a large file, the gap is visible.
- **Always-on.** If the LSP crashes, isn't installed, or the file is
  too broken to elaborate, tree-sitter still highlights what parsed.
- **Powers structural editor features, not just colors.** Text
  objects (`vaf` "around function"), smart folding, indentation,
  sticky scope context, rainbow brackets, structural multi-cursor,
  and code injections (e.g. highlighting embedded WAT inside string
  literals) all consume the tree-sitter tree. Semantic tokens are
  highlighting-only.
- **Robust on invalid syntax.** Tree-sitter produces error nodes and
  keeps highlighting the parts that parsed; an elaborator-driven
  semantic-tokens pass typically can't emit tokens for a file that
  fails to elaborate.

Scope sketch:

- New repo `natescode/tree-sitter-silicon` with `grammar.js`, a
  corpus under `test/corpus/`, and a CI job that runs
  `tree-sitter test` + `tree-sitter parse` against `boot/strata/`.
- Highlight queries (`queries/highlights.scm`) mirroring the
  TextMate scope set so the baseline matches today's VS Code look.
- Structural queries (`locals.scm`, `folds.scm`, `injections.scm`,
  `textobjects.scm`) — these are the features semantic tokens
  cannot provide.
- The VS Code extension itself will not consume this; tree-sitter
  is for editors outside VS Code. The grammar source can crib from
  the Ohm grammar at `lsp/dist/silicon-official.ohm`, but the two
  will need to be kept in rough sync as the language evolves.

### How they layer

In an editor like Neovim, the expected stack ends up:

1. **Tree-sitter** as the base layer — fast, structural,
   always-on highlighting plus text objects / folding / injections.
2. **LSP semantic tokens** layered on top — fills in the things
   syntax alone can't know (type alias vs constructor, mutable vs
   immutable binding, deprecated symbols, …).
3. **TextMate grammar** as the VS Code path and as the universal
   fallback for editors that consume neither of the above.

## Palette

The theme reuses the exact CSS variables from the playground's
`sigil-dark`:

| Token / surface | Color   |
| --- | --- |
| Background | `#0d1117` |
| Foreground text | `#e6edf3` |
| Comments | `#484f58` italic |
| Strings | `#3fb950` |
| Numbers / booleans | `#79c0ff` |
| Keywords (`@let`, `@fn`, …) | `#a371f7` |
| Function names (`&add`) | `#d2a8ff` |
| Primitive types | `#58a6ff` |
| Operators | `#ff7b72` |
| Accent (cursor, badges) | `#a371f7` |

## License

MIT, matching the upstream Sigil project.
