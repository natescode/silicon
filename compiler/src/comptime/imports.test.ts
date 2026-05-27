/**
 * Tests for the comptime import surface.
 *
 * Each import is a JS function that the WASM-side handler will call via
 * its `@extern` declaration.  We exercise the imports directly (no full
 * WASM compile) because:
 *
 *   (a) The wrapper logic is what we're testing — does it recover the
 *       right value from a handle, call the right builder, intern the
 *       result?  That's JS-level behaviour.
 *
 *   (b) End-to-end WASM-side wiring needs the "compiler" module to be
 *       registered in `moduleRegistry` so the lowerer recognises
 *       `&compiler::ir_makeConst` calls in handler source.  That
 *       plumbing is a separate story (D-B-* continuation).  The import
 *       surface is well-typed regardless — once wired, identical code
 *       runs.
 *
 * Covers D-B-3 (basic IR builders) and D-B-2's downstream usage.
 */

import { test, expect, describe } from 'bun:test'
import { createComptimeEnv, createComptimeImports } from './imports'
import { createElaboratorRegistry } from '../elaborator/registry'
import type {
    IRConst, IRBinOp, IRBlock, IRLocalGet, IRLocalSet, IRGlobalSet,
    IRIf, IRLoop, IRBreak, IRContinue, IRReturn,
    IRExport, IRLocal, IRParam, IRGlobal, IRFunction, IRImport,
} from '../ir/nodes'

function setup() {
    const env = createComptimeEnv(createElaboratorRegistry())
    const imports = createComptimeImports(env)
    // Cast once — every host import returns or accepts an i32; the
    // shape is uniform.  We only need `any` here, not at call sites.
    const fns = imports.compiler as Record<string, (...args: number[]) => number>
    return { env, fns }
}

describe('imports — ir_makeConst', () => {
    test('returns a non-zero handle for a literal Const node', () => {
        const { env, fns } = setup()
        const wtId = env.strings.intern('i32')
        const handle = fns.ir_makeConst(42, wtId)
        expect(handle).toBeGreaterThan(0)
    })

    test('the resulting IR Const has the value and type that were passed', () => {
        const { env, fns } = setup()
        const wtId = env.strings.intern('i32')
        const handle = fns.ir_makeConst(42, wtId)
        const ir = env.irHandles.get(handle) as IRConst
        expect(ir.kind).toBe('Const')
        expect(ir.value).toBe(42)
        expect(ir.wasmType).toBe('i32')
    })

    test('f32 type id round-trips', () => {
        const { env, fns } = setup()
        const wtId = env.strings.intern('f32')
        const handle = fns.ir_makeConst(7, wtId)
        const ir = env.irHandles.get(handle) as IRConst
        expect(ir.wasmType).toBe('f32')
        expect(ir.value).toBe(7)
    })

    test('value is coerced to i32 (sign-extended-truncated)', () => {
        const { env, fns } = setup()
        const wtId = env.strings.intern('i32')
        // -1 round-trips through `| 0`
        const handle = fns.ir_makeConst(-1, wtId)
        const ir = env.irHandles.get(handle) as IRConst
        expect(ir.value).toBe(-1)
    })
})

describe('imports — ir_makeLocalGet / ir_makeLocalSet', () => {
    test('LocalGet round-trips name and type', () => {
        const { env, fns } = setup()
        const nameId = env.strings.intern('x')
        const wtId   = env.strings.intern('i32')
        const handle = fns.ir_makeLocalGet(nameId, wtId)
        const ir = env.irHandles.get(handle) as IRLocalGet
        expect(ir.kind).toBe('LocalGet')
        expect(ir.name).toBe('x')
        expect(ir.wasmType).toBe('i32')
    })

    test('LocalSet wraps a sub-IR-expression by handle', () => {
        const { env, fns } = setup()
        const wtId = env.strings.intern('i32')
        const valueH = fns.ir_makeConst(99, wtId)
        const nameId = env.strings.intern('y')
        const handle = fns.ir_makeLocalSet(nameId, valueH)
        const ir = env.irHandles.get(handle) as IRLocalSet
        expect(ir.kind).toBe('LocalSet')
        expect(ir.name).toBe('y')
        expect((ir.value as IRConst).value).toBe(99)
    })

    test('LocalSet with valueH=0 returns 0 (defensive — null value)', () => {
        const { fns } = setup()
        const nameId = 0
        expect(fns.ir_makeLocalSet(nameId, 0)).toBe(0)
    })
})

describe('imports — ir_makeBinOp', () => {
    test('builds an IR BinOp with left/right resolved from handles', () => {
        const { env, fns } = setup()
        const wtId    = env.strings.intern('i32')
        const instrId = env.strings.intern('i32.add')
        const leftH   = fns.ir_makeConst(1, wtId)
        const rightH  = fns.ir_makeConst(2, wtId)
        const handle = fns.ir_makeBinOp(instrId, leftH, rightH, wtId)
        const ir = env.irHandles.get(handle) as IRBinOp
        expect(ir.kind).toBe('BinOp')
        expect((ir as any).op).toBe('i32_add')
        expect((ir.left  as IRConst).value).toBe(1)
        expect((ir.right as IRConst).value).toBe(2)
        expect(ir.wasmType).toBe('i32')
    })

    test('returns 0 when either operand handle is invalid', () => {
        const { env, fns } = setup()
        const wtId    = env.strings.intern('i32')
        const instrId = env.strings.intern('i32.add')
        const validH = fns.ir_makeConst(1, wtId)
        // 999 is a non-existent id — handle resolution returns undefined
        expect(fns.ir_makeBinOp(instrId, 999, validH, wtId)).toBe(0)
        expect(fns.ir_makeBinOp(instrId, validH, 999, wtId)).toBe(0)
    })
})

