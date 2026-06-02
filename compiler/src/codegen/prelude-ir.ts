// SPDX-License-Identifier: MIT
/**
 * Prelude IR — std.wat content as proper IRModule nodes.
 *
 * Mirrors the prelude reification done on the Silicon side (Slice 1).
 * The binary emitter works with a self-contained IRModule that includes
 * prelude functions; the WAT emitter continues using the std.wat string.
 */

import type {
    IRModule, IRFunction, IRGlobal, IRImport, IRExport,
    IRExpr, IRStmt, IRParam, IRLocal, WasmValType, AbstractOp,
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
function binop(op: AbstractOp, left: IRExpr, right: IRExpr, resultType: WasmValType = i32): IRExpr {
    return { kind: 'BinOp', wasmType: resultType, op, left, right }
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
    //
    // Phase 9c-4: on memory.grow failure we now `unreachable` (clean
    // WASM trap) instead of returning -1.  Returning a sentinel
    // pointer corrupted downstream loads silently; the trap surfaces
    // the failure at the call site with a documented wasmtime message
    // ("wasm trap: unreachable instruction executed").  The --max-heap
    // CLI flag (handled at memory-section emit time) lets callers cap
    // the wasm memory and exercise this path deterministically.
    const size = lg('size')
    const addr = lg('addr')
    const newHeap = lg('new_heap')
    const curBytes = lg('cur_bytes')
    const needPages = lg('need_pages')
    const heap = () => gg('heap')

    const unreachable: IRExpr = { kind: 'Unreachable' }

    const body = block([
        // new_heap = heap + size
        ls('new_heap', binop('i32_add', heap(), size)),
        // cur_bytes = memory.size << 16
        ls('cur_bytes', binop('i32_shl', instr0('memory.size', i32), c(16))),
        // if (new_heap <= cur_bytes) fast path
        stmtExpr(iif(
            binop('i32_le_s', newHeap, curBytes),
            vblock(
                ls('addr', heap()),
                gs('heap', newHeap),
                stmtExpr(ret(addr)),
            ),
        )),
        // need_pages = (new_heap - cur_bytes) >> 16 + 1
        ls('need_pages', binop('i32_add',
            binop('i32_shr_u', binop('i32_sub', newHeap, curBytes), c(16)),
            c(1),
        )),
        // if (memory.grow(need_pages) == -1) → clean trap.
        stmtExpr(iif(
            binop('i32_eq', instr1('memory.grow', i32, needPages), c(-1)),
            unreachable,
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
            binop('i32_add', c(4), binop('i32_mul', lg('count'), lg('elem_bytes'))))),
        stmtExpr(instr2('i32.store', void_, lg('base'), lg('count'))),
    ], lg('base'))
    return fn('alloc_array', [['count', i32], ['elem_bytes', i32]], i32, [['base', i32]], body)
}

function buildAllocString(): IRFunction {
    // (param $byte_len i32) (result i32)
    // (local $base i32)
    const body = block([
        ls('base', ucall('alloc', i32, binop('i32_add', c(4), lg('byte_len')))),
        stmtExpr(instr2('i32.store', void_, lg('base'), lg('byte_len'))),
    ], lg('base'))
    return fn('alloc_string', [['byte_len', i32]], i32, [['base', i32]], body)
}

function buildScratchAlloc(): IRFunction {
    // (param $n i32) (result i32)
    const body = ucall('alloc', i32,
        binop('i32_and', binop('i32_add', lg('n'), c(3)), c(-4)))
    return fn('scratch_alloc', [['n', i32]], i32, [], body)
}

// ── Phase 5 Workstream A — allocator primitives for growable containers ──
//
// `mem_copy` is a byte-wise copy: `dst = src` for `n_bytes`.  Used by
// `realloc` (below) and directly by Vec/HashMap implementations that need
// to shift elements (e.g. vec_insert / vec_remove).  Loop-based for
// portability; a `memory.copy` (bulk-memory proposal) variant is a
// post-1.0 optimization.
function buildMemCopy(): IRFunction {
    const LOOP_ID = 200001
    const body = vblock(
        ls('i', c(0)),
        stmtExpr(loop(LOOP_ID,
            binop('i32_lt_s', lg('i'), lg('n_bytes')),
            vblock(
                stmtExpr(instr2('i32.store8', void_,
                    binop('i32_add', lg('dst'), lg('i')),
                    instr1('i32.load8_u', i32,
                        binop('i32_add', lg('src'), lg('i'))))),
                ls('i', binop('i32_add', lg('i'), c(1))),
            ),
        )),
    )
    return fn('mem_copy',
        [['dst', i32], ['src', i32], ['n_bytes', i32]],
        void_,
        [['i', i32]],
        body)
}

// `realloc(old_ptr, old_size, new_size)` — bump-allocate a new block of
// `new_size` bytes, byte-copy the first `min(old_size, new_size)` bytes
// from the old block, return the new pointer.  The old block is
// abandoned (the bump allocator has no free list, so its memory is
// permanently lost — acceptable for 1.0; a real free-list allocator is
// a post-1.0 sweep).
//
// Used by Vec to grow its backing buffer when capacity is exhausted:
//
//   new_buf = realloc(old_buf, old_capacity * elem_size,
//                              new_capacity * elem_size)
//
// `old_size = 0` is the "fresh alloc" path — equivalent to plain alloc.
function buildRealloc(): IRFunction {
    const newPtr = lg('new_ptr')
    const copyN = lg('copy_n')
    const body = block([
        // Allocate the new block first.
        ls('new_ptr', ucall('alloc', i32, lg('new_size'))),
        // copy_n = min(old_size, new_size).  Two-statement form (default
        // assignment + conditional override) avoids a result-bearing if,
        // which would diverge from the parallel std.wat shape (breaking
        // the byte-equal direct-emitter check) and trip a user-facing
        // codegen test that asserts user @let definitions without an
        // else don't emit a result-typed-if.
        ls('copy_n', lg('new_size')),
        stmtExpr(iif(
            binop('i32_lt_s', lg('old_size'), lg('new_size')),
            vblock(ls('copy_n', lg('old_size'))),
        )),
        // mem_copy(new_ptr, old_ptr, copy_n) — but only if old_ptr is
        // non-zero (sentinel for "no previous block").
        stmtExpr(iif(
            binop('i32_ne', lg('old_ptr'), c(0)),
            vblock(stmtExpr(ucall('mem_copy', void_, newPtr, lg('old_ptr'), copyN))),
        )),
    ], newPtr)
    return fn('realloc',
        [['old_ptr', i32], ['old_size', i32], ['new_size', i32]],
        i32,
        [['new_ptr', i32], ['copy_n', i32]],
        body)
}

// ── Phase 9c — explicit-arena escape ─────────────────────────────────
//
// `arena_promote(saved, ptr, size)` copies a contiguous heap block from
// inside the current arena (at `ptr`, `size` bytes) to the arena's saved
// boundary (`saved`), then advances the heap pointer to `saved + size`.
// Returns the new pointer.  Used by `&move_to_parent_arena` at the tail
// position of `&with_arena { ... }` blocks.
//
// Preconditions enforced by the lowerer (not at runtime):
//   - `saved` is the value `heap` held at entry to the enclosing arena.
//   - `ptr` was allocated inside that arena (i.e. saved ≤ ptr < heap).
//   - The block is a flat, contiguous heap layout (String, value-array,
//     sum-with-flat-payloads).  Nested heap references are a v1.1
//     extension (trace-and-copy).
//
// Two-step memmove (i.e. memcpy when regions don't overlap):  this
// reuses `mem_copy`'s byte-wise loop.  `mem_copy` walks forward, so when
// `saved < ptr` (the common case — the arena's content lives above its
// boundary) overlap is benign: each destination byte is written before
// the corresponding source byte is read.  When `saved == ptr` the loop
// is a no-op on already-coincident bytes.  The `saved > ptr` case
// cannot arise from a well-formed arena.
function buildArenaPromote(): IRFunction {
    const body = block([
        // mem_copy(saved, ptr, size)
        stmtExpr(ucall('mem_copy', void_, lg('saved'), lg('ptr'), lg('size'))),
        // heap = saved + size
        gs('heap', binop('i32_add', lg('saved'), lg('size'))),
    ], lg('saved'))
    return fn('arena_promote',
        [['saved', i32], ['ptr', i32], ['size', i32]],
        i32,
        [],
        body)
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

// Phase 9c-8 — memory introspection helpers.
//
// `heap_used()` returns how many bytes have been bump-allocated since
// the program started — the heap's high-water mark minus the static
// data segment boundary.  Used by tests + dashboards + leak checks.
//
//   &heap_used == 0   immediately after program start
//   &heap_used        grows monotonically until something resets `heap`
//                     (an `&@with_arena` exit, an explicit `&heap_set`)
//
// `arena_used(saved)` is the per-arena view: bytes allocated since a
// caller-supplied entry pointer.  Pass `&heap_get` at arena entry to
// compute "current arena's bump distance" later.  Cheap and explicit;
// avoids us having to plumb a global "active arena" pointer or named
// arena handles for v1.0.
function buildHeapUsed(): IRFunction {
    return fn('heap_used', [], i32, [],
        binop('i32_sub', gg('heap'), gg('heap_base')))
}

function buildArenaUsed(): IRFunction {
    return fn('arena_used', [['saved', i32]], i32, [],
        binop('i32_sub', gg('heap'), lg('saved')))
}

function buildArrLen(): IRFunction {
    return fn('arr_len', [['ptr', i32]], i32, [], instr1('i32.load', i32, lg('ptr')))
}

function buildArrLoadI32(): IRFunction {
    // ptr + 4 + index * 4
    const addr = binop('i32_add', lg('ptr'),
        binop('i32_add', c(4), binop('i32_mul', lg('index'), c(4))))
    return fn('arr_load_i32', [['ptr', i32], ['index', i32]], i32, [],
        instr1('i32.load', i32, addr))
}

function buildArrStoreI32(): IRFunction {
    const addr = binop('i32_add', lg('ptr'),
        binop('i32_add', c(4), binop('i32_mul', lg('index'), c(4))))
    const body = vblock(stmtExpr(instr2('i32.store', void_, addr, lg('value'))))
    return fn('arr_store_i32', [['ptr', i32], ['index', i32], ['value', i32]], void_, [], body)
}

function buildArrLoadF32(): IRFunction {
    const addr = binop('i32_add', lg('ptr'),
        binop('i32_add', c(4), binop('i32_mul', lg('index'), c(4))))
    return fn('arr_load_f32', [['ptr', i32], ['index', i32]], f32,
        [], instr1('f32.load', f32, addr))
}

function buildPrintInt(): IRFunction {
    return fn('print_int', [['v', i32]], void_, [],
        vblock(stmtExpr(ucall(ENV_PRINT, void_, lg('v')))))
}

function buildPrintBool(): IRFunction {
    return fn('print_bool', [['v', i32]], void_, [],
        vblock(stmtExpr(ucall(ENV_PRINT, void_, lg('v')))))
}

function buildPrintFloat(): IRFunction {
    return fn('print_float', [['v', f32]], void_, [],
        vblock(stmtExpr(ucall(ENV_PRINT, void_,
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
            binop('i32_lt_s', lg('i'), lg('len')),
            vblock(
                stmtExpr(ucall(ENV_PRINT, void_,
                    instr1('i32.load8_u', i32,
                        binop('i32_add', lg('ptr'), binop('i32_add', c(4), lg('i')))))),
                ls('i', binop('i32_add', lg('i'), c(1))),
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
        ls('total', binop('i32_add', lg('len_a'), lg('len_b'))),
        ls('dst', ucall('alloc', i32, binop('i32_add', c(4), lg('total')))),
        stmtExpr(instr2('i32.store', void_, lg('dst'), lg('total'))),
        // copy $a bytes
        ls('i', c(0)),
        stmtExpr(loop(LOOP_A,
            binop('i32_lt_s', lg('i'), lg('len_a')),
            vblock(
                stmtExpr(instr2('i32.store8', void_,
                    binop('i32_add', binop('i32_add', lg('dst'), c(4)), lg('i')),
                    instr1('i32.load8_u', i32,
                        binop('i32_add', binop('i32_add', lg('a'), c(4)), lg('i'))))),
                ls('i', binop('i32_add', lg('i'), c(1))),
            ),
        )),
        // copy $b bytes
        ls('i', c(0)),
        stmtExpr(loop(LOOP_B,
            binop('i32_lt_s', lg('i'), lg('len_b')),
            vblock(
                stmtExpr(instr2('i32.store8', void_,
                    binop('i32_add',
                        binop('i32_add', lg('dst'), binop('i32_add', c(4), lg('len_a'))),
                        lg('i')),
                    instr1('i32.load8_u', i32,
                        binop('i32_add', binop('i32_add', lg('b'), c(4)), lg('i'))))),
                ls('i', binop('i32_add', lg('i'), c(1))),
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
    /** Phase 9c-4: optional max-pages cap.  When set, the wasm memory
     *  is emitted with `flags=1` (min+max).  The bump allocator traps
     *  via `unreachable` if `memory.grow` exceeds this cap.  Powers
     *  the `--max-heap=N` CLI flag for testing exhaustion paths. */
    memoryMaxPages?: number
}

// Private internal names for env.print / env.read imports.
// These must not collide with any user-defined Silicon function name.
// The binary emitter resolves calls by these names; the WAT emitter uses
// std.wat directly ($print / $read) and is unaffected by this change.
const ENV_PRINT = '__env_print' as const
const ENV_READ  = '__env_read'  as const

export function buildPrelude(heapBase: number, includeHostIO: boolean, maxPages?: number): PreludeSpec {
    const imports: IRImport[] = []
    if (includeHostIO) {
        imports.push({ kind: 'Import', env: 'env', field: 'print', name: ENV_PRINT, params: [i32], result: undefined })
        imports.push({ kind: 'Import', env: 'env', field: 'read',  name: ENV_READ,  params: [],   result: i32 })
    }

    const globals: IRGlobal[] = [
        {
            kind: 'Global',
            name: 'heap',
            wasmType: i32,
            mutable: true,
            init: c(heapBase),
        },
        // Phase 9c-8: immutable `heap_base` so `$heap_used` can compute
        // `heap - heap_base` without baking the per-program base into
        // the helper's IR.
        {
            kind: 'Global',
            name: 'heap_base',
            wasmType: i32,
            mutable: false,
            init: c(heapBase),
        },
    ]

    const functions: IRFunction[] = [
        buildAlloc(),
        buildAllocArray(),
        buildAllocString(),
        buildScratchAlloc(),
        buildMemCopy(),
        buildRealloc(),
        buildArenaPromote(),
        buildStrPtr(),
        buildStrLen(),
        buildHeapGet(),
        buildHeapSet(),
        buildHeapUsed(),
        buildArenaUsed(),
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
        { kind: 'Export', alias: 'mem_copy',      internalName: 'mem_copy',      what: 'func' },
        { kind: 'Export', alias: 'realloc',       internalName: 'realloc',       what: 'func' },
        { kind: 'Export', alias: 'arena_promote', internalName: 'arena_promote', what: 'func' },
    ]

    return { imports, globals, functions, funcExports, memoryPages: 1, memoryMaxPages: maxPages }
}
