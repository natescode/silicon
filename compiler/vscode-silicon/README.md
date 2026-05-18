# Silicon for VS Code

Syntax highlighting, the **Sigil Dark** color theme, and a
**language server** for the
[Silicon programming language](https://github.com/natescode/sigil) — a
bootstrappable language that targets WebAssembly Text Format (WAT)
and runs under WASI.

> **TODO: extract to its own repository.** Lives in the `sigil`
> monorepo today because the grammar and theme still iterate
> alongside the compiler.  Move to `natescode/vscode-silicon` before
> the first Marketplace publish — VSIX builds shouldn't depend on
> the compiler tree.

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
- **Language server client** (`client/`) — spawns `lsp-silicon` and
  wires diagnostics, document symbols (outline / breadcrumb),
  go-to-definition, and hover for any `.si` file in the workspace.

## Language server settings

| Setting | Default | What it does |
| --- | --- | --- |
| `silicon.lsp.enabled` | `true` | Turn the language server on / off. |
| `silicon.lsp.serverPath` | `""` | Absolute path to `lsp-silicon/src/index.ts`. Leave empty to auto-resolve relative to the workspace root. |

Command: **`Silicon: Restart LSP`** in the command palette
(`Ctrl/Cmd-Shift-P`) restarts the server without reloading the window.

## Install (local development)

```bash
cd vscode-silicon
# Run the extension in a fresh VS Code window:
code --extensionDevelopmentPath="$(pwd)"
```

Or symlink into `~/.vscode/extensions/`:

```bash
ln -s "$(pwd)" ~/.vscode/extensions/vscode-silicon
```

Then in VS Code:

1. Open any `.si` file — syntax highlighting kicks in automatically.
2. **Cmd/Ctrl + K, Cmd/Ctrl + T** → pick **Sigil Dark**.

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
