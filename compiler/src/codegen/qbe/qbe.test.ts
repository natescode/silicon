// SPDX-License-Identifier: MIT
/**
 * QBE direct lowering tests
 *
 * Story 8-1: module skeleton
 *   - Type mapping (SiliconType → QbeType)
 *   - Operator mapping (WAT intrinsic name → QBE mnemonic)
 *   - Function signature emission from real Silicon source
 *   - @extern declaration emission
 *   - @var global declaration emission
 *
 * Tests use actual Silicon source code compiled through the real pipeline
 * (parse → elaborate → typecheck) then lowered directly to QBE IR text.
 * No hand-built IRModule nodes — we verify the direct-lowering path.
 */

import { describe, test, expect } from 'bun:test'
import { siliconTypeToQbe, siliconTypeToQbeReturn, watInstrToQbeInstr } from './types'
import { lowerToQbe } from './lower'
import { compileToTyped } from '../../../tests/properties/_compile'

// ---------------------------------------------------------------------------
// Helper: compile Silicon source to QBE IR text
// ---------------------------------------------------------------------------

function toQbe(source: string): string {
    const { typedAST, registry, functions } = compileToTyped(source)
    return lowerToQbe(typedAST, registry, functions)
}

// ---------------------------------------------------------------------------
// Type mapping  (Story 8-1)
// ---------------------------------------------------------------------------

describe('siliconTypeToQbe', () => {
    test('Int → w',   () => expect(siliconTypeToQbe({ kind: 'Int' })).toBe('w'))
    test('Int64 → l', () => expect(siliconTypeToQbe({ kind: 'Int64' })).toBe('l'))
    test('Float → s', () => expect(siliconTypeToQbe({ kind: 'Float' })).toBe('s'))
    test('Bool → w',  () => expect(siliconTypeToQbe({ kind: 'Bool' })).toBe('w'))
    test('UInt8 → w', () => expect(siliconTypeToQbe({ kind: 'UInt8' })).toBe('w'))
    test('UInt64 → l',() => expect(siliconTypeToQbe({ kind: 'UInt64' })).toBe('l'))
    test('undefined → w (safe default)', () => expect(siliconTypeToQbe(undefined)).toBe('w'))
    test('String → l (64-bit pointer on native target)', () => expect(siliconTypeToQbe({ kind: 'String' })).toBe('l'))
})

describe('siliconTypeToQbeReturn', () => {
    test('Void → "void"',       () => expect(siliconTypeToQbeReturn({ kind: 'Void' })).toBe('void'))
    test('undefined → "void"',  () => expect(siliconTypeToQbeReturn(undefined)).toBe('void'))
    test('Int → "w"',           () => expect(siliconTypeToQbeReturn({ kind: 'Int' })).toBe('w'))
    test('Float → "s"',         () => expect(siliconTypeToQbeReturn({ kind: 'Float' })).toBe('s'))
    test('Int64 → "l"',         () => expect(siliconTypeToQbeReturn({ kind: 'Int64' })).toBe('l'))
})

// ---------------------------------------------------------------------------
// WAT intrinsic → QBE instruction mapping  (Story 8-1 / 8-2)
// ---------------------------------------------------------------------------