describe('imports — ir_makeBlock + array builders', () => {
    test('builds an empty Block with no statements and no trailing', () => {
        const { env, fns } = setup()
        const stmtsArrH = fns.compiler_arr_new()
        const handle = fns.ir_makeBlock(stmtsArrH, /* trailing */ 0, /* wasmType */ 0)
        const ir = env.irHandles.get(handle) as IRBlock
        expect(ir.kind).toBe('Block')
        expect(ir.stmts).toEqual([])
        expect(ir.trailing).toBeUndefined()
        expect(ir.wasmType).toBe('void')
    })

    test('builds a Block with a trailing expression — wasmType inferred from trailing', () => {
        const { env, fns } = setup()
        const wtId = env.strings.intern('i32')
        const trailingH = fns.ir_makeConst(7, wtId)
        const stmtsArrH = fns.compiler_arr_new()
        const handle = fns.ir_makeBlock(stmtsArrH, trailingH, /* infer */ 0)
        const ir = env.irHandles.get(handle) as IRBlock
        expect(ir.wasmType).toBe('i32')
        expect((ir.trailing as IRConst).value).toBe(7)
    })

    test('builds a Block with one LocalSet statement', () => {
        const { env, fns } = setup()
        const wtId   = env.strings.intern('i32')
        const valH   = fns.ir_makeConst(42, wtId)
        const nameId = env.strings.intern('x')
        const stmtH  = fns.ir_makeLocalSet(nameId, valH)

        const arrH = fns.compiler_arr_new()
        fns.compiler_arr_push(arrH, stmtH)
        const handle = fns.ir_makeBlock(arrH, /* trailing */ 0, /* wasmType */ 0)
        const ir = env.irHandles.get(handle) as IRBlock
        expect(ir.stmts).toHaveLength(1)
        expect((ir.stmts[0] as IRLocalSet).name).toBe('x')
    })

    test('compiler_arr_push is a no-op for invalid value handle', () => {
        const { env, fns } = setup()
        const arrH = fns.compiler_arr_new()
        fns.compiler_arr_push(arrH, /* invalid */ 9999)
        fns.compiler_arr_push(arrH, /* zero */    0)
        const arr = env.irHandles.get(arrH) as any[]
        expect(arr).toEqual([])
    })
})

describe('imports — ir_null', () => {
    test('returns 0 (the null-IR sentinel)', () => {
        const { fns } = setup()
        expect(fns.ir_null()).toBe(0)
    })
})

describe('imports — ir_makeIf', () => {
    test('builds an If with cond/then/else_ and inferred wasmType', () => {
        const { env, fns } = setup()
        const wtI32 = env.strings.intern('i32')
        const condH  = fns.ir_makeConst(1,  wtI32)
        const thenH  = fns.ir_makeConst(7,  wtI32)
        const elseH  = fns.ir_makeConst(9,  wtI32)
        const handle = fns.ir_makeIf(condH, thenH, elseH, /* infer */ 0)
        const ir = env.irHandles.get(handle) as IRIf
        expect(ir.kind).toBe('If')
        expect(ir.wasmType).toBe('i32')
        expect((ir.cond as IRConst).value).toBe(1)
        expect((ir.then as IRConst).value).toBe(7)
        expect((ir.else_ as IRConst).value).toBe(9)
    })

    test('If with no else (elseH=0) has wasmType void by default', () => {
        const { env, fns } = setup()
        const wtI32 = env.strings.intern('i32')
        const condH = fns.ir_makeConst(1, wtI32)
        const thenH = fns.ir_makeConst(7, wtI32)
        const handle = fns.ir_makeIf(condH, thenH, /* else */ 0, /* infer */ 0)
        const ir = env.irHandles.get(handle) as IRIf
        expect(ir.else_).toBeUndefined()
        expect(ir.wasmType).toBe('void')
    })

    test('If with explicit wasmType id overrides inference', () => {
        const { env, fns } = setup()
        const wtI32 = env.strings.intern('i32')
        const condH = fns.ir_makeConst(1, wtI32)
        const thenH = fns.ir_makeConst(7, wtI32)
        const explicitWt = env.strings.intern('i32')
        const handle = fns.ir_makeIf(condH, thenH, 0, explicitWt)
        const ir = env.irHandles.get(handle) as IRIf
        expect(ir.wasmType).toBe('i32')
    })

    test('If returns 0 if cond or then handle is invalid', () => {
        const { env, fns } = setup()
        const wtI32 = env.strings.intern('i32')
        const ok = fns.ir_makeConst(1, wtI32)
        expect(fns.ir_makeIf(/* cond */ 9999, ok, 0, 0)).toBe(0)
        expect(fns.ir_makeIf(ok, /* then */ 9999, 0, 0)).toBe(0)
    })
})

describe('imports — ir_makeLoop / ir_makeBreak / ir_makeContinue', () => {
    test('Loop carries id, cond, body', () => {
        const { env, fns } = setup()
        const wtI32 = env.strings.intern('i32')
        const condH = fns.ir_makeConst(1, wtI32)
        const arrH  = fns.compiler_arr_new()
        const bodyH = fns.ir_makeBlock(arrH, 0, 0)
        const handle = fns.ir_makeLoop(/* id */ 3, condH, bodyH)
        const ir = env.irHandles.get(handle) as IRLoop
        expect(ir.kind).toBe('Loop')
        expect(ir.id).toBe(3)
        expect((ir.cond as IRConst).value).toBe(1)
        expect(ir.body.kind).toBe('Block')
    })

    test('Break / Continue carry the loop id', () => {
        const { env, fns } = setup()
        const brkH = fns.ir_makeBreak(7)
        const ctnH = fns.ir_makeContinue(7)
        expect((env.irHandles.get(brkH) as IRBreak).kind).toBe('Break')
        expect((env.irHandles.get(brkH) as IRBreak).id).toBe(7)
        expect((env.irHandles.get(ctnH) as IRContinue).kind).toBe('Continue')
        expect((env.irHandles.get(ctnH) as IRContinue).id).toBe(7)
    })

    test('Loop with invalid cond or body returns 0', () => {
        const { env, fns } = setup()
        const wtI32 = env.strings.intern('i32')
        const ok = fns.ir_makeConst(1, wtI32)
        expect(fns.ir_makeLoop(0, /* cond */ 9999, ok)).toBe(0)
        expect(fns.ir_makeLoop(0, ok, /* body */ 9999)).toBe(0)
    })
})

