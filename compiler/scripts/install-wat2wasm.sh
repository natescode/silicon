#!/usr/bin/env bash
# scripts/install-wat2wasm.sh — fetch the standalone wat2wasm binary
# from the wabt release tree into ./bin/.  Used by build.sh and test.sh
# so the Silicon-only shell pipeline doesn't require the user to have
# wabt installed system-wide.
#
# Idempotent: skips the download if ./bin/wat2wasm already exists and
# runs.
#
# Override the version pinned below by exporting WABT_VERSION before
# running:  WABT_VERSION=1.0.37 ./scripts/install-wat2wasm.sh

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

WABT_VERSION="${WABT_VERSION:-1.0.36}"
BIN_DIR="$PROJECT_ROOT/bin"
mkdir -p "$BIN_DIR"

# Skip if already installed and runnable.
if [ -x "$BIN_DIR/wat2wasm" ] && "$BIN_DIR/wat2wasm" --version >/dev/null 2>&1; then
  echo "wat2wasm already installed: $("$BIN_DIR/wat2wasm" --version)"
  exit 0
fi
if [ -x "$BIN_DIR/wat2wasm.exe" ] && "$BIN_DIR/wat2wasm.exe" --version >/dev/null 2>&1; then
  echo "wat2wasm already installed: $("$BIN_DIR/wat2wasm.exe" --version)"
  exit 0
fi

# Pick the right wabt release asset for the host OS.  Asset names track
# WebAssembly/wabt's release-pipeline conventions; updates may shift the
# OS suffixes.  When they do, set WABT_ASSET directly to override.
detect_asset() {
  case "$(uname -s)" in
    Linux*)               echo "wabt-${WABT_VERSION}-ubuntu-20.04.tar.gz" ;;
    Darwin*)              echo "wabt-${WABT_VERSION}-macos-14.tar.gz" ;;
    MINGW*|MSYS*|CYGWIN*) echo "wabt-${WABT_VERSION}-windows.tar.gz" ;;
    *)                    echo "" ;;
  esac
}

ASSET="${WABT_ASSET:-$(detect_asset)}"
if [ -z "$ASSET" ]; then
  echo "install-wat2wasm.sh: unsupported OS '$(uname -s)'." >&2
  echo "  Download manually from https://github.com/WebAssembly/wabt/releases" >&2
  echo "  and place the wat2wasm binary at $BIN_DIR/wat2wasm" >&2
  exit 1
fi

URL="https://github.com/WebAssembly/wabt/releases/download/${WABT_VERSION}/${ASSET}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "install-wat2wasm.sh: downloading $ASSET"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$URL" -o "$TMP/wabt.tar.gz"
elif command -v wget >/dev/null 2>&1; then
  wget -q "$URL" -O "$TMP/wabt.tar.gz"
else
  echo "install-wat2wasm.sh: need curl or wget" >&2
  exit 127
fi

echo "install-wat2wasm.sh: extracting"
tar -xzf "$TMP/wabt.tar.gz" -C "$TMP"

# wat2wasm lives in <unpacked>/bin/wat2wasm (or .exe on Windows).  Find
# whichever is present and copy it to project bin/.
found="$(find "$TMP" -type f \( -name 'wat2wasm' -o -name 'wat2wasm.exe' \) | head -1)"
if [ -z "$found" ]; then
  echo "install-wat2wasm.sh: wat2wasm binary not found in archive" >&2
  exit 1
fi
cp "$found" "$BIN_DIR/"
chmod +x "$BIN_DIR/$(basename "$found")"

echo "install-wat2wasm.sh: ✓ installed to $BIN_DIR/$(basename "$found")"
"$BIN_DIR/$(basename "$found")" --version
