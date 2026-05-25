/**
 * Byte-equal WAT output verification across backends (story 8-14)
 *
 * Three verification tiers:
 *
 *   1. WAT determinism   — same Silicon source compiled to WAT twice produces
 *                          byte-identical output (no randomised temps, IDs, or
 *                          ordering).
 *
 *   2. QBE IR determinism — same typed AST lowered to QBE IR twice produces
 *                           byte-identical output.
 *
 *   3. Cross-backend type consistency — for each primitive type, the WAT
 *                           backend and the QBE backend agree on the encoding:
 *                           Int → i32 / w,  Float → f32 / s,  Int64 → i64 / l.
 *
 * No wasmtime or qbe binary is required; all assertions are textual.
 */

import { describe, test, expect } from 'bun:test'
import * as path from 'node:path'
import * as fsp  from 'node:fs/promises'

import { compileToWatString, compileToTyped } from '../../tests/properties/_compile'
import { lowerToQbe }                          from '../codegen/qbe/lower'
import { siliconTypeToQbe }                    from '../codegen/qbe/types'

const EXAMPLES_DIR = path.join(import.meta.dir, 'examples')

// ---------------------------------------------------------------------------
// Shared program list — subset that compiles cleanly through BOTH backends.
// Excludes strings, structs, @extern, WASI, casts (not all in QBE lowerer).
// ---------------------------------------------------------------------------
const BOTH_BACKENDS: string[] = [
    'simple_literal.si',
    'basic_arithmetic.si',
    'boolean_true.si',
    'boolean_false.si',
    'subtraction.si',
    'multiplication.si',
    'division.si',
    'modulo.si',
    'nested_expressions.si',
    'complex_expression.si',
    'comparison_equal.si',
    'comparison_not_equal.si',
    'comparison_greater_than.si',
    'comparison_less_than.si',
    'comparison_greater_equal.si',
    'comparison_less_equal.si',
    'stratum_definition.si',
    'fn_function.si',
    'function_definition.si',
    'function_call.si',
    'block_trailing_expr.si',
    'block_stmts_then_expr.si',
    'if_else_expr.si',
    'if_in_block.si',
    'early_return.si',
    'count_loop.si',
    'var_global.si',
    'var_mutation.si',
    'local_set_fix.si',
]

// ---------------------------------------------------------------------------
// Helper: load an example source file
// ---------------------------------------------------------------------------
async function readExample(name: string): Promise<string> {
    return fsp.readFile(path.join(EXAMPLES_DIR, name), 'utf-8')
}

// Helper: compile a source string to QBE IR
function toQbeIr(src: string): string {
    const { typedAST, registry, functions } = compileToTyped(src)
    return lowerToQbe(typedAST, registry, functions)
}

// ---------------------------------------------------------------------------
// 1. WAT determinism
// ---------------------------------------------------------------------------

describe('WAT determinism — same source produces byte-equal output', () => {
    for (const example of BOTH_BACKENDS) {
        test(example, async () => {
            const src  = await readExample(example)
            const wat1 = compileToWatString(src)
            const wat2 = compileToWatString(src)
            expect(wat1).toBe(wat2)
        })
    }
})

// ---------------------------------------------------------------------------
// 2. QBE IR determinism
// ---------------------------------------------------------------------------

describe('QBE IR determinism — same source produces byte-equal output', () => {
    for (const example of BOTH_BACKENDS) {
        test(example, async () => {
            const src  = await readExample(example)
            const ir1  = toQbeIr(src)
            const ir2  = toQbeIr(src)
            expect(ir1).toBe(ir2)
        })
    }
})

// ---------------------------------------------------------------------------
// 3. Cross-backend type consistency
// ---------------------------------------------------------------------------

describe('cross-backend type consistency — WAT i32/f32/i64 ↔ QBE w/s/l', () => {

    // For each function, both backends must agree on the same primitive types.
    // We verify via regex matching on the emitted text: the WAT backend emits
    // `(param i32)` / `(result i32)` etc., the QBE backend emits `w %name` /
    // `function w $name(...)`.

    test('Int param: WAT uses i32, QBE uses w', () => {
        const src = '@fn add x:Int, y:Int := x + y;'
        const wat = compileToWatString(src)
        const qbe = toQbeIr(src)
        expect(wat).toMatch(/param.*i32/)
        expect(qbe).toMatch(/w %x/)
    })

    test('Int return: WAT uses i32 result, QBE uses function w', () => {
        const src = '@fn id x:Int := x;'
        const wat = compileToWatString(src)
        const qbe = toQbeIr(src)
        expect(wat).toMatch(/result i32/)
        expect(qbe).toMatch(/function w \$id/)
    })

    test('Float param: WAT uses f32, QBE uses s', () => {
        const src = '@fn scale x:Float := x;'
        const wat = compileToWatString(src)
        const qbe = toQbeIr(src)
        expect(wat).toMatch(/param.*f32/)
        expect(qbe).toMatch(/s %x/)
    })

    test('Float return: WAT uses f32 result, QBE uses function s', () => {
        const src = '@fn half x:Float := x;'
        const wat = compileToWatString(src)
        const qbe = toQbeIr(src)
        expect(wat).toMatch(/result f32/)
        expect(qbe).toMatch(/function s \$half/)
    })

    test('Int64 param: WAT uses i64, QBE uses l', () => {
        const src = '@fn widen x:Int64 := x;'
        const wat = compileToWatString(src)
        const qbe = toQbeIr(src)
        expect(wat).toMatch(/param.*i64/)
        expect(qbe).toMatch(/l %x/)
    })

    test('Int64 return: WAT uses i64 result, QBE uses function l', () => {
        const src = '@fn big x:Int64 := x;'
        const wat = compileToWatString(src)
        const qbe = toQbeIr(src)
        expect(wat).toMatch(/result i64/)
        expect(qbe).toMatch(/function l \$big/)
    })

    test('Bool param: WAT uses i32, QBE uses w', () => {
        const src = '@fn flag b:Bool := b;'
        const wat = compileToWatString(src)
        const qbe = toQbeIr(src)
        expect(wat).toMatch(/param.*i32/)
        expect(qbe).toMatch(/w %b/)
    })
})