describe('imports — ir_makeReturn', () => {
    test('Return with a value wraps the IR expression', () => {
        const { env, fns } = setup()
        const wtI32  = env.strings.intern('i32')
        const valH   = fns.ir_makeConst(42, wtI32)
        const handle = fns.ir_makeReturn(valH)
        const ir = env.irHandles.get(handle) as IRReturn
        expect(ir.kind).toBe('Return')
        expect((ir.value as IRConst).value).toBe(42)
    })

    test('Return with valueH=0 is a void return', () => {
        const { env, fns } = setup()
        const handle = fns.ir_makeReturn(0)
        const ir = env.irHandles.get(handle) as IRReturn
        expect(ir.kind).toBe('Return')
        expect(ir.value).toBeUndefined()
    })
})

describe('imports — ir_makeExport', () => {
    test('Export carries alias / internalName / what', () => {
        const { env, fns } = setup()
        const aliasId    = env.strings.intern('main')
        const internalId = env.strings.intern('$main')
        const whatId     = env.strings.intern('func')
        const handle = fns.ir_makeExport(aliasId, internalId, whatId)
        const ir = env.irHandles.get(handle) as IRExport
        expect(ir.kind).toBe('Export')
        expect(ir.alias).toBe('main')
        expect(ir.internalName).toBe('$main')
        expect(ir.what).toBe('func')
    })
})

describe('imports — ir_makeLocal / ir_makeParam', () => {
    test('Local has name and wasmType', () => {
        const { env, fns } = setup()
        const handle = fns.ir_makeLocal(env.strings.intern('x'), env.strings.intern('i32'))
        const ir = env.irHandles.get(handle) as IRLocal
        expect(ir.name).toBe('x')
        expect(ir.wasmType).toBe('i32')
    })

    test('Param has name and wasmType', () => {
        const { env, fns } = setup()
        const handle = fns.ir_makeParam(env.strings.intern('n'), env.strings.intern('i64'))
        const ir = env.irHandles.get(handle) as IRParam
        expect(ir.name).toBe('n')
        expect(ir.wasmType).toBe('i64')
    })
})

describe('imports — ir_makeGlobal', () => {
    test('mutable Global with i32 init', () => {
        const { env, fns } = setup()
        const initH = fns.ir_makeConst(0, env.strings.intern('i32'))
        const handle = fns.ir_makeGlobal(
            env.strings.intern('counter'),
            env.strings.intern('i32'),
            /* mutable */ 1,
            initH,
        )
        const ir = env.irHandles.get(handle) as IRGlobal
        expect(ir.kind).toBe('Global')
        expect(ir.name).toBe('counter')
        expect(ir.wasmType).toBe('i32')
        expect(ir.mutable).toBe(true)
        expect((ir.init as IRConst).value).toBe(0)
    })

    test('immutable Global (mutable=0)', () => {
        const { env, fns } = setup()
        const initH = fns.ir_makeConst(1, env.strings.intern('i32'))
        const handle = fns.ir_makeGlobal(
            env.strings.intern('PI'), env.strings.intern('i32'), 0, initH,
        )
        const ir = env.irHandles.get(handle) as IRGlobal
        expect(ir.mutable).toBe(false)
    })

    test('Global with invalid init handle returns 0', () => {
        const { env, fns } = setup()
        expect(fns.ir_makeGlobal(
            env.strings.intern('x'), env.strings.intern('i32'), 0, /* bad */ 9999,
        )).toBe(0)
    })
})

describe('imports — ir_makeFunction', () => {
    test('builds a function with params, locals, and body', () => {
        const { env, fns } = setup()
        const wtI32 = env.strings.intern('i32')

        const paramsArr = fns.compiler_arr_new()
        fns.compiler_arr_push(paramsArr, fns.ir_makeParam(env.strings.intern('n'), wtI32))

        const localsArr = fns.compiler_arr_new()
        fns.compiler_arr_push(localsArr, fns.ir_makeLocal(env.strings.intern('tmp'), wtI32))

        const bodyStmts = fns.compiler_arr_new()
        const body = fns.ir_makeBlock(bodyStmts, fns.ir_makeLocalGet(env.strings.intern('n'), wtI32), 0)

        const handle = fns.ir_makeFunction(
            env.strings.intern('id'), paramsArr, wtI32, localsArr, body,
        )
        const ir = env.irHandles.get(handle) as IRFunction
        expect(ir.kind).toBe('Function')
        expect(ir.name).toBe('id')
        expect(ir.returnType).toBe('i32')
        expect(ir.params).toHaveLength(1)
        expect(ir.params[0].name).toBe('n')
        expect(ir.locals).toHaveLength(1)
        expect(ir.locals[0].name).toBe('tmp')
        expect(ir.body).toBeDefined()
    })

    test('extern-style function: bodyH=0 → no body', () => {
        const { env, fns } = setup()
        const paramsArr = fns.compiler_arr_new()
        const localsArr = fns.compiler_arr_new()
        const handle = fns.ir_makeFunction(
            env.strings.intern('puts'), paramsArr, /* void */ 0, localsArr, /* no body */ 0,
        )
        const ir = env.irHandles.get(handle) as IRFunction
        expect(ir.body).toBeUndefined()
        expect(ir.returnType).toBe('void')
    })
})

describe('imports — ir_makeImport', () => {
    test('builds an Import with param-type array and result', () => {
        const { env, fns } = setup()
        // Import params are WasmValType strings, not IR sub-nodes — push as string ids.
        const paramsArr = fns.compiler_arr_new()
        fns.compiler_arr_push_str(paramsArr, env.strings.intern('i32'))
        fns.compiler_arr_push_str(paramsArr, env.strings.intern('i32'))

        const handle = fns.ir_makeImport(
            env.strings.intern('env'),
            env.strings.intern('fd_write'),
            env.strings.intern('fd_write'),
            paramsArr,
            env.strings.intern('i32'),
        )
        const ir = env.irHandles.get(handle) as IRImport
        expect(ir.kind).toBe('Import')
        expect(ir.env).toBe('env')
        expect(ir.field).toBe('fd_write')
        expect(ir.params).toEqual(['i32', 'i32'])
        expect(ir.result).toBe('i32')
    })

    test('Import with resultStr=0 → no result', () => {
        const { env, fns } = setup()
        const paramsArr = fns.compiler_arr_new()
        const handle = fns.ir_makeImport(
            env.strings.intern('env'),
            env.strings.intern('noret'),
            env.strings.intern('noret'),
            paramsArr,
            /* no result */ 0,
        )
        const ir = env.irHandles.get(handle) as IRImport
        expect(ir.result).toBeUndefined()
    })
})

