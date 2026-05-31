// SPDX-License-Identifier: MIT
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
import { siliconTypeToQbe, abstractOpToQbe }   from '../codegen/qbe/types'
import { wasmIntrinsics }                       from '../intrinsics/intrinsics'
import type { AbstractOp }                      from '../ir/nodes'

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
        const src = '\\\\ add (Int, Int)\n@fn add x, y := x + y;'
        const wat = compileToWatString(src)
        const qbe = toQbeIr(src)
        expect(wat).toMatch(/param.*i32/)
        expect(qbe).toMatch(/w %x/)
    })

    test('Int return: WAT uses i32 result, QBE uses function w', () => {
        const src = '\\\\ id (Int)\n@fn id x := x;'
        const wat = compileToWatString(src)
        const qbe = toQbeIr(src)
        expect(wat).toMatch(/result i32/)
        expect(qbe).toMatch(/function w \$id/)
    })

    test('Float param: WAT uses f32, QBE uses s', () => {
        const src = '\\\\ scale (Float)\n@fn scale x := x;'
        const wat = compileToWatString(src)
        const qbe = toQbeIr(src)
        expect(wat).toMatch(/param.*f32/)
        expect(qbe).toMatch(/s %x/)
    })

    test('Float return: WAT uses f32 result, QBE uses function s', () => {
        const src = '\\\\ half (Float)\n@fn half x := x;'
        const wat = compileToWatString(src)
        const qbe = toQbeIr(src)
        expect(wat).toMatch(/result f32/)
        expect(qbe).toMatch(/function s \$half/)
    })

    test('Int64 param: WAT uses i64, QBE uses l', () => {
        const src = '\\\\ widen (Int64)\n@fn widen x := x;'
        const wat = compileToWatString(src)
        const qbe = toQbeIr(src)
        expect(wat).toMatch(/param.*i64/)
        expect(qbe).toMatch(/l %x/)
    })

    test('Int64 return: WAT uses i64 result, QBE uses function l', () => {
        const src = '\\\\ big (Int64)\n@fn big x := x;'
        const wat = compileToWatString(src)
        const qbe = toQbeIr(src)
        expect(wat).toMatch(/result i64/)
        expect(qbe).toMatch(/function l \$big/)
    })

    test('Bool param: WAT uses i32, QBE uses w', () => {
        const src = '\\\\ flag (Bool)\n@fn flag b := b;'
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
        const wat = compileToWatString('\\\\ add (Int, Int)\n@fn add x, y := x + y;')
        expect(wat).toContain('(func')
        expect(wat).toContain('(param')
        expect(wat).toContain('i32')
        expect(wat).toContain('(result i32)')
        expect(wat).toContain('i32.add')
    })

    test('global var appears in WAT data section', () => {
        const wat = compileToWatString('@var count := 0;')
        expect(wat).toContain('(global')
        expect(wat).toContain('i32')
    })

    test('@if lowers to WAT conditional correctly', () => {
        const wat = compileToWatString(
            '\\\\ choose (Int, Int, Int)\n@fn choose a, b, flag := { &@if flag, { a }, { b } };'
        )
        expect(wat).toContain('(if')
        expect(wat).toContain('(then')
        expect(wat).toContain('(else')
    })

    test('@loop lowers to WAT block/loop pair', () => {
        const wat = compileToWatString(
            '@fn f  := { @var n:Int := 0; &@loop n < 5, { n = n + 1; }; n };'
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
        const qbe = toQbeIr('\\\\ add (Int, Int)\n@fn add x, y := x + y;')
        expect(qbe).toMatch(/function w \$add\(w %x, w %y\)/)
        expect(qbe).toContain('@start')
        expect(qbe).toContain('add')
        expect(qbe).toContain('ret')
    })

    test('global var appears in QBE data/thread section', () => {
        const qbe = toQbeIr('@var count := 0;')
        expect(qbe).toMatch(/\$(count|_count)/)
    })

    test('@if lowers to QBE jnz + labels', () => {
        const qbe = toQbeIr(
            '\\\\ choose (Int, Int, Int)\n@fn choose a, b, flag := { &@if flag, { a }, { b } };'
        )
        expect(qbe).toContain('jnz')
        expect(qbe).toContain('jmp')
    })

    test('@loop lowers to QBE head/exit label pair with jnz condition', () => {
        const qbe = toQbeIr(
            '@fn f  := { @var n:Int := 0; &@loop n < 5, { n = n + 1; }; n };'
        )
        expect(qbe).toContain('@loop')       // loop head
        expect(qbe).toContain('@loop_exit')  // exit label
        expect(qbe).toContain('jnz')         // conditional jump on condition
        expect(qbe).toContain('jmp')         // back-edge jump
    })
})

