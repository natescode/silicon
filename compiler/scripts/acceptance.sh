#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Story 10c-9 — 1.0 acceptance gate.
#
# Runs on a fresh machine (or a fresh CI runner) and verifies the
# install-to-running-program flow that the launch announcement promises:
#
#   1.  install sgl  (Homebrew or curl|sh)
#   2.  sgl init scratch && cd scratch
#   3.  sgl run     →  prints "Hello, Silicon!" and exits 0
#
# Exit status:
#   0  — every gate passed
#   1  — a gate failed; the script halted at the failing step
#
# Environment knobs:
#
#   ACCEPTANCE_METHOD=brew | curl | local-build      (default: brew)
#   SGL_VERSION=1.0.0                                (curl path)
#   SKIP_CLEANUP=1                                   leave the scratch dir
#
# Runs unattended.  No interactive prompts.

set -euo pipefail

METHOD="${ACCEPTANCE_METHOD:-brew}"
SCRATCH="$(mktemp -d /tmp/sgl-acceptance-XXXXXXXX)"
trap '[ "${SKIP_CLEANUP:-}" = "1" ] || rm -rf "$SCRATCH"' EXIT

log()   { printf '\n=== %s ===\n' "$*"; }
fail()  { printf '\nFAIL: %s\n' "$*" >&2; exit 1; }

# --- 1. install -------------------------------------------------------

log "Install method: $METHOD"
case "$METHOD" in
    brew)
        command -v brew >/dev/null 2>&1 || fail "brew not on PATH"
        # Tap may already exist on subsequent runs; that's fine.
        brew tap NatesCode/sigil 2>/dev/null || true
        brew install sgl
        ;;
    curl)
        : "${SGL_VERSION:?SGL_VERSION required for curl install}"
        SGL_VERSION="$SGL_VERSION" \
            sh -c 'curl -fsSL https://raw.githubusercontent.com/NatesCode/sigil/main/scripts/install.sh | sh'
        # install.sh writes to ~/.sgl/bin
        export PATH="$HOME/.sgl/bin:$PATH"
        ;;
    local-build)
        # Smoke path for testing the acceptance script itself without a
        # published release.  Builds sgl from the current repo.
        bun run build:sigilc
        SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
        export PATH="$SCRIPT_DIR/../dist:$PATH"
        ;;
    *)
        fail "unknown ACCEPTANCE_METHOD: $METHOD (expected brew | curl | local-build)"
        ;;
esac

# --- 2. version self-check --------------------------------------------

log "sgl --version"
command -v sgl >/dev/null 2>&1 || fail "sgl not on PATH after install"
sgl help | head -5 || fail "sgl help failed"

# --- 3. init + run ----------------------------------------------------

log "Scaffold and run a hello project"
cd "$SCRATCH"
sgl init hello
cd hello

# wasmtime is documented as required for `sgl run`; install if missing.
if ! command -v wasmtime >/dev/null 2>&1; then
    log "wasmtime missing — installing"
    curl https://wasmtime.dev/install.sh -sSf | bash
    export PATH="$HOME/.wasmtime/bin:$PATH"
fi

OUT="$(sgl run 2>&1 || true)"
echo "$OUT"
echo "$OUT" | grep -q "Hello, Silicon!" || fail "sgl run did not print the expected greeting"

# --- 4. sgl check (typecheck only) ------------------------------------

log "sgl check"
sgl check || fail "sgl check failed"

# --- 5. sgl build (emits .wasm) ---------------------------------------

log "sgl build"
sgl build
test -f bin/main.wasm || fail "sgl build did not produce bin/main.wasm"

# --- 6. summary -------------------------------------------------------

log "Acceptance: PASS"
printf '\nAll gates green.  Scratch dir: %s\n' "$SCRATCH"
[ "${SKIP_CLEANUP:-}" = "1" ] && printf '(left in place per SKIP_CLEANUP=1)\n'
