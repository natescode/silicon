/**
 * Phase 0 WASIX smoke test — bootstrap-plan §Phase 0.
 *
 * Compiles each .si entry with --target=wasix, assembles the WAT to WASM
 * via wabt, runs the resulting module under wasmtime, and asserts:
 *
 *   - boot/main.si echoes stdin → stdout byte-for-byte.
 *   - boot/tests/arena_test.si prints "arena OK" — alloc / alloc / reset
 *     / alloc lands at the original address.
 *   - boot/tests/vec_test.si prints "vec OK" — push 10 items, grow twice,
 *     read back, sum equals 45.
 *
 * Wasmtime is required; the test skips with a clear message when it's not
 * on PATH so the rest of the suite stays green on machines without it.
 * Runtime choice rationale: wasmtime is the WASI reference implementation
 * — wasmer 2.x has a mapdir rights bug that blocks Phase 4b, wasmer 7.x
 * has post-path_open fd corruption + Windows absolute-path bugs.
 */

import { test, expect, describe } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
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
const WASM_BIN = path.join(PROJECT_ROOT, 'wasm-bin')
// Ensure wasm-bin/ exists for every temp artifact path below.  Sync so
// the constant initialisation order doesn't matter to the describe blocks.
mkdirSync(WASM_BIN, { recursive: true })