describe('imports — diag_error / diag_warn (T-5 accumulator)', () => {
    test('diag_error appends a Diagnostic with phase=lower', () => {
        const { env, fns } = setup()
        const codeId = env.strings.intern('E0042')
        const msgId  = env.strings.intern('something went wrong')
        const hintId = env.strings.intern('try the other thing')
        fns.diag_error(codeId, /* span=0 → empty */ 0, msgId, hintId)
        expect(env.registry.diagnostics).toHaveLength(1)
        const diag = env.registry.diagnostics[0]
        expect(diag.code).toBe('E0042')
        expect(diag.message).toBe('something went wrong')
        expect(diag.hint).toBe('try the other thing')
        expect(diag.phase).toBe('lower')
        expect(diag.span.file).toBe('')
    })

    test('diag_warn appends without throwing', () => {
        const { env, fns } = setup()
        fns.diag_warn(env.strings.intern('W001'), 0, env.strings.intern('heads up'), 0)
        expect(env.registry.diagnostics).toHaveLength(1)
        expect(env.registry.diagnostics[0].hint).toBeUndefined()
    })

    test('diag_error with a span handle records that span', () => {
        const { env, fns } = setup()
        const span = { file: 'foo.si', line: 12, col: 3, length: 5 }
        const spanH = env.handles.intern(span)
        fns.diag_error(env.strings.intern('E1'), spanH, env.strings.intern('bad'), 0)
        expect(env.registry.diagnostics[0].span).toEqual(span)
    })

    test('multiple diagnostics accumulate in order', () => {
        const { env, fns } = setup()
        fns.diag_error(env.strings.intern('E1'), 0, env.strings.intern('first'),  0)
        fns.diag_warn (env.strings.intern('W1'), 0, env.strings.intern('second'), 0)
        fns.diag_error(env.strings.intern('E2'), 0, env.strings.intern('third'),  0)
        expect(env.registry.diagnostics.map(d => d.message)).toEqual(['first', 'second', 'third'])
    })
})

describe('imports — utility helpers (D-B-13)', () => {
    test('compiler_watId converts :: → _ and round-trips through strings', () => {
        const { env, fns } = setup()
        const nameId = env.strings.intern('Foo::Bar::baz')
        const watId  = fns.compiler_watId(nameId)
        expect(env.strings.get(watId)).toBe('Foo_Bar_baz')
    })

    test('compiler_watId is a no-op for simple identifiers', () => {
        const { env, fns } = setup()
        const nameId = env.strings.intern('main')
        const watId  = fns.compiler_watId(nameId)
        expect(env.strings.get(watId)).toBe('main')
    })

    test('compiler_freshId allocates monotonically with a prefix', () => {
        const { env, fns } = setup()
        const prefixId = env.strings.intern('local')
        const a = fns.compiler_freshId(prefixId)
        const b = fns.compiler_freshId(prefixId)
        expect(env.strings.get(a)).toBe('local_0')
        expect(env.strings.get(b)).toBe('local_1')
    })

    test('compiler_freshId with prefix=0 uses default "tmp"', () => {
        const { env, fns } = setup()
        const id = fns.compiler_freshId(0)
        expect(env.strings.get(id)).toBe('tmp_0')
    })

    test('compiler_arg returns the i-th child arg of an AST node', () => {
        const { env, fns } = setup()
        const child0 = { type: 'Literal', value: 1 }
        const child1 = { type: 'Literal', value: 2 }
        const callNode = { type: 'FunctionCall', args: [child0, child1] }
        const nodeH = env.handles.intern(callNode)
        const arg0H = fns.compiler_arg(nodeH, 0)
        const arg1H = fns.compiler_arg(nodeH, 1)
        expect(env.handles.get(arg0H)).toBe(child0)
        expect(env.handles.get(arg1H)).toBe(child1)
    })

    test('compiler_arg returns 0 for out-of-range indices', () => {
        const { env, fns } = setup()
        const callNode = { type: 'FunctionCall', args: [{ a: 1 }] }
        const nodeH = env.handles.intern(callNode)
        expect(fns.compiler_arg(nodeH, 5)).toBe(0)
        expect(fns.compiler_arg(nodeH, -1)).toBe(0)
    })

    test('compiler_arg returns 0 when node has no args array', () => {
        const { env, fns } = setup()
        const nodeH = env.handles.intern({ type: 'Bare' })
        expect(fns.compiler_arg(nodeH, 0)).toBe(0)
    })

    test('compiler_choose: non-zero cond → aH', () => {
        const { fns } = setup()
        expect(fns.compiler_choose(1, 100, 200)).toBe(100)
        expect(fns.compiler_choose(-1, 100, 200)).toBe(100)
    })

    test('compiler_choose: zero cond → bH', () => {
        const { fns } = setup()
        expect(fns.compiler_choose(0, 100, 200)).toBe(200)
    })
})

