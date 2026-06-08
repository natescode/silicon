// SPDX-License-Identifier: MIT
/**
 * ADR-0024 — CLI integration: a multi-module component compiles end-to-end via
 * the real `sgl` CLI (directory = module, `mod::name` cross-module calls, `@pub`
 * visibility, sibling-file auto-inclusion), and the module-edge diagnostics fire.
 */

import { test, expect, describe, afterEach } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'

const CLI = path.join(__dirname, 'sigil_cli.ts')

function runSgl(args: string[], cwd?: string): { stdout: string; stderr: string; code: number } {
    const r = spawnSync('bun', ['run', CLI, ...args], { cwd, encoding: 'utf-8' })
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? -1 }
}

const tmpDirs: string[] = []
afterEach(() => { for (const d of tmpDirs.splice(0)) try { fs.rmSync(d, { recursive: true, force: true }) } catch {} })

/** Scaffold a project from a `{ relPath: source }` map; returns the project dir. */
function project(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgl-mod-'))
    tmpDirs.push(dir)
    fs.writeFileSync(path.join(dir, 'sgl.toml'), '[package]\nname = "app"\nentry = "src/main.si"\n[dependencies]\n')
    for (const [rel, src] of Object.entries(files)) {
        const p = path.join(dir, rel)
        fs.mkdirSync(path.dirname(p), { recursive: true })
        fs.writeFileSync(p, src)
    }
    return dir
}

describe('ADR-0024 CLI — multi-module component', () => {
    test('cross-module `mod::name` call compiles and merges into one .wasm', () => {
        const dir = project({
            'src/main.si': `\\\\ @export run () -> Int\n@fn run := { math::square(5) };`,
            'src/math/ops.si':
                `\\\\ @pub square (Int) -> Int\n@fn square n := { mul(n, n) };\n` +
                `\\\\ mul (Int, Int) -> Int\n@fn mul a, b := { a * b };`,
        })
        const r = runSgl(['build', '--wat'], dir)
        expect(r.stderr + r.stdout).not.toContain('error')
        expect(r.code).toBe(0)
        const wat = fs.readFileSync(path.join(dir, 'main.wat'), 'utf-8')
        // Sub-module function got prefixed and merged in (no separate import).
        expect(wat).toContain('math__square')
        expect(wat).toContain('math__mul')
        expect(wat).toContain('(export "run"')
    })

    test('calling a private (non-@pub) member across modules is E-PRIV', () => {
        const dir = project({
            'src/main.si': `\\\\ @export run () -> Int\n@fn run := { math::mul(2, 3) };`,
            'src/math/ops.si':
                `\\\\ @pub square (Int) -> Int\n@fn square n := { mul(n, n) };\n` +
                `\\\\ mul (Int, Int) -> Int\n@fn mul a, b := { a * b };`,
        })
        const r = runSgl(['check'], dir)
        expect(r.code).not.toBe(0)
        expect(r.stderr).toContain('E-PRIV')
    })

    test('sibling files in the root module auto-include (no @use needed)', () => {
        const dir = project({
            'src/main.si': `\\\\ @export run () -> Int\n@fn run := { helper(40) };`,
            'src/util.si': `\\\\ helper (Int) -> Int\n@fn helper x := { x + 2 };`,
        })
        const r = runSgl(['check'], dir)
        expect(r.stderr).not.toContain('E-')
        expect(r.code).toBe(0)
    })

    test('a top-level statement in a sub-module is E-MOD-TOPSTMT', () => {
        const dir = project({
            'src/main.si': `\\\\ @export run () -> Int\n@fn run := { m::f(1) };`,
            'src/m/m.si': `\\\\ @pub f (Int) -> Int\n@fn f x := { x };\nf(1);`,
        })
        const r = runSgl(['check'], dir)
        expect(r.code).not.toBe(0)
        expect(r.stderr).toContain('E-MOD-TOPSTMT')
    })

    test('`sgl run` on a library component (no main) is E-NO-MAIN', () => {
        const dir = project({
            'src/main.si': `\\\\ @export add (Int, Int) -> Int\n@fn add a, b := { a + b };`,
        })
        const r = runSgl(['run'], dir)
        expect(r.code).not.toBe(0)
        expect(r.stderr).toContain('E-NO-MAIN')
    })

    test('standalone file outside a project keeps single-file behaviour (no auto-include)', () => {
        // No sgl.toml: a bare file in a dir with an unrelated sibling must NOT
        // pull the sibling in (legacy `@use`-only semantics).
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgl-bare-'))
        tmpDirs.push(dir)
        fs.writeFileSync(path.join(dir, 'a.si'), `\\\\ @export run () -> Int\n@fn run := { 7 };`)
        fs.writeFileSync(path.join(dir, 'b.si'), `this is not valid silicon @@@`)
        const r = runSgl(['build', '--wat', 'a.si'], dir)
        // b.si must not be merged (it would break the build).
        expect(r.code).toBe(0)
    })
})
