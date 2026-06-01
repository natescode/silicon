#!/usr/bin/env sh
# Silicon installer — curl -fsSL https://raw.githubusercontent.com/natescode/silicon/main/scripts/install.sh | sh
#
# Downloads the latest sgl binary for the current platform and installs it to
# $SGL_INSTALL_DIR (default: ~/.sgl/bin), then adds it to PATH via the shell
# profile if not already present.
#
# Environment variables:
#   SGL_INSTALL_DIR   Override install directory   (default: ~/.sgl/bin)
#   SGL_VERSION       Pin a specific version tag    (default: latest)
#   SGL_NO_MODIFY_PATH  Set to any value to skip PATH modification
#   SGL_REPO          Override GitHub repo          (default: natescode/silicon)

set -eu

REPO="${SGL_REPO:-natescode/silicon}"
INSTALL_DIR="${SGL_INSTALL_DIR:-$HOME/.sgl/bin}"
VERSION="${SGL_VERSION:-}"

# ── Detect platform ──────────────────────────────────────────────────────────

detect_platform() {
    OS="$(uname -s)"
    ARCH="$(uname -m)"

    case "${OS}" in
        Linux)
            case "${ARCH}" in
                x86_64)  PLATFORM="linux-x86_64"  ;;
                aarch64) PLATFORM="linux-aarch64"  ;;
                arm64)   PLATFORM="linux-aarch64"  ;;
                *)
                    echo "sgl: unsupported Linux architecture: ${ARCH}" >&2
                    echo "  Supported: x86_64, aarch64" >&2
                    exit 1
                    ;;
            esac
            ;;
        Darwin)
            case "${ARCH}" in
                arm64)   PLATFORM="macos-aarch64"  ;;
                x86_64)  PLATFORM="macos-x86_64"   ;;
                *)
                    echo "sgl: unsupported macOS architecture: ${ARCH}" >&2
                    exit 1
                    ;;
            esac
            ;;
        *)
            echo "sgl: unsupported operating system: ${OS}" >&2
            echo "  Supported: Linux, macOS" >&2
            echo "  Windows: use WSL or download from https://github.com/${REPO}/releases" >&2
            exit 1
            ;;
    esac
}

# ── Resolve version ──────────────────────────────────────────────────────────

resolve_version() {
    if [ -z "${VERSION}" ]; then
        if command -v curl >/dev/null 2>&1; then
            VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
                | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
        elif command -v wget >/dev/null 2>&1; then
            VERSION="$(wget -qO- "https://api.github.com/repos/${REPO}/releases/latest" \
                | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
        else
            echo "sgl: curl or wget is required" >&2
            exit 1
        fi
    fi

    if [ -z "${VERSION}" ]; then
        echo "sgl: could not determine latest release version" >&2
        echo "  Set SGL_VERSION=v1.0.0 to pin a specific version." >&2
        exit 1
    fi
}

# ── Download ─────────────────────────────────────────────────────────────────

