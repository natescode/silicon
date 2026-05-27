/**
 * IR Lowering and Emission Tests
 *
 * Validates the typed IR pipeline:
 *   typed AST node → lowerExpr → IRExpr → emitExpr → WAT string
 *
 * Key property under test: Float arithmetic produces 'f32.add' (not 'i32.add')
 * because the decision is driven by `inferredType`, not by inspecting compiled
 * WAT substrings.
 */

import { test, expect, describe } from 'bun:test'
import { buildStrataRegistry } from '../elaborator/strataLoader'
import { ASTFactory } from '../ast/astNodes'
import { TypeInt, TypeFloat, TypeBool } from '../types/types'
import { intrinsicSignature } from '../types/intrinsicSig'
import { lowerProgram, IRLowerError } from './lower'
import { emitExpr, emitModule } from './emit'
import { ARRAY_LITERAL_CALLEE } from './nodes'
import type { IRExpr, IRBinOp, IRConst, IRCall, IRIf } from './nodes'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const emptyProgram = ASTFactory.program([])
const registry = buildStrataRegistry(emptyProgram)
const noFunctions = new Map<string, any>()

/** Build a BinaryOp AST node with inferredType stamped (as the type checker would do). */
function binOp(left: any, op: string, right: any, inferredType: any): any {
    return { type: 'BinaryOp', operator: op, left, right, inferredType }
}

function intLit(n: number): any {
    return { type: 'IntLiteral', value: String(n), base: 'decimal', inferredType: TypeInt }
}

function floatLit(v: number): any {
    return { type: 'FloatLiteral', value: String(v), inferredType: TypeFloat }
}

function boolLit(b: boolean): any {
    return { type: 'BooleanLiteral', value: b, inferredType: TypeBool }
}

function namespace(path: string[], inferredType: any): any {
    return { type: 'Namespace', path, inferredType }
}

/** Lower a single expression node in an empty scope. */
function lower(node: any): IRExpr {
    const prog = ASTFactory.program([])
    const mod = lowerProgram(
        { ...prog, elements: [] },
        registry,
        noFunctions,
    )
    // Directly lower via lowerProgram by wrapping in a minimal function.
    // For unit testing, we test lowerExpr indirectly via lowerProgram with a
    // function def whose body is our node.
    return lowerExprDirect(node)
}

/** Lower an expression node directly using the internal lowerer. */
function lowerExprDirect(node: any): IRExpr {
    // Build a zero-param @let that returns the node as its body.
    const binding = { expression: node }
    const def = {
        type: 'Definition',
        keyword: '@let',
        name: { name: '__test', typeAnnotation: undefined },
        params: [],
        binding,
        hook: 'function',
    }
    const prog = { type: 'Program', elements: [def] }
    const mod = lowerProgram(prog, registry, noFunctions)
    return mod.functions[0]?.body ?? { kind: 'Nop' }
}

// ---------------------------------------------------------------------------
// Constant lowering
// ---------------------------------------------------------------------------

describe('IR lowering: constants', () => {
    test('IntLiteral → IRConst i32', () => {
        const ir = lowerExprDirect(intLit(42)) as IRConst
        expect(ir.kind).toBe('Const')
        expect(ir.wasmType).toBe('i32')
        expect(ir.value).toBe(42)
    })

    test('FloatLiteral → IRConst f32', () => {
        const ir = lowerExprDirect(floatLit(3.14)) as IRConst
        expect(ir.kind).toBe('Const')
        expect(ir.wasmType).toBe('f32')
        expect(ir.value).toBeCloseTo(3.14)
    })

    test('BooleanLiteral true → IRConst i32 1', () => {
        const ir = lowerExprDirect(boolLit(true)) as IRConst
        expect(ir.kind).toBe('Const')
        expect(ir.wasmType).toBe('i32')
        expect(ir.value).toBe(1)
    })

    test('BooleanLiteral false → IRConst i32 0', () => {
        const ir = lowerExprDirect(boolLit(false)) as IRConst
        expect(ir.kind).toBe('Const')
        expect(ir.wasmType).toBe('i32')
        expect(ir.value).toBe(0)
    })
})

