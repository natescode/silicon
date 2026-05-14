#!/usr/bin/env bash
# Compile demo.si through the Sigil pipeline and print a summary.
set -euo pipefail

SRC="${1:-demo.si}"

echo "Compiling $SRC..."
bun run src/sigil_cli.ts "$SRC"

echo ""
echo "--- main.wat (first 60 lines) ---"
head -60 main.wat
