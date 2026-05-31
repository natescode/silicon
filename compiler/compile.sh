#!/usr/bin/env bash
# Compile a Silicon source through the Sigil pipeline and print a summary.
# Usage: ./compile.sh [path/to/source.si]   (defaults to examples/demo.si)
set -euo pipefail

SRC="${1:-examples/demo.si}"

echo "Compiling $SRC..."
bun run src/sigil_cli.ts "$SRC"

echo ""
echo "--- main.wat (first 60 lines) ---"
head -60 main.wat
