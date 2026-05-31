// SPDX-License-Identifier: MIT
/**
 * Native linker integration for sgl (story 8-8)
 *
 * Turns the assembly output of qbe into a native executable by invoking
 * a C compiler (cc / gcc / clang) which handles both assembly and linking.
 * Using cc rather than as+ld directly avoids hard-coding platform-specific
 * linker flags and startup object paths (crt0/crtbegin/etc.).
 *
 * Pipeline:
 *   QBE IR text
 *     ──[invokeQbe]──▶ .s assembly text
 *     ──[link]──▶ native ELF / Mach-O executable
 */

import { spawnSync } from 'node:child_process'
import * as os from 'node:os'

// ---------------------------------------------------------------------------
// Locate a C compiler
// ---------------------------------------------------------------------------

export const CC_INSTALL_HINT = `\
No C compiler found on PATH.

Install options:
  Fedora/RHEL:            sudo dnf install gcc
  Linux (Debian/Ubuntu):  sudo apt install gcc
  Linux (Arch):           sudo pacman -S gcc
  macOS:                  xcode-select --install   (installs clang)

A C compiler is required to link the QBE assembly into a native executable.`

/**
 * Search PATH for a usable C compiler.
 * Prefers cc (the POSIX standard name) then gcc then clang.
 */
export function findCc(): string | null {
    const candidates = ['cc', 'gcc', 'clang', 'musl-gcc']
    for (const c of candidates) {
        try {
            const r = spawnSync(c, ['--version'], { stdio: 'pipe', timeout: 3000 })
            if (r.error === undefined && (r.status === 0 || (r.stdout as Buffer)?.length > 0)) {
                return c
            }
        } catch { /* not found */ }
    }
    return null
}

/** Returns the cc binary path, or throws with install instructions. */
export function requireCc(): string {
    const bin = findCc()
    if (!bin) throw new Error(CC_INSTALL_HINT)
    return bin
}

// ---------------------------------------------------------------------------
// Assemble + link
// ---------------------------------------------------------------------------

export interface LinkOptions {
    /** Extra -L / -l flags, or raw linker arguments. */
    extraArgs?: string[]
    /** Produce a statically-linked executable.  Default: false (dynamic). */
    static?: boolean
}

/**
 * Invoke the C compiler to assemble and link a QBE-produced assembly file
 * into a native executable.
 *
 * @param ccBin     Path to the C compiler (from findCc/requireCc).
 * @param asmPath   Path to the `.s` assembly file produced by qbe.
 * @param outPath   Desired output executable path.
 * @param opts      Optional link flags.
 */
export function link(
    ccBin:   string,
    asmPath: string,
    outPath: string,
    opts:    LinkOptions = {},
): void {
    const args: string[] = [asmPath, '-o', outPath]
    if (opts.static)      args.push('-static')
    if (opts.extraArgs)   args.push(...opts.extraArgs)

    const result = spawnSync(ccBin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
    })

    if (result.error) throw new Error(`cc invocation error: ${result.error.message}`)
    if (result.status !== 0) {
        const stderr = result.stderr?.toString() ?? ''
        throw new Error(`cc exited with status ${result.status}:\n${stderr}`)
    }
}

// ---------------------------------------------------------------------------
// Native executable output path helpers
// ---------------------------------------------------------------------------

/** Default output executable path for a Silicon source file (beside the source). */
export function defaultExePath(siPath: string): string {
    const nodePath = require('node:path')
    const { dir, name } = nodePath.parse(nodePath.resolve(siPath))
    const exe = os.platform() === 'win32' ? name + '.exe' : name
    return nodePath.join(dir, exe)
}