// ---------------------------------------------------------------------------
// Story 9.5-5 — Strata operator parity: WAT vs QBE backends
//
// Each test compiles a small Silicon program through both the WAT path
// (AbstractOp → WAT instruction via emit.ts) and the QBE path
// (AST → QBE instruction via lookupOpToQbe).  We assert:
//   (a) WAT output contains the expected WAT instruction
//   (b) QBE output contains the expected QBE mnemonic
//   (c) abstractOpToQbe() maps the same AbstractOp correctly (unit check)
//
// Together these verify that both backends implement the same Silicon operator
// semantics derived from the same strata registry.
// ---------------------------------------------------------------------------

/** Helper: compile src to WAT and return the WAT string. */
function toWat(src: string): string {
    return compileToWatString(src)
}

describe('Strata operator parity — WAT vs QBE backends (story 9.5-5)', () => {

    // -- AbstractOp table integrity -------------------------------------------

    test('abstractOpToQbe covers all i32 arithmetic ops', () => {
        const ops: AbstractOp[] = ['i32_add', 'i32_sub', 'i32_mul', 'i32_div_s', 'i32_rem_s']
        for (const op of ops) {
            const entry = abstractOpToQbe(op)
            expect(entry, `abstractOpToQbe('${op}') should be defined`).toBeDefined()
            expect(entry!.qt).toBe('w')
        }
    })

    test('abstractOpToQbe covers all i64 arithmetic ops', () => {
        const ops: AbstractOp[] = ['i64_add', 'i64_sub', 'i64_mul', 'i64_div_s', 'i64_rem_s']
        for (const op of ops) {
            const entry = abstractOpToQbe(op)
            expect(entry, `abstractOpToQbe('${op}') should be defined`).toBeDefined()
            expect(entry!.qt).toBe('l')
        }
    })

    test('abstractOpToQbe covers all f32 arithmetic ops', () => {
        const ops: AbstractOp[] = ['f32_add', 'f32_sub', 'f32_mul', 'f32_div']
        for (const op of ops) {
            const entry = abstractOpToQbe(op)
            expect(entry, `abstractOpToQbe('${op}') should be defined`).toBeDefined()
            expect(entry!.qt).toBe('s')
        }
    })

    test('abstractOpToQbe: i32 comparisons return result type w', () => {
        const ops: AbstractOp[] = ['i32_eq', 'i32_ne', 'i32_lt_s', 'i32_gt_s', 'i32_le_s', 'i32_ge_s']
        for (const op of ops) {
            const entry = abstractOpToQbe(op)
            expect(entry, `abstractOpToQbe('${op}') should be defined`).toBeDefined()
            expect(entry!.qt).toBe('w')
        }
    })

    test('abstractOpToQbe: i64 comparisons return result type w (not l)', () => {
        const ops: AbstractOp[] = ['i64_eq', 'i64_ne', 'i64_lt_s', 'i64_gt_s', 'i64_le_s', 'i64_ge_s']
        for (const op of ops) {
            const entry = abstractOpToQbe(op)
            expect(entry, `abstractOpToQbe('${op}') should be defined`).toBeDefined()
            expect(entry!.qt).toBe('w')
        }
    })

    test('wasmIntrinsics registry covers every AbstractOp (WAT side)', () => {
        const binOps: AbstractOp[] = [
            'i32_add', 'i32_sub', 'i32_mul', 'i32_div_s', 'i32_rem_s',
            'i32_eq', 'i32_ne', 'i32_lt_s', 'i32_gt_s', 'i32_le_s', 'i32_ge_s',
            'i64_add', 'i64_sub', 'i64_mul',
            'i64_eq', 'i64_ne', 'i64_lt_s', 'i64_gt_s',
            'f32_add', 'f32_sub', 'f32_mul', 'f32_div',
            'f32_eq', 'f32_ne', 'f32_lt', 'f32_gt', 'f32_le', 'f32_ge',
        ]
        for (const op of binOps) {
            const entry = wasmIntrinsics[op]
            expect(entry, `wasmIntrinsics['${op}'] should be defined`).toBeDefined()
            expect(typeof entry!.wasmInstr).toBe('string')
        }
    })

    // -- WAT backend: operator → instruction ----------------------------------

    test('+ on Int: WAT emits i32.add', () => {
        const wat = toWat('\\\\ add (Int, Int)\n@fn add a, b := a + b;')
        expect(wat).toContain('i32.add')
    })

    test('- on Int: WAT emits i32.sub', () => {
        const wat = toWat('\\\\ sub (Int, Int)\n@fn sub a, b := a - b;')
        expect(wat).toContain('i32.sub')
    })

    test('* on Int: WAT emits i32.mul', () => {
        const wat = toWat('\\\\ mul (Int, Int)\n@fn mul a, b := a * b;')
        expect(wat).toContain('i32.mul')
    })

    test('/ on Int: WAT emits i32.div_s', () => {
        const wat = toWat('\\\\ div_ (Int, Int)\n@fn div_ a, b := a / b;')
        expect(wat).toContain('i32.div_s')
    })

    test('% on Int: WAT emits i32.rem_s', () => {
        const wat = toWat('\\\\ mod_ (Int, Int)\n@fn mod_ a, b := a % b;')
        expect(wat).toContain('i32.rem_s')
    })

    test('== on Int: WAT emits i32.eq', () => {
        const wat = toWat('\\\\ eq (Int, Int)\n@fn eq a, b := a == b;')
        expect(wat).toContain('i32.eq')
    })

    test('!= on Int: WAT emits i32.ne', () => {
        const wat = toWat('\\\\ ne (Int, Int)\n@fn ne a, b := a != b;')
        expect(wat).toContain('i32.ne')
    })

    test('< on Int: WAT emits i32.lt_s', () => {
        const wat = toWat('\\\\ lt (Int, Int)\n@fn lt a, b := a < b;')
        expect(wat).toContain('i32.lt_s')
    })

    test('> on Int: WAT emits i32.gt_s', () => {
        const wat = toWat('\\\\ gt (Int, Int)\n@fn gt a, b := a > b;')
        expect(wat).toContain('i32.gt_s')
    })

    test('<= on Int: WAT emits i32.le_s', () => {
        const wat = toWat('\\\\ le (Int, Int)\n@fn le a, b := a <= b;')
        expect(wat).toContain('i32.le_s')
    })

    test('>= on Int: WAT emits i32.ge_s', () => {
        const wat = toWat('\\\\ ge (Int, Int)\n@fn ge a, b := a >= b;')
        expect(wat).toContain('i32.ge_s')
    })

    // -- QBE backend: same operators → QBE instructions ----------------------

    test('+ on Int: QBE emits add instruction', () => {
        const qbe = toQbeIr('\\\\ add (Int, Int)\n@fn add a, b := a + b;')
        expect(qbe).toContain('add')
    })

    test('- on Int: QBE emits sub instruction', () => {
        const qbe = toQbeIr('\\\\ sub (Int, Int)\n@fn sub a, b := a - b;')
        expect(qbe).toContain('sub')
    })

    test('* on Int: QBE emits mul instruction', () => {
        const qbe = toQbeIr('\\\\ mul (Int, Int)\n@fn mul a, b := a * b;')
        expect(qbe).toContain('mul')
    })

    test('== on Int: QBE emits ceqw instruction', () => {
        const qbe = toQbeIr('\\\\ eq (Int, Int)\n@fn eq a, b := a == b;')
        expect(qbe).toContain('ceqw')
    })

    test('!= on Int: QBE emits cnew instruction', () => {
        const qbe = toQbeIr('\\\\ ne (Int, Int)\n@fn ne a, b := a != b;')
        expect(qbe).toContain('cnew')
    })

    test('< on Int: QBE emits csltw instruction', () => {
        const qbe = toQbeIr('\\\\ lt (Int, Int)\n@fn lt a, b := a < b;')
        expect(qbe).toContain('csltw')
    })

    test('> on Int: QBE emits csgtw instruction', () => {
        const qbe = toQbeIr('\\\\ gt (Int, Int)\n@fn gt a, b := a > b;')
        expect(qbe).toContain('csgtw')
    })

    // -- Parity: same operator, WAT instruction ≠ QBE mnemonic but same semantics --

    test('abstractOpToQbe(i32_add) → { instr: "add", qt: "w" }', () => {
        const e = abstractOpToQbe('i32_add')!
        expect(e.instr).toBe('add')
        expect(e.qt).toBe('w')
    })

    test('abstractOpToQbe(i32_eq) → { instr: "ceqw", qt: "w" }', () => {
        const e = abstractOpToQbe('i32_eq')!
        expect(e.instr).toBe('ceqw')
        expect(e.qt).toBe('w')
    })

    test('abstractOpToQbe(i64_add) → { instr: "add", qt: "l" }', () => {
        const e = abstractOpToQbe('i64_add')!
        expect(e.instr).toBe('add')
        expect(e.qt).toBe('l')
    })

    test('abstractOpToQbe(f32_add) → { instr: "add", qt: "s" }', () => {
        const e = abstractOpToQbe('f32_add')!
        expect(e.instr).toBe('add')
        expect(e.qt).toBe('s')
    })

    test('abstractOpToQbe(i64_lt_s) → { instr: "csltl", qt: "w" }', () => {
        const e = abstractOpToQbe('i64_lt_s')!
        expect(e.instr).toBe('csltl')
        expect(e.qt).toBe('w')
    })
})

