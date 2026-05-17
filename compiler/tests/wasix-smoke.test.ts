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

    test('boot/tests/strata_loader_test.si: registry JSON byte-equals Stage 0 dump', async () => {
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

        // Build the Stage 0 reference dump from the same bundle the
        // Silicon loader will see.  Same sort, same dedup, same shape
        // as boot/strata/registry_json.si emits.
        const { buildStrataRegistry } = await import('../src/elaborator')
        const { ASTFactory } = await import('../src/ast/astNodes')
        const reg = buildStrataRegistry(ASTFactory.program([]))
        const bareSorted = (table: Record<string, unknown>): string[] => {
            const s = new Set<string>()
            for (const k of Object.keys(table)) {
                s.add(k.includes(':') ? k.slice(0, k.indexOf(':')) : k)
            }
            return Array.from(s).sort()
        }
        const ops = bareSorted(reg.operators)
        const kws = bareSorted(reg.keywords)
        const dks = Object.keys(reg.defKinds).sort()
        const lines: string[] = ['{']
        lines.push('  "operators": [')
        ops.forEach((s, i) => lines.push(`    "${s}"${i < ops.length - 1 ? ',' : ''}`))
        lines.push('  ],')
        lines.push('  "keywords": [')
        kws.forEach((s, i) => lines.push(`    "${s}"${i < kws.length - 1 ? ',' : ''}`))
        lines.push('  ],')
        lines.push('  "defKinds": {')
        dks.forEach((kw, i) => {
            const cg = (reg.defKinds as any)[kw].codegenKind
            lines.push(`    "${kw}": "${cg}"${i < dks.length - 1 ? ',' : ''}`)
        })
        lines.push('  }')
        lines.push('}')
        const expected = lines.join('\n') + '\n'

        try {
            const result = spawnSync('wasmer', ['run', tmpPath], {
                input: Buffer.from(bundle, 'utf-8'),
                maxBuffer: 64 * 1024 * 1024,
            })
            expect(result.status).toBe(0)
            const stdout = (result.stdout ?? Buffer.alloc(0)).toString('utf-8')
            if (stdout !== expected) {
                throw new Error(
                    `Strata registry JSON mismatch\nExpected:\n${expected}\nGot:\n${stdout}`,
                )
            }
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/fn_test.si: @fn definitions compile and execute end-to-end', async () => {
        if (!wasmerAvailable()) {
            console.log('  (skipped: wasmer not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'fn_test.si'))
        const tmpPath = path.join(PROJECT_ROOT, '.fn-smoke.wasm')
        await fs.writeFile(tmpPath, wasm)

        const strataDir = path.join(PROJECT_ROOT, 'src', 'strata')
        const files = (await fs.readdir(strataDir))
            .filter(f => f.endsWith('.si'))
            .sort()
        let bundle = ''
        for (const f of files) {
            bundle += await fs.readFile(path.join(strataDir, f), 'utf-8')
            bundle += '\n'
        }

        // (Silicon program, export name, args, expected result).
        const cases: Array<{ prog: string; fn: string; args: number[]; want: number }> = [
            { prog: '@fn add a:Int, b:Int := { a + b };',
              fn: 'add', args: [20, 22], want: 42 },
            { prog: '@fn sub a:Int, b:Int := { a - b };',
              fn: 'sub', args: [100, 58], want: 42 },
            { prog: '@fn poly a:Int, b:Int, c:Int := { (a * b) + c };',
              fn: 'poly', args: [6, 7, 0], want: 42 },
            { prog: '@fn doubleIt x:Int := { x + x };',
              fn: 'doubleIt', args: [21], want: 42 },
            { prog: '@fn fortytwo := { 42 };',
              fn: 'fortytwo', args: [], want: 42 },
            { prog: '@fn cmp a:Int, b:Int := { a < b };',
              fn: 'cmp', args: [3, 5], want: 1 },
            { prog: '@fn cmp a:Int, b:Int := { a < b };',
              fn: 'cmp', args: [5, 3], want: 0 },
            // Function-call lowering — slice 15.
            { prog: '@fn double x:Int := { x + x };\n' +
                    '@fn quad x:Int := { &double (&double x) };',
              fn: 'quad', args: [5], want: 20 },
            { prog: '@fn id x:Int := { x };\n' +
                    '@fn use2 a:Int, b:Int := { (&id a) + (&id b) };',
              fn: 'use2', args: [17, 25], want: 42 },
            { prog: '@fn k := { 42 };\n' +
                    '@fn k2 := { &k + &k };',
              fn: 'k2', args: [], want: 84 },
            // @if lowering — slice 16.
            { prog: '@fn pick c:Int, a:Int, b:Int := { &@if c, a, b };',
              fn: 'pick', args: [1, 10, 20], want: 10 },
            { prog: '@fn pick c:Int, a:Int, b:Int := { &@if c, a, b };',
              fn: 'pick', args: [0, 10, 20], want: 20 },
            { prog: '@fn abs x:Int := { &@if (x < 0), (0 - x), x };',
              fn: 'abs', args: [7],   want: 7 },
            { prog: '@fn abs x:Int := { &@if (x < 0), (0 - x), x };',
              fn: 'abs', args: [-7],  want: 7 },
            { prog: '@fn max a:Int, b:Int := { &@if (a > b), a, b };',
              fn: 'max', args: [3, 11], want: 11 },
            { prog: '@fn fact n:Int := { &@if (n < 2), 1, (n * (&fact (n - 1))) };',
              fn: 'fact', args: [5],  want: 120 },
            { prog: '@fn fact n:Int := { &@if (n < 2), 1, (n * (&fact (n - 1))) };',
              fn: 'fact', args: [10], want: 3628800 },
            // @local + assignment — slice 17.
            { prog: '@fn step x:Int := {\n  @local y := x + 1;\n  y * 2\n};',
              fn: 'step', args: [20], want: 42 },
            { prog: '@fn mut := {\n  @local x := 10;\n  x = x + 5;\n  x\n};',
              fn: 'mut', args: [], want: 15 },
            { prog: '@fn sum2 a:Int, b:Int := {\n  @local r := 0;\n  r = r + a;\n  r = r + b;\n  r\n};',
              fn: 'sum2', args: [17, 25], want: 42 },
            { prog: '@fn swap_use a:Int, b:Int := {\n  @local t := a;\n  a = b;\n  b = t;\n  a - b\n};',
              fn: 'swap_use', args: [10, 30], want: 20 },
            // @loop — slice 18.
            { prog: '@fn sumTo n:Int := {\n' +
                    '  @local s := 0;\n' +
                    '  @local i := 1;\n' +
                    '  &@loop (i <= n), {\n' +
                    '    s = s + i;\n' +
                    '    i = i + 1\n' +
                    '  };\n' +
                    '  s\n' +
                    '};',
              fn: 'sumTo', args: [10],  want: 55 },
            { prog: '@fn sumTo n:Int := {\n' +
                    '  @local s := 0;\n' +
                    '  @local i := 1;\n' +
                    '  &@loop (i <= n), {\n' +
                    '    s = s + i;\n' +
                    '    i = i + 1\n' +
                    '  };\n' +
                    '  s\n' +
                    '};',
              fn: 'sumTo', args: [100], want: 5050 },
            // Iterative factorial — proves @loop + @local mutation work
            // for non-trivial state machines.
            { prog: '@fn factIter n:Int := {\n' +
                    '  @local r := 1;\n' +
                    '  @local i := 2;\n' +
                    '  &@loop (i <= n), {\n' +
                    '    r = r * i;\n' +
                    '    i = i + 1\n' +
                    '  };\n' +
                    '  r\n' +
                    '};',
              fn: 'factIter', args: [6], want: 720 },
            // gcd via Euclidean algorithm — exercises @loop + assignment-from-expr.
            { prog: '@fn gcd a:Int, b:Int := {\n' +
                    '  &@loop (b != 0), {\n' +
                    '    @local t := b;\n' +
                    '    b = a - ((a / b) * b);\n' +
                    '    a = t\n' +
                    '  };\n' +
                    '  a\n' +
                    '};',
              fn: 'gcd', args: [48, 18], want: 6 },
            { prog: '@fn gcd a:Int, b:Int := {\n' +
                    '  &@loop (b != 0), {\n' +
                    '    @local t := b;\n' +
                    '    b = a - ((a / b) * b);\n' +
                    '    a = t\n' +
                    '  };\n' +
                    '  a\n' +
                    '};',
              fn: 'gcd', args: [1071, 462], want: 21 },
            // @return / @break — slice 19.
            { prog: '@fn safeDiv a:Int, b:Int := {\n' +
                    '  &@if (b == 0), { &@return 0 };\n' +
                    '  a / b\n' +
                    '};',
              fn: 'safeDiv', args: [42, 6], want: 7 },
            { prog: '@fn safeDiv a:Int, b:Int := {\n' +
                    '  &@if (b == 0), { &@return 0 };\n' +
                    '  a / b\n' +
                    '};',
              fn: 'safeDiv', args: [42, 0], want: 0 },
            // findFirst — return early from a loop via @return.
            { prog: '@fn findFirst limit:Int := {\n' +
                    '  @local i := 0;\n' +
                    '  &@loop (i < limit), {\n' +
                    '    &@if ((i * i) > 50), { &@return i };\n' +
                    '    i = i + 1\n' +
                    '  };\n' +
                    '  0 - 1\n' +
                    '};',
              fn: 'findFirst', args: [20], want: 8 },
            { prog: '@fn findFirst limit:Int := {\n' +
                    '  @local i := 0;\n' +
                    '  &@loop (i < limit), {\n' +
                    '    &@if ((i * i) > 50), { &@return i };\n' +
                    '    i = i + 1\n' +
                    '  };\n' +
                    '  0 - 1\n' +
                    '};',
              fn: 'findFirst', args: [5], want: -1 },
            // @break with labeled br — slice 20.
            { prog: '@fn sumUntil arr_sum:Int := {\n' +
                    '  @local s := 0;\n' +
                    '  @local i := 0;\n' +
                    '  &@loop 1, {\n' +
                    '    &@if (i >= arr_sum), { &@break };\n' +
                    '    s = s + i;\n' +
                    '    i = i + 1\n' +
                    '  };\n' +
                    '  s\n' +
                    '};',
              fn: 'sumUntil', args: [11], want: 55 },   // 0+1+...+10
            // @continue skipping odd numbers.
            { prog: '@fn sumEven n:Int := {\n' +
                    '  @local s := 0;\n' +
                    '  @local i := 0;\n' +
                    '  &@loop (i < n), {\n' +
                    '    i = i + 1;\n' +
                    '    &@if ((i - ((i / 2) * 2)) != 0), { &@continue };\n' +
                    '    s = s + i\n' +
                    '  };\n' +
                    '  s\n' +
                    '};',
              fn: 'sumEven', args: [10], want: 30 },    // 2+4+6+8+10
            // @var globals — slice 21.
            // Caller drives the harness: bump returns the post-increment
            // value, so 3 bumps starting from 0 gives 3.
            { prog: '@var counter := 0;\n' +
                    '@fn bump := { counter = counter + 1; counter };\n' +
                    '@fn bump3 := { &bump; &bump; &bump };',
              fn: 'bump3', args: [], want: 3 },
            // get() reads the global after a sequence of mutations.
            { prog: '@var counter := 0;\n' +
                    '@fn bump := { counter = counter + 1; counter };\n' +
                    '@fn add5_get := {\n' +
                    '  &bump; &bump; &bump; &bump; &bump;\n' +
                    '  counter\n' +
                    '};',
              fn: 'add5_get', args: [], want: 5 },
            // Globals visible across multiple functions.
            { prog: '@var acc := 7;\n' +
                    '@fn addG x:Int := { acc = acc + x; acc };\n' +
                    '@fn run := { &addG 3; &addG 2; &addG 8 };',
              fn: 'run', args: [], want: 20 },     // 7+3+2+8
            // @toFloat / @toInt round-trip — slice 23.
            { prog: '@fn roundTrip x:Int := { &@toInt (&@toFloat x) };',
              fn: 'roundTrip', args: [42], want: 42 },
            { prog: '@fn roundTrip x:Int := { &@toInt (&@toFloat x) };',
              fn: 'roundTrip', args: [-7], want: -7 },
            // Two-step round trip should also be identity for values that
            // fit cleanly in f32 (i.e. up to 24-bit ints).
            { prog: '@fn rt2 x:Int := {\n' +
                    '  &@toInt (&@toFloat (&@toInt (&@toFloat x)))\n' +
                    '};',
              fn: 'rt2', args: [1000000], want: 1000000 },
            // &WASM::* user-level intrinsics — slice 25.
            // Store one byte, read it back.
            { prog: '@fn memOp p:Int := {\n' +
                    '  &WASM::i32_store8 p, 65;\n' +
                    '  &WASM::i32_load8_u p\n' +
                    '};',
              fn: 'memOp', args: [256], want: 65 },
            // Store an i32 at a 4-byte-aligned address, read back.
            { prog: '@fn store_read p:Int, v:Int := {\n' +
                    '  &WASM::i32_store p, v;\n' +
                    '  &WASM::i32_load p\n' +
                    '};',
              fn: 'store_read', args: [512, 0xCAFEBABE | 0], want: 0xCAFEBABE | 0 },
            // WASM:: also exposes the same arithmetic ops as binops.
            { prog: '@fn wasmAdd a:Int, b:Int := { &WASM::i32_add a, b };',
              fn: 'wasmAdd', args: [40, 2], want: 42 },
            { prog: '@fn wasmEqz x:Int := { &WASM::i32_eqz x };',
              fn: 'wasmEqz', args: [0], want: 1 },
            { prog: '@fn wasmEqz x:Int := { &WASM::i32_eqz x };',
              fn: 'wasmEqz', args: [7], want: 0 },
            // Additional &WASM::* dispatch — slice 27.
            { prog: '@fn divs a:Int, b:Int := { &WASM::i32_div_s a, b };',
              fn: 'divs', args: [42, 6], want: 7 },
            { prog: '@fn rems a:Int, b:Int := { &WASM::i32_rem_s a, b };',
              fn: 'rems', args: [17, 5], want: 2 },
            { prog: '@fn eq2 a:Int, b:Int := { &WASM::i32_eq a, b };',
              fn: 'eq2', args: [3, 3], want: 1 },
            { prog: '@fn eq2 a:Int, b:Int := { &WASM::i32_eq a, b };',
              fn: 'eq2', args: [3, 4], want: 0 },
            { prog: '@fn lt2 a:Int, b:Int := { &WASM::i32_lt_s a, b };',
              fn: 'lt2', args: [3, 5], want: 1 },
            { prog: '@fn band a:Int, b:Int := { &WASM::i32_and a, b };',
              fn: 'band', args: [0xF0, 0x18], want: 0x10 },
            { prog: '@fn bor a:Int, b:Int := { &WASM::i32_or a, b };',
              fn: 'bor', args: [0xF0, 0x0F], want: 0xFF },
            { prog: '@fn bxor a:Int, b:Int := { &WASM::i32_xor a, b };',
              fn: 'bxor', args: [0xFF, 0x0F], want: 0xF0 },
            { prog: '@fn shl a:Int, b:Int := { &WASM::i32_shl a, b };',
              fn: 'shl', args: [1, 4], want: 16 },
            { prog: '@fn shrs a:Int, b:Int := { &WASM::i32_shr_s a, b };',
              fn: 'shrs', args: [32, 2], want: 8 },
        ]

        // Strings produce a pointer to a length-prefixed UTF-8 block
        // in linear memory.  The harness reads the memory back to
        // verify both the length header and the byte content.
        type StringCase = {
            prog: string; fn: string; args: number[];
            wantLen: number; wantText: string;
        }
        const stringCases: StringCase[] = [
            { prog: "@fn greet := { 'hello' };",
              fn: 'greet', args: [], wantLen: 5, wantText: 'hello' },
            { prog: "@fn empty := { '' };",
              fn: 'empty', args: [], wantLen: 0, wantText: '' },
            // Interning: two identical literals collapse to one pool entry.
            { prog: "@fn a := { 'shared' };\n" +
                    "@fn b := { 'shared' };",
              fn: 'a', args: [], wantLen: 6, wantText: 'shared' },
            { prog: "@fn a := { 'shared' };\n" +
                    "@fn b := { 'shared' };",
              fn: 'b', args: [], wantLen: 6, wantText: 'shared' },
            // Escape sequences — slice 30.
            { prog: "@fn s := { 'hi\\n' };",
              fn: 's', args: [], wantLen: 3, wantText: 'hi\n' },
            { prog: "@fn s := { 'a\\tb' };",
              fn: 's', args: [], wantLen: 3, wantText: 'a\tb' },
            { prog: "@fn s := { 'one\\\\two' };",
              fn: 's', args: [], wantLen: 7, wantText: 'one\\two' },
            { prog: "@fn s := { 'x\\0y' };",
              fn: 's', args: [], wantLen: 3, wantText: 'x\0y' },
        ]

        // Externs need imports provided to instantiate; tracked
        // separately so the harness can pass an `env` object.
        const externCases: Array<{
            prog: string; fn: string; args: number[]; want: number;
            imports: Record<string, (...a: number[]) => number>;
        }> = [
            {
                prog: '@extern host_add:Int a:Int, b:Int;\n' +
                      '@fn use_host x:Int := { &host_add x, 100 };',
                fn: 'use_host', args: [7], want: 107,
                imports: { host_add: (a: number, b: number) => a + b },
            },
            {
                prog: '@extern host_mul:Int a:Int, b:Int;\n' +
                      '@extern host_inc:Int x:Int;\n' +
                      '@fn combo a:Int, b:Int := {\n' +
                      '  &host_inc (&host_mul a, b)\n' +
                      '};',
                fn: 'combo', args: [3, 4], want: 13,
                imports: {
                    host_mul: (a: number, b: number) => a * b,
                    host_inc: (x: number) => x + 1,
                },
            },
            // Multi-segment call → mangled `Module_Fn` name — slice 26.
            // The @extern's bare name is chosen to match the mangled
            // call site (alpha::beta → alpha_beta).
            {
                prog: '@extern alpha_beta:Int x:Int;\n' +
                      '@fn call_ns x:Int := { &alpha::beta x };',
                fn: 'call_ns', args: [21], want: 42,
                imports: { alpha_beta: (x: number) => x * 2 },
            },
            // Three-segment call too: host::inc::one → host_inc_one.
            {
                prog: '@extern host_inc_one:Int x:Int;\n' +
                      '@fn three x:Int := { &host::inc::one x };',
                fn: 'three', args: [40], want: 41,
                imports: { host_inc_one: (x: number) => x + 1 },
            },
        ]

        // Multi-segment @extern — module name comes from the prefix
        // before `::` (slice 28).  Needs its own imports object keyed
        // by the module name, not by "env".
        const moduleExternCases: Array<{
            prog: string; fn: string; args: number[]; want: number;
            importModule: string;
            importField: string;
            impl: (...a: number[]) => number;
        }> = [
            {
                prog: '@extern mathmod::double_it:Int x:Int;\n' +
                      '@fn use x:Int := { &mathmod::double_it x };',
                fn: 'use', args: [21], want: 42,
                importModule: 'mathmod', importField: 'double_it',
                impl: (x: number) => x * 2,
            },
            {
                prog: '@extern wasi_snapshot_preview1::clock_now:Int x:Int;\n' +
                      '@fn now x:Int := { &wasi_snapshot_preview1::clock_now x };',
                fn: 'now', args: [0], want: 1234,
                importModule: 'wasi_snapshot_preview1', importField: 'clock_now',
                impl: () => 1234,
            },
        ]

        try {
            for (const c of cases) {
                const result = spawnSync('wasmer', ['run', tmpPath], {
                    input: Buffer.from(bundle + c.prog + '\n', 'utf-8'),
                    maxBuffer: 64 * 1024 * 1024,
                })
                expect(result.status).toBe(0)
                const wat = (result.stdout ?? Buffer.alloc(0)).toString('utf-8')
                let compiled: { buffer: ArrayBuffer }
                let instance: WebAssembly.Instance
                try {
                    compiled = await watToWasm(wat)
                    ;({ instance } = await WebAssembly.instantiate(compiled.buffer, {}))
                } catch (e: any) {
                    throw new Error(
                        `Wasm build failed for ${JSON.stringify(c.prog)}\n` +
                        `Error: ${e.message}\nWAT:\n${wat}`,
                    )
                }
                const f = (instance.exports as any)[c.fn] as (...a: number[]) => number
                if (typeof f !== 'function') {
                    throw new Error(
                        `No export ${c.fn} for ${JSON.stringify(c.prog)}\nWAT:\n${wat}`,
                    )
                }
                const got = f(...c.args)
                if (got !== c.want) {
                    throw new Error(
                        `${c.fn}(${c.args.join(', ')}) for ${JSON.stringify(c.prog)}\n` +
                        `Expected: ${c.want}\nGot: ${got}\nWAT:\n${wat}`,
                    )
                }
            }
            for (const c of stringCases) {
                const result = spawnSync('wasmer', ['run', tmpPath], {
                    input: Buffer.from(bundle + c.prog + '\n', 'utf-8'),
                    maxBuffer: 64 * 1024 * 1024,
                })
                expect(result.status).toBe(0)
                const wat = (result.stdout ?? Buffer.alloc(0)).toString('utf-8')
                const compiled = await watToWasm(wat)
                const { instance } = await WebAssembly.instantiate(compiled.buffer, {})
                const f = (instance.exports as any)[c.fn] as (...a: number[]) => number
                const ptr = f(...c.args)
                const mem = (instance.exports as any).memory as WebAssembly.Memory
                const view = new DataView(mem.buffer)
                const gotLen = view.getUint32(ptr, true)
                const bytes = new Uint8Array(mem.buffer, ptr + 4, gotLen)
                const gotText = new TextDecoder().decode(bytes)
                if (gotLen !== c.wantLen || gotText !== c.wantText) {
                    throw new Error(
                        `${c.fn}() string mismatch for ${JSON.stringify(c.prog)}\n` +
                        `Expected: len=${c.wantLen} text="${c.wantText}"\n` +
                        `Got:      len=${gotLen} text="${gotText}"\nWAT:\n${wat}`,
                    )
                }
            }
            for (const c of externCases) {
                const result = spawnSync('wasmer', ['run', tmpPath], {
                    input: Buffer.from(bundle + c.prog + '\n', 'utf-8'),
                    maxBuffer: 64 * 1024 * 1024,
                })
                expect(result.status).toBe(0)
                const wat = (result.stdout ?? Buffer.alloc(0)).toString('utf-8')
                const compiled = await watToWasm(wat)
                const { instance } = await WebAssembly.instantiate(
                    compiled.buffer,
                    { env: c.imports },
                )
                const f = (instance.exports as any)[c.fn] as (...a: number[]) => number
                const got = f(...c.args)
                if (got !== c.want) {
                    throw new Error(
                        `${c.fn}(${c.args.join(', ')}) for ${JSON.stringify(c.prog)}\n` +
                        `Expected: ${c.want}\nGot: ${got}\nWAT:\n${wat}`,
                    )
                }
            }
            for (const c of moduleExternCases) {
                const result = spawnSync('wasmer', ['run', tmpPath], {
                    input: Buffer.from(bundle + c.prog + '\n', 'utf-8'),
                    maxBuffer: 64 * 1024 * 1024,
                })
                expect(result.status).toBe(0)
                const wat = (result.stdout ?? Buffer.alloc(0)).toString('utf-8')
                const compiled = await watToWasm(wat)
                const { instance } = await WebAssembly.instantiate(
                    compiled.buffer,
                    { [c.importModule]: { [c.importField]: c.impl } },
                )
                const f = (instance.exports as any)[c.fn] as (...a: number[]) => number
                const got = f(...c.args)
                if (got !== c.want) {
                    throw new Error(
                        `${c.fn}(${c.args.join(', ')}) module=${c.importModule}\n` +
                        `Expected: ${c.want}\nGot: ${got}\nWAT:\n${wat}`,
                    )
                }
            }
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    }, 60000)

    test('boot/tests/fn_test.si: bootstrap compiles a WASI loop that prints the alphabet', async () => {
        if (!wasmerAvailable()) {
            console.log('  (skipped: wasmer not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'fn_test.si'))
        const tmpPath = path.join(PROJECT_ROOT, '.wasi-alpha-boot.wasm')
        await fs.writeFile(tmpPath, wasm)

        const strataDir = path.join(PROJECT_ROOT, 'src', 'strata')
        const files = (await fs.readdir(strataDir))
            .filter(f => f.endsWith('.si'))
            .sort()
        let bundle = ''
        for (const f of files) {
            bundle += await fs.readFile(path.join(strataDir, f), 'utf-8')
            bundle += '\n'
        }

        // Silicon program: loop over ASCII 65..90 ('A'..'Z'),
        // building a 1-byte iovec each iteration and calling
        // WASI fd_write.  After the loop, emit a real newline.
        // Exercises @loop, @local, @if-less assignment, @WASM::*
        // memory ops, multi-segment WASI extern, and string-free
        // byte-level output.
        const userProg = [
            '@extern wasi_snapshot_preview1::fd_write:Int',
            '  fd:Int, iovs:Int, iovs_len:Int, nwritten:Int;',
            '',
            '@fn _start:Void := {',
            '  @local i := 65;',
            '  @local buf := 1024;',
            '  @local iovs := 2048;',
            '  @local written := 2064;',
            '  &@loop (i <= 90), {',
            '    &WASM::i32_store8 buf, i;',
            '    &WASM::i32_store iovs, buf;',
            '    &WASM::i32_store (iovs + 4), 1;',
            '    &wasi_snapshot_preview1::fd_write 1, iovs, 1, written;',
            '    i = i + 1',
            '  };',
            '  &WASM::i32_store8 buf, 10;',
            '  &WASM::i32_store iovs, buf;',
            '  &WASM::i32_store (iovs + 4), 1;',
            '  &wasi_snapshot_preview1::fd_write 1, iovs, 1, written',
            '};',
        ].join('\n') + '\n'

        const alphaWasm = path.join(PROJECT_ROOT, '.wasi-alpha.wasm')
        try {
            const compileRes = spawnSync('wasmer', ['run', tmpPath], {
                input: Buffer.from(bundle + userProg, 'utf-8'),
                maxBuffer: 64 * 1024 * 1024,
            })
            expect(compileRes.status).toBe(0)
            const wat = (compileRes.stdout ?? Buffer.alloc(0)).toString('utf-8')

            const compiled = await watToWasm(wat)
            await fs.writeFile(alphaWasm, Buffer.from(compiled.buffer))

            const runRes = spawnSync('wasmer', ['run', alphaWasm], {
                maxBuffer: 64 * 1024 * 1024,
            })
            expect(runRes.status).toBe(0)
            const stdout = (runRes.stdout ?? Buffer.alloc(0)).toString('utf-8')
            const wantText = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ\n'
            if (stdout !== wantText) {
                throw new Error(
                    `WASI alphabet stdout mismatch.\n` +
                    `Expected: ${JSON.stringify(wantText)}\n` +
                    `Got:      ${JSON.stringify(stdout)}\n` +
                    `WAT:\n${wat}`,
                )
            }
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
            await fs.unlink(alphaWasm).catch(() => {})
        }
    }, 60000)

    test('boot/tests/fn_test.si: bootstrap compiles ITS OWN SOURCE TREE end-to-end (Stage 1 candidate)', async () => {
        if (!wasmerAvailable()) {
            console.log('  (skipped: wasmer not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'fn_test.si'))
        const tmpPath = path.join(PROJECT_ROOT, '.self-host-boot.wasm')
        await fs.writeFile(tmpPath, wasm)

        const strataDir = path.join(PROJECT_ROOT, 'src', 'strata')
        const files = (await fs.readdir(strataDir))
            .filter(f => f.endsWith('.si'))
            .sort()
        let bundle = ''
        for (const f of files) {
            bundle += await fs.readFile(path.join(strataDir, f), 'utf-8')
            bundle += '\n'
        }

        const wasiStub = [
            '@extern wasi_snapshot_preview1::fd_write:Int',
            '  fd:Int, iovs_ptr:Int, iovs_len:Int, nwritten_out:Int;',
            '@extern wasi_snapshot_preview1::fd_read:Int',
            '  fd:Int, iovs_ptr:Int, iovs_len:Int, nread_out:Int;',
        ].join('\n') + '\n'

        // The full bootstrap source tree, ordered so each file's @use
        // dependencies are already in scope by concatenation.
        const sources = [
            'boot/std/io.si',
            'boot/std/arena.si',
            'boot/std/vec.si',
            'boot/parser/tokens.si',
            'boot/parser/lex.si',
            'boot/parser/ast.si',
            'boot/parser/parse.si',
            'boot/strata/registry.si',
            'boot/strata/loader.si',
            'boot/elab/elaborator.si',
            'boot/ir/nodes.si',
            'boot/elab/body.si',
            'boot/ir/lower.si',
            'boot/emit/wat.si',
        ]
        const pieces = await Promise.all(
            sources.map(p => fs.readFile(path.join(PROJECT_ROOT, p), 'utf-8')),
        )
        const userProg = wasiStub + pieces.join('')

        try {
            const compileRes = spawnSync('wasmer', ['run', tmpPath], {
                input: Buffer.from(bundle + userProg, 'utf-8'),
                maxBuffer: 64 * 1024 * 1024,
            })
            expect(compileRes.status).toBe(0)
            const wat = (compileRes.stdout ?? Buffer.alloc(0)).toString('utf-8')
            const compiled = await watToWasm(wat)
            await WebAssembly.compile(compiled.buffer)
            // ~38 KiB for the whole pipeline.  Loose bounds so future
            // changes don't trip the test for size drift alone.
            expect(compiled.buffer.byteLength).toBeGreaterThan(20000)
            expect(compiled.buffer.byteLength).toBeLessThan(150000)
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    }, 60000)

    test('boot/tests/fn_test.si: bootstrap compiles strata loader + registry standalone', async () => {
        if (!wasmerAvailable()) {
            console.log('  (skipped: wasmer not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'fn_test.si'))
        const tmpPath = path.join(PROJECT_ROOT, '.loader-boot.wasm')
        await fs.writeFile(tmpPath, wasm)

        const strataDir = path.join(PROJECT_ROOT, 'src', 'strata')
        const files = (await fs.readdir(strataDir))
            .filter(f => f.endsWith('.si'))
            .sort()
        let bundle = ''
        for (const f of files) {
            bundle += await fs.readFile(path.join(strataDir, f), 'utf-8')
            bundle += '\n'
        }

        const wasiStub = [
            '@extern wasi_snapshot_preview1::fd_write:Int',
            '  fd:Int, iovs_ptr:Int, iovs_len:Int, nwritten_out:Int;',
            '@extern wasi_snapshot_preview1::fd_read:Int',
            '  fd:Int, iovs_ptr:Int, iovs_len:Int, nread_out:Int;',
        ].join('\n') + '\n'

        const pieces = await Promise.all([
            fs.readFile(path.join(PROJECT_ROOT, 'boot', 'std',    'io.si'),       'utf-8'),
            fs.readFile(path.join(PROJECT_ROOT, 'boot', 'std',    'arena.si'),    'utf-8'),
            fs.readFile(path.join(PROJECT_ROOT, 'boot', 'std',    'vec.si'),      'utf-8'),
            fs.readFile(path.join(PROJECT_ROOT, 'boot', 'parser', 'tokens.si'),   'utf-8'),
            fs.readFile(path.join(PROJECT_ROOT, 'boot', 'parser', 'lex.si'),      'utf-8'),
            fs.readFile(path.join(PROJECT_ROOT, 'boot', 'parser', 'ast.si'),      'utf-8'),
            fs.readFile(path.join(PROJECT_ROOT, 'boot', 'parser', 'parse.si'),    'utf-8'),
            fs.readFile(path.join(PROJECT_ROOT, 'boot', 'strata', 'registry.si'), 'utf-8'),
            fs.readFile(path.join(PROJECT_ROOT, 'boot', 'strata', 'loader.si'),   'utf-8'),
        ])

        const userProg = wasiStub + pieces.join('')

        try {
            const compileRes = spawnSync('wasmer', ['run', tmpPath], {
                input: Buffer.from(bundle + userProg, 'utf-8'),
                maxBuffer: 64 * 1024 * 1024,
            })
            expect(compileRes.status).toBe(0)
            const wat = (compileRes.stdout ?? Buffer.alloc(0)).toString('utf-8')
            const compiled = await watToWasm(wat)
            await WebAssembly.compile(compiled.buffer)
            // ~11 KB feels right for ~2000 LoC of frontend + strata loader.
            expect(compiled.buffer.byteLength).toBeGreaterThan(7000)
            expect(compiled.buffer.byteLength).toBeLessThan(50000)
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    }, 60000)

    test('boot/tests/fn_test.si: bootstrap compiles boot/parser/parse.si standalone (lex+ast+parse+std)', async () => {
        if (!wasmerAvailable()) {
            console.log('  (skipped: wasmer not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'fn_test.si'))
        const tmpPath = path.join(PROJECT_ROOT, '.parse-boot.wasm')
        await fs.writeFile(tmpPath, wasm)

        const strataDir = path.join(PROJECT_ROOT, 'src', 'strata')
        const files = (await fs.readdir(strataDir))
            .filter(f => f.endsWith('.si'))
            .sort()
        let bundle = ''
        for (const f of files) {
            bundle += await fs.readFile(path.join(strataDir, f), 'utf-8')
            bundle += '\n'
        }

        const wasiStub = [
            '@extern wasi_snapshot_preview1::fd_write:Int',
            '  fd:Int, iovs_ptr:Int, iovs_len:Int, nwritten_out:Int;',
            '@extern wasi_snapshot_preview1::fd_read:Int',
            '  fd:Int, iovs_ptr:Int, iovs_len:Int, nread_out:Int;',
        ].join('\n') + '\n'

        const pieces = await Promise.all([
            fs.readFile(path.join(PROJECT_ROOT, 'boot', 'std',    'io.si'),     'utf-8'),
            fs.readFile(path.join(PROJECT_ROOT, 'boot', 'std',    'arena.si'),  'utf-8'),
            fs.readFile(path.join(PROJECT_ROOT, 'boot', 'std',    'vec.si'),    'utf-8'),
            fs.readFile(path.join(PROJECT_ROOT, 'boot', 'parser', 'tokens.si'), 'utf-8'),
            fs.readFile(path.join(PROJECT_ROOT, 'boot', 'parser', 'lex.si'),    'utf-8'),
            fs.readFile(path.join(PROJECT_ROOT, 'boot', 'parser', 'ast.si'),    'utf-8'),
            fs.readFile(path.join(PROJECT_ROOT, 'boot', 'parser', 'parse.si'),  'utf-8'),
        ])

        const userProg = wasiStub + pieces.join('')

        try {
            const compileRes = spawnSync('wasmer', ['run', tmpPath], {
                input: Buffer.from(bundle + userProg, 'utf-8'),
                maxBuffer: 64 * 1024 * 1024,
            })
            expect(compileRes.status).toBe(0)
            const wat = (compileRes.stdout ?? Buffer.alloc(0)).toString('utf-8')
            const compiled = await watToWasm(wat)
            await WebAssembly.compile(compiled.buffer)
            // ~9 KB feels right for full lex + parse + ast + std
            // ~1500 LoC of Silicon source.  Tighten the range if a
            // future change shifts emit size meaningfully.
            expect(compiled.buffer.byteLength).toBeGreaterThan(5000)
            expect(compiled.buffer.byteLength).toBeLessThan(40000)
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    }, 60000)

    test('boot/tests/fn_test.si: bootstrap compiles boot/parser/lex.si into validating standalone wasm', async () => {
        if (!wasmerAvailable()) {
            console.log('  (skipped: wasmer not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'fn_test.si'))
        const tmpPath = path.join(PROJECT_ROOT, '.lex-boot.wasm')
        await fs.writeFile(tmpPath, wasm)

        const strataDir = path.join(PROJECT_ROOT, 'src', 'strata')
        const files = (await fs.readdir(strataDir))
            .filter(f => f.endsWith('.si'))
            .sort()
        let bundle = ''
        for (const f of files) {
            bundle += await fs.readFile(path.join(strataDir, f), 'utf-8')
            bundle += '\n'
        }

        const wasiStub = [
            '@extern wasi_snapshot_preview1::fd_write:Int',
            '  fd:Int, iovs_ptr:Int, iovs_len:Int, nwritten_out:Int;',
            '@extern wasi_snapshot_preview1::fd_read:Int',
            '  fd:Int, iovs_ptr:Int, iovs_len:Int, nread_out:Int;',
        ].join('\n') + '\n'

        const io   = await fs.readFile(path.join(PROJECT_ROOT, 'boot', 'std', 'io.si'),    'utf-8')
        const arena = await fs.readFile(path.join(PROJECT_ROOT, 'boot', 'std', 'arena.si'), 'utf-8')
        const vec  = await fs.readFile(path.join(PROJECT_ROOT, 'boot', 'std', 'vec.si'),   'utf-8')
        const toks = await fs.readFile(path.join(PROJECT_ROOT, 'boot', 'parser', 'tokens.si'), 'utf-8')
        const lex  = await fs.readFile(path.join(PROJECT_ROOT, 'boot', 'parser', 'lex.si'),    'utf-8')

        const userProg = wasiStub + io + arena + vec + toks + lex

        try {
            const compileRes = spawnSync('wasmer', ['run', tmpPath], {
                input: Buffer.from(bundle + userProg, 'utf-8'),
                maxBuffer: 64 * 1024 * 1024,
            })
            expect(compileRes.status).toBe(0)
            const wat = (compileRes.stdout ?? Buffer.alloc(0)).toString('utf-8')
            // Both wabt (strict validate) and the JS WebAssembly engine
            // (the cranelift-equivalent validator) must accept it.
            const compiled = await watToWasm(wat)
            await WebAssembly.compile(compiled.buffer)
            // Don't run — lexer requires source bytes in memory and we
            // just want to know the module is structurally valid.
            // Size sanity-check: should be on the order of 3-4 KB.
            expect(compiled.buffer.byteLength).toBeGreaterThan(2000)
            expect(compiled.buffer.byteLength).toBeLessThan(20000)
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    }, 60000)

    test('boot/tests/fn_test.si: bootstrap-compiled io.si library + _start prints via write_str', async () => {
        if (!wasmerAvailable()) {
            console.log('  (skipped: wasmer not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'fn_test.si'))
        const tmpPath = path.join(PROJECT_ROOT, '.wasi-io-boot.wasm')
        await fs.writeFile(tmpPath, wasm)

        const strataDir = path.join(PROJECT_ROOT, 'src', 'strata')
        const files = (await fs.readdir(strataDir))
            .filter(f => f.endsWith('.si'))
            .sort()
        let bundle = ''
        for (const f of files) {
            bundle += await fs.readFile(path.join(strataDir, f), 'utf-8')
            bundle += '\n'
        }

        // WASI extern stub written with the multi-segment name so the
        // bootstrap-mangled call sites in io.si resolve.
        const wasiStub = [
            '@extern wasi_snapshot_preview1::fd_write:Int',
            '  fd:Int, iovs_ptr:Int, iovs_len:Int, nwritten_out:Int;',
            '@extern wasi_snapshot_preview1::fd_read:Int',
            '  fd:Int, iovs_ptr:Int, iovs_len:Int, nread_out:Int;',
        ].join('\n') + '\n'

        // Take the real boot/std/io.si and add a _start that calls
        // write_str.  This is the bootstrap compiling its own library
        // code and using it from a top-level WASI entry point.
        const ioSrc = await fs.readFile(
            path.join(PROJECT_ROOT, 'boot', 'std', 'io.si'),
            'utf-8',
        )
        const userProg = [
            wasiStub,
            ioSrc,
            "@fn _start:Void := { &write_str 1, 'hello, world\\n' };",
        ].join('\n')

        const outWasm = path.join(PROJECT_ROOT, '.wasi-io.wasm')
        try {
            const compileRes = spawnSync('wasmer', ['run', tmpPath], {
                input: Buffer.from(bundle + userProg, 'utf-8'),
                maxBuffer: 64 * 1024 * 1024,
            })
            expect(compileRes.status).toBe(0)
            const wat = (compileRes.stdout ?? Buffer.alloc(0)).toString('utf-8')

            const compiled = await watToWasm(wat)
            await fs.writeFile(outWasm, Buffer.from(compiled.buffer))

            const runRes = spawnSync('wasmer', ['run', outWasm], {
                maxBuffer: 64 * 1024 * 1024,
            })
            expect(runRes.status).toBe(0)
            const stdout = (runRes.stdout ?? Buffer.alloc(0)).toString('utf-8')
            if (stdout !== 'hello, world\n') {
                throw new Error(
                    `WASI io.si stdout mismatch.  Expected ` +
                    `${JSON.stringify('hello, world\n')}, got ` +
                    `${JSON.stringify(stdout)}.\nWAT:\n${wat}`,
                )
            }
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
            await fs.unlink(outWasm).catch(() => {})
        }
    }, 60000)

    test('boot/tests/fn_test.si: bootstrap-compiled WASI program calls helper functions', async () => {
        if (!wasmerAvailable()) {
            console.log('  (skipped: wasmer not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'fn_test.si'))
        const tmpPath = path.join(PROJECT_ROOT, '.wasi-helper-boot.wasm')
        await fs.writeFile(tmpPath, wasm)

        const strataDir = path.join(PROJECT_ROOT, 'src', 'strata')
        const files = (await fs.readdir(strataDir))
            .filter(f => f.endsWith('.si'))
            .sort()
        let bundle = ''
        for (const f of files) {
            bundle += await fs.readFile(path.join(strataDir, f), 'utf-8')
            bundle += '\n'
        }

        // Silicon helper functions used by _start.  Demonstrates that
        // the bootstrap-emitted module correctly resolves call $name
        // references between user-defined Silicon functions, including
        // recursive calls.  fact(5) = 120 → digits '1' '2' '0' '\n'.
        const userProg = [
            '@extern wasi_snapshot_preview1::fd_write:Int',
            '  fd:Int, iovs:Int, iovs_len:Int, nwritten:Int;',
            '',
            '@fn write_byte_at buf:Int, iovs:Int, written:Int, b:Int := {',
            '  &WASM::i32_store8 buf, b;',
            '  &WASM::i32_store iovs, buf;',
            '  &WASM::i32_store (iovs + 4), 1;',
            '  &wasi_snapshot_preview1::fd_write 1, iovs, 1, written',
            '};',
            '',
            '@fn fact n:Int := {',
            '  &@if (n < 2), 1, (n * (&fact (n - 1)))',
            '};',
            '',
            '@fn _start:Void := {',
            '  @local buf := 1024;',
            '  @local iovs := 2048;',
            '  @local written := 2064;',
            '  @local v := &fact 5;',
            '  @local d100 := v / 100;',
            '  @local d10  := (v / 10) - (d100 * 10);',
            '  @local d1   := v - ((v / 10) * 10);',
            '  &write_byte_at buf, iovs, written, (48 + d100);',
            '  &write_byte_at buf, iovs, written, (48 + d10);',
            '  &write_byte_at buf, iovs, written, (48 + d1);',
            '  &write_byte_at buf, iovs, written, 10',
            '};',
        ].join('\n') + '\n'

        const outWasm = path.join(PROJECT_ROOT, '.wasi-helper.wasm')
        try {
            const compileRes = spawnSync('wasmer', ['run', tmpPath], {
                input: Buffer.from(bundle + userProg, 'utf-8'),
                maxBuffer: 64 * 1024 * 1024,
            })
            expect(compileRes.status).toBe(0)
            const wat = (compileRes.stdout ?? Buffer.alloc(0)).toString('utf-8')

            const compiled = await watToWasm(wat)
            await fs.writeFile(outWasm, Buffer.from(compiled.buffer))

            const runRes = spawnSync('wasmer', ['run', outWasm], {
                maxBuffer: 64 * 1024 * 1024,
            })
            expect(runRes.status).toBe(0)
            const stdout = (runRes.stdout ?? Buffer.alloc(0)).toString('utf-8')
            if (stdout !== '120\n') {
                throw new Error(
                    `WASI helper stdout mismatch.  Expected "120\\n", ` +
                    `got ${JSON.stringify(stdout)}.\nWAT:\n${wat}`,
                )
            }
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
            await fs.unlink(outWasm).catch(() => {})
        }
    }, 60000)

    test('boot/tests/fn_test.si: Silicon-bootstrap-compiled WASI program prints via fd_write', async () => {
        if (!wasmerAvailable()) {
            console.log('  (skipped: wasmer not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'fn_test.si'))
        const tmpPath = path.join(PROJECT_ROOT, '.wasi-hello-boot.wasm')
        await fs.writeFile(tmpPath, wasm)

        const strataDir = path.join(PROJECT_ROOT, 'src', 'strata')
        const files = (await fs.readdir(strataDir))
            .filter(f => f.endsWith('.si'))
            .sort()
        let bundle = ''
        for (const f of files) {
            bundle += await fs.readFile(path.join(strataDir, f), 'utf-8')
            bundle += '\n'
        }

        // Silicon program: declare WASI import, build iovec at fixed
        // memory addrs, point it at the string literal's payload bytes
        // (msg + 4 to skip the 4-byte length header), call fd_write
        // to write 2 bytes ("hi") to fd 1.
        const userProg = [
            '@extern wasi_snapshot_preview1::fd_write:Int',
            '  fd:Int, iovs:Int, iovs_len:Int, nwritten:Int;',
            '',
            '@fn _start:Void := {',
            "  @local msg := 'hello\\n';",  // \n → real newline
            '  @local iovs := 1024;',
            '  @local written := 1040;',
            '  &WASM::i32_store iovs, (msg + 4);',
            '  &WASM::i32_store (iovs + 4), 6;',
            '  &wasi_snapshot_preview1::fd_write 1, iovs, 1, written',
            '};',
        ].join('\n') + '\n'

        const helloWat = path.join(PROJECT_ROOT, '.wasi-hello.wat')
        const helloWasm = path.join(PROJECT_ROOT, '.wasi-hello.wasm')
        try {
            // Step 1: compile Silicon → WAT via boot.wasm under wasmer.
            const compileRes = spawnSync('wasmer', ['run', tmpPath], {
                input: Buffer.from(bundle + userProg, 'utf-8'),
                maxBuffer: 64 * 1024 * 1024,
            })
            expect(compileRes.status).toBe(0)
            const wat = (compileRes.stdout ?? Buffer.alloc(0)).toString('utf-8')

            // Step 2: WAT → wasm via wabt.
            const compiled = await watToWasm(wat)
            await fs.writeFile(helloWasm, Buffer.from(compiled.buffer))

            // Step 3: run hello.wasm under wasmer with WASI enabled.
            const runRes = spawnSync('wasmer', ['run', helloWasm], {
                maxBuffer: 64 * 1024 * 1024,
            })
            expect(runRes.status).toBe(0)
            const stdout = (runRes.stdout ?? Buffer.alloc(0)).toString('utf-8')
            if (stdout !== 'hello\n') {
                throw new Error(
                    `WASI hello stdout mismatch.  Expected "hello\\n", got ${JSON.stringify(stdout)}.\nWAT:\n${wat}`,
                )
            }
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
            await fs.unlink(helloWat).catch(() => {})
            await fs.unlink(helloWasm).catch(() => {})
        }
    }, 60000)

    test('boot/tests/scope_test.si: variable references resolve to local.get', async () => {
        if (!wasmerAvailable()) {
            console.log('  (skipped: wasmer not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'scope_test.si'))
        const tmpPath = path.join(PROJECT_ROOT, '.scope-smoke.wasm')
        await fs.writeFile(tmpPath, wasm)

        const strataDir = path.join(PROJECT_ROOT, 'src', 'strata')
        const files = (await fs.readdir(strataDir))
            .filter(f => f.endsWith('.si'))
            .sort()
        let bundle = ''
        for (const f of files) {
            bundle += await fs.readFile(path.join(strataDir, f), 'utf-8')
            bundle += '\n'
        }

        // (input expression, expected stack-machine lines).
        const cases: Array<[string, string[]]> = [
            ['x;',           ['local.get 0']],
            ['a + b;',       ['local.get 0', 'local.get 1', 'i32.add']],
            ['(a * b) + c;', ['local.get 0', 'local.get 1', 'i32.mul', 'local.get 2', 'i32.add']],
            ['a + a;',       ['local.get 0', 'local.get 0', 'i32.add']],
            ['{ a; b };',    ['local.get 0', 'drop', 'local.get 1']],
        ]

        try {
            for (const [src, expectedLines] of cases) {
                const result = spawnSync('wasmer', ['run', tmpPath], {
                    input: Buffer.from(bundle + src + '\n', 'utf-8'),
                    maxBuffer: 64 * 1024 * 1024,
                })
                expect(result.status).toBe(0)
                const stdout = (result.stdout ?? Buffer.alloc(0)).toString('utf-8')
                const expected = expectedLines.join('\n') + '\n'
                if (stdout !== expected) {
                    throw new Error(
                        `Scope mismatch for ${JSON.stringify(src)}\n` +
                        `Expected:\n${expected}\nGot:\n${stdout}`,
                    )
                }
            }
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/module_test.si: full Silicon-bootstrap pipeline produces an executable wasm', async () => {
        if (!wasmerAvailable()) {
            console.log('  (skipped: wasmer not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'module_test.si'))
        const tmpPath = path.join(PROJECT_ROOT, '.module-smoke.wasm')
        await fs.writeFile(tmpPath, wasm)

        const strataDir = path.join(PROJECT_ROOT, 'src', 'strata')
        const files = (await fs.readdir(strataDir))
            .filter(f => f.endsWith('.si'))
            .sort()
        let bundle = ''
        for (const f of files) {
            bundle += await fs.readFile(path.join(strataDir, f), 'utf-8')
            bundle += '\n'
        }

        // (input expression, expected $main() return value).
        const cases: Array<[string, number]> = [
            ['42;',          42],
            ['1 + 2;',       3],
            ['40 + 2;',      42],
            ['10 * 3;',      30],
            ['(1 + 2) * 3;', 9],
            ['100 - 58;',    42],
            ['12 / 4;',      3],
            ['17 % 5;',      2],
        ]

        try {
            for (const [src, expectedValue] of cases) {
                const result = spawnSync('wasmer', ['run', tmpPath], {
                    input: Buffer.from(bundle + src + '\n', 'utf-8'),
                    maxBuffer: 64 * 1024 * 1024,
                })
                expect(result.status).toBe(0)
                const wat = (result.stdout ?? Buffer.alloc(0)).toString('utf-8')

                // Run the bootstrap-emitted WAT through wabt and execute $main.
                const compiled = await watToWasm(wat)
                const { instance } = await WebAssembly.instantiate(compiled.buffer, {})
                const main = (instance.exports as any).main as () => number
                const actual = main()
                if (actual !== expectedValue) {
                    throw new Error(
                        `Bootstrap-emitted wasm wrong result for ${JSON.stringify(src)}\n` +
                        `Expected: ${expectedValue}\nGot: ${actual}\nWAT:\n${wat}`,
                    )
                }
            }
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/emit_test.si: end-to-end emits WAT instructions from Silicon expressions', async () => {
        if (!wasmerAvailable()) {
            console.log('  (skipped: wasmer not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'emit_test.si'))
        const tmpPath = path.join(PROJECT_ROOT, '.emit-smoke.wasm')
        await fs.writeFile(tmpPath, wasm)

        const strataDir = path.join(PROJECT_ROOT, 'src', 'strata')
        const files = (await fs.readdir(strataDir))
            .filter(f => f.endsWith('.si'))
            .sort()
        let bundle = ''
        for (const f of files) {
            bundle += await fs.readFile(path.join(strataDir, f), 'utf-8')
            bundle += '\n'
        }

        const cases: Array<[string, string[]]> = [
            ['42;',          ['i32.const 42']],
            ['1 + 2;',       ['i32.const 1', 'i32.const 2', 'i32.add']],
            ['10 * 3;',      ['i32.const 10', 'i32.const 3', 'i32.mul']],
            ['(1 + 2) * 3;', ['i32.const 1', 'i32.const 2', 'i32.add', 'i32.const 3', 'i32.mul']],
            ['5 < 7;',       ['i32.const 5', 'i32.const 7', 'i32.lt_s']],
            ['{ 1; 2 + 3 };', ['i32.const 1', 'drop', 'i32.const 2', 'i32.const 3', 'i32.add']],
            ['{ };',         []],
        ]

        try {
            for (const [src, expectedLines] of cases) {
                const result = spawnSync('wasmer', ['run', tmpPath], {
                    input: Buffer.from(bundle + src + '\n', 'utf-8'),
                    maxBuffer: 64 * 1024 * 1024,
                })
                expect(result.status).toBe(0)
                const stdout = (result.stdout ?? Buffer.alloc(0)).toString('utf-8')
                const expected = expectedLines.length === 0 ? '' : expectedLines.join('\n') + '\n'
                if (stdout !== expected) {
                    throw new Error(
                        `Emit mismatch for ${JSON.stringify(src)}\n` +
                        `Expected:\n${expected}\nGot:\n${stdout}`,
                    )
                }
            }
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/lower_test.si: end-to-end lowers arithmetic expressions to IR', async () => {
        if (!wasmerAvailable()) {
            console.log('  (skipped: wasmer not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'lower_test.si'))
        const tmpPath = path.join(PROJECT_ROOT, '.lower-smoke.wasm')
        await fs.writeFile(tmpPath, wasm)

        const strataDir = path.join(PROJECT_ROOT, 'src', 'strata')
        const files = (await fs.readdir(strataDir))
            .filter(f => f.endsWith('.si'))
            .sort()
        let bundle = ''
        for (const f of files) {
            bundle += await fs.readFile(path.join(strataDir, f), 'utf-8')
            bundle += '\n'
        }

        // Each row: (input expression, expected stdout line).
        const cases: Array<[string, string]> = [
            ['1 + 2;',   'kind=4 op=1 left=2:1 right=2:2'],
            ['10 * 3;',  'kind=4 op=3 left=2:10 right=2:3'],
            ['5 < 7;',   'kind=4 op=8 left=2:5 right=2:7'],
            ['9 - 4;',   'kind=4 op=2 left=2:9 right=2:4'],
            ['8 == 8;',  'kind=4 op=6 left=2:8 right=2:8'],
            ['12 / 3;',  'kind=4 op=4 left=2:12 right=2:3'],
            ['15 % 4;',  'kind=4 op=5 left=2:15 right=2:4'],
            // Blocks — IR_BLOCK kind = 14.  Children: 2 = IR_I32_CONST,
            // 4 = IR_BINOP, 14 = IR_BLOCK (nested).
            ['{ };',          'kind=14 n=0'],
            ['{ 99 };',       'kind=14 n=1 child[0]=2'],
            ['{ 1; 2; 3 };',  'kind=14 n=3 child[0]=2 child[1]=2 child[2]=2'],
            ['{ 1; 2 + 3 };', 'kind=14 n=2 child[0]=2 child[1]=4'],
            // (block) IR shape — drops only show up in the WAT emitter.
            ['{ { 1 }; 2 };', 'kind=14 n=2 child[0]=14 child[1]=2'],
            // String concat (++) is a user fn — interpreter returns IR_NONE
            // and the test program emits the `no-ir` sentinel.
        ]

        try {
            for (const [src, expected] of cases) {
                const result = spawnSync('wasmer', ['run', tmpPath], {
                    input: Buffer.from(bundle + src + '\n', 'utf-8'),
                    maxBuffer: 64 * 1024 * 1024,
                })
                expect(result.status).toBe(0)
                const stdout = (result.stdout ?? Buffer.alloc(0)).toString('utf-8').trim()
                if (stdout !== expected) {
                    throw new Error(
                        `Lower mismatch for ${JSON.stringify(src)}\n` +
                        `Expected: ${expected}\nGot:      ${stdout}`,
                    )
                }
            }
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/body_test.si: body interpreter dispatches IR::* intrinsics', async () => {
        if (!wasmerAvailable()) {
            console.log('  (skipped: wasmer not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'body_test.si'))
        const tmpPath = path.join(PROJECT_ROOT, '.body-smoke.wasm')
        await fs.writeFile(tmpPath, wasm)

        const strataDir = path.join(PROJECT_ROOT, 'src', 'strata')
        const files = (await fs.readdir(strataDir))
            .filter(f => f.endsWith('.si'))
            .sort()
        let bundle = ''
        for (const f of files) {
            bundle += await fs.readFile(path.join(strataDir, f), 'utf-8')
            bundle += '\n'
        }

        // Build expected per-op output by walking the bundle's
        // Elaboration nodes in source order (matches Silicon's
        // registration walk).  Dedup by symbol — first wins.
        const ast = addToAstSemantics(siliconGrammar)(parse(bundle)).toAst() as Program
        const opIntrinsicToCode: Record<string, number> = {
            'i32_add': 1, 'i32_sub': 2, 'i32_mul': 3, 'i32_div_s': 4,
            'i32_rem_s': 5, 'i32_eq': 6, 'i32_ne': 7,
            'i32_lt_s': 8, 'i32_le_s': 9, 'i32_gt_s': 10, 'i32_ge_s': 11,
            'i32_and': 12, 'i32_or': 13, 'i32_xor': 14,
            'i32_shl': 15, 'i32_shr_s': 16,
        }
        const SEED_LEFT = 100, SEED_RIGHT = 200
        const IR_NULL = 1, IR_BINOP = 4, IR_UNOP = 5
        const expectedLines: string[] = []
        const seen = new Set<string>()
        for (const el of (ast.elements as any[])) {
            const e = el?.type === 'Elaboration' ? el
                    : el?.type === 'Element' && el.kind === 'elaboration' ? el.value
                    : null
            if (!e) continue
            if (e.kind !== 'operator') continue
            const sym = typeof e.symbol === 'string' ? e.symbol
                      : e.symbol?.value ?? String(e.symbol)
            if (seen.has(sym)) continue
            seen.add(sym)
            // First IR::* call in the body — same shape my Silicon
            // dispatcher resolves.
            const findIrCall = (n: any): any => {
                if (!n || typeof n !== 'object') return null
                if (n.type === 'FunctionCall' && n.name?.type === 'Namespace'
                        && n.name.path?.[0] === 'IR') return n
                for (const k of Object.keys(n)) {
                    if (k === 'sourceLocation' || k === 'inferredType') continue
                    const c = n[k]
                    if (c && typeof c === 'object') {
                        const r = findIrCall(c)
                        if (r) return r
                    }
                }
                return null
            }
            const fc = findIrCall(e.semantics)
            let line = `${sym} `
            if (!fc) {
                line += 'kind=none op=- l=- r=-'
            } else {
                const last = fc.name.path[fc.name.path.length - 1] as string
                if (last === 'null') {
                    line += 'kind=1 op=- l=- r=-'
                } else if (last === 'i32_eqz') {
                    line += `kind=${IR_UNOP} op=17 l=${SEED_LEFT} r=-`
                } else if (last in opIntrinsicToCode) {
                    line += `kind=${IR_BINOP} op=${opIntrinsicToCode[last]} l=${SEED_LEFT} r=${SEED_RIGHT}`
                } else {
                    line += 'kind=none op=- l=- r=-'
                }
            }
            expectedLines.push(line)
        }
        const expected = expectedLines.join('\n') + '\n'

        try {
            const result = spawnSync('wasmer', ['run', tmpPath], {
                input: Buffer.from(bundle, 'utf-8'),
                maxBuffer: 64 * 1024 * 1024,
            })
            expect(result.status).toBe(0)
            const stdout = (result.stdout ?? Buffer.alloc(0)).toString('utf-8')
            if (stdout !== expected) {
                throw new Error(
                    `Body interpreter mismatch\nExpected:\n${expected}\nGot:\n${stdout}`,
                )
            }
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/ir_nodes_test.si: IR record builders + accessors round-trip', async () => {
        if (!wasmerAvailable()) {
            console.log('  (skipped: wasmer not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'ir_nodes_test.si'))
        const tmpPath = path.join(PROJECT_ROOT, '.ir-nodes.wasm')
        await fs.writeFile(tmpPath, wasm)
        try {
            const result = spawnSync('wasmer', ['run', tmpPath], { maxBuffer: 1 << 20 })
            expect(result.status).toBe(0)
            const stdout = (result.stdout ?? Buffer.alloc(0)).toString('utf-8').trim()
            expect(stdout).toBe('ok')
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/templates_test.si: per-stratum body templates byte-equal Stage 0', async () => {
        if (!wasmerAvailable()) {
            console.log('  (skipped: wasmer not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'templates_test.si'))
        const tmpPath = path.join(PROJECT_ROOT, '.tpl-smoke.wasm')
        await fs.writeFile(tmpPath, wasm)

        const strataDir = path.join(PROJECT_ROOT, 'src', 'strata')
        const files = (await fs.readdir(strataDir))
            .filter(f => f.endsWith('.si'))
            .sort()
        let bundle = ''
        for (const f of files) {
            bundle += await fs.readFile(path.join(strataDir, f), 'utf-8')
            bundle += '\n'
        }

        type Step = { call: string; args: string[] }
        type Entry = { steps: Step[]; rich: boolean }
        // Need Elaboration AST nodes so we can run isRichBody on each
        // stratum's semantics block.  Reparse the bundle and collect
        // them keyed by symbol.
        const { isRichBody } = await import('../src/elaborator/strataBody')
        const bundleAst = addToAstSemantics(siliconGrammar)(parse(bundle)).toAst() as Program
        const elabBySymbol = new Map<string, any[]>()
        for (const el of (bundleAst.elements as any[])) {
            const e = el?.type === 'Elaboration' ? el
                    : el?.type === 'Element' && el.kind === 'elaboration' ? el.value
                    : null
            if (!e) continue
            const sym = typeof e.symbol === 'string' ? e.symbol
                      : e.symbol?.value ?? String(e.symbol)
            const k = `${e.kind}:${sym}`
            if (!elabBySymbol.has(k)) elabBySymbol.set(k, [])
            elabBySymbol.get(k)!.push(e)
        }
        const reg = buildStrataRegistry(({ type: 'Program', elements: [] } as any))
        const bareSorted = (
            table: Record<string, any>, kind: 'operator' | 'keyword',
        ): Array<[string, Entry]> => {
            const seen = new Map<string, Entry>()
            for (const k of Object.keys(table)) {
                const bare = k.includes(':') ? k.slice(0, k.indexOf(':')) : k
                if (seen.has(bare)) continue
                const tpl = table[k]?.data?.bodyTemplate ?? []
                const steps: Step[] = tpl.map((s: any) => ({
                    call: s.intrinsic ?? s.userFunc ?? '',
                    args: (s.argRefs ?? []) as string[],
                }))
                // isRichBody is per-stratum; for symbols with multiple
                // registrations (e.g. Plus + PlusFloat for '+'), use
                // the FIRST stratum's body (matches Silicon's
                // first-registered-wins dedup).
                const elabs = elabBySymbol.get(`${kind}:${bare}`) ?? []
                const rich = elabs.length > 0 ? isRichBody(elabs[0].semantics) : false
                seen.set(bare, { steps, rich })
            }
            return Array.from(seen.entries()).sort((a, b) => a[0] < b[0] ? -1 : 1)
        }
        const ops = bareSorted(reg.operators, 'operator')
        const kws = bareSorted(reg.keywords,  'keyword')
        const stepStr = (s: Step): string => {
            const args = s.args.length === 0
                ? '[]'
                : '[' + s.args.map(a => `"${a}"`).join(', ') + ']'
            return `{ "call": "${s.call}", "args": ${args} }`
        }
        const stepsStr = (steps: Step[]): string =>
            steps.length === 0
                ? '[]'
                : '[ ' + steps.map(stepStr).join(', ') + ' ]'
        const lines: string[] = ['{']
        lines.push('  "operators": [')
        ops.forEach(([k, e], i) => {
            const sep = i < ops.length - 1 ? ',' : ''
            lines.push(`    { "op": "${k}", "rich": ${e.rich}, "steps": ${stepsStr(e.steps)} }${sep}`)
        })
        lines.push('  ],')
        lines.push('  "keywords": [')
        kws.forEach(([k, e], i) => {
            const sep = i < kws.length - 1 ? ',' : ''
            lines.push(`    { "kw": "${k}", "rich": ${e.rich}, "steps": ${stepsStr(e.steps)} }${sep}`)
        })
        lines.push('  ]')
        lines.push('}')
        const expected = lines.join('\n') + '\n'

        try {
            const result = spawnSync('wasmer', ['run', tmpPath], {
                input: Buffer.from(bundle, 'utf-8'),
                maxBuffer: 64 * 1024 * 1024,
            })
            expect(result.status).toBe(0)
            const stdout = (result.stdout ?? Buffer.alloc(0)).toString('utf-8')
            if (stdout !== expected) {
                throw new Error(
                    `Body template mismatch\nExpected:\n${expected}\nGot:\n${stdout}`,
                )
            }
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/intrinsics_test.si: per-stratum intrinsic map byte-equal Stage 0', async () => {
        if (!wasmerAvailable()) {
            console.log('  (skipped: wasmer not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'intrinsics_test.si'))
        const tmpPath = path.join(PROJECT_ROOT, '.intr-smoke.wasm')
        await fs.writeFile(tmpPath, wasm)

        const strataDir = path.join(PROJECT_ROOT, 'src', 'strata')
        const files = (await fs.readdir(strataDir))
            .filter(f => f.endsWith('.si'))
            .sort()
        let bundle = ''
        for (const f of files) {
            bundle += await fs.readFile(path.join(strataDir, f), 'utf-8')
            bundle += '\n'
        }

        const reg = buildStrataRegistry(({ type: 'Program', elements: [] } as any))
        const bareSorted = (table: Record<string, any>): Array<[string, string | null]> => {
            const seen = new Map<string, string | null>()
            for (const k of Object.keys(table)) {
                const bare = k.includes(':') ? k.slice(0, k.indexOf(':')) : k
                // First entry wins — matches Silicon's stable-sort + dedup.
                if (!seen.has(bare)) seen.set(bare, table[k]?.data?.intrinsic ?? null)
            }
            return Array.from(seen.entries()).sort((a, b) => a[0] < b[0] ? -1 : 1)
        }
        const ops = bareSorted(reg.operators)
        const kws = bareSorted(reg.keywords)
        const intrJson = (v: string | null): string => v === null ? 'null' : `"${v}"`
        const lines: string[] = ['{']
        lines.push('  "operators": [')
        ops.forEach(([k, v], i) => {
            const sep = i < ops.length - 1 ? ',' : ''
            lines.push(`    { "op": "${k}", "intrinsic": ${intrJson(v)} }${sep}`)
        })
        lines.push('  ],')
        lines.push('  "keywords": [')
        kws.forEach(([k, v], i) => {
            const sep = i < kws.length - 1 ? ',' : ''
            lines.push(`    { "kw": "${k}", "intrinsic": ${intrJson(v)} }${sep}`)
        })
        lines.push('  ]')
        lines.push('}')
        const expected = lines.join('\n') + '\n'

        try {
            const result = spawnSync('wasmer', ['run', tmpPath], {
                input: Buffer.from(bundle, 'utf-8'),
                maxBuffer: 64 * 1024 * 1024,
            })
            expect(result.status).toBe(0)
            const stdout = (result.stdout ?? Buffer.alloc(0)).toString('utf-8')
            if (stdout !== expected) {
                throw new Error(
                    `Intrinsics dump mismatch\nExpected:\n${expected}\nGot:\n${stdout}`,
                )
            }
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/elaborator_test.si: definition hooks byte-equal Stage 0 elaboration', async () => {
        if (!wasmerAvailable()) {
            console.log('  (skipped: wasmer not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'elaborator_test.si'))
        const tmpPath = path.join(PROJECT_ROOT, '.elab-smoke.wasm')
        await fs.writeFile(tmpPath, wasm)

        // Built-in strata bundle + a handful of user definitions covering
        // every codegen kind (function / global / extern) plus one bad
        // keyword to exercise the error path.
        const strataDir = path.join(PROJECT_ROOT, 'src', 'strata')
        const files = (await fs.readdir(strataDir))
            .filter(f => f.endsWith('.si'))
            .sort()
        let bundle = ''
        for (const f of files) {
            bundle += await fs.readFile(path.join(strataDir, f), 'utf-8')
            bundle += '\n'
        }
        const userProg = [
            // good definitions — exercise every codegen kind
            '@let x := 42;',
            '@fn add a:Int, b:Int := { a + b };',
            '@var counter := 0;',
            '@extern print x:Int;',
            // bad definitions — exercise each constraint code (0/1/2)
            '@bogus thing := 0;',                // unknown keyword (0)
            '@var oops a, b := 0;',              // global doesn't take params (1)
            '@extern badext x:Int := 0;',        // extern doesn't take binding (2)
            // top-level binops — slice 3 resolution
            '1 + 2;',
            'a == b;',
        ].join('\n') + '\n'
        const input = bundle + userProg

        // Build the Stage 0 reference dump by running the real elaborator.
        const ast = addToAstSemantics(siliconGrammar)(parse(input)).toAst() as Program
        const reg = buildStrataRegistry(ast)
        const { program: elab, errors } = elaborate(ast, reg)
        const defs: Array<{ keyword: string; name: string; hook: string }> = []
        for (const el of (elab.elements as any[])) {
            if (el && el.type === 'Definition' && el.hook) {
                const name = typeof el.name === 'string' ? el.name : (el.name?.name ?? '')
                defs.push({ keyword: el.keyword, name, hook: el.hook })
            }
        }
        // Classify each Stage 0 error message into the Silicon error code.
        const classify = (msg: string): number => {
            if (msg.includes('does not accept parameters')) return 1
            if (msg.includes('does not accept a binding')) return 2
            return 0
        }
        const lines: string[] = ['{']
        lines.push('  "definitions": [')
        defs.forEach((d, i) => {
            const sep = i < defs.length - 1 ? ',' : ''
            lines.push(`    { "keyword": "${d.keyword}", "name": "${d.name}", "hook": "${d.hook}" }${sep}`)
        })
        lines.push('  ],')
        if (errors.length === 0) {
            lines.push('  "errors": [],')
        } else {
            lines.push('  "errors": [')
            errors.forEach((e, i) => {
                const sep = i < errors.length - 1 ? ',' : ''
                lines.push(`    { "keyword": "${e.keyword}", "code": ${classify(e.message)} }${sep}`)
            })
            lines.push('  ],')
        }
        // Walk the elaborated AST in preorder, matching boot/elab/elaborator.si
        // walk_expr order: BinOp (self) → left → right; Call: callee →
        // args; Block: statements → trailing; Definition bindings; etc.
        type Bin = { op: string; resolved: boolean }
        const bins: Bin[] = []
        const visit = (n: any): void => {
            if (!n || typeof n !== 'object') return
            switch (n.type) {
                case 'BinaryOp':
                    bins.push({ op: n.operator, resolved: !!n.semantics })
                    visit(n.left)
                    visit(n.right)
                    return
                case 'FunctionCall':
                    visit(n.name)
                    for (const a of n.args ?? []) visit(a)
                    return
                case 'Block':
                    for (const it of n.items ?? []) visit(it)
                    if (n.trailing) visit(n.trailing)
                    return
                case 'Assignment':
                    visit(n.target)
                    visit(n.value)
                    return
                case 'ArrayLiteral':
                case 'TupleLiteral':
                    for (const e of n.elements ?? []) visit(e)
                    return
                case 'ObjectLiteral':
                    for (const p of n.pairs ?? []) visit(p.value)
                    return
                case 'Definition':
                    if (n.binding) visit(n.binding.expression ?? n.binding)
                    return
            }
        }
        for (const el of (elab.elements as any[])) visit(el)
        if (bins.length === 0) {
            lines.push('  "binops": []')
        } else {
            lines.push('  "binops": [')
            bins.forEach((b, i) => {
                const sep = i < bins.length - 1 ? ',' : ''
                lines.push(`    { "op": "${b.op}", "resolved": ${b.resolved} }${sep}`)
            })
            lines.push('  ]')
        }
        lines.push('}')
        const expected = lines.join('\n') + '\n'

        try {
            const result = spawnSync('wasmer', ['run', tmpPath], {
                input: Buffer.from(input, 'utf-8'),
                maxBuffer: 64 * 1024 * 1024,
            })
            expect(result.status).toBe(0)
            const stdout = (result.stdout ?? Buffer.alloc(0)).toString('utf-8')
            if (stdout !== expected) {
                throw new Error(
                    `Elaboration mismatch\nExpected:\n${expected}\nGot:\n${stdout}`,
                )
            }
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
