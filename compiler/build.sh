#!/usr/bin/env bash
# build.sh — Silicon-only build driver for sigil.
#
# Rebuilds wasm-bin/stage1.wasm from the boot/*.si tree using ONLY:
#   - wasmtime (>= 14)  — runs the prior stage1.wasm to compile sources
#   - wat2wasm (wabt)   — assembles the resulting WAT into a WASM binary
#
# No bun, no node, no typescript.  The prior stage1.wasm is the seed
# compiler (like rustc bootstrapping itself).
#
# Usage:
#   ./build.sh                        # rebuild wasm-bin/stage1.wasm in-place
#   ./build.sh test                   # build + run boot/tests/*.si under wasmtime
#   ./build.sh check                  # build into a temp path, fixed-point check
#
# Exit codes: 0 = success; non-zero = build / verification failed.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

WASM_BIN="$PROJECT_ROOT/wasm-bin"
SEED="$WASM_BIN/stage1.wasm"
OUT_WAT="$WASM_BIN/stage1.wat"
OUT_WASM="$WASM_BIN/stage1.wasm"
TMP_WAT="$(mktemp -t stage1.XXXXXX.wat)"
TMP_WASM="$(mktemp -t stage1.XXXXXX.wasm)"
trap 'rm -f "$TMP_WAT" "$TMP_WASM"' EXIT

cmd="${1:-build}"

# ─── Tool resolution ───────────────────────────────────────────────────
# Prefer project-local bin/ (populated by scripts/install-wat2wasm.sh)
# so the Silicon-only pipeline works without polluting the user's PATH
# or requiring system-wide wabt.  Falls back to PATH when bin/ is empty.
resolve_wat2wasm() {
  if   [ -x "$PROJECT_ROOT/bin/wat2wasm" ];     then echo "$PROJECT_ROOT/bin/wat2wasm"
  elif [ -x "$PROJECT_ROOT/bin/wat2wasm.exe" ]; then echo "$PROJECT_ROOT/bin/wat2wasm.exe"
  elif command -v wat2wasm >/dev/null 2>&1;     then command -v wat2wasm
  else echo ''
  fi
}

command -v wasmtime >/dev/null 2>&1 || {
  echo "build.sh: missing required tool 'wasmtime'" >&2
  echo "  install via: https://wasmtime.dev/install.sh" >&2
  exit 127
}

WAT2WASM="$(resolve_wat2wasm)"
if [ -z "$WAT2WASM" ]; then
  echo "build.sh: missing required tool 'wat2wasm'" >&2
  echo "  fetch automatically to ./bin/ via:" >&2
  echo "    ./scripts/install-wat2wasm.sh" >&2
  echo "  or install wabt system-wide from:" >&2
  echo "    https://github.com/WebAssembly/wabt/releases" >&2
  exit 127
fi

[ -f "$SEED" ] || {
  echo "build.sh: seed compiler $SEED not found" >&2
  echo "  this script bootstraps from the checked-in stage1.wasm; restore it via git." >&2
  exit 2
}

# ─── Source bundle ─────────────────────────────────────────────────────
# The bundle order MUST mirror scripts/build-stage1.ts:STAGE1_FILES so
# Silicon and TS pipelines produce byte-equal output.  Kept here as a
# literal list rather than reading from boot/build_order.txt so a typo
# in the data file can't silently change the bundle layout.
STAGE1_FILES=(
  "boot/std/argv.si"
  "boot/std/io.si"
  "boot/std/fs.si"
  "boot/std/arena.si"
  "boot/std/vec.si"
  "boot/embedded_bundle.si"
  "boot/parser/tokens.si"
  "boot/parser/lex.si"
  "boot/parser/ast.si"
  "boot/parser/parse.si"
  "boot/types/types.si"
  "boot/types/errors.si"
  "boot/types/ctx.si"
  "boot/types/preregister_std.si"
  "boot/types/preregister_defs.si"
  "boot/types/intrinsic_sig.si"
  "boot/types/check.si"
  "boot/strata/registry.si"
  "boot/strata/loader.si"
  "boot/elab/elaborator.si"
  "boot/ir/nodes.si"
  "boot/elab/body.si"
  "boot/elab/body_scope.si"
  "boot/compiler_api/ctx.si"
  "boot/elab/body_rich.si"
  "boot/ir/lower.si"
  "boot/emit/wat.si"
  "boot/cli.si"
  "boot/modules/use.si"
  "boot/stage1.si"
)