// ---------------------------------------------------------------------------
// Binary operation lowering — the key Round 31 improvement
// ---------------------------------------------------------------------------

describe('IR lowering: binary operators (type-driven, not sniffed)', () => {
    test('Int + Int → IRBinOp wasmType:i32, op:i32_add', () => {
        const node = binOp(intLit(1), '+', intLit(2), TypeInt)
        const ir = lowerExprDirect(node) as IRBinOp
        expect(ir.kind).toBe('BinOp')
        expect(ir.wasmType).toBe('i32')
        expect((ir as any).op).toBe('i32_add')
    })

    test('Float + Float → IRBinOp wasmType:f32, op:f32_add (no sniffing!)', () => {
        const node = binOp(floatLit(1.0), '+', floatLit(2.0), TypeFloat)
        const ir = lowerExprDirect(node) as IRBinOp
        expect(ir.kind).toBe('BinOp')
        expect(ir.wasmType).toBe('f32')
        // This is the key test: f32.add is chosen from inferredType, not from
        // inspecting whether the compiled WAT contains "f32.const".
        expect((ir as any).op).toBe('f32_add')
    })

    test('Int * Int → IRBinOp op:i32_mul', () => {
        const node = binOp(intLit(3), '*', intLit(4), TypeInt)
        const ir = lowerExprDirect(node) as IRBinOp
        expect((ir as any).op).toBe('i32_mul')
    })

    test('Float * Float → IRBinOp op:f32_mul', () => {
        const node = binOp(floatLit(1.5), '*', floatLit(2.0), TypeFloat)
        const ir = lowerExprDirect(node) as IRBinOp
        expect((ir as any).op).toBe('f32_mul')
    })

    test('Int < Int → IRBinOp wasmType:i32, op:i32_lt_s (comparison returns Bool→i32)', () => {
        const node = binOp(intLit(1), '<', intLit(2), TypeBool)
        const ir = lowerExprDirect(node) as IRBinOp
        expect(ir.kind).toBe('BinOp')
        expect(ir.wasmType).toBe('i32')
        expect((ir as any).op).toBe('i32_lt_s')
    })

    test('Float < Float → IRBinOp op:f32_lt', () => {
        const node = binOp(floatLit(1.0), '<', floatLit(2.0), TypeBool)
        const ir = lowerExprDirect(node) as IRBinOp
        expect((ir as any).op).toBe('f32_lt')
    })

    test('Int == Int → IRBinOp op:i32_eq', () => {
        const node = binOp(intLit(1), '==', intLit(1), TypeBool)
        const ir = lowerExprDirect(node) as IRBinOp
        expect((ir as any).op).toBe('i32_eq')
    })

    test('|| → IRIf (short-circuit)', () => {
        const node = binOp(boolLit(false), '||', boolLit(true), TypeBool)
        const ir = lowerExprDirect(node) as IRIf
        expect(ir.kind).toBe('If')
        expect(ir.wasmType).toBe('i32')
        // then branch is always (i32.const 1)
        expect((ir.then as IRConst).value).toBe(1)
    })

    test('bitwise | always uses i32.or regardless of operand type', () => {
        // | is always i32 in WASM
        const node = binOp(intLit(3), '|', intLit(1), TypeInt)
        const ir = lowerExprDirect(node) as IRBinOp
        expect((ir as any).op).toBe('i32_or')
    })
})

// ---------------------------------------------------------------------------
// WAT emission: constants
// ---------------------------------------------------------------------------