describe('imports — ctx accessors (D-B-11)', () => {
    function setupWithCtx() {
        const { env, fns } = setup()
        // Minimal mock ctx — just the shape `imports.ts` consumes.
        const localsMap  = new Map<string, string>()
        const globalsMap = new Map<string, string>()
        const varNamesSet = new Set<string>()
        const loopStack: number[] = []
        let nextLoopId = 100
        env.ctx = {
            locals: {
                get: (n) => localsMap.get(n) as any,
                set: (n, t) => { localsMap.set(n, t as any) },
            },
            globals: {
                get: (n) => globalsMap.get(n) as any,
                set: (n, t) => { globalsMap.set(n, t as any) },
            },
            varNames: {
                has: (n) => varNamesSet.has(n),
                add: (n) => { varNamesSet.add(n) },
            },
            pendingLocals: {
                push: (_l) => { /* recorded by env.ctx caller indirectly */ },
            },
            loopStack: {
                push: (id) => { loopStack.push(id) },
                pop:  ()   => loopStack.pop(),
                peek: ()   => loopStack[loopStack.length - 1],
            },
            nextLoopId: () => nextLoopId++,
            functionSigs: { get: () => undefined },
        } as any
        return { env, fns, localsMap, globalsMap, varNamesSet, loopStack }
    }

    test('locals_set / locals_get round-trip through the ctx', () => {
        const { env, fns, localsMap } = setupWithCtx()
        fns.compiler_ctx_locals_set(env.strings.intern('x'), env.strings.intern('i32'))
        expect(localsMap.get('x')).toBe('i32')
        const tId = fns.compiler_ctx_locals_get(env.strings.intern('x'))
        expect(env.strings.get(tId)).toBe('i32')
    })

    test('locals_get returns 0 for unknown name', () => {
        const { env, fns } = setupWithCtx()
        expect(fns.compiler_ctx_locals_get(env.strings.intern('missing'))).toBe(0)
    })

    test('globals_set / globals_get round-trip', () => {
        const { env, fns, globalsMap } = setupWithCtx()
        fns.compiler_ctx_globals_set(env.strings.intern('g'), env.strings.intern('f32'))
        expect(globalsMap.get('g')).toBe('f32')
        const tId = fns.compiler_ctx_globals_get(env.strings.intern('g'))
        expect(env.strings.get(tId)).toBe('f32')
    })

    test('varNames add / has', () => {
        const { env, fns, varNamesSet } = setupWithCtx()
        expect(fns.compiler_ctx_varNames_has(env.strings.intern('foo'))).toBe(0)
        fns.compiler_ctx_varNames_add(env.strings.intern('foo'))
        expect(varNamesSet.has('foo')).toBe(true)
        expect(fns.compiler_ctx_varNames_has(env.strings.intern('foo'))).toBe(1)
    })

    test('compiler_isVarName is an alias for varNames_has', () => {
        const { env, fns } = setupWithCtx()
        fns.compiler_ctx_varNames_add(env.strings.intern('y'))
        expect(fns.compiler_isVarName(env.strings.intern('y'))).toBe(1)
        expect(fns.compiler_isVarName(env.strings.intern('z'))).toBe(0)
    })

    test('loopStack push / peek / pop', () => {
        const { fns, loopStack } = setupWithCtx()
        fns.compiler_ctx_loopStack_push(7)
        fns.compiler_ctx_loopStack_push(8)
        expect(fns.compiler_ctx_loopStack_peek()).toBe(8)
        expect(fns.compiler_ctx_loopStack_pop()).toBe(8)
        expect(fns.compiler_ctx_loopStack_pop()).toBe(7)
        expect(fns.compiler_ctx_loopStack_pop()).toBe(0)   // empty
        expect(loopStack).toEqual([])
    })

    test('nextLoopId allocates monotonically', () => {
        const { fns } = setupWithCtx()
        expect(fns.compiler_ctx_nextLoopId()).toBe(100)
        expect(fns.compiler_ctx_nextLoopId()).toBe(101)
        expect(fns.compiler_ctx_nextLoopId()).toBe(102)
    })

    test('ctx accessors are no-ops when env.ctx is undefined', () => {
        const { env, fns } = setup()
        expect(env.ctx).toBeUndefined()
        // Should not throw, all return 0 for queries
        expect(() => fns.compiler_ctx_locals_set(0, 0)).not.toThrow()
        expect(fns.compiler_ctx_locals_get(0)).toBe(0)
        expect(fns.compiler_ctx_varNames_has(0)).toBe(0)
        expect(fns.compiler_ctx_loopStack_peek()).toBe(0)
        expect(fns.compiler_ctx_nextLoopId()).toBe(0)
    })

    test('pendingLocals_push wires a local handle into the ctx', () => {
        const { env, fns } = setupWithCtx()
        let pushed: any = null
        env.ctx!.pendingLocals.push = (l) => { pushed = l }
        const localH = fns.ir_makeLocal(env.strings.intern('t'), env.strings.intern('i32'))
        fns.compiler_ctx_pendingLocals_push(localH)
        expect(pushed).toEqual({ name: 't', wasmType: 'i32' })
    })
})