// ---------------------------------------------------------------------------
// Phase 9c — arena scope + escape (WAT determinism + structural shape;
// QBE rejection with a useful diagnostic).
//
// Runtime execution of arena programs is covered by src/codegen/arena.test.ts
// (instantiates the WASM and reads memory back).  Here we verify the
// cross-backend posture:
//   - WAT lowering is deterministic for arena programs.
//   - WAT emits the expected save/restore envelope structurally.
//   - QBE lowering rejects the strata with a documented error.
// ---------------------------------------------------------------------------

const ARENA_PROGRAMS: { name: string; src: string }[] = [
    {
        name: 'empty arena',
        src:  `\\\\ probe () -> Int
@fn probe  := { &@with_arena {}; 0 };`,
    },
    {
        name: 'arena with value-type tail',
        src:  `\\\\ probe () -> Int
@fn probe  := &@with_arena { 42 };`,
    },
    {
        name: 'arena with String promotion',
        src:  `\\\\ build () -> String
@fn build  := &@with_arena { @local s:String := 'hi'; &@move_to_parent_arena s };`,
    },
    {
        name: 'arena with Array[Int] promotion',
        src:  `\\\\ build () -> Int
@fn build  := &@with_arena { @local a := $[1,2,3]; &@move_to_parent_arena a };`,
    },
    {
        name: 'nested arenas',
        src:  `\\\\ probe () -> Int
@fn probe  := { &@with_arena { &@with_arena {}; }; 0 };`,
    },
]

