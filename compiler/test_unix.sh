#!/usr/bin/env bash
# test.sh — run boot/tests/*_test.si under stage1.wasm + wasmtime.
#
# Silicon-only test driver.  Uses no bun, no node, no typescript.
# Required tools on PATH: wasmtime, wat2wasm (or ./bin/wat2wasm
# installed via scripts/install-wat2wasm.{sh,ps1}).
#
# For each test:
#   1. Resolve its @use graph depth-first (in-shell, no external tool).
#   2. Concatenate WASI extern stub + deps (DFS post-order) + the test
#      itself into a single source bundle.
#   3. Pipe the bundle through stage1.wasm under wasmtime → WAT.
#   4. wat2wasm WAT → .wasm.
#   5. Execute the .wasm under wasmtime; capture stdout.
#   6. Pass iff stdout contains " OK" (matches the convention used by
#      arena_test, vec_test, body_scope_test, body_rich_test, etc.).
#
# Usage:
#   ./test.sh                            # run a curated list of tests
#   ./test.sh boot/tests/arena_test.si   # run one test
#   ./test.sh boot/tests/*_test.si       # glob-expand

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

STAGE1="$PROJECT_ROOT/wasm-bin/stage1.wasm"
[ -f "$STAGE1" ] || { echo "test.sh: $STAGE1 missing — run ./build.sh first" >&2; exit 2; }
command -v wasmtime >/dev/null 2>&1 || { echo "test.sh: wasmtime missing" >&2; exit 127; }

# Resolve wat2wasm with the same priority as build.sh: prefer the
# project-local copy fetched by scripts/install-wat2wasm.sh; fall back
# to PATH.  No PATH copy → tell the user the install script exists.
if   [ -x "$PROJECT_ROOT/bin/wat2wasm" ];     then WAT2WASM="$PROJECT_ROOT/bin/wat2wasm"
elif [ -x "$PROJECT_ROOT/bin/wat2wasm.exe" ]; then WAT2WASM="$PROJECT_ROOT/bin/wat2wasm.exe"
elif command -v wat2wasm >/dev/null 2>&1;     then WAT2WASM="$(command -v wat2wasm)"
else
  echo "test.sh: wat2wasm missing — run ./scripts/install-wat2wasm.sh" >&2
  exit 127
fi

WASI_STUB='@extern wasi_snapshot_preview1::fd_write:Int
  fd:Int, iovs_ptr:Int, iovs_len:Int, nwritten_out:Int;
@extern wasi_snapshot_preview1::fd_read:Int
  fd:Int, iovs_ptr:Int, iovs_len:Int, nread_out:Int;
@extern wasi_snapshot_preview1::proc_exit
  code:Int;
@extern wasi_snapshot_preview1::args_get:Int
  argv_ptr:Int, argv_buf:Int;
@extern wasi_snapshot_preview1::args_sizes_get:Int
  argc_out:Int, argv_buf_size_out:Int;
'

# ── Minimal @use resolver (depth-first, post-order, cycle-safe) ────
declare -A VISITED
ORDER=()

resolve_uses() {
  local file="$1"
  local abs
  abs="$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"
  [ -n "${VISITED[$abs]:-}" ] && return
  VISITED[$abs]=1
  local dir
  dir="$(dirname "$abs")"
  # Only the FIRST single-quoted token on a line that starts with @use.
  while IFS= read -r line; do
    if [[ "$line" =~ ^[[:space:]]*@use[[:space:]]+\'([^\']+)\' ]]; then
      resolve_uses "$dir/${BASH_REMATCH[1]}"
    fi
  done < "$abs"
  ORDER+=("$abs")
}

run_one() {
  local test_file="$1"
  [ -f "$test_file" ] || { echo "  ✗ MISSING $test_file"; return 1; }
  VISITED=()
  ORDER=()
  resolve_uses "$test_file"

  local bundle_tmp wat_tmp wasm_tmp
  bundle_tmp="$(mktemp)"
  wat_tmp="$(mktemp --suffix=.wat)"
  wasm_tmp="$(mktemp --suffix=.wasm)"
  trap 'rm -f "$bundle_tmp" "$wat_tmp" "$wasm_tmp"' RETURN

  {
    printf '%s\n' "$WASI_STUB"
    for f in "${ORDER[@]}"; do cat "$f"; done
  } > "$bundle_tmp"

  if ! wasmtime --dir . "$STAGE1" < "$bundle_tmp" > "$wat_tmp" 2>/dev/null; then
    echo "  ✗ COMPILE FAIL $test_file"
    return 1
  fi
  if ! "$WAT2WASM" "$wat_tmp" -o "$wasm_tmp" 2>/dev/null; then
    echo "  ✗ ASSEMBLE FAIL $test_file"
    return 1
  fi

  local out
  out="$(wasmtime "$wasm_tmp" 2>&1 || true)"
  if echo "$out" | grep -q ' OK$\|^ok$\|^arena OK\|^body-scope OK\|^body-rich OK\|^vec OK'; then
    echo "  ✓ PASS $test_file — $(echo "$out" | tr -d '\r')"
    return 0
  else
    echo "  ✗ FAIL $test_file"
    echo "    output:"; echo "$out" | sed 's/^/      /'
    return 1
  fi
}

# Default test set — every boot/tests/*_test.si that prints " OK" on
# success.  Standalone-compilable; no stdin fixtures required.  Tests
# omitted here (lex_test, parse_test, body_test, emit_test, fn_test,
# lower_test, module_test, scope_test, json_test, json_fixtures_test,
# templates_test, intrinsics_test, elaborator_test, strata_loader_test)
# either need parsed input on stdin or compared their output against
# Stage 0 (TypeScript) dumps that no longer exist — they remain as
# .si files for users who want to drive them under a custom harness.
DEFAULT_TESTS=(
  # Runtime + data structures (Phase 0/1)
  "boot/tests/arena_test.si"
  "boot/tests/vec_test.si"
  "boot/tests/ir_nodes_test.si"
  "boot/tests/body_scope_test.si"
  "boot/tests/body_rich_test.si"
  # User-defined keywords (Phase 1)
  "boot/tests/nz_keyword_test.si"
  "boot/tests/const_keyword_test.si"
  "boot/tests/loc_keyword_test.si"
  # Typechecker (Phase 2)
  "boot/tests/types_test.si"
  "boot/tests/errors_test.si"
  "boot/tests/intrinsic_sig_test.si"
  "boot/tests/ctx_test.si"
  "boot/tests/preregister_std_test.si"
  "boot/tests/preregister_defs_test.si"
  "boot/tests/check_literals_test.si"
  "boot/tests/check_binop_test.si"
  "boot/tests/check_call_test.si"
  "boot/tests/check_block_test.si"
  "boot/tests/check_kw_test.si"
  "boot/tests/check_array_test.si"
  # Strata 2.0 (Phase 3)
  "boot/tests/strata2_test.si"
)

if [ $# -gt 0 ]; then
  TESTS=("$@")
else
  TESTS=("${DEFAULT_TESTS[@]}")
fi

PASS=0; FAIL=0
echo "test.sh: running ${#TESTS[@]} test(s)…"
for t in "${TESTS[@]}"; do
  if run_one "$t"; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi
done
echo
echo "test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