describe('imports — compiler_ast_field (D-B-7)', () => {
    test('top-level path "" returns the node itself tagged as NODE', () => {
        const { env, fns } = setup()
        const node = { type: 'Definition' }
        const nodeH = env.handles.intern(node)
        const tagged = fns.compiler_ast_field(nodeH, env.strings.intern(''))
        expect(fns.compiler_tag_kind(tagged)).toBe(1)   // TAG_NODE
        const id = fns.compiler_tag_value(tagged)
        expect(env.handles.get(id)).toBe(node)
    })

    test('dotted path "name.name" walks to a leaf string', () => {
        const { env, fns } = setup()
        const node = { name: { name: 'foo' } }
        const nodeH = env.handles.intern(node)
        const tagged = fns.compiler_ast_field(nodeH, env.strings.intern('name.name'))
        expect(fns.compiler_tag_kind(tagged)).toBe(2)   // TAG_STR
        const sid = fns.compiler_tag_value(tagged)
        expect(env.strings.get(sid)).toBe('foo')
    })

    test('numeric segment indexes into arrays — "args.0"', () => {
        const { env, fns } = setup()
        const child = { type: 'Literal', value: 1 }
        const node  = { args: [child] }
        const nodeH = env.handles.intern(node)
        const tagged = fns.compiler_ast_field(nodeH, env.strings.intern('args.0'))
        expect(fns.compiler_tag_kind(tagged)).toBe(1)   // TAG_NODE
        expect(env.handles.get(fns.compiler_tag_value(tagged))).toBe(child)
    })

    test('boolean field is TAG_BOOL', () => {
        const { env, fns } = setup()
        const node = { isExported: true }
        const nodeH = env.handles.intern(node)
        const tagged = fns.compiler_ast_field(nodeH, env.strings.intern('isExported'))
        expect(fns.compiler_tag_kind(tagged)).toBe(4)   // TAG_BOOL
        expect(fns.compiler_tag_value(tagged)).toBe(1)
    })

    test('small integer field is TAG_INT', () => {
        const { env, fns } = setup()
        const node = { count: 42 }
        const nodeH = env.handles.intern(node)
        const tagged = fns.compiler_ast_field(nodeH, env.strings.intern('count'))
        expect(fns.compiler_tag_kind(tagged)).toBe(3)   // TAG_INT
        expect(fns.compiler_tag_value(tagged)).toBe(42)
    })

    test('negative integer field round-trips through sign-extension', () => {
        const { env, fns } = setup()
        const node = { delta: -5 }
        const nodeH = env.handles.intern(node)
        const tagged = fns.compiler_ast_field(nodeH, env.strings.intern('delta'))
        expect(fns.compiler_tag_kind(tagged)).toBe(3)
        expect(fns.compiler_tag_value(tagged)).toBe(-5)
    })

    test('missing field is null (tagged 0)', () => {
        const { env, fns } = setup()
        const node = { a: 1 }
        const nodeH = env.handles.intern(node)
        const tagged = fns.compiler_ast_field(nodeH, env.strings.intern('missing'))
        expect(tagged).toBe(0)
    })

    test('walking through null mid-path returns 0', () => {
        const { env, fns } = setup()
        const node = { name: null }
        const nodeH = env.handles.intern(node)
        const tagged = fns.compiler_ast_field(nodeH, env.strings.intern('name.name'))
        expect(tagged).toBe(0)
    })

    test('array field returns TAG_ARR + iteration via compiler_arr_*', () => {
        const { env, fns } = setup()
        const child0 = { type: 'A' }
        const child1 = { type: 'B' }
        const node = { args: [child0, child1] }
        const nodeH = env.handles.intern(node)
        const tagged = fns.compiler_ast_field(nodeH, env.strings.intern('args'))
        expect(fns.compiler_tag_kind(tagged)).toBe(5)   // TAG_ARR
        const arrId = fns.compiler_tag_value(tagged)
        expect(fns.compiler_arr_len(arrId)).toBe(2)
        const t0 = fns.compiler_arr_get(arrId, 0)
        const t1 = fns.compiler_arr_get(arrId, 1)
        expect(fns.compiler_tag_kind(t0)).toBe(1)
        expect(fns.compiler_tag_kind(t1)).toBe(1)
        expect(env.handles.get(fns.compiler_tag_value(t0))).toBe(child0)
        expect(env.handles.get(fns.compiler_tag_value(t1))).toBe(child1)
    })

    test('compiler_arr_len returns 0 for non-array handle', () => {
        const { fns } = setup()
        expect(fns.compiler_arr_len(0)).toBe(0)
        expect(fns.compiler_arr_len(9999)).toBe(0)
    })

    test('compiler_arr_get returns 0 for out-of-range', () => {
        const { env, fns } = setup()
        const arrId = fns.compiler_arr_new()
        fns.compiler_arr_push(arrId, fns.ir_makeConst(1, env.strings.intern('i32')))
        expect(fns.compiler_arr_get(arrId, 0)).toBeGreaterThan(0)
        expect(fns.compiler_arr_get(arrId, 1)).toBe(0)
        expect(fns.compiler_arr_get(arrId, -1)).toBe(0)
    })
})

describe('imports — type::* (D-B-8)', () => {
    test('type primitives are singletons across calls', () => {
        const { env, fns } = setup()
        const a = fns.type_int()
        const b = fns.type_int()
        expect(a).toBe(b)
        // Different primitives have different handles
        expect(fns.type_int()).not.toBe(fns.type_float())
    })

    test('type_variable mints a fresh Variable each call (different objects)', () => {
        const { env, fns } = setup()
        const a = fns.type_variable(env.strings.intern('T'))
        const b = fns.type_variable(env.strings.intern('T'))
        // Distinct handles because they're distinct objects (each fresh-minted)
        expect(a).not.toBe(b)
        const t = env.handles.get(a) as any
        expect(t.kind).toBe('Variable')
        expect(t.name).toBe('T')
    })

    test('type_array wraps an element type', () => {
        const { env, fns } = setup()
        const intH = fns.type_int()
        const arrH = fns.type_array(intH)
        const t = env.handles.get(arrH) as any
        expect(t.kind).toBe('Array')
        expect(t.element).toEqual({ kind: 'Int' })
    })

    test('type_equals true for structurally equal types', () => {
        const { env, fns } = setup()
        // Two Array[Int] built independently are structurally equal
        const a = fns.type_array(fns.type_int())
        const b = fns.type_array(fns.type_int())
        expect(fns.type_equals(a, b)).toBe(1)
        expect(fns.type_equals(fns.type_int(), fns.type_float())).toBe(0)
    })

    test('type_format renders types as strings', () => {
        const { env, fns } = setup()
        const arrInt = fns.type_array(fns.type_int())
        const sId = fns.type_format(arrInt)
        expect(env.strings.get(sId)).toBe('Array[Int]')
        expect(env.strings.get(fns.type_format(fns.type_int()))).toBe('Int')
    })

    test('type_substitute walks a template substituting variables', () => {
        const { env, fns } = setup()
        // Template: Array[Variable("T")]
        const tvar = fns.type_variable(env.strings.intern('T'))
        const tmpl = fns.type_array(tvar)
        // Bindings: T → Int
        const bindings = new Map()
        bindings.set('T', { kind: 'Int' })
        const bId = env.handles.intern(bindings)
        const concrete = fns.type_substitute(tmpl, bId)
        expect(env.strings.get(fns.type_format(concrete))).toBe('Array[Int]')
    })

    test('type_substitute with empty bindings returns the template handle', () => {
        const { env, fns } = setup()
        const tmpl = fns.type_int()
        const bId = env.handles.intern(new Map())
        expect(fns.type_substitute(tmpl, bId)).toBe(tmpl)
    })

    test('type_mangle_suffix joins formatted types with underscores', () => {
        const { env, fns } = setup()
        const bindings = new Map()
        bindings.set('T', { kind: 'Int' })
        bindings.set('U', { kind: 'Float' })
        const bId = env.handles.intern(bindings)
        const sId = fns.type_mangle_suffix(bId)
        expect(env.strings.get(sId)).toBe('Int_Float')
    })

    test('type_mangle_suffix is empty string for empty bindings', () => {
        const { env, fns } = setup()
        const bId = env.handles.intern(new Map())
        const sId = fns.type_mangle_suffix(bId)
        expect(env.strings.get(sId)).toBe('')
    })
})

