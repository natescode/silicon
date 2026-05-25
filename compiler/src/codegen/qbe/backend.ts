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
import * as fs   from 'node:fs'
import * as fsp  from 'node:fs/promises'
import * as path from 'node:path'
import * as os   from 'node:os'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default user-local install directory for sgl-managed tools. */
export const SGL_BIN_DIR = path.join(os.homedir(), '.sgl', 'bin')

/** QBE source tarball URL pattern — update when QBE cuts a new release. */
const QBE_SRC_URL = 'https://c9x.me/compile/release/qbe-1.2.tar.gz'

export const QBE_INSTALL_HINT = `\
qbe not found on PATH.

Install options:
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
        // qbe --version exits 0; some older builds exit non-zero but still write output
        return r.error === undefined && (r.stdout?.length > 0 || r.status === 0)
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

/**
 * Download the QBE source tarball and compile it into SGL_BIN_DIR.
 *
 * Requires:
 *   - curl or wget on PATH
 *   - A C compiler (cc) on PATH
 *   - tar on PATH
 *
 * Returns the path to the installed qbe binary.
 */
export async function downloadAndBuildQbe(log: (msg: string) => void = console.log): Promise<string> {
    await fsp.mkdir(SGL_BIN_DIR, { recursive: true })

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgl-qbe-'))
    const tarPath = path.join(tmpDir, 'qbe.tar.gz')
    const outBin  = path.join(SGL_BIN_DIR, 'qbe')

    try {
        log(`Downloading QBE source from ${QBE_SRC_URL} …`)

        // Prefer curl, fall back to wget
        const curlResult = spawnSync('curl', ['-fsSL', '-o', tarPath, QBE_SRC_URL], { stdio: 'pipe' })
        if (curlResult.status !== 0) {
            const wgetResult = spawnSync('wget', ['-q', '-O', tarPath, QBE_SRC_URL], { stdio: 'pipe' })
            if (wgetResult.status !== 0) throw new Error('Neither curl nor wget is available')
        }

        log('Extracting …')
        spawnSync('tar', ['xzf', tarPath, '-C', tmpDir], { stdio: 'inherit' })

        // The tarball extracts to qbe-<version>/
        const entries = fs.readdirSync(tmpDir).filter(e => e.startsWith('qbe-'))
        if (!entries.length) throw new Error('Unexpected tarball layout — no qbe-* directory')
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
        // Best-effort cleanup of the tmp directory
        fs.rmSync(tmpDir, { recursive: true, force: true })
    }
}