# WASI extern declarations.  Must be lexically identical to the WASI_STUB
# in scripts/build-stage1.ts so the two pipelines emit byte-equal WAT.
emit_wasi_stub() {
  cat <<'EOF'
@extern wasi_snapshot_preview1::fd_write:Int
  fd:Int, iovs_ptr:Int, iovs_len:Int, nwritten_out:Int;
@extern wasi_snapshot_preview1::fd_read:Int
  fd:Int, iovs_ptr:Int, iovs_len:Int, nread_out:Int;
@extern wasi_snapshot_preview1::args_get:Int
  argv_ptr:Int, argv_buf:Int;
@extern wasi_snapshot_preview1::args_sizes_get:Int
  argc_out:Int, argv_buf_size_out:Int;
@extern wasi_snapshot_preview1::proc_exit
  code:Int;
@extern wasi_snapshot_preview1::path_open:Int
  dirfd:Int, dirflags:Int, path_ptr:Int, path_len:Int,
  oflags:Int, fs_rights_base:Int64, fs_rights_inheriting:Int64,
  fdflags:Int, fd_out:Int;
@extern wasi_snapshot_preview1::fd_prestat_get:Int
  fd:Int, buf_out:Int;
@extern wasi_snapshot_preview1::fd_prestat_dir_name:Int
  fd:Int, path_ptr:Int, path_len:Int;
EOF
}

assemble_bundle() {
  emit_wasi_stub
  for f in "${STAGE1_FILES[@]}"; do
    [ -f "$f" ] || { echo "build.sh: missing $f" >&2; exit 1; }
    cat "$f"
  done
}

# ─── Compile pipeline ──────────────────────────────────────────────────
# Stage1's embedded_bundle is already baked in, so we DO need to prepend
# the strata bundle when feeding boot.wasm (Stage 0's TS pipeline does
# the same).  Stage1 itself reads its own embedded bundle internally,
# so we DON'T prepend strata when invoking stage1.wasm.
#
# This script assumes we're rebuilding stage1 USING stage1 (self-host).
# The TS scripts/build-stage1.ts uses boot.wasm + bundle prefix; we use
# stage1.wasm and let its embedded bundle do the work.  The two paths
# produce byte-equal WAT.

build_stage1() {
  echo "build.sh: bundling $(printf '%d' "${#STAGE1_FILES[@]}") source files…"
  local bundle
  bundle="$(assemble_bundle)"
  echo "build.sh: compiling via stage1.wasm under wasmtime…"
  wasmtime --dir . "$SEED" <<<"$bundle" > "$TMP_WAT"
  echo "build.sh: assembling WAT → WASM via $WAT2WASM…"
  "$WAT2WASM" "$TMP_WAT" -o "$TMP_WASM"
}

# ─── Subcommands ───────────────────────────────────────────────────────
case "$cmd" in
  build)
    build_stage1
    cp "$TMP_WAT"  "$OUT_WAT"
    cp "$TMP_WASM" "$OUT_WASM"
    echo "build.sh: ✓ wrote $OUT_WAT ($(wc -c <"$OUT_WAT") bytes)"
    echo "build.sh: ✓ wrote $OUT_WASM ($(wc -c <"$OUT_WASM") bytes)"
    ;;
  check)
    build_stage1
    if cmp -s "$SEED" "$TMP_WASM"; then
      echo "build.sh: ✓ fixed point — rebuilt stage1.wasm byte-equal to seed"
    else
      echo "build.sh: ✗ fixed-point FAILED" >&2
      echo "         seed: $(wc -c <"$SEED") bytes" >&2
      echo "         new:  $(wc -c <"$TMP_WASM") bytes" >&2
      exit 1
    fi
    ;;
  test)
    build_stage1
    cp "$TMP_WAT"  "$OUT_WAT"
    cp "$TMP_WASM" "$OUT_WASM"
    echo "build.sh: build complete; test runner not yet ported (Phase 6)"
    echo "  individual boot/tests/*.si can be built+run via the existing"
    echo "  scripts/build-boot.ts until the Silicon test runner lands."
    ;;
  *)
    echo "build.sh: unknown subcommand '$cmd'" >&2
    echo "Usage: $0 [build|check|test]" >&2
    exit 64
    ;;
esac