describe('imports — ast::* manipulation (D-B-6)', () => {
    test('ast_capture_template deep-clones an AST node', () => {
        const { env, fns } = setup()
        const node = { type: 'Definition', name: { name: 'foo' } }
        const nodeH = env.handles.intern(node)
        const tmplH = fns.ast_capture_template(nodeH, env.strings.intern('pre'))
        const tmpl = env.handles.get(tmplH) as any
        expect(tmpl.kind).toBe('pre')
        expect(tmpl.ast).toEqual(node)
        expect(tmpl.ast).not.toBe(node)   // deep cloned
        expect(tmpl.ast.name).not.toBe(node.name)
    })

    test('ast_capture_template defaults to "pre" for unknown kind', () => {
        const { env, fns } = setup()
        const node = { type: 'Foo' }
        const nodeH = env.handles.intern(node)
        const tmplH = fns.ast_capture_template(nodeH, env.strings.intern('xyz'))
        expect((env.handles.get(tmplH) as any).kind).toBe('pre')
    })

    test('ast_clone produces an independent copy', () => {
        const { env, fns } = setup()
        const tmplH = fns.ast_capture_template(
            env.handles.intern({ type: 'Definition', name: 'a' }),
            env.strings.intern('post'),
        )
        const clonedH = fns.ast_clone(tmplH)
        expect(clonedH).not.toBe(tmplH)
        const orig   = env.handles.get(tmplH) as any
        const cloned = env.handles.get(clonedH) as any
        expect(cloned.ast).toEqual(orig.ast)
        expect(cloned.ast).not.toBe(orig.ast)
        expect(cloned.kind).toBe('post')
    })

    test('ast_with_keyword replaces the keyword field', () => {
        const { env, fns } = setup()
        const tmplH = fns.ast_capture_template(
            env.handles.intern({ type: 'Definition', keyword: '@generic', name: { name: 'id' } }),
            env.strings.intern('pre'),
        )
        const newH = fns.ast_with_keyword(tmplH, env.strings.intern('@fn'))
        expect((env.handles.get(newH) as any).ast.keyword).toBe('@fn')
        // Original unchanged
        expect((env.handles.get(tmplH) as any).ast.keyword).toBe('@generic')
    })

    test('ast_with_name replaces the name field', () => {
        const { env, fns } = setup()
        const tmplH = fns.ast_capture_template(
            env.handles.intern({ type: 'Definition', name: { name: 'id' } }),
            env.strings.intern('pre'),
        )
        const newH = fns.ast_with_name(tmplH, env.strings.intern('id$Int'))
        expect((env.handles.get(newH) as any).ast.name.name).toBe('id$Int')
    })

    test('ast_rewrite_call mutates a FunctionCall.name in place', () => {
        const { env, fns } = setup()
        const call = { type: 'FunctionCall', name: { type: 'Namespace', path: ['id'] } }
        const callH = env.handles.intern(call)
        fns.ast_rewrite_call(callH, env.strings.intern('id$Int'))
        expect(call.name.path).toEqual(['id$Int'])
    })

    test('ast_rewrite_call handles non-Namespace name shapes', () => {
        const { env, fns } = setup()
        const call: any = { type: 'FunctionCall', name: 'id' }
        const callH = env.handles.intern(call)
        fns.ast_rewrite_call(callH, env.strings.intern('id$Int'))
        expect(call.name).toEqual({ type: 'Namespace', path: ['id$Int'] })
    })

    test('ast_patch_types rewrites Variable type annotations to concrete', () => {
        const { env, fns } = setup()
        const node = {
            type: 'Definition',
            params: [{ type: 'TypeAnnotation', typename: 'T' }],
            inferredType: { kind: 'Variable', name: 'T' },
        }
        const tmplH = fns.ast_capture_template(env.handles.intern(node), env.strings.intern('pre'))
        const bindings = new Map()
        bindings.set('T', { kind: 'Int' })
        const bH = env.handles.intern(bindings)
        const patched = fns.ast_patch_types(tmplH, bH)
        const result = env.handles.get(patched) as any
        expect(result.ast.params[0].typename).toBe('Int')
        expect(result.ast.inferredType).toEqual({ kind: 'Int' })
    })

    test('ast_patch_types with empty bindings returns the original template handle', () => {
        const { env, fns } = setup()
        const tmplH = fns.ast_capture_template(
            env.handles.intern({ type: 'Definition' }), env.strings.intern('pre'),
        )
        const bH = env.handles.intern(new Map())
        expect(fns.ast_patch_types(tmplH, bH)).toBe(tmplH)
    })
})

