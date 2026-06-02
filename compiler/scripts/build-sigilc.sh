#!/usr/bin/env bash
# Build a standalone native sigilc binary (no Bun install required to run).
# Output: dist/sigilc (Linux/macOS).
#
# Thin wrapper around the canonical builder, cli/scripts/build-binary.ts.
# That builder inlines the compiler's built-in assets (strata / std.wat /
# built-in modules / web platform) via assets.generated instead of scanning
# the source tree at runtime — a `bun build --compile` binary has no source
# tree to readdirSync, so a naive `bun build --compile src/sigil_cli.ts`
# traps with `/$bunfs/root` ENOENT on first compile. It also tracks the
# CLI's real entry point (cli/src/sigil_cli.ts), which has moved out of the
# compiler package.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# build-binary.ts emits cli/dist/sgl-<os>-<arch> for the host platform.
bun run "$ROOT/cli/scripts/build-binary.ts"

case "$(uname -s)" in Darwin) os=macos;; *) os=linux;; esac
case "$(uname -m)" in arm64|aarch64) arch=aarch64;; *) arch=x86_64;; esac

mkdir -p dist
cp "$ROOT/cli/dist/sgl-${os}-${arch}" dist/sigilc
echo "Built dist/sigilc ($(du -sh dist/sigilc | cut -f1))"
