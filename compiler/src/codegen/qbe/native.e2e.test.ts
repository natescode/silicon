// SPDX-License-Identifier: MIT
/**
 * Native backend end-to-end tests (story 8-9)
 *
 * Full pipeline: Silicon source → QBE IR → assembly → native executable.
 * All tests skip gracefully when qbe or cc is not on PATH.
 *
 * On Linux x86-64 CI: `sudo apt-get install -y qbe` makes qbe available
 * and cc is present by default, so the full suite runs.
 */

import { describe, test, expect } from 'bun:test'
import * as path from 'node:path'
import * as os   from 'node:os'
import * as fs   from 'node:fs'
import * as fsp  from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

import { findQbe, invokeQbe, hostQbeArch } from './backend'
import { findCc, link, injectMainWrapper }  from './linker'
import { lowerToQbe }                       from './lower'
import { compileToTyped }                   from '../../../tests/properties/_compile'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const qbeBin = findQbe()
const ccBin  = findCc()
const SKIP   = !qbeBin || !ccBin

function skip(msg = '(skipped: qbe or cc not on PATH)') {
    console.log('  ' + msg)
}

/** Compile Silicon source all the way to a native executable in tmpDir. */
async function compileNative(src: string, tmpDir: string, name = 'prog'): Promise<string> {
    const { typedAST, registry, functions } = compileToTyped(src)
    const qbeIr  = injectMainWrapper(lowerToQbe(typedAST, registry, functions))
    const asmOut = invokeQbe(qbeBin!, qbeIr, hostQbeArch())
    const asmPath = path.join(tmpDir, `${name}.s`)
    const exePath = path.join(tmpDir, name)
    await fsp.writeFile(asmPath, asmOut)
    link(ccBin!, asmPath, exePath)
    return exePath
}

/** Run an executable and return its exit code. */
function runExe(exePath: string): number {
    const r = spawnSync(exePath, [], { stdio: 'pipe' })
    return r.status ?? -1
}

/** Run an executable and return its stdout as a string. */
function runExeOutput(exePath: string): string {
    const r = spawnSync(exePath, [], { stdio: 'pipe' })
    return (r.stdout as Buffer).toString()
}

// ---------------------------------------------------------------------------
// Availability guard
// ---------------------------------------------------------------------------

describe('native backend availability', () => {
    test('qbe binary found or gracefully absent', () => {
        expect(qbeBin === null || typeof qbeBin === 'string').toBe(true)
    })
    test('cc binary found or gracefully absent', () => {
        expect(ccBin === null || typeof ccBin === 'string').toBe(true)
    })
})

// ---------------------------------------------------------------------------
// Arithmetic programs
// ---------------------------------------------------------------------------

describe('native — arithmetic', () => {
    test('exit code from constant return', async () => {
        if (SKIP) { skip(); return }
        const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgl-e2e-'))
        try {
            const exe = await compileNative('@fn main:Int := 42;', tmpDir)
            expect(runExe(exe)).toBe(42)
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }) }
    })

    test('addition result as exit code', async () => {
        if (SKIP) { skip(); return }
        const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgl-e2e-'))
        try {
            const exe = await compileNative('@fn main:Int := 20 + 22;', tmpDir)
            expect(runExe(exe)).toBe(42)
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }) }
    })

    test('subtraction result as exit code', async () => {
        if (SKIP) { skip(); return }
        const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgl-e2e-'))
        try {
            const exe = await compileNative('@fn main:Int := 50 - 8;', tmpDir)
            expect(runExe(exe)).toBe(42)
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }) }
    })

    test('multiplication result as exit code', async () => {
        if (SKIP) { skip(); return }
        const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgl-e2e-'))
        try {
            const exe = await compileNative('@fn main:Int := 6 * 7;', tmpDir)
            expect(runExe(exe)).toBe(42)
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }) }
    })

    test('zero exit code', async () => {
        if (SKIP) { skip(); return }
        const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgl-e2e-'))
        try {
            const exe = await compileNative('@fn main:Int := 0;', tmpDir)
            expect(runExe(exe)).toBe(0)
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }) }
    })
})

// ---------------------------------------------------------------------------
// Control flow programs
// ---------------------------------------------------------------------------

describe('native — control flow', () => {
    test('@if true branch', async () => {
        if (SKIP) { skip(); return }
        const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgl-e2e-'))
        try {
            const src = '@fn main:Int := &@if @true, { 10 }, { 20 };'
            const exe = await compileNative(src, tmpDir)
            expect(runExe(exe)).toBe(10)
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }) }
    })

    test('@if false branch', async () => {
        if (SKIP) { skip(); return }
        const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgl-e2e-'))
        try {
            const src = '@fn main:Int := &@if @false, { 10 }, { 20 };'
            const exe = await compileNative(src, tmpDir)
            expect(runExe(exe)).toBe(20)
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }) }
    })

    test('@if with comparison', async () => {
        if (SKIP) { skip(); return }
        const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgl-e2e-'))
        try {
            const src = '@fn main:Int := &@if 3 > 2, { 42 }, { 0 };'
            const exe = await compileNative(src, tmpDir)
            expect(runExe(exe)).toBe(42)
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }) }
    })
})

