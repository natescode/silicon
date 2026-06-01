# NOTICE

Sigil (the Silicon compiler) is © 2024–2026 NatesCode LLC, Nathan Hedglin,
licensed under the MIT License (see `LICENSE.md`).

This product includes software developed by third parties. The following
runtime / build dependencies are bundled into or required by the project.
Each component retains its own license; this NOTICE collects the
attributions required by those licenses.

## Production dependencies

| Package | Version | License | Source |
|---------|---------|---------|--------|
| binaryen | ^117.0.0 | Apache-2.0 | https://github.com/WebAssembly/binaryen |
| wabt | ^1.0.39 | Apache-2.0 | https://github.com/WebAssembly/wabt |

## Build / dev dependencies (not redistributed)

| Package | Version | License | Source |
|---------|---------|---------|--------|
| fast-check | ^4.8.0 | MIT | https://github.com/dubzzz/fast-check |
| @changesets/cli | ^2.31.0 | MIT | https://github.com/changesets/changesets |
| @microsoft/api-extractor | ^7.58.7 | MIT | https://github.com/microsoft/rushstack |
| @types/bun | latest | MIT | https://github.com/oven-sh/bun |
| @types/node | ^20.14.2 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| vscode-oniguruma | ^2.0.1 | MIT | https://github.com/microsoft/vscode-oniguruma |
| vscode-textmate | ^9.3.2 | MIT | https://github.com/microsoft/vscode-textmate |
| typescript | ^5.0.0 | Apache-2.0 | https://github.com/microsoft/TypeScript |

## Apache-2.0 attribution

`binaryen` and `wabt` are distributed under the Apache License, Version 2.0.
A copy of that license is available at:

    https://www.apache.org/licenses/LICENSE-2.0

No modifications to those projects' source are made in this repository. The
prebuilt artefacts are consumed via npm.

## Runtime tooling (not bundled)

The `sgl` CLI invokes the following tools at runtime when present; they are
not redistributed by this project:

- **wasmtime** — Apache-2.0 — https://github.com/bytecodealliance/wasmtime
- **QBE** — MIT — https://c9x.me/compile/
- **wat2wasm** (WABT) — Apache-2.0 — https://github.com/WebAssembly/wabt

## Bun runtime (embedded in the `sgl` binary)

The standalone `sgl` binaries are built with `bun build --compile`, which embeds
the **Bun** runtime. Bun's own code is MIT-licensed, but Bun **statically links
JavaScriptCore/WebKit (LGPL-2)** plus a number of other libraries (boringssl,
libarchive, mimalloc, brotli, c-ares, …) under MIT / BSD / Apache-2.0 / zlib.

Per LGPL-2, the binary is distributed in object form so the LGPL'd library can
be modified and relinked; Bun's patched WebKit source and relink instructions
are at <https://github.com/oven-sh/webkit>.

The full set of these attributions ships **with each binary** as
`THIRD-PARTY-LICENSES.md` inside the release tarball (a verbatim copy of Bun's
`LICENSE.md`). Canonical text: <https://github.com/oven-sh/bun/blob/main/LICENSE.md>.

The `sgl` binary does **not** bundle `binaryen` or `wabt` — they are Node-side
build/test tooling only (the compiler assembles WebAssembly with its own
emitter), so they are not redistributed in the binary or the playground bundle.

## Reporting

If you find a missing attribution, please open an issue at
https://github.com/NatesCode/silicon/issues.
