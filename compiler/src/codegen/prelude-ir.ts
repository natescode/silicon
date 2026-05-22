/**
 * Prelude IR — std.wat content as proper IRModule nodes.
 *
 * Mirrors the prelude reification done on the Silicon side (Slice 1).
 * The binary emitter works with a self-contained IRModule that includes
 * prelude functions; the WAT emitter continues using the std.wat string.
 */

import type {
    IRModule, IRFunction, IRGlobal, IRImport, IRExport,
    IRExpr, IRStmt, IRParam, IRLocal, WasmValType,
} from '../ir/nodes'

// ---------------------------------------------------------------------------
// Builder helpers
// ---------------------------------------------------------------------------

const i32 = 'i32' as const
const f32 = 'f32' as const
const void_ = 'void' as const

function c(value: number, type: WasmValType = i32): IRExpr {
    return { kind: 'Const', wasmType: type, value }
}
function lg(name: string, type: WasmValType = i32): IRExpr {
    return { kind: 'LocalGet', wasmType: type, name }
}
function gg(name: string, type: WasmValType = i32): IRExpr {
    return { kind: 'GlobalGet', wasmType: type, name }
}
function ls(name: string, value: IRExpr): IRStmt {
    return { kind: 'LocalSet', name, value }
}
function gs(name: string, value: IRExpr): IRStmt {
    return { kind: 'GlobalSet', name, value }
}
function binop(instr: string, left: IRExpr, right: IRExpr, resultType: WasmValType = i32): IRExpr {
    return { kind: 'BinOp', wasmType: resultType, instr, left, right }
}
function instr0(callee: string, type: VoidableType): IRExpr {
    return { kind: 'Call', wasmType: type, callee, callKind: 'instr', args: [] }
}
function instr1(callee: string, type: VoidableType, arg: IRExpr): IRExpr {
    return { kind: 'Call', wasmType: type, callee, callKind: 'instr', args: [arg] }
}
function instr2(callee: string, type: VoidableType, a: IRExpr, b: IRExpr): IRExpr {
    return { kind: 'Call', wasmType: type, callee, callKind: 'instr', args: [a, b] }
}
function ucall(callee: string, type: VoidableType, ...args: IRExpr[]): IRExpr {
    return { kind: 'Call', wasmType: type, callee, callKind: 'user', args }
}
function ret(value?: IRExpr): IRExpr {
    return { kind: 'Return', value }
}
function stmtExpr(expr: IRExpr): IRStmt {
    return { kind: 'ExprStmt', expr }
}
function block(stmts: IRStmt[], trailing?: IRExpr): IRExpr {
    const wasmType = trailing ? (trailing as any).wasmType ?? i32 : void_
    return { kind: 'Block', wasmType, stmts, trailing }
}
function vblock(...stmts: IRStmt[]): IRExpr {
    return { kind: 'Block', wasmType: void_, stmts }
}
function iif(cond: IRExpr, then: IRExpr, else_?: IRExpr): IRExpr {
    const wasmType = else_ && (then as any).wasmType !== void_ ? (then as any).wasmType : void_
    return { kind: 'If', wasmType, cond, then, else_ }
}
function loop(id: number, cond: IRExpr, body: IRExpr): IRExpr {
    return { kind: 'Loop', id, cond, body }
}

type VoidableType = 'i32' | 'f32' | 'void'

function fn(
    name: string,
    params: Array<[string, VoidableType]>,
    returnType: VoidableType,
    locals: Array<[string, VoidableType]>,
    body: IRExpr,
): IRFunction {
    return {
        kind: 'Function',
        name,
        params: params.map(([n, t]) => ({ name: n, wasmType: t as WasmValType })),
        returnType,
        locals: locals.map(([n, t]) => ({ name: n, wasmType: t as WasmValType })),
        body,
    }
}

// ---------------------------------------------------------------------------
// Prelude function bodies
// ---------------------------------------------------------------------------

