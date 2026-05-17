/**
 * Phase 0 WASIX smoke test — bootstrap-plan §Phase 0.
 *
 * Compiles each .si entry with --target=wasix, assembles the WAT to WASM
 * via wabt, runs the resulting module under wasmer, and asserts:
 *
 *   - boot/main.si echoes stdin → stdout byte-for-byte (the file-echo
 *     gate, adapted to use stdin rather than argv-based path_open because
 *     WASI path_open needs i64 rights args and Silicon-Core is i32/f32).
 *   - boot/tests/arena_test.si prints "arena OK" — alloc / alloc / reset
 *     / alloc lands at the original address.
 *   - boot/tests/vec_test.si prints "vec OK" — push 10 items, grow twice,
 *     read back, sum equals 45.
 *
 * Wasmer is required; the test skips with a clear message when it's not
 * on PATH so the rest of the suite stays green on machines without it.
 */

import { test, expect, describe } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import parse from '../src/parser'
import { addToAstSemantics, type Program } from '../src/ast'
import { compileToWat } from '../src/codegen'
import { watToWasm } from '../src/codegen/toWasm'
import { elaborate, buildStrataRegistry } from '../src/elaborator'
import { typecheck, formatTypeError } from '../src/types'
import { siliconGrammar } from '../src/grammar'
import { loadModules } from '../src/modules'
import { resolveUses } from '../src/modules/useResolver'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..')

function wasmerAvailable(): boolean {
    const probe = spawnSync('wasmer', ['--version'], { encoding: 'utf-8' })
    return probe.status === 0
}

async function buildBoot(entryPath: string): Promise<Uint8Array> {
    const entryAbs = path.resolve(entryPath)
    const raw = await fs.readFile(entryAbs, 'utf-8')
    const { source } = resolveUses(raw, entryAbs)

    const match = parse(source)
    const ast = addToAstSemantics(siliconGrammar)(match).toAst() as Program
    const moduleRegistry = loadModules(PROJECT_ROOT)
    const registry = buildStrataRegistry(ast)
    const { program: elab, errors: elabErrors } = elaborate(ast, registry)
    expect(elabErrors).toEqual([])
    const { program: typed, errors: typeErrors, functions } =
        typecheck(elab, registry, moduleRegistry)
    if (typeErrors.length > 0) {
        throw new Error('type: ' + typeErrors.map(formatTypeError).join('; '))
    }
    const wat = compileToWat(typed, registry, functions, moduleRegistry, { target: 'wasix' })
    return await watToWasm(wat)
}