// ---------------------------------------------------------------------------
// Function call programs
// ---------------------------------------------------------------------------

describe('native — function calls', () => {
    test('call a helper function', async () => {
        if (SKIP) { skip(); return }
        const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgl-e2e-'))
        try {
            const src = [
                '@fn answer:Int := 42;',
                '@fn main:Int := (&answer);',
            ].join('\n')
            const exe = await compileNative(src, tmpDir)
            expect(runExe(exe)).toBe(42)
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }) }
    })

    test('call with argument', async () => {
        if (SKIP) { skip(); return }
        const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgl-e2e-'))
        try {
            const src = [
                '@fn double:Int x:Int := x * 2;',
                '@fn main:Int := (&double 21);',
            ].join('\n')
            const exe = await compileNative(src, tmpDir)
            expect(runExe(exe)).toBe(42)
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }) }
    })

    test('recursive function', async () => {
        if (SKIP) { skip(); return }
        const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgl-e2e-'))
        try {
            // fib(7) = 13, fib(8) = 21, fib(9) = 34
            const src = [
                '@fn fib:Int n:Int := &@if n <= 1, { n }, { (&fib n - 1) + (&fib n - 2) };',
                '@fn main:Int := (&fib 9);',
            ].join('\n')
            const exe = await compileNative(src, tmpDir)
            expect(runExe(exe)).toBe(34)
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }) }
    })
})

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

describe('native — variables', () => {
    test('@local variable read', async () => {
        if (SKIP) { skip(); return }
        const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgl-e2e-'))
        try {
            const src = [
                '@fn main:Int := {',
                '  @local x:Int := 42;',
                '  x',
                '};',
            ].join('\n')
            const exe = await compileNative(src, tmpDir)
            expect(runExe(exe)).toBe(42)
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }) }
    })

    test('@local variable mutation', async () => {
        if (SKIP) { skip(); return }
        const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgl-e2e-'))
        try {
            const src = [
                '@fn main:Int := {',
                '  @local x:Int := 0;',
                '  x = x + 42;',
                '  x',
                '};',
            ].join('\n')
            const exe = await compileNative(src, tmpDir)
            expect(runExe(exe)).toBe(42)
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }) }
    })
})

// ---------------------------------------------------------------------------
// Platform metadata
// ---------------------------------------------------------------------------

describe('native — platform', () => {
    test('hostQbeArch returns expected value on x86-64 Linux', () => {
        if (os.platform() !== 'linux' || os.arch() !== 'x64') {
            console.log('  (skipped: not Linux x86-64)')
            return
        }
        expect(hostQbeArch()).toBe('amd64_sysv')
    })

    test('hostQbeArch returns expected value on ARM64 Linux', () => {
        if (os.platform() !== 'linux' || os.arch() !== 'arm64') {
            console.log('  (skipped: not Linux ARM64)')
            return
        }
        expect(hostQbeArch()).toBe('arm64')
    })

    test('hostQbeArch returns expected value on macOS ARM64', () => {
        if (os.platform() !== 'darwin' || os.arch() !== 'arm64') {
            console.log('  (skipped: not macOS ARM64)')
            return
        }
        expect(hostQbeArch()).toBe('arm64')
    })

    test('hostQbeArch returns expected value on macOS x86-64', () => {
        if (os.platform() !== 'darwin' || os.arch() !== 'x64') {
            console.log('  (skipped: not macOS x86-64)')
            return
        }
        expect(hostQbeArch()).toBe('amd64_sysv')
    })

    test('QBE IR contains expected type for Int return', () => {
        if (SKIP) { skip(); return }
        const { typedAST, registry, functions } = compileToTyped('@fn main:Int := 42;')
        const ir = lowerToQbe(typedAST, registry, functions)
        expect(ir).toContain('function w $main()')
        expect(ir).toContain('ret')
    })

    test('assembled output is non-empty ELF on Linux', async () => {
        if (SKIP) { skip(); return }
        if (os.platform() !== 'linux') { skip('(skipped: not Linux)'); return }

        const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgl-e2e-'))
        try {
            const exe = await compileNative('@fn main:Int := 0;', tmpDir)
            const bytes = await fsp.readFile(exe)
            // ELF magic: 0x7f 'E' 'L' 'F'
            expect(bytes[0]).toBe(0x7f)
            expect(bytes[1]).toBe(0x45)  // 'E'
            expect(bytes[2]).toBe(0x4c)  // 'L'
            expect(bytes[3]).toBe(0x46)  // 'F'
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }) }
    })

    test('assembled output is Mach-O on macOS', async () => {
        if (SKIP) { skip(); return }
        if (os.platform() !== 'darwin') { skip('(skipped: not macOS)'); return }

        const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgl-e2e-'))
        try {
            const exe = await compileNative('@fn main:Int := 0;', tmpDir)
            const bytes = await fsp.readFile(exe)
            // 64-bit Mach-O little-endian magic: 0xCF 0xFA 0xED 0xFE
            expect(bytes[0]).toBe(0xcf)
            expect(bytes[1]).toBe(0xfa)
            expect(bytes[2]).toBe(0xed)
            expect(bytes[3]).toBe(0xfe)
        } finally { fs.rmSync(tmpDir, { recursive: true, force: true }) }
    })
})
