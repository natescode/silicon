#!/usr/bin/env bash
# Build a standalone native sigilc binary (no Bun install required to run).
# Output: dist/sigilc (Linux/macOS) or dist/sigilc.exe (Windows)
set -euo pipefail
mkdir -p dist
bun build --compile src/sigil_cli.ts --outfile dist/sigilc
echo "Built dist/sigilc ($(du -sh dist/sigilc | cut -f1))"