describe('watInstrToQbeInstr', () => {
    // arithmetic
    test('i32.add → add',    () => expect(watInstrToQbeInstr('i32.add')).toBe('add'))
    test('i32.sub → sub',    () => expect(watInstrToQbeInstr('i32.sub')).toBe('sub'))
    test('i32.mul → mul',    () => expect(watInstrToQbeInstr('i32.mul')).toBe('mul'))
    test('i32.div_s → div',  () => expect(watInstrToQbeInstr('i32.div_s')).toBe('div'))
    test('i32.div_u → udiv', () => expect(watInstrToQbeInstr('i32.div_u')).toBe('udiv'))
    // comparisons
    test('i32.eq → ceqw',    () => expect(watInstrToQbeInstr('i32.eq')).toBe('ceqw'))
    test('i32.lt_s → csltw', () => expect(watInstrToQbeInstr('i32.lt_s')).toBe('csltw'))
    test('i64.eq → ceql',    () => expect(watInstrToQbeInstr('i64.eq')).toBe('ceql'))
    test('f32.add → add',    () => expect(watInstrToQbeInstr('f32.add')).toBe('add'))
    test('f32.mul → mul',    () => expect(watInstrToQbeInstr('f32.mul')).toBe('mul'))
    test('f32.eq → ceqs',    () => expect(watInstrToQbeInstr('f32.eq')).toBe('ceqs'))
    // unknown returns undefined (not a throw)
    test('unknown → undefined', () => expect(watInstrToQbeInstr('bogus')).toBeUndefined())
})

// ---------------------------------------------------------------------------
// Function signature emission from real Silicon source  (Story 8-1)
// ---------------------------------------------------------------------------