// ---------------------------------------------------------------------------
// 4. siliconTypeToQbe ↔ known WAT type-string mapping
// ---------------------------------------------------------------------------

describe('siliconTypeToQbe type table correctness', () => {
    // These assertions lock the mapping table so a future refactor that breaks
    // the WAT↔QBE correspondence fails here, not silently downstream.
    const cases: Array<[Parameters<typeof siliconTypeToQbe>[0], string, string]> = [
        [{ kind: 'Int' },   'w', 'i32'],
        [{ kind: 'Int64' }, 'l', 'i64'],
        [{ kind: 'Float' }, 's', 'f32'],
        [{ kind: 'Bool' },  'w', 'i32'],
        [{ kind: 'UInt8' }, 'w', 'i32'],
        [{ kind: 'UInt64' },'l', 'i64'],
    ]

    for (const [siType, expectedQbe, expectedWat] of cases) {
        test(`${siType.kind}: QBE=${expectedQbe}, WAT=${expectedWat}`, () => {
            expect(siliconTypeToQbe(siType)).toBe(expectedQbe)
            // Verify WAT-side via a round-trip through the actual compiler.
            const src = `@fn probe x:${siType.kind} := x;`
            // Some types (UInt8/UInt64) map to the same wasm type as Int/Int64.
            const wat = compileToWatString(src)
            expect(wat).toMatch(new RegExp(`param.*${expectedWat}`))
        })
    }
})

// ---------------------------------------------------------------------------
// 5. WAT structural regression snapshots
// ---------------------------------------------------------------------------

describe('WAT regression snapshots — known-good function shapes', () => {
    test('simple Int function has correct WAT shape', () => {
        const wat = compileToWatString('@fn add x:Int, y:Int := x + y;')
        expect(wat).toContain('(func')
        expect(wat).toContain('(param')
        expect(wat).toContain('i32')
        expect(wat).toContain('(result i32)')
        expect(wat).toContain('i32.add')
    })

    test('global var appears in WAT data section', () => {
        const wat = compileToWatString('@var count:Int := 0;')
        expect(wat).toContain('(global')
        expect(wat).toContain('i32')
    })

    test('@if lowers to WAT conditional correctly', () => {
        const wat = compileToWatString(
            '@fn choose a:Int, b:Int, flag:Int := { &@if flag, { a }, { b } };'
        )
        expect(wat).toContain('(if')
        expect(wat).toContain('(then')
        expect(wat).toContain('(else')
    })

    test('@loop lowers to WAT block/loop pair', () => {
        const wat = compileToWatString(
            '@fn f := { @var n:Int := 0; &@loop n < 5, { n = n + 1; }; n };'
        )
        expect(wat).toContain('(block')
        expect(wat).toContain('(loop')
    })
})

// ---------------------------------------------------------------------------
// 6. QBE IR structural regression snapshots
// ---------------------------------------------------------------------------

describe('QBE IR regression snapshots — known-good function shapes', () => {
    test('simple Int function has correct QBE shape', () => {
        const qbe = toQbeIr('@fn add x:Int, y:Int := x + y;')
        expect(qbe).toMatch(/function w \$add\(w %x, w %y\)/)
        expect(qbe).toContain('@start')
        expect(qbe).toContain('add')
        expect(qbe).toContain('ret')
    })

    test('global var appears in QBE data/thread section', () => {
        const qbe = toQbeIr('@var count:Int := 0;')
        expect(qbe).toMatch(/\$(count|_count)/)
    })

    test('@if lowers to QBE jnz + labels', () => {
        const qbe = toQbeIr(
            '@fn choose a:Int, b:Int, flag:Int := { &@if flag, { a }, { b } };'
        )
        expect(qbe).toContain('jnz')
        expect(qbe).toContain('jmp')
    })

    test('@loop lowers to QBE head/exit label pair with jnz condition', () => {
        const qbe = toQbeIr(
            '@fn f := { @var n:Int := 0; &@loop n < 5, { n = n + 1; }; n };'
        )
        expect(qbe).toContain('@loop')       // loop head
        expect(qbe).toContain('@loop_exit')  // exit label
        expect(qbe).toContain('jnz')         // conditional jump on condition
        expect(qbe).toContain('jmp')         // back-edge jump
    })
})