describe('Phase 9c arena: WAT determinism', () => {
    for (const p of ARENA_PROGRAMS) {
        test(p.name, () => {
            const wat1 = compileToWatString(p.src)
            const wat2 = compileToWatString(p.src)
            expect(wat1).toBe(wat2)
        })
    }
})

describe('Phase 9c arena: WAT envelope shape', () => {
    test('arena body sets/gets the bump pointer via $heap', () => {
        const wat = compileToWatString(`\\\\ probe () -> Int
@fn probe  := { &@with_arena {}; 0 };`)
        expect(wat).toContain('global.get $heap')
        expect(wat).toContain('global.set $heap')
    })

    test('String promotion lowers to a $arena_promote call', () => {
        const wat = compileToWatString(`
            \\\\ build () -> String
            @fn build  := &@with_arena {
                @local s := 'hi';
                &@move_to_parent_arena s
            };
        `)
        expect(wat).toContain('call $arena_promote')
    })

    test('arena prelude exports arena_promote', () => {
        // Spot-check the prelude wires the helper as a public export so
        // host tooling (and tests like arena.test.ts) can observe it.
        const wat = compileToWatString(`\\\\ probe () -> Int
@fn probe  := 0;`)
        expect(wat).toContain('"arena_promote"')
    })
})

describe('Phase 9c arena: QBE rejection (allocator surface deferred)', () => {
    test('&@with_arena throws a structured error on the QBE backend', () => {
        expect(() => toQbeIr(`\\\\ probe () -> Int
@fn probe  := { &@with_arena {}; 0 };`))
            .toThrow(/not yet supported on the native backend/)
    })

    test('&@move_to_parent_arena throws a structured error on the QBE backend', () => {
        expect(() => toQbeIr(`
            \\\\ build () -> Int
            @fn build  := &@with_arena { &@move_to_parent_arena 7 };
        `)).toThrow(/not yet supported on the native backend/)
    })

    test('QBE rejection error names Phase 9c-6 follow-up', () => {
        try {
            toQbeIr(`\\\\ probe () -> Int
@fn probe  := { &@with_arena {}; 0 };`)
            throw new Error('expected toQbeIr to throw')
        } catch (e) {
            expect(String(e)).toContain('9c-6')
        }
    })
})