describe('imports — lowering helpers (D-B-12)', () => {
    test('all helpers are no-ops / return 0 when env.api is undefined', () => {
        const { env, fns } = setup()
        expect(env.api).toBeUndefined()
        const nodeH = env.handles.intern({ type: 'X' })
        expect(fns.compiler_lowerExpr(nodeH)).toBe(0)
        expect(fns.compiler_lowerExprIfDefined(nodeH)).toBe(0)
        expect(fns.compiler_resolveType(nodeH)).toBe(0)
        expect(fns.compiler_resolveFunctionReturnType(nodeH, 0, 0)).toBe(0)
        expect(fns.compiler_lowerFunctionBody(nodeH, 0)).toBe(0)
        // lowerParams returns an empty array handle (still > 0)
        const arrH = fns.compiler_lowerParams(nodeH)
        expect(arrH).toBeGreaterThan(0)
        expect(fns.compiler_arr_len(arrH)).toBe(0)
    })

    test('compiler_lowerExpr delegates through env.api', () => {
        const { env, fns } = setup()
        // Install a stub CompilerAPI with a recognisable lowerExpr.
        const fakeIr = { kind: 'Const', wasmType: 'i32', value: 7 }
        env.api = {
            lowerExpr: (n: any) => n.x === 'sentinel' ? fakeIr : null,
            lowerExprIfDefined: (n: any) => null,
            lowerParams: () => [{ name: 'p', wasmType: 'i32' }],
            lowerFunctionBody: () => ({ body: fakeIr, locals: [{ name: 'l', wasmType: 'i32' }] }),
            resolveFunctionReturnType: () => 'i32',
            resolveType: () => 'f32',
        } as any
        const nodeH = env.handles.intern({ x: 'sentinel' })
        const irH = fns.compiler_lowerExpr(nodeH)
        expect(irH).toBeGreaterThan(0)
        expect(env.irHandles.get(irH)).toBe(fakeIr)
    })

    test('compiler_lowerParams returns a handle array of IRParam handles', () => {
        const { env, fns } = setup()
        env.api = {
            lowerExpr: () => null, lowerExprIfDefined: () => null,
            lowerParams: () => [{ name: 'a', wasmType: 'i32' }, { name: 'b', wasmType: 'f32' }],
            lowerFunctionBody: () => ({ body: undefined, locals: [] }),
            resolveFunctionReturnType: () => 'i32',
            resolveType: () => 'i32',
        } as any
        const arrH = fns.compiler_lowerParams(env.handles.intern({}))
        expect(fns.compiler_arr_len(arrH)).toBe(2)
        const p0 = env.irHandles.get(fns.compiler_arr_get(arrH, 0)) as any
        expect(p0.name).toBe('a')
    })

    test('compiler_lowerFunctionBody returns a struct handle with body + locals', () => {
        const { env, fns } = setup()
        const fakeBody = { kind: 'Const', wasmType: 'i32', value: 0 }
        env.api = {
            lowerExpr: () => null, lowerExprIfDefined: () => null,
            lowerParams: () => [],
            lowerFunctionBody: () => ({ body: fakeBody, locals: [{ name: 'l', wasmType: 'i32' }] }),
            resolveFunctionReturnType: () => 'i32',
            resolveType: () => 'i32',
        } as any
        const resultH = fns.compiler_lowerFunctionBody(env.handles.intern({}), 0)
        const bodyH = fns.compiler_funcResult_body(resultH)
        const localsH = fns.compiler_funcResult_locals(resultH)
        expect(env.irHandles.get(bodyH)).toBe(fakeBody)
        expect(fns.compiler_arr_len(localsH)).toBe(1)
    })

    test('compiler_resolveFunctionReturnType returns a string id from api', () => {
        const { env, fns } = setup()
        env.api = {
            lowerExpr: () => null, lowerExprIfDefined: () => null,
            lowerParams: () => [],
            lowerFunctionBody: () => ({ body: undefined, locals: [] }),
            resolveFunctionReturnType: () => 'f32',
            resolveType: () => 'i32',
        } as any
        const sId = fns.compiler_resolveFunctionReturnType(env.handles.intern({}), 0, 0)
        expect(env.strings.get(sId)).toBe('f32')
    })

    test('compiler_resolveType returns wasmType string id from api', () => {
        const { env, fns } = setup()
        env.api = {
            lowerExpr: () => null, lowerExprIfDefined: () => null,
            lowerParams: () => [],
            lowerFunctionBody: () => ({ body: undefined, locals: [] }),
            resolveFunctionReturnType: () => 'i32',
            resolveType: () => 'i64',
        } as any
        const sId = fns.compiler_resolveType(env.handles.intern({ typename: 'Int64' }))
        expect(env.strings.get(sId)).toBe('i64')
    })
})

describe('imports — module accumulators (D-B-9)', () => {
    test('module_push_definition accumulates AST defs', () => {
        const { env, fns } = setup()
        const def = { type: 'Definition', keyword: '@fn', name: { name: 'foo' } }
        const defH = env.handles.intern(def)
        fns.module_push_definition(defH)
        expect(env.pendingDefinitions).toHaveLength(1)
        expect(env.pendingDefinitions[0]).toBe(def)
    })

    test('module_push_definition is a no-op for zero handle', () => {
        const { env, fns } = setup()
        fns.module_push_definition(0)
        expect(env.pendingDefinitions).toHaveLength(0)
    })

    test('module_push_global captures name + type + init triple', () => {
        const { env, fns } = setup()
        const fakeType = { kind: 'Int' }
        const fakeInit = { type: 'Literal', value: 0 }
        const typeH = env.handles.intern(fakeType)
        const initH = env.handles.intern(fakeInit)
        fns.module_push_global(env.strings.intern('counter'), typeH, initH)
        expect(env.pendingGlobals).toHaveLength(1)
        expect(env.pendingGlobals[0]).toEqual({
            name: 'counter', type: fakeType, init: fakeInit,
        })
    })
})

describe('imports — end-to-end: build an "x + 42" expression', () => {
    test('a compiled handler returning a BinOp handle lets the firing code recover the right IR', () => {
        // This mimics what a real handler would do: read its argument,
        // build IR, return the handle.  We simulate the WASM-side body
        // as a JS function calling the imports.
        const { env, fns } = setup()
        const wtI32 = env.strings.intern('i32')

        // Simulated handler body (what the compiled @fn would do):
        const buildXPlus42 = (): number => {
            const xId    = env.strings.intern('x')
            const addStr = env.strings.intern('i32.add')
            const x42H   = fns.ir_makeConst(42, wtI32)
            const xH     = fns.ir_makeLocalGet(xId, wtI32)
            return fns.ir_makeBinOp(addStr, xH, x42H, wtI32)
        }

        // Simulated firing code:
        const resultHandle = buildXPlus42()
        expect(resultHandle).toBeGreaterThan(0)
        const ir = env.irHandles.get(resultHandle) as IRBinOp
        expect(ir.kind).toBe('BinOp')
        expect((ir as any).op).toBe('i32_add')
        expect((ir.left  as IRLocalGet).name).toBe('x')
        expect((ir.right as IRConst).value).toBe(42)
    })
})