describe('IR emission: constants', () => {
    test('IRConst i32 42 → (i32.const 42)', () => {
        const ir: IRExpr = { kind: 'Const', wasmType: 'i32', value: 42 }
        expect(emitExpr(ir)).toBe('(i32.const 42)')
    })

    test('IRConst f32 3.14 → (f32.const 3.14)', () => {
        const ir: IRExpr = { kind: 'Const', wasmType: 'f32', value: 3.14 }
        expect(emitExpr(ir)).toBe('(f32.const 3.14)')
    })
})

// ---------------------------------------------------------------------------
// WAT emission: binary ops
// ---------------------------------------------------------------------------

describe('IR emission: binary ops (type-driven)', () => {
    test('i32.add emission', () => {
        const ir: IRExpr = {
            kind: 'BinOp', wasmType: 'i32', op: 'i32_add',
            left: { kind: 'Const', wasmType: 'i32', value: 1 },
            right: { kind: 'Const', wasmType: 'i32', value: 2 },
        }
        const wat = emitExpr(ir)
        expect(wat).toContain('i32.add')
        expect(wat).toContain('(i32.const 1)')
        expect(wat).toContain('(i32.const 2)')
        expect(wat).not.toContain('f32')
    })

    test('f32.add emission — correct instruction, no i32.add', () => {
        const ir: IRExpr = {
            kind: 'BinOp', wasmType: 'f32', op: 'f32_add',
            left: { kind: 'Const', wasmType: 'f32', value: 1.0 },
            right: { kind: 'Const', wasmType: 'f32', value: 2.0 },
        }
        const wat = emitExpr(ir)
        expect(wat).toContain('f32.add')
        expect(wat).toContain('(f32.const 1)')
        expect(wat).toContain('(f32.const 2)')
        expect(wat).not.toContain('i32.add')
    })

    test('f32.lt emission with i32 result', () => {
        const ir: IRExpr = {
            kind: 'BinOp', wasmType: 'i32', op: 'f32_lt',
            left: { kind: 'Const', wasmType: 'f32', value: 1.0 },
            right: { kind: 'Const', wasmType: 'f32', value: 2.0 },
        }
        const wat = emitExpr(ir)
        expect(wat).toContain('f32.lt')
        expect(wat).not.toContain('i32.lt')
    })
})

// ---------------------------------------------------------------------------
// WAT emission: control flow
// ---------------------------------------------------------------------------

describe('IR emission: control flow', () => {
    test('IRIf with else (value-producing) emits (if (result i32) ...)', () => {
        const ir: IRExpr = {
            kind: 'If', wasmType: 'i32',
            cond: { kind: 'Const', wasmType: 'i32', value: 1 },
            then: { kind: 'Const', wasmType: 'i32', value: 10 },
            else_: { kind: 'Const', wasmType: 'i32', value: 20 },
        }
        const wat = emitExpr(ir)
        expect(wat).toContain('(if (result i32)')
        expect(wat).toContain('(then')
        expect(wat).toContain('(else')
    })

    test('IRIf void form (no else) emits plain (if ...)', () => {
        const ir: IRExpr = {
            kind: 'If', wasmType: 'void',
            cond: { kind: 'Const', wasmType: 'i32', value: 1 },
            then: { kind: 'Nop' },
        }
        const wat = emitExpr(ir)
        expect(wat).toContain('(if')
        expect(wat).not.toContain('result')
    })

    test('IRLoop emits block/loop labels', () => {
        const ir: IRExpr = {
            kind: 'Loop', id: 7,
            cond: { kind: 'Const', wasmType: 'i32', value: 1 },
            body: { kind: 'Nop' },
        }
        const wat = emitExpr(ir)
        expect(wat).toContain('$brk_7')
        expect(wat).toContain('$cont_7')
        expect(wat).toContain('br_if $brk_7')
        expect(wat).toContain('br $cont_7')
    })

    test('IRBreak emits br to exit label', () => {
        const ir: IRExpr = { kind: 'Break', id: 3 }
        expect(emitExpr(ir)).toBe('(br $brk_3)')
    })

    test('IRContinue emits br to loop header', () => {
        const ir: IRExpr = { kind: 'Continue', id: 3 }
        expect(emitExpr(ir)).toBe('(br $cont_3)')
    })
})