function buildAlloc(): IRFunction {
    // (param $size i32) (result i32)
    // (local $addr i32) (local $new_heap i32) (local $cur_bytes i32) (local $need_pages i32)
    const size = lg('size')
    const addr = lg('addr')
    const newHeap = lg('new_heap')
    const curBytes = lg('cur_bytes')
    const needPages = lg('need_pages')
    const heap = () => gg('heap')

    const body = block([
        // new_heap = heap + size
        ls('new_heap', binop('i32.add', heap(), size)),
        // cur_bytes = memory.size << 16
        ls('cur_bytes', binop('i32.shl', instr0('memory.size', i32), c(16))),
        // if (new_heap <= cur_bytes) fast path
        stmtExpr(iif(
            binop('i32.le_s', newHeap, curBytes),
            vblock(
                ls('addr', heap()),
                gs('heap', newHeap),
                stmtExpr(ret(addr)),
            ),
        )),
        // need_pages = (new_heap - cur_bytes) >> 16 + 1
        ls('need_pages', binop('i32.add',
            binop('i32.shr_u', binop('i32.sub', newHeap, curBytes), c(16)),
            c(1),
        )),
        // if (memory.grow(need_pages) == -1) return -1
        stmtExpr(iif(
            binop('i32.eq', instr1('memory.grow', i32, needPages), c(-1)),
            ret(c(-1)),
        )),
        // bump and return
        ls('addr', heap()),
        gs('heap', newHeap),
    ], addr)

    return fn('alloc', [['size', i32]], i32,
        [['addr', i32], ['new_heap', i32], ['cur_bytes', i32], ['need_pages', i32]],
        body)
}

function buildAllocArray(): IRFunction {
    // (param $count i32) (param $elem_bytes i32) (result i32)
    // (local $base i32)
    const body = block([
        ls('base', ucall('alloc', i32,
            binop('i32.add', c(4), binop('i32.mul', lg('count'), lg('elem_bytes'))))),
        stmtExpr(instr2('i32.store', void_, lg('base'), lg('count'))),
    ], lg('base'))
    return fn('alloc_array', [['count', i32], ['elem_bytes', i32]], i32, [['base', i32]], body)
}

function buildAllocString(): IRFunction {
    // (param $byte_len i32) (result i32)
    // (local $base i32)
    const body = block([
        ls('base', ucall('alloc', i32, binop('i32.add', c(4), lg('byte_len')))),
        stmtExpr(instr2('i32.store', void_, lg('base'), lg('byte_len'))),
    ], lg('base'))
    return fn('alloc_string', [['byte_len', i32]], i32, [['base', i32]], body)
}

function buildScratchAlloc(): IRFunction {
    // (param $n i32) (result i32)
    const body = ucall('alloc', i32,
        binop('i32.and', binop('i32.add', lg('n'), c(3)), c(-4)))
    return fn('scratch_alloc', [['n', i32]], i32, [], body)
}

function buildStrPtr(): IRFunction {
    return fn('str_ptr', [['s', i32]], i32, [], lg('s'))
}

function buildStrLen(): IRFunction {
    return fn('str_len', [['s', i32]], i32, [], instr1('i32.load', i32, lg('s')))
}

function buildHeapGet(): IRFunction {
    return fn('heap_get', [], i32, [], gg('heap'))
}

function buildHeapSet(): IRFunction {
    return fn('heap_set', [['h', i32]], void_, [], vblock(gs('heap', lg('h'))))
}

function buildArrLen(): IRFunction {
    return fn('arr_len', [['ptr', i32]], i32, [], instr1('i32.load', i32, lg('ptr')))
}

function buildArrLoadI32(): IRFunction {
    // ptr + 4 + index * 4
    const addr = binop('i32.add', lg('ptr'),
        binop('i32.add', c(4), binop('i32.mul', lg('index'), c(4))))
    return fn('arr_load_i32', [['ptr', i32], ['index', i32]], i32, [],
        instr1('i32.load', i32, addr))
}

function buildArrStoreI32(): IRFunction {
    const addr = binop('i32.add', lg('ptr'),
        binop('i32.add', c(4), binop('i32.mul', lg('index'), c(4))))
    const body = vblock(stmtExpr(instr2('i32.store', void_, addr, lg('value'))))
    return fn('arr_store_i32', [['ptr', i32], ['index', i32], ['value', i32]], void_, [], body)
}

function buildArrLoadF32(): IRFunction {
    const addr = binop('i32.add', lg('ptr'),
        binop('i32.add', c(4), binop('i32.mul', lg('index'), c(4))))
    return fn('arr_load_f32', [['ptr', i32], ['index', i32]], f32,
        [], instr1('f32.load', f32, addr))
}

function buildPrintInt(): IRFunction {
    return fn('print_int', [['v', i32]], void_, [],
        vblock(stmtExpr(ucall('print', void_, lg('v')))))
}

function buildPrintBool(): IRFunction {
    return fn('print_bool', [['v', i32]], void_, [],
        vblock(stmtExpr(ucall('print', void_, lg('v')))))
}

function buildPrintFloat(): IRFunction {
    return fn('print_float', [['v', f32]], void_, [],
        vblock(stmtExpr(ucall('print', void_,
            instr1('i32.trunc_f32_s', i32, lg('v', f32))))))
}

