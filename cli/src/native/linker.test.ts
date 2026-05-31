// SPDX-License-Identifier: MIT
/**
 * Linker module tests (story 8-8)
 *
 * Tests that don't require cc are pure-unit.
 * Tests that invoke cc/qbe are skipped gracefully when the tools are absent.
 */

import { describe, test, expect } from 'bun:test'
import { findCc, requireCc, defaultExePath, CC_INSTALL_HINT } from './linker'
import { findQbe, invokeQbe, hostQbeArch } from './backend'
import * as path from 'node:path'
import * as os   from 'node:os'
import * as fs   from 'node:fs'
import * as fsp  from 'node:fs/promises'

// ---------------------------------------------------------------------------
// CC_INSTALL_HINT
// ---------------------------------------------------------------------------

describe('CC_INSTALL_HINT', () => {
    test('mentions gcc', () => expect(CC_INSTALL_HINT).toContain('gcc'))
    test('mentions clang', () => expect(CC_INSTALL_HINT).toContain('clang'))
    test('mentions apt', () => expect(CC_INSTALL_HINT).toContain('apt'))
})

// ---------------------------------------------------------------------------
// findCc / requireCc
// ---------------------------------------------------------------------------

describe('findCc', () => {
    test('returns a string or null without throwing', () => {
        const result = findCc()
        expect(result === null || typeof result === 'string').toBe(true)
    })

    test('result is non-empty when found', () => {
        const result = findCc()
        if (result !== null) expect(result.length).toBeGreaterThan(0)
    })
})

describe('requireCc', () => {
    test('throws with install hint when cc not found', () => {
        if (findCc() === null) {
            expect(() => requireCc()).toThrow()
        }
    })

    test('returns non-empty path when cc found', () => {
        if (findCc() !== null) {
            expect(requireCc().length).toBeGreaterThan(0)
        }
    })
})

// (hasQbeMain / injectMainWrapper are pure compiler transforms — tested in
//  the compiler package at src/codegen/qbe/wrapper.test.ts.)

// ---------------------------------------------------------------------------
// defaultExePath
// ---------------------------------------------------------------------------

describe('defaultExePath', () => {
    test('strips .si extension', () => {
        const result = defaultExePath('src/main.si')
        expect(result).not.toContain('.si')
        expect(result).toContain('main')
    })

    test('adds .exe on Windows', () => {
        if (os.platform() === 'win32') {
            expect(defaultExePath('foo.si')).toBe('foo.exe')
        }
    })

    test('has no extension on Unix', () => {
        if (os.platform() !== 'win32') {
            expect(path.extname(defaultExePath('foo.si'))).toBe('')
        }
    })
})

// ---------------------------------------------------------------------------
// Integration: qbe → cc → executable  (skipped if tools absent)
// ---------------------------------------------------------------------------

describe('link — integration', () => {
    const qbeBin = findQbe()
    const ccBin  = findCc()

    test('produces a runnable executable from minimal QBE IR', async () => {
        if (!qbeBin || !ccBin) {
            console.log('  (skipped: qbe or cc not on PATH)')
            return
        }

        const { link } = await import('./linker')
        const minimalIr = [
            'export function w $main() {',
            '@start',
            '\tret 42',
            '}',
        ].join('\n')

        const tmpDir  = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgl-link-test-'))
        const asmPath = path.join(tmpDir, 'out.s')
        const exePath = path.join(tmpDir, 'out')
        try {
            const asm = invokeQbe(qbeBin, minimalIr, hostQbeArch())
            await fsp.writeFile(asmPath, asm)
            link(ccBin, asmPath, exePath)
            expect(fs.existsSync(exePath)).toBe(true)

            // Executable should exit with 42
            const { spawnSync } = await import('node:child_process')
            const run = spawnSync(exePath, [], { stdio: 'pipe' })
            expect(run.status).toBe(42)
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true })
        }
    })

    test('roundtrip: Silicon → QBE IR → asm → executable', async () => {
        if (!qbeBin || !ccBin) {
            console.log('  (skipped: qbe or cc not on PATH)')
            return
        }

        const { link } = await import('./linker')
        const { compileToQbe } = await import('@silicon/compiler/native')

        const src = '\\\\ main () -> Int\n@fn main  := 0 - 1;'   // returns -1 → exit code 255 (wraps on byte)
        const { qbeIr } = compileToQbe(src)
        const asmOut = invokeQbe(qbeBin, qbeIr, hostQbeArch())

        const tmpDir  = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgl-roundtrip-'))
        const asmPath = path.join(tmpDir, 'prog.s')
        const exePath = path.join(tmpDir, 'prog')
        try {
            await fsp.writeFile(asmPath, asmOut)
            link(ccBin, asmPath, exePath)
            expect(fs.existsSync(exePath)).toBe(true)
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true })
        }
    })
})
