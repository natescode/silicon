// SPDX-License-Identifier: MIT
/**
 * Self-host gate (story 8-13)
 *
 * Verifies that the native QBE pipeline can compile the full example suite.
 * Each test compiles one example from src/e2e/examples/ to a native binary
 * and confirms it exits cleanly (code 0).
 *
 * Tests skip gracefully when qbe or cc is absent (local dev without toolchain).
 * In CI, all four platform workflows install qbe+cc, so the full suite runs.
 *
 * Programs requiring features not yet in the QBE lowerer (strings, structs,
 * casts, @extern, WASI) are excluded with a comment explaining why.
 */

import { describe, test, expect } from 'bun:test'
import * as path from 'node:path'
import * as os   from 'node:os'
import * as fs   from 'node:fs'
import * as fsp  from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

import { findQbe, invokeQbe, hostQbeArch } from './backend'
import { findCc, link }                    from './linker'
import { compileToQbe }                     from '@silicon/compiler/native'

// ---------------------------------------------------------------------------
// Toolchain guard
// ---------------------------------------------------------------------------

const qbeBin = findQbe()
const ccBin  = findCc()
const SKIP   = !qbeBin || !ccBin

// Example suite lives in the compiler package; reference it across the workspace.
const EXAMPLES_DIR = path.join(import.meta.dir, '..', '..', '..', 'compiler', 'src', 'e2e', 'examples')

// ---------------------------------------------------------------------------
// Programs expected to compile and run cleanly through the QBE backend.
// All produce exit code 0 (injected $main returns 0; top-level expressions
// go into $__sgl_entry which is called but its return value is discarded).
// ---------------------------------------------------------------------------
const COMPILE_OK: string[] = [
    // -- literals --
    'simple_literal.si',          // 42;
    'basic_arithmetic.si',        // 1 + 2;
    'float_literal.si',           // 3.14;
    'boolean_true.si',            // @true;
    'boolean_false.si',           // @false;
    // -- arithmetic --
    'subtraction.si',
    'multiplication.si',
    'division.si',
    'modulo.si',
    'nested_expressions.si',      // (1 + 2) * 3;
    'complex_expression.si',
    // -- comparisons --
    'comparison_equal.si',        // 5 == 5;
    'comparison_not_equal.si',    // 5 != 3;
    'comparison_greater_than.si', // 5 > 3;
    'comparison_less_than.si',    // 3 < 5;
    'comparison_greater_equal.si',// 5 >= 3;
    'comparison_less_equal.si',   // 3 <= 5;
    // -- bitwise --
    'bitwise_or.si',              // 5 | 3;
    'bitwise_xor.si',             // 5 ^ 3;
    'bitwise_shl.si',             // 1 << 3;
    'bitwise_shr.si',             // 8 >> 1;
    // -- stratum (verifies built-in stratum dispatch) --
    'stratum_definition.si',      // 1 + 2;
    // -- functions --
    'fn_function.si',             // @fn add x:Int, y:Int := x + y;
    'function_definition.si',     // @fn add x:Int, y:Int := x + y;
    'function_call.si',           // @fn add ...; &add 1, 2;
    'block_trailing_expr.si',     // @fn add x:Int, y:Int := { x + y };
    'block_stmts_then_expr.si',   // @fn compute x:Int, y:Int := { x = x + 1; x + y };
    // -- control flow --
    'if_else_expr.si',            // @fn choose a:Int, b:Int, flag:Int := { &@if flag, { a }, { b } };
    'if_in_block.si',             // @fn abs x:Int := { &@if x < 0, { 0 - x }, { x } };
    'early_return.si',            // @fn safeDivide ... @return
    // -- loops + variables --
    'count_loop.si',              // @local n:Int + @loop
    'var_global.si',              // @local count:Int := 0;
    'var_mutation.si',            // global var mutation
    'local_set_fix.si',           // @fn inc x:Int := { x = x + 1; x };
]

// Programs that require features not yet in the QBE lowerer — excluded to
// keep the gate green while those features are in progress.
// string_literal.si, multiple_statements.si — string data sections unimplemented
// struct_basic.si, struct_nested.si        — struct field layout unimplemented
// cast_to_float.si, cast_to_int.si         — @toFloat/@toInt casts unimplemented
// let_constant.si                          — @global + call-style access uncertain
// user_stratum_add.si                      — compiler API strata
// path_open_i64.si                         — WASI FFI
// defer_*.si, int64_extern_call.si         — @extern (no implementations provided)

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function compileExample(name: string, tmpDir: string): Promise<number> {
    const src = await fsp.readFile(path.join(EXAMPLES_DIR, name), 'utf-8')
    const { qbeIr, diagnostics } = compileToQbe(src)
    if (diagnostics.length) throw new Error(diagnostics.map(d => d.message).join('\n'))
    const asmOut = invokeQbe(qbeBin!, qbeIr, hostQbeArch())
    const stem   = path.basename(name, '.si')
    const asmPath = path.join(tmpDir, `${stem}.s`)
    const exePath = path.join(tmpDir, stem)
    await fsp.writeFile(asmPath, asmOut)
    link(ccBin!, asmPath, exePath)
    const r = spawnSync(exePath, [], { stdio: 'pipe' })
    return r.status ?? -1
}

// ---------------------------------------------------------------------------
// Self-host suite
// ---------------------------------------------------------------------------

describe('selfhost — native pipeline compiles example suite', () => {
    for (const example of COMPILE_OK) {
        test(example, async () => {
            if (SKIP) {
                console.log('  (skipped: qbe or cc not on PATH)')
                return
            }
            const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgl-sh-'))
            try {
                const code = await compileExample(example, tmpDir)
                expect(code).toBe(0)
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true })
            }
        })
    }
})

// ---------------------------------------------------------------------------
// Coverage report (informational, always runs)
// ---------------------------------------------------------------------------

describe('selfhost — coverage', () => {
    test('COMPILE_OK list is non-empty', () => {
        expect(COMPILE_OK.length).toBeGreaterThan(0)
    })

    test('all listed examples exist on disk', () => {
        for (const name of COMPILE_OK) {
            const p = path.join(EXAMPLES_DIR, name)
            expect(fs.existsSync(p), `${name} missing from examples dir`).toBe(true)
        }
    })
})