describe('lowerToQbe — function signatures', () => {
    test('zero-param void function emits correct header', () => {
        const out = toQbe(`@fn noop  := {};`)
        expect(out).toContain('function $noop()')
        expect(out).toContain('@start')
        expect(out).toContain('}')
    })

    test('i32-returning function emits w return type', () => {
        const out = toQbe(`\\\\ answer () -> Int
@fn answer  := 42;`)
        expect(out).toContain('function w $answer()')
    })

    test('single Int param uses w type', () => {
        const out = toQbe(`\\\\ double (Int) -> Int
@fn double x := x + x;`)
        expect(out).toContain('w %x')
    })

    test('multi-param function lists all params', () => {
        const out = toQbe(`\\\\ add (Int, Int) -> Int
@fn add x, y := x + y;`)
        expect(out).toContain('$add(w %x, w %y)')
    })

    test('Float param uses s type', () => {
        const out = toQbe(`\\\\ neg (Float) -> Float
@fn neg v := v;`)
        expect(out).toContain('s %v')
    })

    test('multiple functions all appear in output', () => {
        const out = toQbe(`
            \\\\ one () -> Int
            @fn one  := 1;
            \\\\ two () -> Int
            @fn two  := 2;
        `)
        expect(out).toContain('$one')
        expect(out).toContain('$two')
    })

    test('output contains @start block entry label', () => {
        const out = toQbe(`\\\\ f (Int) -> Int
@fn f x := x;`)
        expect(out).toContain('@start')
    })

    test('output is syntactically a QBE function block', () => {
        const out = toQbe(`\\\\ f () -> Int
@fn f  := 0;`)
        // Must open with "function", contain @start, close with }
        expect(out).toMatch(/function.*\{/)
        expect(out).toContain('@start')
        expect(out).toContain('}')
    })
})

// ---------------------------------------------------------------------------
// @extern declaration emission  (Story 8-1)
// ---------------------------------------------------------------------------

describe('lowerToQbe — @extern', () => {
    test('@extern emits a comment (not a real function block)', () => {
        const out = toQbe(`@extern { \\\\ write (Int, Int, Int) -> Int }`)
        expect(out).toContain('# extern function')
        expect(out).toContain('$write')
        expect(out).not.toContain('@start')
    })

    test('@extern comment includes parameter types', () => {
        const out = toQbe(`@extern { \\\\ read (Int) -> Int }`)
        expect(out).toContain('$read')
        expect(out).toContain('# extern function')
    })
})

// ---------------------------------------------------------------------------
// @var global declaration emission  (Story 8-1 / 8-5)
// ---------------------------------------------------------------------------

describe('lowerToQbe — @var globals', () => {
    test('@var Int emits a w-typed data declaration', () => {
        const out = toQbe(`@var counter := 0;`)
        expect(out).toContain('data $counter')
        expect(out).toContain('w 0')
    })

    test('@var with non-zero init emits the actual value', () => {
        const out = toQbe(`@var answer := 42;`)
        expect(out).toContain('w 42')
    })

    test('@var Float emits an s-typed data declaration', () => {
        const out = toQbe(`@var pi := 3.14;`)
        expect(out).toContain('data $pi')
        expect(out).toContain('s ')
    })

    test('global appears before functions in output', () => {
        const out = toQbe(`
            @var x := 0;
            \\\\ f () -> Int
            @fn f  := 1;
        `)
        const globalPos = out.indexOf('data $x')
        const funcPos   = out.indexOf('function')
        expect(globalPos).toBeLessThan(funcPos)
    })

    test('global read in function body emits loadw', () => {
        const out = toQbe(`
            @var g := 0;
            \\\\ read_g () -> Int
            @fn read_g  := g;
        `)
        expect(out).toContain('loadw $g')
    })

    test('global write in function body emits storew', () => {
        const out = toQbe(`
            @var g := 0;
            @fn set_g  := { g = 99; };
        `)
        expect(out).toContain('storew')
        expect(out).toContain('$g')
    })

    test('global read-modify-write emits load + op + store', () => {
        const out = toQbe(`
            @var counter := 0;
            @fn inc  := { counter = counter + 1; };
        `)
        expect(out).toContain('loadw $counter')
        expect(out).toContain('storew')
    })
})

// ---------------------------------------------------------------------------
// Expression lowering — literals and arithmetic  (Story 8-1 / 8-2)
// ---------------------------------------------------------------------------

describe('lowerToQbe — literals', () => {
    test('integer constant in return position', () => {
        const out = toQbe(`\\\\ answer () -> Int
@fn answer  := 42;`)
        expect(out).toContain('ret 42')
    })

    test('boolean true constant', () => {
        const out = toQbe(`\\\\ always_true () -> Bool
@fn always_true  := @true;`)
        expect(out).toContain('ret 1')
    })
})

describe('lowerToQbe — binary arithmetic', () => {
    test('Int addition emits QBE add instruction', () => {
        const out = toQbe(`\\\\ add (Int, Int) -> Int
@fn add x, y := x + y;`)
        expect(out).toContain('=w add %x, %y')
    })

    test('Int subtraction emits sub', () => {
        const out = toQbe(`\\\\ sub (Int, Int) -> Int
@fn sub x, y := x - y;`)
        expect(out).toContain('=w sub %x, %y')
    })

    test('Int multiplication emits mul', () => {
        const out = toQbe(`\\\\ mul (Int, Int) -> Int
@fn mul x, y := x * y;`)
        expect(out).toContain('=w mul %x, %y')
    })

    test('Int equality emits ceqw', () => {
        const out = toQbe(`\\\\ eq (Int, Int) -> Bool
@fn eq x, y := x == y;`)
        expect(out).toContain('ceqw')
    })

    test('Float addition emits QBE add instruction (single via =s sigil)', () => {
        const out = toQbe(`\\\\ fadd (Float, Float) -> Float
@fn fadd x, y := x + y;`)
        expect(out).toContain('=s add %x, %y')
    })

    test('nested arithmetic emits multiple instructions', () => {
        const out = toQbe(`\\\\ calc (Int) -> Int
@fn calc x := (x + 1) * 2;`)
        // Should have at least two instructions for the two operations
        const instrCount = (out.match(/^\s+%t\d+ =/gm) ?? []).length
        expect(instrCount).toBeGreaterThanOrEqual(2)
    })
})

// ---------------------------------------------------------------------------
// Call lowering  (Story 8-3)
// ---------------------------------------------------------------------------

describe('lowerToQbe — function calls', () => {
    test('user function call emits QBE call instruction', () => {
        const out = toQbe(`
            \\\\ add (Int, Int) -> Int
            @fn add a, b := a + b;
            \\\\ main () -> Int
            @fn main  := &add 1, 2;
        `)
        expect(out).toContain('call $add(')
    })

    test('user function call result stored in temp', () => {
        const out = toQbe(`
            \\\\ double (Int) -> Int
            @fn double x := x + x;
            \\\\ main () -> Int
            @fn main  := &double 5;
        `)
        expect(out).toMatch(/%t\d+ =w call \$double/)
    })

    test('extern function call emits QBE call instruction', () => {
        const out = toQbe(`
            @extern { \\\\ write (Int, Int, Int) -> Int }
            \\\\ f () -> Int
            @fn f  := &write 1, 2, 3;
        `)
        expect(out).toContain('call $write(')
    })

    test('void function call emits call without assignment', () => {
        const out = toQbe(`
            @fn noop  := {};
            @fn caller  := { &noop; };
        `)
        // void call — no assignment, just bare call
        expect(out).toMatch(/\tcall \$noop\(\)/)
    })

    test('call with typed args emits correct types', () => {
        const out = toQbe(`
            \\\\ add (Int, Int) -> Int
            @fn add a, b := a + b;
            \\\\ main () -> Int
            @fn main  := &add 10, 20;
        `)
        expect(out).toContain('w 10')
        expect(out).toContain('w 20')
    })
})

describe('lowerToQbe — @return', () => {
    test('@return in function body emits ret instruction', () => {
        const out = toQbe(`\\\\ f (Int) -> Int
@fn f x := { &@return x; x };`)
        expect(out).toContain('ret %x')
    })

    test('@return with literal emits ret literal', () => {
        const out = toQbe(`\\\\ zero () -> Int
@fn zero  := { &@return 0; 1 };`)
        expect(out).toContain('ret 0')
    })

    test('early @return stops at first ret, trailing expr also has ret', () => {
        const out = toQbe(`\\\\ f (Int) -> Int
@fn f x := { &@return 0; x };`)
        // At least one ret 0 appears
        expect(out).toContain('ret 0')
    })
})

// ---------------------------------------------------------------------------
// Control flow  (Story 8-4)
// ---------------------------------------------------------------------------

describe('lowerToQbe — @local variable declarations', () => {
    test('@local Int declaration emits copy instruction', () => {
        const out = toQbe(`\\\\ f () -> Int
@fn f  := { @local x:Int := 5; x };`)
        expect(out).toContain('=w copy 5')
    })

    test('@local variable is readable after declaration', () => {
        const out = toQbe(`\\\\ f () -> Int
@fn f  := { @local x:Int := 42; x };`)
        expect(out).toContain('ret %x')
    })

    test('assignment to local emits copy', () => {
        const out = toQbe(`\\\\ f () -> Int
@fn f  := { @local x:Int := 0; x = 7; x };`)
        expect(out).toContain('=w copy 7')
    })
})

describe('lowerToQbe — @if', () => {
    test('@if with no else emits jnz + block labels', () => {
        const out = toQbe(`@fn f  := { @local x:Int := 0; &@if x == 0, { x = 1 }; };`)
        expect(out).toContain('jnz')
        expect(out).toMatch(/@\w+/)
    })

    test('@if with else emits two branches', () => {
        const out = toQbe(`\\\\ abs (Int) -> Int
@fn abs x := &@if x < 0, { 0 - x }, { x };`)
        // Both 0 - x and the else branch should appear
        expect(out).toContain('jnz')
        // Two block labels: then + else
        const labels = (out.match(/^@\w+/gm) ?? []).filter(l => l !== '@start')
        expect(labels.length).toBeGreaterThanOrEqual(2)
    })

    test('@if condition uses the correct comparison instruction', () => {
        const out = toQbe(`\\\\ f (Int) -> Int
@fn f x := &@if x == 0, { 1 }, { 0 };`)
        expect(out).toContain('ceqw')
        expect(out).toContain('jnz')
    })

    test('@if result is returned from function', () => {
        const out = toQbe(`\\\\ sign (Int) -> Int
@fn sign x := &@if x < 0, { 0 - 1 }, { 1 };`)
        expect(out).toContain('ret')
    })
})

describe('lowerToQbe — @loop / @break', () => {
    test('@loop emits a loop head block', () => {
        const out = toQbe(`@fn f  := { &@loop { &@break }; };`)
        // Must have at least two labels: the loop head + exit
        const labels = (out.match(/^@\w+/gm) ?? []).filter(l => l !== '@start')
        expect(labels.length).toBeGreaterThanOrEqual(2)
    })

    test('@break emits a jump to the loop exit label', () => {
        const out = toQbe(`@fn f  := { &@loop { &@break }; };`)
        // A jmp instruction that targets a loop exit label must appear
        expect(out).toMatch(/jmp @\w+/)
    })

    test('loop body executes until @break', () => {
        const out = toQbe(`
            \\\\ count () -> Int
            @fn count  := {
                @local i := 0;
                &@loop {
                    i = i + 1;
                    &@if i == 3, { &@break };
                };
                i
            };
        `)
        expect(out).toContain('jnz')
        expect(out).toMatch(/jmp @\w+/)
    })
})

// ---------------------------------------------------------------------------
// @defer  (Story 8-6)
// ---------------------------------------------------------------------------

describe('lowerToQbe — @defer', () => {
    test('@defer cleanup runs before normal function return', () => {
        const out = toQbe(`
            @extern { \\\\ cleanup (Int) -> Int }
            \\\\ f (Int) -> Int
            @fn f h := {
                &@defer &cleanup h;
                h
            };
        `)
        // The call to cleanup must appear before the final ret
        const cleanupPos = out.indexOf('call $cleanup')
        const retPos     = out.lastIndexOf('ret ')
        expect(cleanupPos).toBeGreaterThan(-1)
        expect(cleanupPos).toBeLessThan(retPos)
    })

    test('@defer runs before early @return', () => {
        const out = toQbe(`
            @extern { \\\\ release (Int) -> Int }
            \\\\ f (Int, Int) -> Int
            @fn f flag, h := {
                &@defer &release h;
                &@if flag == 0, { &@return 0 };
                h
            };
        `)
        // release must appear before both ret 0 (early) and the trailing ret
        expect(out).toContain('call $release')
    })

    test('@defer LIFO: last registered runs first', () => {
        const out = toQbe(`
            @extern { \\\\ a () -> Int }
            @extern { \\\\ b () -> Int }
            @fn f  := {
                &@defer &a;
                &@defer &b;
            };
        `)
        const posA = out.indexOf('call $a')
        const posB = out.indexOf('call $b')
        // b was deferred last, so b runs before a
        expect(posB).toBeLessThan(posA)
    })
})

// ---------------------------------------------------------------------------
// End-to-end complete function lowering  (Story 8-6)
// ---------------------------------------------------------------------------

describe('lowerToQbe — complete function lowering', () => {
    test('safe_div: early return + arithmetic', () => {
        const out = toQbe(`
            \\\\ safe_div (Int, Int) -> Int
            @fn safe_div a, b := {
                &@if b == 0, { &@return 0 };
                a / b
            };
        `)
        expect(out).toContain('ceqw')
        expect(out).toContain('ret 0')
        expect(out).toContain('div')
    })

    test('clamp: multi-branch mutation + return', () => {
        const out = toQbe(`
            \\\\ clamp (Int, Int, Int) -> Int
            @fn clamp x, lo, hi := {
                @local r := x;
                &@if r < lo, { r = lo };
                &@if r > hi, { r = hi };
                r
            };
        `)
        expect(out).toContain('csltw')
        expect(out).toContain('csgtw')
        expect(out).toContain('ret')
    })

    test('nested calls: double + quad', () => {
        const out = toQbe(`
            \\\\ double (Int) -> Int
            @fn double x := x + x;
            \\\\ quad (Int) -> Int
            @fn quad x := &double (&double x);
        `)
        const doubleCount = (out.match(/call \$double/g) ?? []).length
        expect(doubleCount).toBe(2)
    })
})
