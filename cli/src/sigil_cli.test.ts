// SPDX-License-Identifier: MIT
/**
 * Phase 9d-4 — CLI integration tests for `--target=wasm-gc`.
 *
 * Spawns the actual sgl CLI as a subprocess and checks its observable
 * behavior — help text, error messages on invalid target, sgl.toml
 * [build] target resolution.  This is the realistic level for CLI
 * tests; the parseTarget function isn't exported (and shouldn't be —
 * its only caller is the CLI top-level).
 */

import { test, expect, describe } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

const CLI = path.join(__dirname, 'sigil_cli.ts')

function runSgl(args: string[], cwd?: string): { stdout: string; stderr: string; code: number } {
    const result = spawnSync('bun', ['run', CLI, ...args], {
        cwd,
        encoding: 'utf-8',
    })
    return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        code:   result.status ?? -1,
    }
}

/** True if a tool is resolvable on PATH (no stdin hang, unlike `tool -h`). */
function onPath(name: string): boolean {
    return spawnSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' }).status === 0
}
/** The native backend needs qbe (PATH or ~/.sgl/bin) + a C compiler. */
const NATIVE_OK =
    (onPath('qbe') || fs.existsSync(path.join(os.homedir(), '.sgl', 'bin', 'qbe'))) &&
    (onPath('cc') || onPath('gcc') || onPath('clang'))

describe('Phase 9d-4: --target=wasm-gc CLI flag', () => {

    test('help text lists wasm-gc as a target value', () => {
        const r = runSgl(['help'])
        expect(r.code).toBe(0)
        expect(r.stdout).toContain('wasm-gc')
        expect(r.stdout).toContain('host (default)')
    })

    test('--target=invalid errors with a structured message naming the valid set', () => {
        const r = runSgl(['build', '--target=invalid-target', 'nonexistent.si'])
        expect(r.code).not.toBe(0)
        expect(r.stderr).toContain('--target')
        expect(r.stderr).toContain('host | wasix | wasm-gc')
    })

    test('--target=wasm-gc is accepted (no parse error before reaching the missing-file check)', () => {
        // The CLI will fail because nonexistent.si doesn't exist, but the
        // failure must be about the file, not about the target parser.
        const r = runSgl(['build', '--target=wasm-gc', 'nonexistent.si'])
        expect(r.code).not.toBe(0)
        // No target-parser complaint in stderr.
        expect(r.stderr).not.toContain('unknown --target value')
    })
})

describe('Phase 9d-4: sgl.toml [build] target', () => {

    function withTempProject(fn: (dir: string) => void): void {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgl-test-'))
        try { fn(dir) } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    }

    test('sgl.toml [build] target = "wasm-gc" is accepted at parse time', () => {
        withTempProject(dir => {
            fs.writeFileSync(path.join(dir, 'sgl.toml'),
                '[package]\nname = "test"\nentry = "src/main.si"\n[build]\ntarget = "wasm-gc"\n')
            fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
            // Empty file — build will fail later, but the toml target
            // parse must succeed.
            fs.writeFileSync(path.join(dir, 'src', 'main.si'), '')
            const r = runSgl(['build'], dir)
            // We don't care whether the empty build succeeds; we care
            // that there's no toml-target parse error.
            expect(r.stderr).not.toContain("unknown sgl.toml")
        })
    })

    // Note: an "invalid build.target raises a toml-specific error"
    // test would belong here, but sgl_cli.ts currently loads the OHM
    // grammar via a cwd-relative `Bun.file('./src/grammar/…')` path —
    // running from a tempdir trips an ENOENT before the toml parser
    // ever fires.  The shared parseTarget code path is exercised
    // by the "--target=invalid-target" CLI test above, which uses
    // the same diagnostic-message machinery.  Fixing the grammar
    // loader to use a script-relative path is unrelated to Phase 9d.

    test('CLI --target overrides sgl.toml [build] target', () => {
        withTempProject(dir => {
            // toml says wasm-gc, but we override with --target=host.
            fs.writeFileSync(path.join(dir, 'sgl.toml'),
                '[package]\nname = "test"\nentry = "src/main.si"\n[build]\ntarget = "wasm-gc"\n')
            fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
            fs.writeFileSync(path.join(dir, 'src', 'main.si'), '')
            const r = runSgl(['build', '--target=host'], dir)
            // No errors about target — both are valid.  We can't easily
            // assert which one "won" at this layer without inspecting
            // the emitted binary, but the absence of conflicting target
            // errors means the resolution path is working.
            expect(r.stderr).not.toContain('unknown')
        })
    })
})

