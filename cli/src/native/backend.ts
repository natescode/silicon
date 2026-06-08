// SPDX-License-Identifier: MIT
/**
 * QBE backend integration for sgl
 *
 * Story 8-7: locate the qbe binary (PATH → ~/.sgl/bin/qbe), invoke it on
 * QBE IR text, and return the resulting assembly.  Story 8-8 adds the
 * as/ld step that turns that assembly into a native executable.
 *
 * qbe is never bundled as a base64 blob — we locate or compile it at setup
 * time.  `ensureQbe()` drives that; `findQbe()` is the pure PATH probe.
 */

import { spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs   from 'node:fs'
import * as fsp  from 'node:fs/promises'
import * as path from 'node:path'
import * as os   from 'node:os'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default user-local install directory for sgl-managed tools. */
export const SGL_BIN_DIR = path.join(os.homedir(), '.sgl', 'bin')

/** Canonical QBE 1.2 source. Upstream (c9x.me) removed its release tarballs and
 *  its git is dumb-HTTP-only, so we pin Debian's permanently archived orig
 *  tarball, verified against the hash below. Update both together on a bump. */
const QBE_SRC_URL = 'https://deb.debian.org/debian/pool/main/q/qbe/qbe_1.2.orig.tar.xz'
const QBE_SRC_SHA256 = 'a6d50eb952525a234bf76ba151861f73b7a382ac952d985f2b9af1df5368225d'

export const QBE_INSTALL_HINT = `\
qbe not found on PATH.

Install options:
  Fedora/RHEL:            sudo dnf install qbe
  Linux (Debian/Ubuntu):  sudo apt install qbe
  Linux (Arch):           sudo pacman -S qbe
  macOS (Homebrew):       brew install qbe
  Build from source:      sgl setup   (downloads and compiles qbe into ~/.sgl/bin/)

After installing, re-run your sgl command.`

// ---------------------------------------------------------------------------
// Binary location
// ---------------------------------------------------------------------------

/**
 * Probe a single executable candidate.  Returns true if the binary exists
 * and exits successfully (any exit code is fine — qbe with no args exits 1
 * on some versions but still works).
 */
function probeCandidate(bin: string): boolean {
    try {
        const r = spawnSync(bin, ['--version'], { stdio: 'pipe', timeout: 3000 })
        // qbe --version exits 0 on some builds; others exit non-zero and write to stderr
        return r.error === undefined && (r.stdout?.length > 0 || r.stderr?.length > 0 || r.status === 0)
    } catch {
        return false
    }
}

/**
 * Search for the qbe binary in PATH and well-known install locations.
 * Returns the executable path, or null if not found.
 */
export function findQbe(): string | null {
    const candidates: string[] = [
        'qbe',
        path.join(SGL_BIN_DIR, 'qbe'),
        '/usr/bin/qbe',
        '/usr/local/bin/qbe',
        '/opt/homebrew/bin/qbe',
    ]

    for (const c of candidates) {
        if (probeCandidate(c)) return c
    }
    return null
}

/**
 * Returns the qbe binary path, or throws with install instructions.
 * Use this when qbe is required (build/run --native paths).
 */
export function requireQbe(): string {
    const bin = findQbe()
    if (!bin) throw new Error(QBE_INSTALL_HINT)
    return bin
}

// ---------------------------------------------------------------------------
// QBE invocation
// ---------------------------------------------------------------------------

/**
 * Run QBE IR text through the qbe compiler and return the resulting
 * assembly as a string.
 *
 * @param qbeBin  Path to the qbe binary (from findQbe/requireQbe).
 * @param qbeIr   Complete QBE IR text to compile.
 * @param arch    Target architecture for qbe (e.g. 'amd64_sysv', 'arm64').
 *                Defaults to the host architecture.
 */
export function invokeQbe(qbeBin: string, qbeIr: string, arch?: string): string {
    const args: string[] = arch ? ['-t', arch] : []
    const result = spawnSync(qbeBin, args, {
        input: qbeIr,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30_000,
    })

    if (result.error) throw new Error(`qbe invocation error: ${result.error.message}`)
    if (result.status !== 0) {
        throw new Error(`qbe exited with status ${result.status}:\n${result.stderr ?? ''}`)
    }
    return result.stdout ?? ''
}

// ---------------------------------------------------------------------------
// Architecture detection
// ---------------------------------------------------------------------------

/**
 * Maps Node.js process.arch to the qbe target architecture string.
 * Returns undefined to let qbe auto-detect (its default).
 */
export function hostQbeArch(): string | undefined {
    switch (process.arch) {
        case 'x64':   return 'amd64_sysv'
        case 'arm64': return 'arm64'
        default:      return undefined   // let qbe pick
    }
}

// ---------------------------------------------------------------------------
// sgl setup — download and compile qbe from source
// ---------------------------------------------------------------------------

function requireTool(name: string): void {
    const r = spawnSync(name, ['--version'], { stdio: 'pipe' })
    if (r.error) {
        throw new Error(
            `${name} is required to build QBE but was not found on PATH.\n` +
            `Install it with:\n` +
            `  Fedora/RHEL:        sudo dnf install ${name === 'make' ? 'make gcc' : name}\n` +
            `  Debian/Ubuntu:      sudo apt install ${name === 'make' ? 'build-essential' : name}\n` +
            `  Arch:               sudo pacman -S ${name === 'make' ? 'base-devel' : name}\n` +
            `  macOS:              xcode-select --install`
        )
    }
}

/**
 * Download the QBE source tarball via Bun's built-in fetch() and compile it
 * into SGL_BIN_DIR.  No external HTTP client (curl/wget) is required.
 *
 * Requires tar and make on PATH (pre-flight checked with clear errors).
 *
 * Returns the path to the installed qbe binary.
 */
export async function downloadAndBuildQbe(log: (msg: string) => void = console.log): Promise<string> {
    // Pre-flight: verify build tools before touching the network.
    requireTool('tar')
    requireTool('make')

    await fsp.mkdir(SGL_BIN_DIR, { recursive: true })

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgl-qbe-'))
    const tarPath = path.join(tmpDir, 'qbe.tar.xz')
    const outBin  = path.join(SGL_BIN_DIR, 'qbe')

    try {
        log(`Downloading QBE source from ${QBE_SRC_URL} …`)

        const resp = await fetch(QBE_SRC_URL)
        if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${QBE_SRC_URL}`)
        const buf = Buffer.from(await resp.arrayBuffer())

        // Verify the download against the pinned hash before trusting it.
        const digest = createHash('sha256').update(buf).digest('hex')
        if (digest !== QBE_SRC_SHA256) {
            throw new Error(
                `QBE source checksum mismatch:\n  expected ${QBE_SRC_SHA256}\n  got      ${digest}`)
        }
        await fsp.writeFile(tarPath, buf)

        log('Extracting …')
        // `tar xf` auto-detects xz (GNU tar ≥ 1.22 and bsdtar/macOS).
        const tarResult = spawnSync('tar', ['xf', tarPath, '-C', tmpDir], { stdio: 'pipe' })
        if (tarResult.status !== 0) {
            throw new Error(`tar failed: ${tarResult.stderr?.toString().trim()}`)
        }

        // The tarball extracts to qbe-<version>/
        const entries = fs.readdirSync(tmpDir).filter(e => e.startsWith('qbe-'))
        if (!entries.length) throw new Error('Unexpected tarball layout — no qbe-* directory found')
        const srcDir = path.join(tmpDir, entries[0])

        log(`Building QBE from source in ${srcDir} …`)
        execFileSync('make', ['-j4'], { cwd: srcDir, stdio: 'inherit' })

        const builtBin = path.join(srcDir, 'qbe')
        if (!fs.existsSync(builtBin)) throw new Error('make succeeded but qbe binary not found')

        await fsp.copyFile(builtBin, outBin)
        await fsp.chmod(outBin, 0o755)

        log(`Installed qbe → ${outBin}`)
        return outBin
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    }
}