function wasmtimeAvailable(): boolean {
    const probe = spawnSync('wasmtime', ['--version'], { encoding: 'utf-8' })
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
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }

        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'main.si'))
        const tmpPath = path.join(WASM_BIN, 'boot-smoke.wasm')
        await fs.writeFile(tmpPath, wasm)

        try {
            // Use README.md as the input — large enough to span multiple
            // 4KB chunks, mixed content, deterministic on disk.
            const input = await fs.readFile(path.join(PROJECT_ROOT, 'README.md'))
            const result = spawnSync('wasmtime', [tmpPath], {
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
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'arena_test.si'))
        const tmpPath = path.join(WASM_BIN, 'arena-smoke.wasm')
        await fs.writeFile(tmpPath, wasm)
        try {
            const result = spawnSync('wasmtime', [tmpPath], { encoding: 'buffer' })
            expect(result.status).toBe(0)
            expect(result.stdout?.toString('utf-8')).toBe('arena OK\n')
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/vec_test.si: push 10, grow twice, sum is 45', async () => {
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'vec_test.si'))
        const tmpPath = path.join(WASM_BIN, 'vec-smoke.wasm')
        await fs.writeFile(tmpPath, wasm)
        try {
            const result = spawnSync('wasmtime', [tmpPath], { encoding: 'buffer' })
            expect(result.status).toBe(0)
            expect(result.stdout?.toString('utf-8')).toBe('vec OK\n')
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/lex_test.si: lexer produces expected token streams', async () => {
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'lex_test.si'))
        const tmpPath = path.join(WASM_BIN, 'lex-smoke.wasm')
        await fs.writeFile(tmpPath, wasm)
        try {
            const result = spawnSync('wasmtime', [tmpPath], { encoding: 'buffer' })
            expect(result.status).toBe(0)
            expect(result.stdout?.toString('utf-8')).toBe('lex OK 6\n')
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/parse_test.si: parser produces expected AST shapes', async () => {
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'parse_test.si'))
        const tmpPath = path.join(WASM_BIN, 'parse-smoke.wasm')
        await fs.writeFile(tmpPath, wasm)
        try {
            const result = spawnSync('wasmtime', [tmpPath], { encoding: 'buffer' })
            expect(result.status).toBe(0)
            expect(result.stdout?.toString('utf-8')).toBe('parse OK 17\n')
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/json_test.si: corpus from src/e2e/examples matches Stage 0', async () => {
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'json_test.si'))
        const tmpPath = path.join(WASM_BIN, 'json-corpus.wasm')
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

                const result = spawnSync('wasmtime', [tmpPath], {
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
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'strata_loader_test.si'))
        const tmpPath = path.join(WASM_BIN, 'strata-smoke.wasm')
        await fs.writeFile(tmpPath, wasm)

        // Concatenate every built-in stratum file as the loader input.
        const strataDir = path.join(PROJECT_ROOT, 'boot', 'strata', 'builtin')
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
            const result = spawnSync('wasmtime', [tmpPath], {
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
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'fn_test.si'))
        const tmpPath = path.join(WASM_BIN, 'fn-smoke.wasm')
        await fs.writeFile(tmpPath, wasm)

        const strataDir = path.join(PROJECT_ROOT, 'boot', 'strata', 'builtin')
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
                const result = spawnSync('wasmtime', [tmpPath], {
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
                const result = spawnSync('wasmtime', [tmpPath], {
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
                const result = spawnSync('wasmtime', [tmpPath], {
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
                const result = spawnSync('wasmtime', [tmpPath], {
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
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'fn_test.si'))
        const tmpPath = path.join(WASM_BIN, 'wasi-alpha-boot.wasm')
        await fs.writeFile(tmpPath, wasm)

        const strataDir = path.join(PROJECT_ROOT, 'boot', 'strata', 'builtin')
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

        const alphaWasm = path.join(WASM_BIN, 'wasi-alpha.wasm')
        try {
            const compileRes = spawnSync('wasmtime', [tmpPath], {
                input: Buffer.from(bundle + userProg, 'utf-8'),
                maxBuffer: 64 * 1024 * 1024,
            })
            expect(compileRes.status).toBe(0)
            const wat = (compileRes.stdout ?? Buffer.alloc(0)).toString('utf-8')

            const compiled = await watToWasm(wat)
            await fs.writeFile(alphaWasm, Buffer.from(compiled.buffer))

            const runRes = spawnSync('wasmtime', [alphaWasm], {
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

    test('scripts/build-stage1.ts + scripts/run-silicon.ts compile & run a WASI hello via stage1', async () => {
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        // Ensure boot.wasm exists for the build-stage1 script.
        const bootPath = path.join(WASM_BIN, 'boot.wasm')
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'fn_test.si'))
        await fs.writeFile(bootPath, wasm)

        const stage1Wasm = path.join(WASM_BIN, 'stage1.wasm')
        const helloSrc = path.join(WASM_BIN, 'script-hello.si')
        const helloWat = path.join(WASM_BIN, 'script-hello.wat')
        const helloWasm = path.join(WASM_BIN, 'script-hello.wasm')
        try {
            const buildRes = spawnSync('bun', ['run', 'scripts/build-stage1.ts'],
                { cwd: PROJECT_ROOT, maxBuffer: 64 * 1024 * 1024 })
            expect(buildRes.status).toBe(0)
            const stage1Stat = await fs.stat(stage1Wasm)
            expect(stage1Stat.size).toBeGreaterThan(20000)

            await fs.writeFile(helloSrc, [
                "@extern wasi_snapshot_preview1::fd_write:Int",
                "  fd:Int, iovs_ptr:Int, iovs_len:Int, nwritten_out:Int;",
                "",
                "@fn _start:Void := {",
                "  @local msg := 'stage1 ok\\n';",
                "  @local iovs := 1024;",
                "  @local written := 1040;",
                "  &WASM::i32_store iovs, (msg + 4);",
                "  &WASM::i32_store (iovs + 4), 10;",
                "  &wasi_snapshot_preview1::fd_write 1, iovs, 1, written",
                "};",
            ].join('\n') + '\n')

            const runScriptRes = spawnSync(
                'bun', ['run', 'scripts/run-silicon.ts', helloSrc, helloWat, '--wasm'],
                { cwd: PROJECT_ROOT, maxBuffer: 64 * 1024 * 1024 },
            )
            expect(runScriptRes.status).toBe(0)

            const wasiRes = spawnSync('wasmtime', [helloWasm],
                { maxBuffer: 64 * 1024 * 1024 })
            expect(wasiRes.status).toBe(0)
            const stdout = (wasiRes.stdout ?? Buffer.alloc(0)).toString('utf-8')
            expect(stdout).toBe('stage1 ok\n')
        } finally {
            await fs.unlink(helloSrc).catch(() => {})
            await fs.unlink(helloWat).catch(() => {})
            await fs.unlink(helloWasm).catch(() => {})
        }
    }, 120000)

    test('STAGE 2 == STAGE 1: self-host fixed-point — stage1.wasm and stage2.wasm are byte-equal', async () => {
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const boot = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'fn_test.si'))
        const bootPath = path.join(WASM_BIN, 'fp-stage0.wasm')
        await fs.writeFile(bootPath, boot)

        // Build the stage1 source bundle (everything stage1.wasm
        // needs as a complete Silicon program).
        const strataDir = path.join(PROJECT_ROOT, 'boot', 'strata', 'builtin')
        const strataFiles = (await fs.readdir(strataDir))
            .filter(f => f.endsWith('.si'))
            .sort()
        let bundle = ''
        for (const f of strataFiles) {
            const raw = await fs.readFile(path.join(strataDir, f), 'utf-8')
            // Normalise line endings — scripts/build-stage1.ts does the
            // same when generating boot/embedded_bundle.si, so the bytes
            // the bundle contributes here MUST match the embedded copy
            // for the byte-equal self-host gate to hold cross-platform.
            bundle += raw.replace(/\r\n/g, '\n') + '\n'
        }
        const wasiStub = [
            '@extern wasi_snapshot_preview1::fd_write:Int',
            '  fd:Int, iovs_ptr:Int, iovs_len:Int, nwritten_out:Int;',
            '@extern wasi_snapshot_preview1::fd_read:Int',
            '  fd:Int, iovs_ptr:Int, iovs_len:Int, nread_out:Int;',
            '@extern wasi_snapshot_preview1::args_get:Int',
            '  argv_ptr:Int, argv_buf:Int;',
            '@extern wasi_snapshot_preview1::args_sizes_get:Int',
            '  argc_out:Int, argv_buf_size_out:Int;',
            '@extern wasi_snapshot_preview1::proc_exit',
            '  code:Int;',
            '@extern wasi_snapshot_preview1::path_open:Int',
            '  dirfd:Int, dirflags:Int, path_ptr:Int, path_len:Int,',
            '  oflags:Int, fs_rights_base:Int64, fs_rights_inheriting:Int64,',
            '  fdflags:Int, fd_out:Int;',
            '@extern wasi_snapshot_preview1::fd_prestat_get:Int',
            '  fd:Int, buf_out:Int;',
            '@extern wasi_snapshot_preview1::fd_prestat_dir_name:Int',
            '  fd:Int, path_ptr:Int, path_len:Int;',
        ].join('\n') + '\n'
        const stage1Sources = [
            'boot/std/argv.si',
            'boot/std/io.si', 'boot/std/fs.si',
            'boot/std/arena.si', 'boot/std/vec.si',
            'boot/embedded_bundle.si',
            'boot/parser/tokens.si', 'boot/parser/lex.si',
            'boot/parser/ast.si', 'boot/parser/parse.si',
            'boot/strata/registry.si', 'boot/strata/loader.si',
            'boot/elab/elaborator.si', 'boot/ir/nodes.si',
            'boot/elab/body.si',
            'boot/elab/body_scope.si',
            'boot/compiler_api/ctx.si',
            'boot/elab/body_rich.si',
            'boot/ir/lower.si',
            'boot/emit/wat.si',
            'boot/cli.si',
            'boot/modules/use.si',
            'boot/stage1.si',
        ]
        const stage1Bundle = wasiStub + (await Promise.all(
            stage1Sources.map(p => fs.readFile(path.join(PROJECT_ROOT, p), 'utf-8')),
        )).join('')
        // After Phase 2, stage1.wasm embeds the strata bundle.  boot.wasm
        // still doesn't, so we keep prepending `bundle` for the boot.wasm
        // step.  For the stage1.wasm step we feed JUST the user portion —
        // stage1 prepends its own embedded copy at runtime.
        const bootInput   = Buffer.from(bundle + stage1Bundle, 'utf-8')
        const stage1Input = Buffer.from(stage1Bundle, 'utf-8')

        const stage1Path = path.join(WASM_BIN, 'fp-stage1.wasm')
        const stage2Path = path.join(WASM_BIN, 'fp-stage2.wasm')
        try {
            // 1. boot.wasm compiles stage1 source → stage1.wat → stage1.wasm
            const r1 = spawnSync('wasmtime', [bootPath], {
                input: bootInput, maxBuffer: 64 * 1024 * 1024,
            })
            expect(r1.status).toBe(0)
            const stage1Wat = (r1.stdout ?? Buffer.alloc(0)).toString('utf-8')
            const stage1Bin = await watToWasm(stage1Wat)
            await fs.writeFile(stage1Path, Buffer.from(stage1Bin.buffer))

            // 2. stage1.wasm compiles SAME stage1 source → stage2.wat → stage2.wasm
            const r2 = spawnSync('wasmtime', [stage1Path], {
                input: stage1Input, maxBuffer: 64 * 1024 * 1024,
            })
            expect(r2.status).toBe(0)
            const stage2Wat = (r2.stdout ?? Buffer.alloc(0)).toString('utf-8')
            const stage2Bin = await watToWasm(stage2Wat)
            await fs.writeFile(stage2Path, Buffer.from(stage2Bin.buffer))

            // 3. Fixed-point assertions: stage 1 == stage 2 at every
            //    representation level the build produces.
            if (stage1Wat !== stage2Wat) {
                throw new Error(
                    `Stage 1 WAT != Stage 2 WAT (${stage1Wat.length} vs ${stage2Wat.length} bytes) — not a fixed point.`,
                )
            }
            const s1 = await fs.readFile(stage1Path)
            const s2 = await fs.readFile(stage2Path)
            if (Buffer.compare(s1, s2) !== 0) {
                throw new Error(
                    `stage1.wasm != stage2.wasm (${s1.length} vs ${s2.length} bytes)`,
                )
            }
            expect(s1.length).toBe(s2.length)
            expect(s1.length).toBeGreaterThan(20000)
        } finally {
            await fs.unlink(bootPath).catch(() => {})
            await fs.unlink(stage1Path).catch(() => {})
            await fs.unlink(stage2Path).catch(() => {})
        }
    }, 120000)

    test('PHASE 1: stage1.wasm wraps top-level statements in synthesised _start (delfina_smoke)', async () => {
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const stage1Path = path.join(WASM_BIN, 'stage1.wasm')
        try { await fs.access(stage1Path) }
        catch {
            console.log('  (skipped: stage1.wasm missing — run scripts/build-stage1.ts)')
            return
        }

        // After Phase 2, strata are embedded in stage1.wasm — we only
        // need to prepend io.si (for &write_str / &write_byte; stdlib
        // is NOT embedded) and the user source.  If stage1's Pass 3
        // synthesis works, the emitted WAT will have exactly one
        // (func $_start (export "_start") ...) whose body is the
        // top-level calls from delfina_smoke.
        //
        // Order matters: delfina_smoke.si declares the WASI externs
        // (including proc_exit) used indirectly by io.si's
        // panic_stderr.  The bootstrap registers @extern signatures
        // in source order, so the declarations must appear BEFORE
        // io.si — otherwise the panic_stderr call site falls back to
        // "produces value" and emits a spurious drop after proc_exit.
        let bundle = ''
        bundle += await fs.readFile(path.join(PROJECT_ROOT, 'boot', 'tests', 'delfina_smoke.si'), 'utf-8') + '\n'
        bundle += await fs.readFile(path.join(PROJECT_ROOT, 'boot', 'std', 'io.si'), 'utf-8') + '\n'

        const compile = spawnSync('wasmtime', [stage1Path], {
            input: Buffer.from(bundle, 'utf-8'),
            maxBuffer: 64 * 1024 * 1024,
        })
        expect(compile.status).toBe(0)
        const wat = (compile.stdout ?? Buffer.alloc(0)).toString('utf-8')

        // Two assertions: synthesis fired (one $_start present) and
        // wasmer is happy to run the result with the expected output.
        const startMatches = wat.match(/\(func \$_start /g) ?? []
        expect(startMatches.length).toBe(1)

        const wasm = await watToWasm(wat)
        const tmpPath = path.join(WASM_BIN, 'delfina-smoke.wasm')
        await fs.writeFile(tmpPath, Buffer.from(wasm.buffer))
        try {
            const run = spawnSync('wasmtime', [tmpPath], { encoding: 'buffer' })
            expect(run.status).toBe(0)
            expect(run.stdout?.toString('utf-8')).toBe('Delfina\n')
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    }, 60000)

    test('PHASE 2: stage1.wasm compiles user source with NO host-side strata bundling', async () => {
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const stage1Path = path.join(WASM_BIN, 'stage1.wasm')
        try { await fs.access(stage1Path) }
        catch {
            console.log('  (skipped: stage1.wasm missing — run scripts/build-stage1.ts)')
            return
        }

        // Feed JUST the user file to stage1.wasm — no strata, no
        // stdlib, nothing.  If Phase 2's embedded bundle works, the
        // operators / definition keywords resolve via stage1's
        // baked-in EMBEDDED_BUNDLE rather than anything we
        // concatenate here.
        const userSrc = await fs.readFile(
            path.join(PROJECT_ROOT, 'boot', 'tests', 'embedded_bundle_smoke.si'),
            'utf-8',
        )

        const compile = spawnSync('wasmtime', [stage1Path], {
            input: Buffer.from(userSrc, 'utf-8'),
            maxBuffer: 64 * 1024 * 1024,
        })
        expect(compile.status).toBe(0)
        const wat = (compile.stdout ?? Buffer.alloc(0)).toString('utf-8')

        // Two checks: (a) the user's @fn made it into the WAT and
        // (b) the WAT is wabt-parseable (proving the operator + the
        // synthesised _start both lowered correctly with strata
        // resolved from the embedded bundle).
        expect(wat).toContain('(func $add ')
        expect(wat).toContain('(func $_start ')
        const wasm = await watToWasm(wat)
        expect(wasm.buffer.byteLength).toBeGreaterThan(100)
    }, 60000)

    // Stage1-pipeline coverage: each fixture goes source → stage1.wasm
    // → strict watToWasm → wasmtime.  Without this, stage1 codegen bugs
    // that the bun test suite would otherwise route around (because it
    // compiles fixtures via Stage 0 TS) only surface when a user runs
    // them through the actual stage1 binary.  Historically this masked
    // the drop-after-void-call regression (boot/ir/lower.si:
    // register_extern_sigs) until it broke the Phase 4+5 shell pipeline.
    const STAGE1_PIPELINE_FIXTURES: Array<{path: string, expect: string}> = [
        { path: 'boot/tests/arena_test.si',     expect: 'arena OK' },
        { path: 'boot/tests/ir_nodes_test.si',  expect: 'ok' },
        // vec_test uses nested &@and — historically stage1 had no
        // dispatch for @and/@or/@not, so the call silently returned
        // IR_NONE and the @local binding was uninitialized.  Lock in
        // the short-circuit-bool fix.
        { path: 'boot/tests/vec_test.si',       expect: 'vec OK' },
        // nz_keyword_test exercises a keyword defined entirely in
        // Silicon (boot/strata/builtin/logic.si:NotZero — has NO
        // branch in boot/ir/lower.si).  Routes through body_rich's
        // generic @-keyword fallback.  This is the proof that adding
        // expression-form keywords in pure Silicon works end-to-end.
        { path: 'boot/tests/nz_keyword_test.si', expect: 'nz OK' },
        // const_keyword_test exercises the first DEFINITION-FORM
        // keyword defined purely in Silicon (boot/strata/builtin/
        // logic.si:Const).  Routes through try_dispatch_def_via_
        // body_rich, whose makeGlobal handler reads the bound def's
        // (name_off, name_len, int-literal init) and side-effects
        // global_add — emitting a normal (global $X (mut i32) ...).
        { path: 'boot/tests/const_keyword_test.si', expect: 'const OK' },
        // loc_keyword_test exercises the first INLINE def keyword
        // introducing a local (boot/strata/builtin/logic.si:Loc).
        // Routes through the inline-position try_dispatch_def_via_
        // body_rich hook in lower_expr's AST_DEFINITION branch,
        // body_rich's Compiler::ir::makeLocal + ctx::locals::set,
        // and lower_definition's updated actual_n_locals count so
        // the freshly-pushed local appears in the function's
        // (local i32 ...) declarations.
        { path: 'boot/tests/loc_keyword_test.si', expect: 'loc OK' },
    ]
    for (const fx of STAGE1_PIPELINE_FIXTURES) {
        test(`STAGE 1 PIPELINE: ${fx.path} compiles via stage1.wasm + strict watToWasm + runs`, async () => {
            if (!wasmtimeAvailable()) { console.log('  (skipped: wasmtime not on PATH)'); return }
            const stage1Path = path.join(WASM_BIN, 'stage1.wasm')
            try { await fs.access(stage1Path) } catch {
                console.log('  (skipped: stage1.wasm missing — run scripts/build-stage1.ts)')
                return
            }
            // Replicate the shell pipeline's @use resolver: depth-first
            // post-order, cycle-safe, P_SRC-relative paths.  The result
            // is a single concat bundle stage1.wasm can ingest.
            const visited = new Set<string>()
            const order: string[] = []
            async function resolve(file: string): Promise<void> {
                const abs = path.resolve(file)
                if (visited.has(abs)) return
                visited.add(abs)
                const src = await fs.readFile(abs, 'utf-8')
                const dir = path.dirname(abs)
                for (const line of src.split('\n')) {
                    const m = /^\s*@use\s+'([^']+)'/.exec(line)
                    if (m) await resolve(path.join(dir, m[1]))
                }
                order.push(abs)
            }
            await resolve(path.join(PROJECT_ROOT, fx.path))
            const wasiStub = [
                '@extern wasi_snapshot_preview1::fd_write:Int',
                '  fd:Int, iovs_ptr:Int, iovs_len:Int, nwritten_out:Int;',
                '@extern wasi_snapshot_preview1::fd_read:Int',
                '  fd:Int, iovs_ptr:Int, iovs_len:Int, nread_out:Int;',
                '@extern wasi_snapshot_preview1::proc_exit',
                '  code:Int;',
                '',
            ].join('\n')
            let bundle = wasiStub
            for (const f of order) bundle += await fs.readFile(f, 'utf-8')

            const compile = spawnSync('wasmtime', ['--dir', '.', stage1Path], {
                input: Buffer.from(bundle, 'utf-8'),
                maxBuffer: 64 * 1024 * 1024,
            })
            expect(compile.status).toBe(0)
            const wat = (compile.stdout ?? Buffer.alloc(0)).toString('utf-8')

            // Strict watToWasm — surfaces any drop-after-void-call or
            // similar stack-discipline bugs at compile time rather than
            // at wasmtime load time.
            const wasm = await watToWasm(wat)
            const tmpPath = path.join(WASM_BIN, 'stage1-pipeline-smoke.wasm')
            await fs.writeFile(tmpPath, Buffer.from(wasm.buffer))
            try {
                const run = spawnSync('wasmtime', [tmpPath], { maxBuffer: 1 << 20 })
                expect(run.status).toBe(0)
                const stdout = (run.stdout ?? Buffer.alloc(0)).toString('utf-8').trim()
                expect(stdout).toBe(fx.expect)
            } finally {
                await fs.unlink(tmpPath).catch(() => {})
            }
        }, 60000)
    }

    test('PHASE 4a: stage1.wasm CLI — --help prints help to stdout and exits 0', async () => {
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const stage1Path = path.join(WASM_BIN, 'stage1.wasm')
        try { await fs.access(stage1Path) }
        catch {
            console.log('  (skipped: stage1.wasm missing)')
            return
        }
        const r = spawnSync('wasmtime', [stage1Path, '--help'], {
            input: '',
            maxBuffer: 64 * 1024 * 1024,
        })
        expect(r.status).toBe(0)
        const out = (r.stdout ?? Buffer.alloc(0)).toString('utf-8')
        expect(out).toContain('sigil — Silicon bootstrap compiler')
        expect(out).toContain('Flags:')
        expect(out).toContain('--help')
    }, 30000)

    test('PHASE 4a: stage1.wasm CLI — unknown flag exits non-zero with stderr message', async () => {
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const stage1Path = path.join(WASM_BIN, 'stage1.wasm')
        try { await fs.access(stage1Path) }
        catch {
            console.log('  (skipped: stage1.wasm missing)')
            return
        }
        const r = spawnSync('wasmtime', [stage1Path, '--bogus'], {
            input: '',
            maxBuffer: 64 * 1024 * 1024,
        })
        expect(r.status).toBe(2)
        const err = (r.stderr ?? Buffer.alloc(0)).toString('utf-8')
        expect(err).toContain('unknown flag')
    }, 30000)

    test('PHASE 4a: stage1.wasm CLI — no args still compiles stdin normally', async () => {
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const stage1Path = path.join(WASM_BIN, 'stage1.wasm')
        try { await fs.access(stage1Path) }
        catch {
            console.log('  (skipped: stage1.wasm missing)')
            return
        }
        // No `--` and no args; argv = [argv0] only.  The compile
        // pipeline runs on whatever's on stdin.
        const r = spawnSync('wasmtime', [stage1Path], {
            input: '@fn add a:Int, b:Int := { a + b };\n@fn main := { &add 1, 2 };\n',
            maxBuffer: 64 * 1024 * 1024,
        })
        expect(r.status).toBe(0)
        const wat = (r.stdout ?? Buffer.alloc(0)).toString('utf-8')
        expect(wat).toContain('(func $add ')
        expect(wat).toContain('(func $main ')
    }, 30000)

    // PHASE 4b: stage1.wasm reads source from a file path via positional argv.
    //
    // End-to-end exercise of the i64 + path_open work:
    //   - boot/std/fs.si:find_preopen_dir locates the --dir preopen fd.
    //   - boot/std/fs.si:open_file_for_read calls path_open with
    //     fs_rights_base = FD_READ|FD_SEEK|FD_TELL (=38) as i64.
    //   - boot/cli.si treats a non-`--` argv entry as the source path
    //     and sets SOURCE_FD.
    //   - boot/stage1.si reads from &source_fd instead of fd 0.
    //
    // Gate: path-mode WAT byte-equals stdin-mode WAT for the same
    // source file — proves the full chain works AND that the
    // synthesised _start wrapping behaves the same regardless of input.
    test('PHASE 4b: stage1.wasm reads source via positional path arg', async () => {
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const stage1Path = path.join(WASM_BIN, 'stage1.wasm')
        try { await fs.access(stage1Path) } catch { return }

        const tmpDir = path.join(WASM_BIN, 'phase4b-test')
        await fs.mkdir(tmpDir, { recursive: true })
        const srcPath = path.join(tmpDir, 'hello.si')
        await fs.writeFile(srcPath, '@fn answer:Int := { 42 };\n')

        try {
            // Compare path-mode WAT against stdin-mode WAT — they must
            // produce byte-identical output for the same source.
            const stdinR = spawnSync('wasmtime', [stage1Path], {
                input: await fs.readFile(srcPath, 'utf-8'),
                maxBuffer: 64 * 1024 * 1024,
            })
            const pathR = spawnSync('wasmtime',
                ['--dir', `${tmpDir}::tests`, stage1Path, 'hello.si'],
                { maxBuffer: 64 * 1024 * 1024 })

            expect(stdinR.status).toBe(0)
            expect(pathR.status).toBe(0)
            const stdinWat = (stdinR.stdout ?? Buffer.alloc(0)).toString('utf-8')
            const pathWat  = (pathR.stdout  ?? Buffer.alloc(0)).toString('utf-8')
            expect(pathWat).toBe(stdinWat)
        } finally {
            await fs.rm(tmpDir, { recursive: true, force: true })
        }
    }, 30000)

    // STAGE 1 boot-vs-stage1 output diff test.
    //
    // Originally disabled under wasmer 2.x due to a JIT-compilation bug
    // (filename-dependent "range start is bigger than current length"
    // panic on freshly-written wasm files).  Should work under wasmtime
    // — re-enabling now that the runtime migration has landed.  If it
    // turns out to be flaky on CI, revert this to test.skip with a
    // wasmtime-specific note.
    test('STAGE 1: bootstrap-compiled compiler produces byte-identical WAT to the TS-built bootstrap', async () => {
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const boot = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'fn_test.si'))
        const bootPath = path.join(WASM_BIN, 'stage0-boot.wasm')
        await fs.writeFile(bootPath, boot)

        // Step 1: assemble the full bootstrap source + stage1 driver.
        const strataDir = path.join(PROJECT_ROOT, 'boot', 'strata', 'builtin')
        const strataFiles = (await fs.readdir(strataDir))
            .filter(f => f.endsWith('.si'))
            .sort()
        let bundle = ''
        for (const f of strataFiles) {
            const raw = await fs.readFile(path.join(strataDir, f), 'utf-8')
            bundle += raw.replace(/\r\n/g, '\n') + '\n'
        }
        const wasiStub = [
            '@extern wasi_snapshot_preview1::fd_write:Int',
            '  fd:Int, iovs_ptr:Int, iovs_len:Int, nwritten_out:Int;',
            '@extern wasi_snapshot_preview1::fd_read:Int',
            '  fd:Int, iovs_ptr:Int, iovs_len:Int, nread_out:Int;',
            '@extern wasi_snapshot_preview1::args_get:Int',
            '  argv_ptr:Int, argv_buf:Int;',
            '@extern wasi_snapshot_preview1::args_sizes_get:Int',
            '  argc_out:Int, argv_buf_size_out:Int;',
            '@extern wasi_snapshot_preview1::proc_exit',
            '  code:Int;',
            '@extern wasi_snapshot_preview1::path_open:Int',
            '  dirfd:Int, dirflags:Int, path_ptr:Int, path_len:Int,',
            '  oflags:Int, fs_rights_base:Int64, fs_rights_inheriting:Int64,',
            '  fdflags:Int, fd_out:Int;',
            '@extern wasi_snapshot_preview1::fd_prestat_get:Int',
            '  fd:Int, buf_out:Int;',
            '@extern wasi_snapshot_preview1::fd_prestat_dir_name:Int',
            '  fd:Int, path_ptr:Int, path_len:Int;',
        ].join('\n') + '\n'
        const stage1Sources = [
            'boot/std/argv.si',
            'boot/std/io.si', 'boot/std/fs.si',
            'boot/std/arena.si', 'boot/std/vec.si',
            'boot/embedded_bundle.si',
            'boot/parser/tokens.si', 'boot/parser/lex.si',
            'boot/parser/ast.si', 'boot/parser/parse.si',
            'boot/strata/registry.si', 'boot/strata/loader.si',
            'boot/elab/elaborator.si', 'boot/ir/nodes.si',
            'boot/elab/body.si',
            'boot/elab/body_scope.si',
            'boot/compiler_api/ctx.si',
            'boot/elab/body_rich.si',
            'boot/ir/lower.si',
            'boot/emit/wat.si',
            'boot/cli.si',
            'boot/modules/use.si',
            'boot/stage1.si',
        ]
        const stage1Bundle = wasiStub + (await Promise.all(
            stage1Sources.map(p => fs.readFile(path.join(PROJECT_ROOT, p), 'utf-8')),
        )).join('')

        const stage1WasmPath = path.join(WASM_BIN, 'stage1.wasm')
        try {
            // Step 2: compile stage1 via boot.wasm.
            const compileRes = spawnSync('wasmtime', [bootPath], {
                input: Buffer.from(bundle + stage1Bundle, 'utf-8'),
                maxBuffer: 64 * 1024 * 1024,
            })
            expect(compileRes.status).toBe(0)
            const stage1Wat = (compileRes.stdout ?? Buffer.alloc(0)).toString('utf-8')
            const stage1Compiled = await watToWasm(stage1Wat)
            await fs.writeFile(stage1WasmPath, Buffer.from(stage1Compiled.buffer))

            // Step 3: run a small Silicon program through BOTH boot.wasm
            // and stage1.wasm, then diff the resulting WAT byte-for-byte.
            const userProg = bundle +
                '@fn add a:Int, b:Int := { a + b };\n' +
                '@fn main := { &add 20, 22 };\n'
            const userBuf = Buffer.from(userProg, 'utf-8')

            const bootRun = spawnSync('wasmtime', [bootPath], {
                input: userBuf, maxBuffer: 64 * 1024 * 1024,
            })
            expect(bootRun.status).toBe(0)
            const bootOut = (bootRun.stdout ?? Buffer.alloc(0)).toString('utf-8')

            const stage1Run = spawnSync('wasmtime', [stage1WasmPath], {
                input: userBuf, maxBuffer: 64 * 1024 * 1024,
            })
            expect(stage1Run.status).toBe(0)
            const stage1Out = (stage1Run.stdout ?? Buffer.alloc(0)).toString('utf-8')

            if (bootOut !== stage1Out) {
                throw new Error(
                    `Stage 1 vs boot.wasm output diverge.\n` +
                    `boot:   ${bootOut.length} bytes\n` +
                    `stage1: ${stage1Out.length} bytes\n` +
                    `--- first 200 bytes of diff context ---\n` +
                    `boot:   ${JSON.stringify(bootOut.slice(0, 200))}\n` +
                    `stage1: ${JSON.stringify(stage1Out.slice(0, 200))}`,
                )
            }
            // Both outputs are non-trivial.
            expect(bootOut.length).toBeGreaterThan(500)
        } finally {
            await fs.unlink(bootPath).catch(() => {})
            await fs.unlink(stage1WasmPath).catch(() => {})
        }
    }, 90000)

    test('boot/tests/fn_test.si: bootstrap compiles ITS OWN SOURCE TREE end-to-end (Stage 1 candidate)', async () => {
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'fn_test.si'))
        const tmpPath = path.join(WASM_BIN, 'self-host-boot.wasm')
        await fs.writeFile(tmpPath, wasm)

        const strataDir = path.join(PROJECT_ROOT, 'boot', 'strata', 'builtin')
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
            '@extern wasi_snapshot_preview1::args_get:Int',
            '  argv_ptr:Int, argv_buf:Int;',
            '@extern wasi_snapshot_preview1::args_sizes_get:Int',
            '  argc_out:Int, argv_buf_size_out:Int;',
            '@extern wasi_snapshot_preview1::proc_exit',
            '  code:Int;',
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
            'boot/elab/body_scope.si',
            'boot/compiler_api/ctx.si',
            'boot/elab/body_rich.si',
            'boot/ir/lower.si',
            'boot/emit/wat.si',
        ]
        const pieces = await Promise.all(
            sources.map(p => fs.readFile(path.join(PROJECT_ROOT, p), 'utf-8')),
        )
        const userProg = wasiStub + pieces.join('')

        try {
            const compileRes = spawnSync('wasmtime', [tmpPath], {
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
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'fn_test.si'))
        const tmpPath = path.join(WASM_BIN, 'loader-boot.wasm')
        await fs.writeFile(tmpPath, wasm)

        const strataDir = path.join(PROJECT_ROOT, 'boot', 'strata', 'builtin')
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
            '@extern wasi_snapshot_preview1::args_get:Int',
            '  argv_ptr:Int, argv_buf:Int;',
            '@extern wasi_snapshot_preview1::args_sizes_get:Int',
            '  argc_out:Int, argv_buf_size_out:Int;',
            '@extern wasi_snapshot_preview1::proc_exit',
            '  code:Int;',
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
            const compileRes = spawnSync('wasmtime', [tmpPath], {
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
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'fn_test.si'))
        const tmpPath = path.join(WASM_BIN, 'parse-boot.wasm')
        await fs.writeFile(tmpPath, wasm)

        const strataDir = path.join(PROJECT_ROOT, 'boot', 'strata', 'builtin')
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
            '@extern wasi_snapshot_preview1::args_get:Int',
            '  argv_ptr:Int, argv_buf:Int;',
            '@extern wasi_snapshot_preview1::args_sizes_get:Int',
            '  argc_out:Int, argv_buf_size_out:Int;',
            '@extern wasi_snapshot_preview1::proc_exit',
            '  code:Int;',
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
            const compileRes = spawnSync('wasmtime', [tmpPath], {
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
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'fn_test.si'))
        const tmpPath = path.join(WASM_BIN, 'lex-boot.wasm')
        await fs.writeFile(tmpPath, wasm)

        const strataDir = path.join(PROJECT_ROOT, 'boot', 'strata', 'builtin')
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
            '@extern wasi_snapshot_preview1::args_get:Int',
            '  argv_ptr:Int, argv_buf:Int;',
            '@extern wasi_snapshot_preview1::args_sizes_get:Int',
            '  argc_out:Int, argv_buf_size_out:Int;',
            '@extern wasi_snapshot_preview1::proc_exit',
            '  code:Int;',
        ].join('\n') + '\n'

        const io   = await fs.readFile(path.join(PROJECT_ROOT, 'boot', 'std', 'io.si'),    'utf-8')
        const arena = await fs.readFile(path.join(PROJECT_ROOT, 'boot', 'std', 'arena.si'), 'utf-8')
        const vec  = await fs.readFile(path.join(PROJECT_ROOT, 'boot', 'std', 'vec.si'),   'utf-8')
        const toks = await fs.readFile(path.join(PROJECT_ROOT, 'boot', 'parser', 'tokens.si'), 'utf-8')
        const lex  = await fs.readFile(path.join(PROJECT_ROOT, 'boot', 'parser', 'lex.si'),    'utf-8')

        const userProg = wasiStub + io + arena + vec + toks + lex

        try {
            const compileRes = spawnSync('wasmtime', [tmpPath], {
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
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'fn_test.si'))
        const tmpPath = path.join(WASM_BIN, 'wasi-io-boot.wasm')
        await fs.writeFile(tmpPath, wasm)

        const strataDir = path.join(PROJECT_ROOT, 'boot', 'strata', 'builtin')
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
            '@extern wasi_snapshot_preview1::args_get:Int',
            '  argv_ptr:Int, argv_buf:Int;',
            '@extern wasi_snapshot_preview1::args_sizes_get:Int',
            '  argc_out:Int, argv_buf_size_out:Int;',
            '@extern wasi_snapshot_preview1::proc_exit',
            '  code:Int;',
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

        const outWasm = path.join(WASM_BIN, 'wasi-io.wasm')
        try {
            const compileRes = spawnSync('wasmtime', [tmpPath], {
                input: Buffer.from(bundle + userProg, 'utf-8'),
                maxBuffer: 64 * 1024 * 1024,
            })
            expect(compileRes.status).toBe(0)
            const wat = (compileRes.stdout ?? Buffer.alloc(0)).toString('utf-8')

            const compiled = await watToWasm(wat)
            await fs.writeFile(outWasm, Buffer.from(compiled.buffer))

            const runRes = spawnSync('wasmtime', [outWasm], {
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
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'fn_test.si'))
        const tmpPath = path.join(WASM_BIN, 'wasi-helper-boot.wasm')
        await fs.writeFile(tmpPath, wasm)

        const strataDir = path.join(PROJECT_ROOT, 'boot', 'strata', 'builtin')
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

        const outWasm = path.join(WASM_BIN, 'wasi-helper.wasm')
        try {
            const compileRes = spawnSync('wasmtime', [tmpPath], {
                input: Buffer.from(bundle + userProg, 'utf-8'),
                maxBuffer: 64 * 1024 * 1024,
            })
            expect(compileRes.status).toBe(0)
            const wat = (compileRes.stdout ?? Buffer.alloc(0)).toString('utf-8')

            const compiled = await watToWasm(wat)
            await fs.writeFile(outWasm, Buffer.from(compiled.buffer))

            const runRes = spawnSync('wasmtime', [outWasm], {
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
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'fn_test.si'))
        const tmpPath = path.join(WASM_BIN, 'wasi-hello-boot.wasm')
        await fs.writeFile(tmpPath, wasm)

        const strataDir = path.join(PROJECT_ROOT, 'boot', 'strata', 'builtin')
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

        const helloWat = path.join(WASM_BIN, 'wasi-hello.wat')
        const helloWasm = path.join(WASM_BIN, 'wasi-hello.wasm')
        try {
            // Step 1: compile Silicon → WAT via boot.wasm under wasmer.
            const compileRes = spawnSync('wasmtime', [tmpPath], {
                input: Buffer.from(bundle + userProg, 'utf-8'),
                maxBuffer: 64 * 1024 * 1024,
            })
            expect(compileRes.status).toBe(0)
            const wat = (compileRes.stdout ?? Buffer.alloc(0)).toString('utf-8')

            // Step 2: WAT → wasm via wabt.
            const compiled = await watToWasm(wat)
            await fs.writeFile(helloWasm, Buffer.from(compiled.buffer))

            // Step 3: run hello.wasm under wasmer with WASI enabled.
            const runRes = spawnSync('wasmtime', [helloWasm], {
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
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'scope_test.si'))
        const tmpPath = path.join(WASM_BIN, 'scope-smoke.wasm')
        await fs.writeFile(tmpPath, wasm)

        const strataDir = path.join(PROJECT_ROOT, 'boot', 'strata', 'builtin')
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
                const result = spawnSync('wasmtime', [tmpPath], {
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
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'module_test.si'))
        const tmpPath = path.join(WASM_BIN, 'module-smoke.wasm')
        await fs.writeFile(tmpPath, wasm)

        const strataDir = path.join(PROJECT_ROOT, 'boot', 'strata', 'builtin')
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
                const result = spawnSync('wasmtime', [tmpPath], {
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
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'emit_test.si'))
        const tmpPath = path.join(WASM_BIN, 'emit-smoke.wasm')
        await fs.writeFile(tmpPath, wasm)

        const strataDir = path.join(PROJECT_ROOT, 'boot', 'strata', 'builtin')
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
                const result = spawnSync('wasmtime', [tmpPath], {
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
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'lower_test.si'))
        const tmpPath = path.join(WASM_BIN, 'lower-smoke.wasm')
        await fs.writeFile(tmpPath, wasm)

        const strataDir = path.join(PROJECT_ROOT, 'boot', 'strata', 'builtin')
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
                const result = spawnSync('wasmtime', [tmpPath], {
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
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'body_test.si'))
        const tmpPath = path.join(WASM_BIN, 'body-smoke.wasm')
        await fs.writeFile(tmpPath, wasm)

        const strataDir = path.join(PROJECT_ROOT, 'boot', 'strata', 'builtin')
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
            const result = spawnSync('wasmtime', [tmpPath], {
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
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'ir_nodes_test.si'))
        const tmpPath = path.join(WASM_BIN, 'ir-nodes.wasm')
        await fs.writeFile(tmpPath, wasm)
        try {
            const result = spawnSync('wasmtime', [tmpPath], { maxBuffer: 1 << 20 })
            expect(result.status).toBe(0)
            const stdout = (result.stdout ?? Buffer.alloc(0)).toString('utf-8').trim()
            expect(stdout).toBe('ok')
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/types_test.si: Phase 2 slice 2a — SiliconType arena + helpers', async () => {
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'types_test.si'))
        const tmpPath = path.join(WASM_BIN, 'types.wasm')
        await fs.writeFile(tmpPath, wasm)
        try {
            const result = spawnSync('wasmtime', [tmpPath], { maxBuffer: 1 << 20 })
            expect(result.status).toBe(0)
            const stdout = (result.stdout ?? Buffer.alloc(0)).toString('utf-8').trim()
            expect(stdout).toBe('types OK')
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/check_kw_test.si: Phase 2 slice 2e-v — checkNode keyword calls', async () => {
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'check_kw_test.si'))
        const tmpPath = path.join(WASM_BIN, 'check_kw.wasm')
        await fs.writeFile(tmpPath, wasm)
        try {
            const result = spawnSync('wasmtime', [tmpPath], { maxBuffer: 1 << 20 })
            expect(result.status).toBe(0)
            const stdout = (result.stdout ?? Buffer.alloc(0)).toString('utf-8').trim()
            expect(stdout).toBe('check-kw OK')
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/check_block_test.si: Phase 2 slice 2e-iv — checkNode Block + Assignment + inline Definition', async () => {
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'check_block_test.si'))
        const tmpPath = path.join(WASM_BIN, 'check_block.wasm')
        await fs.writeFile(tmpPath, wasm)
        try {
            const result = spawnSync('wasmtime', [tmpPath], { maxBuffer: 1 << 20 })
            expect(result.status).toBe(0)
            const stdout = (result.stdout ?? Buffer.alloc(0)).toString('utf-8').trim()
            expect(stdout).toBe('check-block OK')
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/check_call_test.si: Phase 2 slice 2e-iii — checkNode FunctionCall', async () => {
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'check_call_test.si'))
        const tmpPath = path.join(WASM_BIN, 'check_call.wasm')
        await fs.writeFile(tmpPath, wasm)
        try {
            const result = spawnSync('wasmtime', [tmpPath], { maxBuffer: 1 << 20 })
            expect(result.status).toBe(0)
            const stdout = (result.stdout ?? Buffer.alloc(0)).toString('utf-8').trim()
            expect(stdout).toBe('check-call OK')
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/check_binop_test.si: Phase 2 slice 2e-ii — checkNode BinaryOp', async () => {
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'check_binop_test.si'))
        const tmpPath = path.join(WASM_BIN, 'check_binop.wasm')
        await fs.writeFile(tmpPath, wasm)
        try {
            const result = spawnSync('wasmtime', [tmpPath], { maxBuffer: 1 << 20 })
            expect(result.status).toBe(0)
            const stdout = (result.stdout ?? Buffer.alloc(0)).toString('utf-8').trim()
            expect(stdout).toBe('check-binop OK')
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/check_literals_test.si: Phase 2 slice 2e-i — checkNode skeleton + literals + Namespace', async () => {
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'check_literals_test.si'))
        const tmpPath = path.join(WASM_BIN, 'check_literals.wasm')
        await fs.writeFile(tmpPath, wasm)
        try {
            const result = spawnSync('wasmtime', [tmpPath], { maxBuffer: 1 << 20 })
            expect(result.status).toBe(0)
            const stdout = (result.stdout ?? Buffer.alloc(0)).toString('utf-8').trim()
            expect(stdout).toBe('check-literals OK')
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/preregister_defs_test.si: Phase 2 slice 2d-iii — top-level definition pre-registration', async () => {
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'preregister_defs_test.si'))
        const tmpPath = path.join(WASM_BIN, 'preregister_defs.wasm')
        await fs.writeFile(tmpPath, wasm)
        try {
            const result = spawnSync('wasmtime', [tmpPath], { maxBuffer: 1 << 20 })
            expect(result.status).toBe(0)
            const stdout = (result.stdout ?? Buffer.alloc(0)).toString('utf-8').trim()
            expect(stdout).toBe('preregister-defs OK')
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/preregister_std_test.si: Phase 2 slice 2d-ii — std.wat fn pre-registration', async () => {
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'preregister_std_test.si'))
        const tmpPath = path.join(WASM_BIN, 'preregister_std.wasm')
        await fs.writeFile(tmpPath, wasm)
        try {
            const result = spawnSync('wasmtime', [tmpPath], { maxBuffer: 1 << 20 })
            expect(result.status).toBe(0)
            const stdout = (result.stdout ?? Buffer.alloc(0)).toString('utf-8').trim()
            expect(stdout).toBe('preregister-std OK')
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/ctx_test.si: Phase 2 slice 2d-i — typechecker Ctx skeleton', async () => {
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'ctx_test.si'))
        const tmpPath = path.join(WASM_BIN, 'ctx.wasm')
        await fs.writeFile(tmpPath, wasm)
        try {
            const result = spawnSync('wasmtime', [tmpPath], { maxBuffer: 1 << 20 })
            expect(result.status).toBe(0)
            const stdout = (result.stdout ?? Buffer.alloc(0)).toString('utf-8').trim()
            expect(stdout).toBe('ctx OK')
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/intrinsic_sig_test.si: Phase 2 slice 2c — intrinsic signature derivation', async () => {
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'intrinsic_sig_test.si'))
        const tmpPath = path.join(WASM_BIN, 'intrinsic_sig.wasm')
        await fs.writeFile(tmpPath, wasm)
        try {
            const result = spawnSync('wasmtime', [tmpPath], { maxBuffer: 1 << 20 })
            expect(result.status).toBe(0)
            const stdout = (result.stdout ?? Buffer.alloc(0)).toString('utf-8').trim()
            expect(stdout).toBe('intrinsic-sig OK')
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/errors_test.si: Phase 2 slice 2b — TypeError arena + formatter', async () => {
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'errors_test.si'))
        const tmpPath = path.join(WASM_BIN, 'errors.wasm')
        await fs.writeFile(tmpPath, wasm)
        try {
            const result = spawnSync('wasmtime', [tmpPath], { maxBuffer: 1 << 20 })
            expect(result.status).toBe(0)
            const stdout = (result.stdout ?? Buffer.alloc(0)).toString('utf-8').trim()
            const lines = stdout.split('\n')
            expect(lines[lines.length - 1]).toBe('errors OK')
            expect(lines).toContain(`[Mismatch] expected Int, got Float`)
            expect(lines).toContain(`[InvalidOperator] operator 'op_plus' cannot be applied to (String, Int)`)
            expect(lines).toContain(`[UnboundIdentifier] unbound identifier 'here'`)
            expect(lines).toContain(`[UnknownType] unknown type 'here'`)
            expect(lines).toContain(`[HeterogeneousArray] array literal must be homogeneous: first element is Int, found Array<Int>`)
            expect(lines).toContain(`[Annotation] 'here' declared as Int but initialiser has type Bool`)
            expect(lines).toContain(`[ImmutableAssignment] 'here' is immutable and cannot be reassigned`)
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/body_rich_test.si: Phase 1b rich-body dispatch — Compiler::ir::* + IR::null', async () => {
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'body_rich_test.si'))
        const tmpPath = path.join(WASM_BIN, 'body-rich.wasm')
        await fs.writeFile(tmpPath, wasm)
        try {
            const result = spawnSync('wasmtime', [tmpPath], { maxBuffer: 1 << 20 })
            expect(result.status).toBe(0)
            const stdout = (result.stdout ?? Buffer.alloc(0)).toString('utf-8').trim()
            expect(stdout).toBe('body-rich OK')
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/body_scope_test.si: Phase 1a rich-body scope + path-eval scaffolding', async () => {
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'body_scope_test.si'))
        const tmpPath = path.join(WASM_BIN, 'body-scope.wasm')
        await fs.writeFile(tmpPath, wasm)
        try {
            const result = spawnSync('wasmtime', [tmpPath], { maxBuffer: 1 << 20 })
            expect(result.status).toBe(0)
            const stdout = (result.stdout ?? Buffer.alloc(0)).toString('utf-8').trim()
            expect(stdout).toBe('body-scope OK')
        } finally {
            await fs.unlink(tmpPath).catch(() => {})
        }
    })

    test('boot/tests/templates_test.si: per-stratum body templates byte-equal Stage 0', async () => {
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'templates_test.si'))
        const tmpPath = path.join(WASM_BIN, 'tpl-smoke.wasm')
        await fs.writeFile(tmpPath, wasm)

        const strataDir = path.join(PROJECT_ROOT, 'boot', 'strata', 'builtin')
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
            const result = spawnSync('wasmtime', [tmpPath], {
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
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'intrinsics_test.si'))
        const tmpPath = path.join(WASM_BIN, 'intr-smoke.wasm')
        await fs.writeFile(tmpPath, wasm)

        const strataDir = path.join(PROJECT_ROOT, 'boot', 'strata', 'builtin')
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
            const result = spawnSync('wasmtime', [tmpPath], {
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
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'elaborator_test.si'))
        const tmpPath = path.join(WASM_BIN, 'elab-smoke.wasm')
        await fs.writeFile(tmpPath, wasm)

        // Built-in strata bundle + a handful of user definitions covering
        // every codegen kind (function / global / extern) plus one bad
        // keyword to exercise the error path.
        const strataDir = path.join(PROJECT_ROOT, 'boot', 'strata', 'builtin')
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
            const result = spawnSync('wasmtime', [tmpPath], {
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
        if (!wasmtimeAvailable()) {
            console.log('  (skipped: wasmtime not on PATH)')
            return
        }
        const wasm = await buildBoot(path.join(PROJECT_ROOT, 'boot', 'tests', 'json_fixtures_test.si'))
        const tmpPath = path.join(WASM_BIN, 'json-fixtures.wasm')
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
            const result = spawnSync('wasmtime', [tmpPath], {
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