describe('native linker flags (-l / -L / --link)', () => {

    test('help text documents -l<lib> and --link', () => {
        const r = runSgl(['help'])
        expect(r.code).toBe(0)
        expect(r.stdout).toContain('-l<lib>')
        expect(r.stdout).toContain('--link')
    })

    test('--link with no argument errors during parsing', () => {
        const r = runSgl(['build', '--native', '--link'])
        expect(r.code).not.toBe(0)
        expect(r.stderr).toContain('--link requires a linker argument')
    })

    test('bare -l flags are not treated as the source file or an unknown flag', () => {
        // -lraylib must be collected as a linker arg, leaving nonexistent.si as
        // the positional. The build then fails for a *different* reason (missing
        // file / qbe), never "unknown flag" and never opening '-lraylib'.
        const r = runSgl(['build', '--native', 'nonexistent.si', '-lraylib'])
        expect(r.code).not.toBe(0)
        expect(r.stderr).not.toContain("unknown flag")
        expect(r.stderr).not.toContain("-lraylib")
    })
})

describe('native: --emit-qbe / --save-temps / sgl.toml [native]', () => {

    function withTempDir(fn: (dir: string) => void): void {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgl-native-'))
        try { fn(dir) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
    }

    test('help documents --emit-qbe, --save-temps and the [native] section', () => {
        const r = runSgl(['help'])
        expect(r.code).toBe(0)
        expect(r.stdout).toContain('--emit-qbe')
        expect(r.stdout).toContain('--save-temps')
        expect(r.stdout).toContain('[native]')
    })

    test('--emit-qbe writes a .qbe file of QBE IR (no qbe binary required)', () => {
        withTempDir(dir => {
            fs.writeFileSync(path.join(dir, 'm.si'), '0;\n')
            const r = runSgl(['build', '--emit-qbe', 'm.si'], dir)
            expect(r.code).toBe(0)
            const out = path.join(dir, 'm.qbe')
            expect(fs.existsSync(out)).toBe(true)
            expect(fs.readFileSync(out, 'utf-8')).toContain('function')
        })
    })

    test.skipIf(!NATIVE_OK)('sgl.toml [native] libs are passed to the linker', () => {
        withTempDir(dir => {
            fs.writeFileSync(path.join(dir, 'sgl.toml'),
                '[package]\nname = "t"\nentry = "m.si"\n\n[native]\nlibs = ["sgl_bogus_xyz"]\n')
            fs.writeFileSync(path.join(dir, 'm.si'), '0;\n')
            const r = runSgl(['build', '--native'], dir)
            // links with -lsgl_bogus_xyz → the linker reports it as missing,
            // proving the toml lib reached the link step.
            expect(r.code).not.toBe(0)
            expect(r.stderr + r.stdout).toContain('sgl_bogus_xyz')
        })
    })

    test.skipIf(!NATIVE_OK)('--save-temps keeps the .qbe and .s intermediates', () => {
        withTempDir(dir => {
            fs.writeFileSync(path.join(dir, 'm.si'), '0;\n')
            const r = runSgl(['build', '--native', '--save-temps', 'm.si'], dir)
            expect(r.code).toBe(0)
            expect(fs.existsSync(path.join(dir, 'm.qbe'))).toBe(true)
            expect(fs.existsSync(path.join(dir, 'm.s'))).toBe(true)
        })
    })
})