download() {
    TARBALL="sgl-${VERSION}-${PLATFORM}.tar.gz"
    URL="https://github.com/${REPO}/releases/download/${VERSION}/${TARBALL}"
    SHA_URL="${URL}.sha256"

    # TMP_DIR is created by main() (so its EXIT trap can clean it up — this
    # function runs in a $(...) subshell and couldn't propagate it back).
    TARBALL_PATH="${TMP_DIR}/${TARBALL}"

    # Must go to stderr: download() echoes the extracted binary path on stdout,
    # which the caller captures via `$(download)`.
    echo "  Downloading sgl ${VERSION} for ${PLATFORM}..." >&2

    if command -v curl >/dev/null 2>&1; then
        curl -fsSL --progress-bar -o "${TARBALL_PATH}" "${URL}"
        curl -fsSL -o "${TARBALL_PATH}.sha256" "${SHA_URL}" 2>/dev/null || true
    elif command -v wget >/dev/null 2>&1; then
        wget -q --show-progress -O "${TARBALL_PATH}" "${URL}"
        wget -q -O "${TARBALL_PATH}.sha256" "${SHA_URL}" 2>/dev/null || true
    fi

    # Verify checksum if the .sha256 file was downloaded successfully.
    if [ -f "${TARBALL_PATH}.sha256" ]; then
        EXPECTED="$(awk '{print $1}' "${TARBALL_PATH}.sha256")"
        if command -v sha256sum >/dev/null 2>&1; then
            ACTUAL="$(sha256sum "${TARBALL_PATH}" | awk '{print $1}')"
        elif command -v shasum >/dev/null 2>&1; then
            ACTUAL="$(shasum -a 256 "${TARBALL_PATH}" | awk '{print $1}')"
        else
            ACTUAL=""
        fi
        if [ -n "${ACTUAL}" ] && [ "${ACTUAL}" != "${EXPECTED}" ]; then
            echo "sgl: checksum mismatch — download may be corrupted" >&2
            echo "  Expected: ${EXPECTED}" >&2
            echo "  Got:      ${ACTUAL}" >&2
            rm -rf "${TMP_DIR}"
            exit 1
        fi
    fi

    tar xzf "${TARBALL_PATH}" -C "${TMP_DIR}"
    EXTRACTED_BIN="${TMP_DIR}/sgl-${VERSION}-${PLATFORM}/sgl"
    echo "${EXTRACTED_BIN}"
}

# ── Install ──────────────────────────────────────────────────────────────────

install_binary() {
    BIN_SRC="$1"
    SRC_DIR="$(dirname "${BIN_SRC}")"
    mkdir -p "${INSTALL_DIR}"
    cp "${BIN_SRC}" "${INSTALL_DIR}/sgl"
    chmod +x "${INSTALL_DIR}/sgl"
    # Keep the licenses next to the installed binary (they ship in the tarball:
    # Silicon's MIT LICENSE + the embedded Bun runtime's THIRD-PARTY-LICENSES.md).
    [ -f "${SRC_DIR}/LICENSE" ] && cp "${SRC_DIR}/LICENSE" "${INSTALL_DIR}/LICENSE"
    [ -f "${SRC_DIR}/THIRD-PARTY-LICENSES.md" ] && cp "${SRC_DIR}/THIRD-PARTY-LICENSES.md" "${INSTALL_DIR}/THIRD-PARTY-LICENSES.md"
    return 0
}

# ── PATH setup ───────────────────────────────────────────────────────────────

add_to_path() {
    case ":${PATH}:" in
        *":${INSTALL_DIR}:"*) return 0 ;;  # already on PATH
    esac

    if [ -n "${SGL_NO_MODIFY_PATH:-}" ]; then
        return 0
    fi

    LINE="export PATH=\"\$PATH:${INSTALL_DIR}\""

    for PROFILE in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
        if [ -f "${PROFILE}" ]; then
            if ! grep -qF "${INSTALL_DIR}" "${PROFILE}" 2>/dev/null; then
                printf '\n# Silicon sgl\n%s\n' "${LINE}" >> "${PROFILE}"
                echo "  Added ${INSTALL_DIR} to PATH in ${PROFILE}"
            fi
        fi
    done
}

# ── Main ─────────────────────────────────────────────────────────────────────

main() {
    echo "Silicon sgl installer"
    echo ""

    detect_platform
    resolve_version

    echo "  Version:  ${VERSION}"
    echo "  Platform: ${PLATFORM}"
    echo "  Install:  ${INSTALL_DIR}/sgl"
    echo ""

    # Create the temp dir here so the EXIT trap cleans it up regardless of how
    # we exit (download() runs in a subshell and can't own this).
    TMP_DIR="$(mktemp -d)"
    trap 'rm -rf "${TMP_DIR}"' EXIT INT TERM

    BIN_SRC="$(download)"
    install_binary "${BIN_SRC}"

    add_to_path

    echo ""
    echo "  sgl ${VERSION} installed to ${INSTALL_DIR}/sgl"

    if ! command -v sgl >/dev/null 2>&1; then
        echo ""
        echo "  Restart your shell or run:"
        echo "    export PATH=\"\$PATH:${INSTALL_DIR}\""
    fi

    echo ""
    echo "  Get started:"
    echo "    sgl init my-project"
    echo "    cd my-project && sgl run"
}

main