// ---------------------------------------------------------------------------
// Full pipeline: lowerProgram → emitModule
// ---------------------------------------------------------------------------

describe('IR pipeline: lowerProgram + emitModule', () => {
    test('simple Int function emits i32.add', () => {
        const addDef = {
            type: 'Definition',
            keyword: '@let',
            name: { name: 'add', typeAnnotation: { typename: 'Int' } },
            params: [
                { name: 'a', typeAnnotation: { typename: 'Int' }, isLiteral: false },
                { name: 'b', typeAnnotation: { typename: 'Int' }, isLiteral: false },
            ],
            binding: {
                expression: binOp(
                    namespace(['a'], TypeInt),
                    '+',
                    namespace(['b'], TypeInt),
                    TypeInt,
                ),
            },
            hook: 'function',
        }
        const prog = { type: 'Program', elements: [addDef] }
        const funcs = new Map([['add', { params: [TypeInt, TypeInt], result: TypeInt }]])
        const mod = lowerProgram(prog, registry, funcs)

        expect(mod.functions).toHaveLength(1)
        expect(mod.functions[0].name).toBe('add')
        expect(mod.functions[0].returnType).toBe('i32')

        const wat = emitModule(mod, '')
        expect(wat).toContain('i32.add')
        expect(wat).not.toContain('f32.add')
        expect(wat).toContain('(func $add')
        expect(wat).toContain('(param $a i32)')
        expect(wat).toContain('(param $b i32)')
        expect(wat).toContain('(result i32)')
    })

    test('Float function emits f32.add — type-driven, not sniffed', () => {
        const addDef = {
            type: 'Definition',
            keyword: '@let',
            name: { name: 'fadd', typeAnnotation: { typename: 'Float' } },
            params: [
                { name: 'a', typeAnnotation: { typename: 'Float' }, isLiteral: false },
                { name: 'b', typeAnnotation: { typename: 'Float' }, isLiteral: false },
            ],
            binding: {
                expression: binOp(
                    namespace(['a'], TypeFloat),
                    '+',
                    namespace(['b'], TypeFloat),
                    TypeFloat,
                ),
            },
            hook: 'function',
        }
        const prog = { type: 'Program', elements: [addDef] }
        const funcs = new Map([['fadd', { params: [TypeFloat, TypeFloat], result: TypeFloat }]])
        const mod = lowerProgram(prog, registry, funcs)

        const wat = emitModule(mod, '')
        expect(wat).toContain('f32.add')
        expect(wat).not.toContain('i32.add')
        expect(wat).toContain('(param $a f32)')
        expect(wat).toContain('(param $b f32)')
        expect(wat).toContain('(result f32)')
    })

    test('Float comparison function emits f32.gt with i32 result', () => {
        const def = {
            type: 'Definition',
            keyword: '@let',
            name: { name: 'greater', typeAnnotation: { typename: 'Int' } },
            params: [
                { name: 'a', typeAnnotation: { typename: 'Float' }, isLiteral: false },
                { name: 'b', typeAnnotation: { typename: 'Float' }, isLiteral: false },
            ],
            binding: {
                expression: binOp(
                    namespace(['a'], TypeFloat),
                    '>',
                    namespace(['b'], TypeFloat),
                    TypeBool,
                ),
            },
            hook: 'function',
        }
        const prog = { type: 'Program', elements: [def] }
        const funcs = new Map([['greater', { params: [TypeFloat, TypeFloat], result: TypeBool }]])
        const mod = lowerProgram(prog, registry, funcs)

        const wat = emitModule(mod, '')
        expect(wat).toContain('f32.gt')
        expect(wat).not.toContain('i32.gt')
    })

    test('lowerProgram handles empty program', () => {
        const prog = { type: 'Program', elements: [] }
        const mod = lowerProgram(prog, registry, noFunctions)
        expect(mod.kind).toBe('Module')
        expect(mod.functions).toHaveLength(0)
        expect(mod.globals).toHaveLength(0)
    })
})

