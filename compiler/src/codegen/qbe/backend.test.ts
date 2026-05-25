/**
 * QBE backend tests (story 8-7)
 *
 * These tests exercise the pure logic of the backend module without requiring
 * qbe to be installed on the host machine.  Network-dependent tests
 * (downloadAndBuildQbe) are excluded from the default suite.
 */

import { describe, test, expect } from 'bun:test'
import { findQbe, requireQbe, invokeQbe, hostQbeArch, SGL_BIN_DIR, QBE_INSTALL_HINT } from './backend'
import * as path from 'node:path'
import * as os   from 'node:os'

// ---------------------------------------------------------------------------
// SGL_BIN_DIR
// ---------------------------------------------------------------------------

describe('SGL_BIN_DIR', () => {
    test('is inside the user home directory', () => {
        expect(SGL_BIN_DIR.startsWith(os.homedir())).toBe(true)
    })

    test('ends with bin', () => {
        expect(path.basename(SGL_BIN_DIR)).toBe('bin')
    })
})

// ---------------------------------------------------------------------------
// hostQbeArch
// ---------------------------------------------------------------------------

describe('hostQbeArch', () => {
    test('returns a string or undefined (never throws)', () => {
        const result = hostQbeArch()
        expect(result === undefined || typeof result === 'string').toBe(true)
    })

    test('x64 maps to amd64_sysv on x86-64 hosts', () => {
        if (process.arch === 'x64') {
            expect(hostQbeArch()).toBe('amd64_sysv')
        }
    })

    test('arm64 maps to arm64 on ARM hosts', () => {
        if (process.arch === 'arm64') {
            expect(hostQbeArch()).toBe('arm64')
        }
    })
})

// ---------------------------------------------------------------------------
// QBE_INSTALL_HINT
// ---------------------------------------------------------------------------

describe('QBE_INSTALL_HINT', () => {
    test('mentions brew for macOS', () => {
        expect(QBE_INSTALL_HINT).toContain('brew')
    })

    test('mentions apt for Linux', () => {
        expect(QBE_INSTALL_HINT).toContain('apt')
    })

    test('mentions sgl setup command', () => {
        expect(QBE_INSTALL_HINT).toContain('sgl setup')
    })
})

// ---------------------------------------------------------------------------
// findQbe / requireQbe
// ---------------------------------------------------------------------------

describe('findQbe', () => {
    test('returns a string or null (never throws)', () => {
        const result = findQbe()
        expect(result === null || typeof result === 'string').toBe(true)
    })

    test('if found, result is a non-empty string', () => {
        const result = findQbe()
        if (result !== null) {
            expect(result.length).toBeGreaterThan(0)
        }
    })
})

describe('requireQbe', () => {
    test('throws with install hint when qbe is not found', () => {
        const found = findQbe()
        if (found === null) {
            expect(() => requireQbe()).toThrow()
        }
    })

    test('returns a non-empty string when qbe is found', () => {
        const found = findQbe()
        if (found !== null) {
            const result = requireQbe()
            expect(typeof result).toBe('string')
            expect(result.length).toBeGreaterThan(0)
        }
    })
})

// ---------------------------------------------------------------------------
// invokeQbe — integration test (skipped if qbe not installed)
// ---------------------------------------------------------------------------

describe('invokeQbe', () => {
    const qbeBin = findQbe()

    test('produces assembly from minimal QBE IR', () => {
        if (!qbeBin) {
            // qbe not installed — skip gracefully
            console.log('  (skipped: qbe not on PATH)')
            return
        }
        const minimalIr = [
            'function w $main() {',
            '@start',
            '\tret 42',
            '}',
        ].join('\n')

        const asm = invokeQbe(qbeBin, minimalIr)
        expect(typeof asm).toBe('string')
        expect(asm.length).toBeGreaterThan(0)
    })

    test('throws on invalid QBE IR', () => {
        if (!qbeBin) {
            console.log('  (skipped: qbe not on PATH)')
            return
        }
        expect(() => invokeQbe(qbeBin, 'this is not valid QBE IR')).toThrow()
    })

    test('roundtrip: lowerToQbe → invokeQbe produces assembly', () => {
        if (!qbeBin) {
            console.log('  (skipped: qbe not on PATH)')
            return
        }
        // Import lazily to avoid circular module loading issues
        const { compileToTyped } = require('../../../tests/properties/_compile')
        const { lowerToQbe }    = require('./lower')

        const { typedAST, registry, functions } = compileToTyped(
            '@fn add:Int x:Int, y:Int := x + y;'
        )
        const qbeIr = lowerToQbe(typedAST, registry, functions)
        const asm   = invokeQbe(qbeBin, qbeIr, hostQbeArch())

        expect(asm).toContain('add')   // the function body has an add instruction
    })
})
