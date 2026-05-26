#!/usr/bin/env sh
# Build a .deb package for the sgl binary.
# Run this after downloading the linux-x86_64 or linux-aarch64 tarball.
#
# Usage:
#   ./packaging/debian/build-deb.sh v1.0.0 linux-x86_64 /path/to/sgl-v1.0.0-linux-x86_64.tar.gz
#
# Requires: dpkg-deb (part of dpkg package on Debian/Ubuntu)

set -eu

VERSION="${1:-1.0.0}"
PLATFORM="${2:-linux-x86_64}"
TARBALL="${3:-}"

if [ -z "${TARBALL}" ] || [ ! -f "${TARBALL}" ]; then
    echo "Usage: $0 <version> <platform> <tarball>" >&2
    exit 1
fi

# Strip leading 'v' for Debian version field
DEB_VERSION="${VERSION#v}"

case "${PLATFORM}" in
    linux-x86_64)  DEB_ARCH="amd64"   ;;
    linux-aarch64) DEB_ARCH="arm64"   ;;
    *)
        echo "Unsupported platform for .deb: ${PLATFORM}" >&2
        exit 1
        ;;
esac

PKG="sgl_${DEB_VERSION}_${DEB_ARCH}"
STAGING="${PKG}"

# Extract binary
mkdir -p "${STAGING}/usr/bin"
tar xzf "${TARBALL}" -C /tmp
cp "/tmp/sgl-${VERSION}-${PLATFORM}/sgl" "${STAGING}/usr/bin/sgl"
chmod 755 "${STAGING}/usr/bin/sgl"

# Control file
mkdir -p "${STAGING}/DEBIAN"
cat > "${STAGING}/DEBIAN/control" <<CONTROL
Package: sgl
Version: ${DEB_VERSION}
Architecture: ${DEB_ARCH}
Maintainer: Nate Codes <nate@natescode.com>
Description: The Silicon compiler
 sgl is the Silicon compiler — a WebAssembly-targeting language with a
 Roslyn-style library API. Compile Silicon source to WebAssembly (.wasm)
 or native executables via the QBE backend.
Homepage: https://github.com/natescode/sigil
CONTROL

# Build
dpkg-deb --build "${STAGING}" "${PKG}.deb"
echo "Built: ${PKG}.deb"
rm -rf "${STAGING}" "/tmp/sgl-${VERSION}-${PLATFORM}"