// ---------------------------------------------------------------------------
// intrinsicSignature — type signature derivation
// ---------------------------------------------------------------------------

describe('intrinsicSignature', () => {
    test('i32_add → (Int, Int) → Int', () => {
        const sig = intrinsicSignature('WASM::i32_add')
        expect(sig).toBeDefined()
        expect(sig!.params).toEqual([TypeInt, TypeInt])
        expect(sig!.result).toEqual(TypeInt)
    })

    test('f32_add → (Float, Float) → Float', () => {
        const sig = intrinsicSignature('WASM::f32_add')
        expect(sig).toBeDefined()
        expect(sig!.params).toEqual([TypeFloat, TypeFloat])
        expect(sig!.result).toEqual(TypeFloat)
    })

    test('i32_lt_s → (Int, Int) → Bool (comparison)', () => {
        const sig = intrinsicSignature('WASM::i32_lt_s')
        expect(sig).toBeDefined()
        expect(sig!.params).toEqual([TypeInt, TypeInt])
        expect(sig!.result).toEqual(TypeBool)
    })

    test('f32_lt → (Float, Float) → Bool (comparison)', () => {
        const sig = intrinsicSignature('WASM::f32_lt')
        expect(sig).toBeDefined()
        expect(sig!.params).toEqual([TypeFloat, TypeFloat])
        expect(sig!.result).toEqual(TypeBool)
    })

    test('i32_eqz has no Silicon-level signature (accepts both Int and Bool operands)', () => {
        // eqz is intentionally untyped: @not must accept Bool and Int. Giving it
        // a signature would cause the typechecker to reject `@not @true` (Bool arg)
        // because the table would say the parameter is Int.
        expect(intrinsicSignature('WASM::i32_eqz')).toBeUndefined()
    })

    test('f32_neg → (Float) → Float (unary)', () => {
        const sig = intrinsicSignature('WASM::f32_neg')
        expect(sig).toBeDefined()
        expect(sig!.params).toEqual([TypeFloat])
        expect(sig!.result).toEqual(TypeFloat)
    })

    test('f32_convert_i32_s → (Int) → Float (conversion)', () => {
        const sig = intrinsicSignature('WASM::f32_convert_i32_s')
        expect(sig).toBeDefined()
        expect(sig!.params).toEqual([TypeInt])
        expect(sig!.result).toEqual(TypeFloat)
    })

    test('i32_trunc_f32_s → (Float) → Int (conversion)', () => {
        const sig = intrinsicSignature('WASM::i32_trunc_f32_s')
        expect(sig).toBeDefined()
        expect(sig!.params).toEqual([TypeFloat])
        expect(sig!.result).toEqual(TypeInt)
    })

    test('control strata have no signature', () => {
        expect(intrinsicSignature('WASM::control_if')).toBeUndefined()
        expect(intrinsicSignature('WASM::control_loop')).toBeUndefined()
        expect(intrinsicSignature('WASM::control_break')).toBeUndefined()
    })

    test('IR kinds have no intrinsic signature (not WASM instructions)', () => {
        expect(intrinsicSignature('IR::def_function')).toBeUndefined()
        expect(intrinsicSignature('IR::meta_export')).toBeUndefined()
    })

    test('unknown name returns undefined', () => {
        expect(intrinsicSignature('WASM::does_not_exist')).toBeUndefined()
        expect(intrinsicSignature('not_a_wasm_name')).toBeUndefined()
    })

    test('ARRAY_LITERAL_CALLEE is a defined string constant', () => {
        expect(typeof ARRAY_LITERAL_CALLEE).toBe('string')
        expect(ARRAY_LITERAL_CALLEE.length).toBeGreaterThan(0)
    })
})
