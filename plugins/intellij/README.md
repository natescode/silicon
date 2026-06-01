# Silicon — IntelliJ Platform plugin

Language support for the [Silicon](../../README.md) programming language
(`.si`) in IntelliJ IDEA and other JetBrains IDEs (PyCharm, WebStorm, GoLand,
CLion, …, Community or Ultimate).

Two pieces:

- **Syntax highlighting** — a native, lexer-based highlighter (no TextMate
  bundle required). Token coloring mirrors the VS Code TextMate grammar so both
  editors look the same, and every token is individually themeable under
  *Settings ▸ Editor ▸ Color Scheme ▸ Silicon*.
- **Language server** — the existing [`@silicon/lsp`](../../lsp) server
  (diagnostics, hover, go-to-definition, document symbols), wired in through
  [LSP4IJ](https://github.com/redhat-developer/lsp4ij). The same server binary
  powers the VS Code extension.

## Layout

```
plugins/intellij/
├─ build.gradle.kts            # IntelliJ Platform Gradle plugin 2.x + LSP4IJ dep
├─ src/main/kotlin/com/natescode/silicon/
│  ├─ SiliconLanguage / SiliconFileType / SiliconIcons / SiliconCommenter
│  ├─ lexer/      SiliconLexer, SiliconTokenTypes      # tokenizer
│  ├─ highlight/  SiliconSyntaxHighlighter(+Factory), SiliconColorSettingsPage
│  └─ lsp/        SiliconLanguageServerFactory, SiliconStreamConnectionProvider,
│                 SiliconServerLocator, SiliconLspSettings, SiliconLspConfigurable
├─ src/main/resources/META-INF/plugin.xml
└─ src/test/kotlin/...          # lexer unit tests
```

## Build & run

Prerequisites: a **JDK 21** must be installed. The wrapper downloads Gradle
8.10.2 on first run.

> **Why JDK 21 specifically?** This is standard for IntelliJ-plugin development —
> JetBrains targets JDK 17/21, and Gradle 8.10.2's embedded Kotlin DSL compiler
> cannot parse Java **25+** (you'd get a cryptic `IllegalArgumentException: 25.x`).
> `gradle/gradle-daemon-jvm.properties` pins the daemon to Java 21, so Gradle
> **auto-discovers** any installed JDK 21 — you don't have to touch `JAVA_HOME`
> even if your default `java` is newer. It does *not* auto-download a JDK; if you
> see *"Cannot find a Java installation … matching Java 21"*, install one
> (e.g. Temurin 21) or point Gradle at it: `./gradlew -Dorg.gradle.java.home=/path/to/jdk-21 …`.

```sh
cd plugins/intellij

./gradlew test          # run the lexer unit tests
./gradlew runIde        # launch a sandbox IDE with the plugin loaded
./gradlew buildPlugin   # produce build/distributions/silicon-intellij-0.1.0.zip
./gradlew verifyPlugin  # IntelliJ Plugin Verifier compatibility check
```

Install the built zip via *Settings ▸ Plugins ▸ ⚙ ▸ Install Plugin from Disk…*.
LSP4IJ is declared as a dependency and is fetched from the JetBrains Marketplace
at build time; when installing the zip manually, also install **LSP4IJ** from
the Marketplace (the plugin depends on it).

## How the language server is launched

`SiliconServerLocator` resolves a launch command, with everything overridable in
*Settings ▸ Languages & Frameworks ▸ Silicon*:

| Setting          | Default (blank) behaviour                                   |
| ---------------- | ----------------------------------------------------------- |
| Enable           | on                                                          |
| Interpreter      | first of `bun`, then `node`, found on `PATH`                |
| Server script    | nearest `lsp/src/index.ts`, searched upward from the project |

The server is started as `<interpreter> <script> --stdio` with the working
directory set to the monorepo root (the grandparent of `lsp/src/`), matching the
dev environment so `@silicon/compiler` resolution works. Out of the box this
"just works" when the IDE has the Silicon monorepo open and `bun` is installed.

For a standalone Silicon user project (created by `sgl init`, no `lsp/` tree),
point **Server script** at the monorepo's `lsp/src/index.ts`, or at the bundled
`lsp/dist/index.js` produced by the VS Code extension's `build:server` and run
it with `node`.

Manage running servers (restart, view traces) from the **Language Servers** tool
window contributed by LSP4IJ.

## Relationship to the VS Code extension

Both clients drive the same `@silicon/lsp` server over stdio and aim for
identical highlighting. The VS Code grammar lives in
[`../vscode/syntaxes/silicon.tmLanguage.json`](../vscode/syntaxes/silicon.tmLanguage.json);
the IntelliJ lexer in `lexer/SiliconLexer.kt` is the hand-ported equivalent. Keep
the two in sync when the language's surface syntax changes.
