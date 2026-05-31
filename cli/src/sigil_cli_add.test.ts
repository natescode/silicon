// SPDX-License-Identifier: MIT
/**
 * Story 6b-11 — `sgl add <name> --path <local>` integration tests.
 *
 * We shell out to bun run src/sigil_cli.ts because the cmdAdd function
 * is not exported (the CLI is a process-entry module).  The pre-existing
 * cwd-relative grammar load constrains us to running from the repo root,
 * so each test runs with cwd=repo and addresses a scratch dir by
 * absolute path.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const REPO = join(import.meta.dirname, '..')
const CLI  = join(REPO, 'src', 'sigil_cli.ts')

function runSgl(args: string[], cwd: string): { code: number, stdout: string, stderr: string } {
    const r = spawnSync('bun', ['run', CLI, ...args], {
        cwd: REPO,   // grammar load is cwd-relative; stay in repo root
        env: { ...process.env, SGL_OVERRIDE_CWD: cwd },
        encoding: 'utf-8',
    })
    return { code: r.status ?? 0, stdout: r.stdout || '', stderr: r.stderr || '' }
}

describe('sgl add (story 6b-11) — local-path dependencies', () => {
    let scratch: string
    let helperDir: string

    beforeEach(() => {
        scratch = mkdtempSync(join(tmpdir(), 'sgl-add-'))
        helperDir = mkdtempSync(join(tmpdir(), 'sgl-helper-'))
        // Plant a minimal sgl.toml in the scratch project.
        writeFileSync(join(scratch, 'sgl.toml'),
            '[package]\nname = "scratch"\nversion = "0.0.1"\nentry = "src/main.si"\n\n[dependencies]\n',
            'utf-8')
        mkdirSync(join(scratch, 'src'), { recursive: true })
        writeFileSync(join(scratch, 'src', 'main.si'), '@fn main  := 0; @export main;\n', 'utf-8')
        // Plant a helper "project" the dep will point at.
        mkdirSync(join(helperDir, 'src'), { recursive: true })
        writeFileSync(join(helperDir, 'src', 'main.si'), '@fn helper  := 42; @export helper;\n', 'utf-8')
    })

    afterEach(() => {
        try { rmSync(scratch, { recursive: true, force: true }) } catch {}
        try { rmSync(helperDir, { recursive: true, force: true }) } catch {}
    })

    test('refuses without a name', () => {
        // Use a child process whose cwd is the scratch dir for the add call.
        const r = spawnSync('bun', ['run', CLI, 'add'], { cwd: REPO, encoding: 'utf-8' })
        expect(r.status).not.toBe(0)
        expect(r.stderr).toContain('package name required')
    })

    test('refuses registry-backed add with a pointer to --path', () => {
        const r = spawnSync('bun', ['run', CLI, 'add', 'somepkg'], { cwd: REPO, encoding: 'utf-8' })
        expect(r.status).not.toBe(0)
        expect(r.stderr).toContain('registry-backed packages are not yet available')
        expect(r.stderr).toContain('--path')
    })

    test('--path on a missing directory errors clean', () => {
        const r = spawnSync('bun', ['run', CLI, 'add', 'x', '--path', '/nonexistent-xyzzy'], {
            cwd: scratch, encoding: 'utf-8',
        })
        expect(r.status).not.toBe(0)
        expect(r.stderr).toMatch(/does not exist/)
    })

    test('--path adds a dependency and writes sgl.toml', () => {
        const r = spawnSync('bun', ['run', CLI, 'add', 'helper', '--path', helperDir], {
            cwd: scratch, encoding: 'utf-8',
        })
        expect(r.status).toBe(0)
        expect(r.stdout).toMatch(/added helper/)
        const toml = readFileSync(join(scratch, 'sgl.toml'), 'utf-8')
        expect(toml).toMatch(/^helper = "path:/m)
    })

    test('second --path on the same name updates the entry rather than duplicating', () => {
        spawnSync('bun', ['run', CLI, 'add', 'helper', '--path', helperDir], { cwd: scratch, encoding: 'utf-8' })
        const r = spawnSync('bun', ['run', CLI, 'add', 'helper', '--path', helperDir], { cwd: scratch, encoding: 'utf-8' })
        expect(r.status).toBe(0)
        expect(r.stdout).toMatch(/updated helper/)
        const toml = readFileSync(join(scratch, 'sgl.toml'), 'utf-8')
        const matches = toml.match(/^helper = /gm) ?? []
        expect(matches.length).toBe(1)
    })

    test('without an existing [dependencies] section, one is appended', () => {
        writeFileSync(join(scratch, 'sgl.toml'),
            '[package]\nname = "scratch"\nversion = "0.0.1"\nentry = "src/main.si"\n',
            'utf-8')
        const r = spawnSync('bun', ['run', CLI, 'add', 'helper', '--path', helperDir], {
            cwd: scratch, encoding: 'utf-8',
        })
        expect(r.status).toBe(0)
        const toml = readFileSync(join(scratch, 'sgl.toml'), 'utf-8')
        expect(toml).toMatch(/\[dependencies\][\s\S]*helper = "path:/)
    })

    test('refuses when no sgl.toml is present', () => {
        const noToml = mkdtempSync(join(tmpdir(), 'sgl-add-empty-'))
        try {
            const r = spawnSync('bun', ['run', CLI, 'add', 'helper', '--path', helperDir], {
                cwd: noToml, encoding: 'utf-8',
            })
            expect(r.status).not.toBe(0)
            expect(r.stderr).toContain('no sgl.toml')
        } finally {
            rmSync(noToml, { recursive: true, force: true })
        }
    })
})

describe('sgl resolve (story 6b-13) — sgl.lock stub generator', () => {
    let scratch: string
    let helperDir: string

    beforeEach(() => {
        scratch = mkdtempSync(join(tmpdir(), 'sgl-resolve-'))
        helperDir = mkdtempSync(join(tmpdir(), 'sgl-resolve-helper-'))
        writeFileSync(join(scratch, 'sgl.toml'),
            '[package]\nname = "scratch"\nversion = "0.1.0"\nentry = "src/main.si"\n\n[dependencies]\n',
            'utf-8')
    })

    afterEach(() => {
        try { rmSync(scratch, { recursive: true, force: true }) } catch {}
        try { rmSync(helperDir, { recursive: true, force: true }) } catch {}
    })

    test('writes a version=1 lockfile with the root package', () => {
        const r = spawnSync('bun', ['run', CLI, 'resolve'], { cwd: scratch, encoding: 'utf-8' })
        expect(r.status).toBe(0)
        const lock = readFileSync(join(scratch, 'sgl.lock'), 'utf-8')
        expect(lock).toMatch(/^version = 1$/m)
        expect(lock).toMatch(/^name = "scratch"$/m)
        expect(lock).toMatch(/^version = "0.1.0"$/m)
        // No dependency entries beyond the root.
        const packageMatches = lock.match(/^\[\[package\]\]$/gm) ?? []
        expect(packageMatches.length).toBe(1)
    })

    test('records path: dependencies under their own [[package]] entries', () => {
        spawnSync('bun', ['run', CLI, 'add', 'helper', '--path', helperDir], { cwd: scratch, encoding: 'utf-8' })
        const r = spawnSync('bun', ['run', CLI, 'resolve'], { cwd: scratch, encoding: 'utf-8' })
        expect(r.status).toBe(0)
        const lock = readFileSync(join(scratch, 'sgl.lock'), 'utf-8')
        expect(lock).toMatch(/name = "helper"/)
        expect(lock).toMatch(/source = "path:/)
        expect(lock).toMatch(/dependencies = \["helper"\]/)
    })

    test('refuses when no sgl.toml is present', () => {
        const noToml = mkdtempSync(join(tmpdir(), 'sgl-resolve-empty-'))
        try {
            const r = spawnSync('bun', ['run', CLI, 'resolve'], { cwd: noToml, encoding: 'utf-8' })
            expect(r.status).not.toBe(0)
            expect(r.stderr).toContain('no sgl.toml')
        } finally {
            rmSync(noToml, { recursive: true, force: true })
        }
    })
})
