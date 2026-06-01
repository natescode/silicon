---
title: Install
---

# Install

## curl | sh (fastest)

```sh
curl -fsSL https://raw.githubusercontent.com/NatesCode/silicon/main/scripts/install.sh | sh
```

The installer auto-detects Linux x86_64 / aarch64 and macOS arm64 / x64,
downloads the matching tarball from GitHub Releases, verifies SHA-256,
installs to `~/.sgl/bin`, and updates your shell rc. Override with
`SGL_INSTALL_DIR` or skip the rc edit with `SGL_NO_MODIFY_PATH=1`.

## Homebrew (macOS, Linux)

```sh
brew tap NatesCode/silicon
brew install sgl
```

The formula handles all four Tier 1 platforms via
`on_macos/on_linux × on_arm/on_intel` blocks.

## apt / dpkg (Debian, Ubuntu)

Download the `.deb` from the GitHub Release for your architecture
(`amd64` or `arm64`) and:

```sh
sudo dpkg -i sgl_<version>_<arch>.deb
```

## Windows (via WSL)

Silicon ships on Windows through WSL2. Install WSL, then run the
`curl | sh` installer or use Homebrew on Linux.

The winget manifest at `packaging/winget/natescode.sgl.yaml` is ready to
be submitted to `microsoft/winget-pkgs`; a native Windows build is
planned for v1.x.

## Build from source

You need:

- **Bun ≥ 1.0**
- **wasmtime** — only for `sgl run` integration tests
- **wat2wasm** — for the `.wat → .wasm` step outside binaryen's path
  (`scripts/install-wat2wasm.sh`)

```sh
git clone https://github.com/NatesCode/silicon
cd sigil
bun install
bun run build:sigilc      # dist/sigilc
```

Run `dist/sigilc --help` to confirm.

## Tier 1 platforms

| Platform | Status |
|----------|--------|
| Linux x86_64  | ✅ |
| Linux aarch64 | ✅ |
| macOS arm64   | ✅ |
| macOS x86_64  | ✅ |
| Windows (WSL) | ✅ |
| Windows (native) | v1.x |

## Verifying integrity

Every GitHub Release includes per-platform SHA-256 checksums alongside
the tarballs. The `curl | sh` installer and the Homebrew formula both
verify these before installing. If you download manually:

```sh
sha256sum -c sgl_<version>_<platform>.tar.gz.sha256
```

Source provenance: signed git tags from
[@NatesCode](https://github.com/NatesCode); release artefacts are built
on GitHub-hosted runners per
`.github/workflows/release.yml`.
