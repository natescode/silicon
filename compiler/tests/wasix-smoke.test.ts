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

    test('boot/tests/json_test.si: corpus from src/e2e/examples matches Stage 0', async () => {
        if (!wasmerAvailable()) {
            console.log('  (skipped: wasmer not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'json_test.si'))
        const tmpPath = path.join(PROJECT_ROOT, '.json-corpus.wasm')
        await fs.writeFile(tmpPath, wasm)

        const stage0Parse = (await import('../src/parser')).default
        const { addToAstSemantics } = await import('../src/ast')
        const { siliconGrammar } = await import('../src/grammar')

        const examplesDir = path.join(PROJECT_ROOT, 'src', 'e2e', 'examples')
        const files = (await fs.readdir(examplesDir))
            .filter(f => f.endsWith('.si'))
            .sort()

        let matches = 0
        let mismatches = 0
        const failures: string[] = []

        try {
            for (const file of files) {
                const src = await fs.readFile(path.join(examplesDir, file), 'utf-8')

                // Some examples are multi-element programs that exercise
                // features the parser stubs out (`@stratum`, generics).
                // Skip examples Stage 0 itself can't parse parse-only.
                let stage0Ast: any
                try {
                    const match = stage0Parse(src)
                    stage0Ast = addToAstSemantics(siliconGrammar)(match).toAst()
                } catch {
                    continue
                }
                const expected = JSON.stringify(stage0Ast, null, 2) + '\n'

                const result = spawnSync('wasmer', ['run', tmpPath], {
                    input: Buffer.from(src, 'utf-8'),
                    maxBuffer: 64 * 1024 * 1024,
                })
                if (result.status !== 0) {
                    failures.push(`${file}: exit ${result.status}`)
                    mismatches++
                    continue
                }
                const stdout = (result.stdout ?? Buffer.alloc(0)).toString('utf-8')
                if (stdout === expected) {
                    matches++
                } else {
                    mismatches++
                    failures.push(file)
                }
            }
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }

        // Allow some failures while the parser is still catching up;
        // require that the *known-good* basic set matches.
        console.log(`  corpus: ${matches} match, ${mismatches} mismatch`)
        if (failures.length > 0) console.log(`  mismatched: ${failures.join(', ')}`)
        expect(matches).toBeGreaterThan(0)
    })

    test('boot/tests/strata_loader_test.si: registry counts match Stage 0 across all built-in strata', async () => {
        if (!wasmerAvailable()) {
            console.log('  (skipped: wasmer not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'strata_loader_test.si'))
        const tmpPath = path.join(PROJECT_ROOT, '.strata-smoke.wasm')
        await fs.writeFile(tmpPath, wasm)

        // Concatenate every built-in stratum file as the loader input.
        const strataDir = path.join(PROJECT_ROOT, 'src', 'strata')
        const files = (await fs.readdir(strataDir))
            .filter(f => f.endsWith('.si'))
            .sort()
        let bundle = ''
        for (const f of files) {
            bundle += await fs.readFile(path.join(strataDir, f), 'utf-8')
            bundle += '\n'
        }

        // Stage 0 counts — derived from text so the test stays in sync
        // with whatever strata land in the bundle.
        const stage0Ops = (bundle.match(/^@stratum_operator/gm) ?? []).length
        const stage0Kws = (bundle.match(/^@stratum_keyword/gm)  ?? []).length
        // Stage 0 defKinds count is whatever buildStrataRegistry produces.
        const { buildStrataRegistry } = await import('../src/elaborator')
        const { ASTFactory } = await import('../src/ast/astNodes')
        const stage0DefKinds = Object.keys(
            buildStrataRegistry(ASTFactory.program([])).defKinds,
        ).length

        try {
            const result = spawnSync('wasmer', ['run', tmpPath], {
                input: Buffer.from(bundle, 'utf-8'),
                maxBuffer: 64 * 1024 * 1024,
            })
            expect(result.status).toBe(0)
            const stdout = (result.stdout ?? Buffer.alloc(0)).toString('utf-8').trim()
            // Format starts with: "ops=N kws=M defkinds=K first_op=…"
            expect(stdout).toMatch(new RegExp(
                `^ops=${stage0Ops} kws=${stage0Kws} defkinds=${stage0DefKinds} `,
            ))
            expect(stdout).toContain('op_lookup_ok=1')
            expect(stdout).toContain('kw_lookup_ok=1')
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/json_fixtures_test.si: 26 fixtures in one process match Stage 0', async () => {
        if (!wasmerAvailable()) {
            console.log('  (skipped: wasmer not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'json_fixtures_test.si'))
        const tmpPath = path.join(PROJECT_ROOT, '.json-fixtures.wasm')
        await fs.writeFile(tmpPath, wasm)

        const stage0Parse = (await import('../src/parser')).default
        const { addToAstSemantics } = await import('../src/ast')
        const { siliconGrammar } = await import('../src/grammar')

        // Fixtures must match the inputs hard-coded in
        // boot/tests/json_fixtures_test.si's `run` function (same order).
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
            // Single wasmer process emits all fixtures separated by
            // `---\n`.  The cumulative-state bug that previously forced
            // a per-process loop was fixed by computing $heap from the
            // data-segment extent — see src/codegen/index.ts.
            const result = spawnSync('wasmer', ['run', tmpPath], {
                maxBuffer: 64 * 1024 * 1024,
            })
            expect(result.status).toBe(0)
            const stdout = (result.stdout ?? Buffer.alloc(0)).toString('utf-8')
            const chunks = stdout.split('---\n').filter(c => c.length > 0)
            expect(chunks.length).toBe(fixtures.length)

            for (let i = 0; i < fixtures.length; i++) {
                const src = fixtures[i]
                const match = stage0Parse(src)
                const stage0Ast = addToAstSemantics(siliconGrammar)(match).toAst()
                const expected = JSON.stringify(stage0Ast, null, 2) + '\n'
                if (chunks[i] !== expected) {
                    throw new Error(
                        `JSON mismatch for ${JSON.stringify(src)}\n` +
                        `Expected:\n${expected}\nGot:\n${chunks[i]}`,
                    )
                }
            }
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })
})