function buildPrintString(): IRFunction {
    // (local $len i32) (local $i i32)
    // len = i32.load ptr
    // i = 0
    // loop while i < len:
    //   call $print (i32.load8_u (ptr + 4 + i))
    //   i = i + 1
    const LOOP_ID = 100000
    const body = vblock(
        ls('len', instr1('i32.load', i32, lg('ptr'))),
        ls('i', c(0)),
        stmtExpr(loop(LOOP_ID,
            binop('i32.lt_s', lg('i'), lg('len')),
            vblock(
                stmtExpr(ucall('print', void_,
                    instr1('i32.load8_u', i32,
                        binop('i32.add', lg('ptr'), binop('i32.add', c(4), lg('i')))))),
                ls('i', binop('i32.add', lg('i'), c(1))),
            ),
        )),
    )
    return fn('print_string', [['ptr', i32]], void_, [['len', i32], ['i', i32]], body)
}

function buildStrConcat(): IRFunction {
    // (local $len_a $len_b $total $dst $i: all i32)
    const LOOP_A = 100001
    const LOOP_B = 100002
    const body = block([
        ls('len_a', instr1('i32.load', i32, lg('a'))),
        ls('len_b', instr1('i32.load', i32, lg('b'))),
        ls('total', binop('i32.add', lg('len_a'), lg('len_b'))),
        ls('dst', ucall('alloc', i32, binop('i32.add', c(4), lg('total')))),
        stmtExpr(instr2('i32.store', void_, lg('dst'), lg('total'))),
        // copy $a bytes
        ls('i', c(0)),
        stmtExpr(loop(LOOP_A,
            binop('i32.lt_s', lg('i'), lg('len_a')),
            vblock(
                stmtExpr(instr2('i32.store8', void_,
                    binop('i32.add', binop('i32.add', lg('dst'), c(4)), lg('i')),
                    instr1('i32.load8_u', i32,
                        binop('i32.add', binop('i32.add', lg('a'), c(4)), lg('i'))))),
                ls('i', binop('i32.add', lg('i'), c(1))),
            ),
        )),
        // copy $b bytes
        ls('i', c(0)),
        stmtExpr(loop(LOOP_B,
            binop('i32.lt_s', lg('i'), lg('len_b')),
            vblock(
                stmtExpr(instr2('i32.store8', void_,
                    binop('i32.add',
                        binop('i32.add', lg('dst'), binop('i32.add', c(4), lg('len_a'))),
                        lg('i')),
                    instr1('i32.load8_u', i32,
                        binop('i32.add', binop('i32.add', lg('b'), c(4)), lg('i'))))),
                ls('i', binop('i32.add', lg('i'), c(1))),
            ),
        )),
    ], lg('dst'))
    return fn('str_concat', [['a', i32], ['b', i32]], i32,
        [['len_a', i32], ['len_b', i32], ['total', i32], ['dst', i32], ['i', i32]],
        body)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PreludeSpec {
    imports: IRImport[]
    globals: IRGlobal[]
    functions: IRFunction[]
    funcExports: IRExport[]
    /** Memory section is always included. */
    memoryPages: number
}

export function buildPrelude(heapBase: number, includeHostIO: boolean): PreludeSpec {
    const imports: IRImport[] = []
    if (includeHostIO) {
        imports.push({ kind: 'Import', env: 'env', field: 'print', name: 'print', params: [i32], result: undefined })
        imports.push({ kind: 'Import', env: 'env', field: 'read',  name: 'read',  params: [],   result: i32 })
    }

    const globals: IRGlobal[] = [{
        kind: 'Global',
        name: 'heap',
        wasmType: i32,
        mutable: true,
        init: c(heapBase),
    }]

    const functions: IRFunction[] = [
        buildAlloc(),
        buildAllocArray(),
        buildAllocString(),
        buildScratchAlloc(),
        buildStrPtr(),
        buildStrLen(),
        buildHeapGet(),
        buildHeapSet(),
        buildArrLen(),
        buildArrLoadI32(),
        buildArrStoreI32(),
        buildArrLoadF32(),
    ]
    if (includeHostIO) {
        functions.push(
            buildPrintInt(),
            buildPrintBool(),
            buildPrintFloat(),
            buildPrintString(),
        )
    }
    functions.push(buildStrConcat())

    const funcExports: IRExport[] = [
        { kind: 'Export', alias: 'alloc',         internalName: 'alloc',         what: 'func' },
        { kind: 'Export', alias: 'scratch_alloc', internalName: 'scratch_alloc', what: 'func' },
    ]

    return { imports, globals, functions, funcExports, memoryPages: 1 }
}