describe('Phase 0 WASIX smoke test', () => {
    test('boot/main.si compiles to WASIX module with required structure', async () => {
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'main.si'))
        expect(wasm.byteLength).toBeGreaterThan(0)

        // Re-parse the WAT to validate the imports / exports the gate requires.
        const entryAbs = path.resolve(path.join(PROJECT_ROOT, 'boot', 'main.si'))
        const raw = await fs.readFile(entryAbs, 'utf-8')
        const { source } = resolveUses(raw, entryAbs)
        const match = parse(source)
        const ast = addToAstSemantics(siliconGrammar)(match).toAst() as Program
        const moduleRegistry = loadModules(PROJECT_ROOT)
        const registry = buildStrataRegistry(ast)
        const { program: elab } = elaborate(ast, registry)
        const { program: typed, functions } = typecheck(elab, registry, moduleRegistry)
        const wat = compileToWat(typed, registry, functions, moduleRegistry, { target: 'wasix' })

        // _start is exported (WASIX runner entry point).
        expect(wat).toContain('(export "_start" (func $__start))')
        // env::print/read are stripped under target=wasix.
        expect(wat).not.toContain('(import "env" "print"')
        expect(wat).not.toContain('(import "env" "read"')
        // The WASI imports we declared are present.
        expect(wat).toContain('(import "wasi_snapshot_preview1" "fd_write"')
        expect(wat).toContain('(import "wasi_snapshot_preview1" "proc_exit"')
    })

    test('boot/main.si echoes stdin → stdout byte-for-byte', async () => {
        if (!wasmerAvailable()) {
            console.log('  (skipped: wasmer not on PATH)')
            return
        }

        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'main.si'))
        const tmpPath = path.join(PROJECT_ROOT, '.boot-smoke.wasm')
        await fs.writeFile(tmpPath, wasm)

        try {
            // Use README.md as the input — large enough to span multiple
            // 4KB chunks, mixed content, deterministic on disk.
            const input = await fs.readFile(path.join(PROJECT_ROOT, 'README.md'))
            const result = spawnSync('wasmer', ['run', tmpPath], {
                input,
                encoding: 'buffer',
                maxBuffer: 64 * 1024 * 1024,
            })
            expect(result.status).toBe(0)
            const stdout = (result.stdout ?? Buffer.alloc(0)) as Buffer
            expect(stdout.equals(input)).toBe(true)
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/arena_test.si: alloc/alloc/reset/alloc returns same addr', async () => {
        if (!wasmerAvailable()) {
            console.log('  (skipped: wasmer not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'arena_test.si'))
        const tmpPath = path.join(PROJECT_ROOT, '.arena-smoke.wasm')
        await fs.writeFile(tmpPath, wasm)
        try {
            const result = spawnSync('wasmer', ['run', tmpPath], { encoding: 'buffer' })
            expect(result.status).toBe(0)
            expect(result.stdout?.toString('utf-8')).toBe('arena OK\n')
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/vec_test.si: push 10, grow twice, sum is 45', async () => {
        if (!wasmerAvailable()) {
            console.log('  (skipped: wasmer not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'vec_test.si'))
        const tmpPath = path.join(PROJECT_ROOT, '.vec-smoke.wasm')
        await fs.writeFile(tmpPath, wasm)
        try {
            const result = spawnSync('wasmer', ['run', tmpPath], { encoding: 'buffer' })
            expect(result.status).toBe(0)
            expect(result.stdout?.toString('utf-8')).toBe('vec OK\n')
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/lex_test.si: lexer produces expected token streams', async () => {
        if (!wasmerAvailable()) {
            console.log('  (skipped: wasmer not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'lex_test.si'))
        const tmpPath = path.join(PROJECT_ROOT, '.lex-smoke.wasm')
        await fs.writeFile(tmpPath, wasm)
        try {
            const result = spawnSync('wasmer', ['run', tmpPath], { encoding: 'buffer' })
            expect(result.status).toBe(0)
            expect(result.stdout?.toString('utf-8')).toBe('lex OK 6\n')
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/parse_test.si: parser produces expected AST shapes', async () => {
        if (!wasmerAvailable()) {
            console.log('  (skipped: wasmer not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'parse_test.si'))
        const tmpPath = path.join(PROJECT_ROOT, '.parse-smoke.wasm')
        await fs.writeFile(tmpPath, wasm)
        try {
            const result = spawnSync('wasmer', ['run', tmpPath], { encoding: 'buffer' })
            expect(result.status).toBe(0)
            expect(result.stdout?.toString('utf-8')).toBe('parse OK 17\n')
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/json_test.si: Silicon serializer matches Stage 0 AST JSON', async () => {
        if (!wasmerAvailable()) {
            console.log('  (skipped: wasmer not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'json_test.si'))
        const tmpPath = path.join(PROJECT_ROOT, '.json-smoke.wasm')
        await fs.writeFile(tmpPath, wasm)

        const stage0Parse = (await import('../src/parser')).default
        const { addToAstSemantics } = await import('../src/ast')
        const { siliconGrammar } = await import('../src/grammar')

        // Fixtures must match the inputs hard-coded in
        // boot/tests/json_test.si's `run` function (same order).
        const fixtures = [
            // Literals
            '42;', '3.14;', '@true;', '@false;',
            // Namespaces
            'x;', 'Color::Red;', 'a.b.c;',
            // Binary expressions
            '1 + 2;', '1 + 2 + 3;', 'a == b;',
            // Function calls
            '&add 1, 2;', '&@if 1, 0;', '&foo;',
            // Block
            '{ 1; 2; 3 };', '{ };',
            // Definitions
            '@let x := 42;',
            '@let x:Int := 42;',
            '@fn add a, b := a + b;',
            '@fn add a:Int, b:Int := { a + b };',
            '@var counter := 0;',
            '@extern print x:Int;',
            // $-literals
            '$[1, 2, 3];',
            '$(1, 2);',
            '${a=1, b=2};',
            // Variant
            '$Circle r:Int;',
            // Assignment
            'x = 5;',
        ]

        try {
            // One wasmer invocation per fixture so cumulative parser
            // state (@vars, heap growth across many parses) can't bleed
            // between cases.  Each invocation pipes the fixture source
            // via stdin.
            for (const src of fixtures) {
                const match = stage0Parse(src)
                const stage0Ast = addToAstSemantics(siliconGrammar)(match).toAst()
                const expected = JSON.stringify(stage0Ast, null, 2) + '\n'

                const result = spawnSync('wasmer', ['run', tmpPath], {
                    input: Buffer.from(src, 'utf-8'),
                    maxBuffer: 64 * 1024 * 1024,
                })
                expect(result.status).toBe(0)
                const stdout = (result.stdout ?? Buffer.alloc(0)).toString('utf-8')
                if (stdout !== expected) {
                    throw new Error(
                        `JSON mismatch for ${JSON.stringify(src)}\n` +
                        `Expected:\n${expected}\nGot:\n${stdout}`,
                    )
                }
            }
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })
})
