/**
 * Direct IR → WASM binary emitter.
 *
 * Takes a PreludeSpec + user IRModule and emits a complete WASM binary,
 * byte-equal to wat2wasm(emitModule(irModule, stdWat)).
 *
 * Section order (spec-mandated): type(1) import(2) function(3) memory(5)
 * global(6) export(7) code(10) data(11).
 */

import { WasmBuffer } from './wasm-buffer'
import type { PreludeSpec } from './prelude-ir'
import type {
    IRModule, IRFunction, IRGlobal, IRImport, IRExport, IRDataSegment,
    IRExpr, IRStmt, WasmValType, WasmType,
} from '../ir/nodes'
import { ARRAY_LITERAL_CALLEE } from '../ir/nodes'

// ---------------------------------------------------------------------------
// Value-type encoding
// ---------------------------------------------------------------------------

const VALTYPE: Record<WasmValType, number> = { i32: 0x7F, i64: 0x7E, f32: 0x7D }
const BLOCKTYPE_VOID = 0x40

function valTypeCode(t: WasmType): number {
    if (t === 'void') return BLOCKTYPE_VOID
    return VALTYPE[t]
}

// ---------------------------------------------------------------------------
// Instruction opcode table
// Each entry: [opcode, ...immediates]
// For load/store: immediates are [align, offset] (both ULEB128)
// For memory.size / memory.grow: immediate is [memidx=0]
// ---------------------------------------------------------------------------

const OPCODES: Record<string, number[]> = {
    'i32.add': [0x6A], 'i32.sub': [0x6B], 'i32.mul': [0x6C],
    'i32.div_s': [0x6D], 'i32.div_u': [0x6E],
    'i32.rem_s': [0x6F], 'i32.rem_u': [0x70],
    'i32.and': [0x71], 'i32.or': [0x72], 'i32.xor': [0x73],
    'i32.shl': [0x74], 'i32.shr_s': [0x75], 'i32.shr_u': [0x76],
    'i32.rotl': [0x77], 'i32.rotr': [0x78],
    'i32.eq': [0x46], 'i32.ne': [0x47],
    'i32.lt_s': [0x48], 'i32.lt_u': [0x49],
    'i32.gt_s': [0x4A], 'i32.gt_u': [0x4B],
    'i32.le_s': [0x4C], 'i32.le_u': [0x4D],
    'i32.ge_s': [0x4E], 'i32.ge_u': [0x4F],
    'i32.eqz': [0x45], 'i32.clz': [0x67], 'i32.ctz': [0x68], 'i32.popcnt': [0x69],
    'f32.add': [0x92], 'f32.sub': [0x93], 'f32.mul': [0x94], 'f32.div': [0x95],
    'f32.min': [0x96], 'f32.max': [0x97],
    'f32.eq': [0x5B], 'f32.ne': [0x5C], 'f32.lt': [0x5D],
    'f32.gt': [0x5E], 'f32.le': [0x5F], 'f32.ge': [0x60],
    'f32.neg': [0x8C], 'f32.abs': [0x8B], 'f32.sqrt': [0x91],
    'i64.add': [0x7C], 'i64.sub': [0x7D], 'i64.mul': [0x7E],
    'i64.div_s': [0x7F], 'i64.rem_s': [0x81],
    'i64.and': [0x83], 'i64.or': [0x84], 'i64.xor': [0x85],
    'i64.shl': [0x86], 'i64.shr_s': [0x87], 'i64.shr_u': [0x88],
    'i64.eq': [0x51], 'i64.ne': [0x52], 'i64.lt_s': [0x53],
    'i64.gt_s': [0x55], 'i64.le_s': [0x57], 'i64.ge_s': [0x59],
    'i64.eqz': [0x50],
    'i32.trunc_f32_s': [0xA8], 'i32.trunc_f32_u': [0xA9],
    'f32.convert_i32_s': [0xB2], 'f32.convert_i32_u': [0xB3],
    'i64.extend_i32_s': [0xAC], 'i64.extend_i32_u': [0xAD],
    'i32.wrap_i64': [0xA7],
    // load/store: [opcode, alignLog2, offset]
    'i32.load':    [0x28, 2, 0], 'i32.load8_s':  [0x2C, 0, 0], 'i32.load8_u':  [0x2D, 0, 0],
    'i32.load16_s':[0x2E, 1, 0], 'i32.load16_u': [0x2F, 1, 0],
    'i32.store':   [0x36, 2, 0], 'i32.store8':   [0x3A, 0, 0], 'i32.store16':  [0x3B, 1, 0],
    'f32.load':    [0x2A, 2, 0], 'f32.store':    [0x38, 2, 0],
    'i64.load':    [0x29, 3, 0], 'i64.store':    [0x37, 3, 0],
    'memory.size': [0x3F, 0], 'memory.grow': [0x40, 0],
    'drop': [0x1A], 'unreachable': [0x00], 'select': [0x1B],
}

// ---------------------------------------------------------------------------
// Type-section signature deduplication
// ---------------------------------------------------------------------------

interface FuncSig { params: WasmValType[]; result: WasmType }

function sigKey(s: FuncSig): string {
    return `${s.params.join(',')}→${s.result}`
}

function importSig(imp: IRImport): FuncSig {
    return { params: imp.params, result: imp.result ?? 'void' }
}

function funcSig(f: IRFunction): FuncSig {
    return { params: f.params.map(p => p.wasmType), result: f.returnType }
}

// ---------------------------------------------------------------------------
// Emission context (per-module state)
// ---------------------------------------------------------------------------

interface EmitCtx {
    typeIdxOf: (sig: FuncSig) => number
    funcIdxOf: (name: string) => number
    globalIdxOf: (name: string) => number
    /** Depth stack for structured control flow: 0=block, 1=loop, 2=if */
    depthStack: number[]
}

function findDepthTo(stack: number[], kind: number): number {
    for (let i = stack.length - 1; i >= 0; i--) {
        const depth = stack.length - 1 - i
        if (stack[i] === kind) return depth
    }
    return 0
}

// ---------------------------------------------------------------------------
// Expression / statement emission (into a WasmBuffer)
// ---------------------------------------------------------------------------

function emitExpr(e: IRExpr, buf: WasmBuffer, ctx: EmitCtx, isUser: boolean,
                  localIdxOf: (name: string) => number): void {
    switch (e.kind) {
        case 'Const': {
            if (e.wasmType === 'i32') {
                buf.u8(0x41); buf.i32(e.value)
            } else if (e.wasmType === 'f32') {
                buf.u8(0x43); buf.f32(e.value)
            } else {
                buf.u8(0x42); buf.i64(BigInt(e.value))
            }
            return
        }
        case 'LocalGet':
            buf.u8(0x20); buf.u32(localIdxOf(e.name)); return
        case 'LocalSet': // shouldn't appear as expr, but handle
            emitExpr(e as unknown as IRExpr, buf, ctx, isUser, localIdxOf); return
        case 'GlobalGet':
            buf.u8(0x23); buf.u32(ctx.globalIdxOf(e.name)); return
        case 'BinOp': {
            emitExpr(e.left, buf, ctx, isUser, localIdxOf)
            emitExpr(e.right, buf, ctx, isUser, localIdxOf)
            const ops = OPCODES[e.instr]
            if (!ops) throw new Error(`Unknown binop: ${e.instr}`)
            for (const b of ops) buf.u8(b)
            return
        }
        case 'Call': {
            if (e.callee === ARRAY_LITERAL_CALLEE) {
                emitArrayLiteral(e.args, buf, ctx, isUser, localIdxOf)
                return
            }
            if (e.callKind === 'instr') {
                // Zero-arg instructions (memory.size etc.) emit before their args
                if (e.args.length === 0) {
                    const ops = OPCODES[e.callee]
                    if (!ops) throw new Error(`Unknown instr: ${e.callee}`)
                    for (const b of ops) buf.u8(b)
                    return
                }
                for (const arg of e.args) emitExpr(arg, buf, ctx, isUser, localIdxOf)
                const ops = OPCODES[e.callee]
                if (!ops) throw new Error(`Unknown instr: ${e.callee}`)
                for (const b of ops) buf.u8(b)
                return
            }
            for (const arg of e.args) emitExpr(arg, buf, ctx, isUser, localIdxOf)
            buf.u8(0x10); buf.u32(ctx.funcIdxOf(e.callee))
            return
        }
        case 'Block': {
            for (const s of e.stmts) emitStmt(s, buf, ctx, isUser, localIdxOf)
            if (e.trailing) emitExpr(e.trailing, buf, ctx, isUser, localIdxOf)
            return
        }
        case 'If': {
            emitExpr(e.cond, buf, ctx, isUser, localIdxOf)
            buf.u8(0x04)
            buf.u8(e.wasmType === 'void' ? BLOCKTYPE_VOID : VALTYPE[e.wasmType as WasmValType])
            ctx.depthStack.push(2)
            emitExprAsBody(e.then, buf, ctx, isUser, localIdxOf, e.then.kind === 'Block' && (e.then as any).wasmType === 'void')
            if (e.else_) {
                buf.u8(0x05)
                emitExprAsBody(e.else_, buf, ctx, isUser, localIdxOf, e.else_.kind === 'Block' && (e.else_ as any).wasmType === 'void')
            }
            buf.u8(0x0B)
            ctx.depthStack.pop()
            return
        }
        case 'Loop': {
            // block (void)
            buf.u8(0x02); buf.u8(BLOCKTYPE_VOID)
            ctx.depthStack.push(0)
            // loop (void)
            buf.u8(0x03); buf.u8(BLOCKTYPE_VOID)
            ctx.depthStack.push(1)
            // br_if to exit block when cond == 0
            emitExpr(e.cond, buf, ctx, isUser, localIdxOf)
            buf.u8(0x45) // i32.eqz
            buf.u8(0x0D); buf.u32(findDepthTo(ctx.depthStack, 0))
            // body
            emitExprAsBody(e.body, buf, ctx, isUser, localIdxOf, true)
            // br to loop head (continue)
            buf.u8(0x0C); buf.u32(findDepthTo(ctx.depthStack, 1))
            // end loop, end block
            buf.u8(0x0B)
            ctx.depthStack.pop()
            buf.u8(0x0B)
            ctx.depthStack.pop()
            return
        }
        case 'Break':
            buf.u8(0x0C); buf.u32(findDepthTo(ctx.depthStack, 0)); return
        case 'Continue':
            buf.u8(0x0C); buf.u32(findDepthTo(ctx.depthStack, 1)); return
        case 'Return':
            if (e.value) emitExpr(e.value, buf, ctx, isUser, localIdxOf)
            buf.u8(0x0F); return
        case 'Nop': return
        case 'Unreachable': buf.u8(0x00); return
    }
}

/** Emit an expression that is used as a statement (drop non-void result). */
function emitExprAsBody(e: IRExpr, buf: WasmBuffer, ctx: EmitCtx, isUser: boolean,
                        localIdxOf: (name: string) => number, voidCtx: boolean): void {
    emitExpr(e, buf, ctx, isUser, localIdxOf)
    // Drop a stray value only when we're in a void context (the surrounding
    // block / function expects nothing on the stack).  The inverted form
    // (`!voidCtx && producesValue`) was a latent bug: it dropped the value
    // an `@if` expression's i32 branch was meant to leave on the stack,
    // causing "stack has 0 values, expected 1" validation failures.  The
    // bug only surfaced when an @if-as-expression with non-void branches
    // ran through the direct binary emitter — first hit by slice_at_i32
    // (5c-2) returning Option[Int] from its then/else arms.
    if (voidCtx && producesValue(e)) {
        buf.u8(0x1A) // drop
    }
}

function producesValue(e: IRExpr): boolean {
    switch (e.kind) {
        case 'Loop': case 'Break': case 'Continue': case 'Return': case 'Nop':
            return false
        case 'Block':
            return e.trailing ? producesValue(e.trailing) : false
        case 'If':
            return e.wasmType !== 'void'
        case 'Call':
            return e.wasmType !== 'void'
        default:
            return (e as any).wasmType !== 'void'
    }
}

function emitStmt(s: IRStmt, buf: WasmBuffer, ctx: EmitCtx, isUser: boolean,
                  localIdxOf: (name: string) => number): void {
    switch (s.kind) {
        case 'LocalSet':
            emitExpr(s.value, buf, ctx, isUser, localIdxOf)
            buf.u8(0x21); buf.u32(localIdxOf(s.name))
            return
        case 'GlobalSet':
            emitExpr(s.value, buf, ctx, isUser, localIdxOf)
            buf.u8(0x24); buf.u32(ctx.globalIdxOf(s.name))
            return
        case 'ExprStmt': {
            const produces = producesValue(s.expr)
            emitExpr(s.expr, buf, ctx, isUser, localIdxOf)
            if (produces) buf.u8(0x1A) // drop
            return
        }
    }
}

function emitArrayLiteral(
    args: IRExpr[], buf: WasmBuffer, ctx: EmitCtx, isUser: boolean,
    localIdxOf: (name: string) => number,
): void {
    const count = (args[0] as { value: number }).value
    const elemBytes = (args[1] as { value: number }).value
    const elements = args.slice(2)

    buf.u8(0x02); buf.u8(0x7F) // block (result i32)
    ctx.depthStack.push(2)

    // local.set $addr = call $alloc_array count elemBytes
    emitExpr(args[0], buf, ctx, isUser, localIdxOf)
    emitExpr(args[1], buf, ctx, isUser, localIdxOf)
    buf.u8(0x10); buf.u32(ctx.funcIdxOf('alloc_array'))
    buf.u8(0x21); buf.u32(localIdxOf('addr'))

    for (let i = 0; i < elements.length; i++) {
        buf.u8(0x20); buf.u32(localIdxOf('addr')) // local.get $addr
        emitExpr(elements[i], buf, ctx, isUser, localIdxOf)
        buf.u8(0x36); buf.u8(2); buf.u32(4 + i * 4) // i32.store align=2 offset
    }

    buf.u8(0x20); buf.u32(localIdxOf('addr')) // local.get $addr (result)
    buf.u8(0x0B) // end block
    ctx.depthStack.pop()
}

// ---------------------------------------------------------------------------
// Local group compression (consecutive same-type locals → one group)
// ---------------------------------------------------------------------------

function compressLocals(types: WasmValType[]): Array<[number, WasmValType]> {
    const groups: Array<[number, WasmValType]> = []
    for (const t of types) {
        if (groups.length > 0 && groups[groups.length - 1][1] === t) {
            groups[groups.length - 1][0]++
        } else {
            groups.push([1, t])
        }
    }
    return groups
}

// ---------------------------------------------------------------------------
// Function body emission
// ---------------------------------------------------------------------------

function emitFunctionBody(
    f: IRFunction,
    isUser: boolean, // user functions get $addr local prepended
    ctx: EmitCtx,
): WasmBuffer {
    // Build local index map: params first, then locals
    const localNames: string[] = []
    const localTypes: WasmValType[] = []
    for (const p of f.params) { localNames.push(p.name); localTypes.push(p.wasmType) }
    // $addr is injected for all user functions
    if (isUser) { localNames.push('addr'); localTypes.push('i32') }
    for (const l of f.locals) { localNames.push(l.name); localTypes.push(l.wasmType) }

    const localIdxOf = (name: string): number => {
        const idx = localNames.indexOf(name)
        if (idx < 0) throw new Error(`Unknown local: ${name} in ${f.name}`)
        return idx
    }

    const bodyBuf = new WasmBuffer()

    // Local declarations (only non-param locals, grouped)
    const declTypes = isUser
        ? ['i32' as WasmValType, ...f.locals.map(l => l.wasmType)]
        : f.locals.map(l => l.wasmType)
    const groups = compressLocals(declTypes)
    bodyBuf.u32(groups.length)
    for (const [count, type] of groups) {
        bodyBuf.u32(count); bodyBuf.u8(VALTYPE[type])
    }

    // Function body instructions
    const funcCtx: EmitCtx = { ...ctx, depthStack: [] }
    if (f.body) {
        if (f.returnType === 'void') {
            emitExprAsBody(f.body, bodyBuf, funcCtx, isUser, localIdxOf, true)
        } else {
            emitExpr(f.body, bodyBuf, funcCtx, isUser, localIdxOf)
        }
    }
    bodyBuf.u8(0x0B) // end

    return bodyBuf
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function buildTypeSection(sigs: FuncSig[]): WasmBuffer {
    const body = new WasmBuffer()
    body.u32(sigs.length)
    for (const sig of sigs) {
        body.u8(0x60)
        body.u32(sig.params.length)
        for (const p of sig.params) body.u8(VALTYPE[p])
        if (sig.result === 'void') {
            body.u32(0)
        } else {
            body.u32(1); body.u8(VALTYPE[sig.result as WasmValType])
        }
    }
    return body
}

function buildImportSection(imports: IRImport[], typeIdxOf: (sig: FuncSig) => number): WasmBuffer {
    const body = new WasmBuffer()
    body.u32(imports.length)
    for (const imp of imports) {
        body.name(imp.env); body.name(imp.field)
        body.u8(0x00) // func descriptor
        body.u32(typeIdxOf(importSig(imp)))
    }
    return body
}

function buildFunctionSection(
    funcs: IRFunction[],
    typeIdxOf: (sig: FuncSig) => number,
): WasmBuffer {
    const body = new WasmBuffer()
    body.u32(funcs.length)
    for (const f of funcs) body.u32(typeIdxOf(funcSig(f)))
    return body
}

function buildMemorySection(pages: number): WasmBuffer {
    const body = new WasmBuffer()
    body.u32(1)       // count = 1
    body.u8(0x00)     // flags: no max
    body.u32(pages)   // min pages
    return body
}

function buildGlobalSection(globals: IRGlobal[], ctx: EmitCtx): WasmBuffer {
    const body = new WasmBuffer()
    body.u32(globals.length)
    for (const g of globals) {
        body.u8(VALTYPE[g.wasmType])
        body.u8(g.mutable ? 1 : 0)
        // init expr — only i32.const supported here (all globals use i32.const)
        const init = g.init as { kind: string; value: number }
        if (init.kind === 'Const' && g.wasmType === 'i32') {
            body.u8(0x41); body.i32(init.value)
        } else {
            throw new Error(`Unsupported global init for ${g.name}`)
        }
        body.u8(0x0B) // end
    }
    return body
}

function buildExportSection(
    memExport: boolean,
    funcExports: IRExport[],
    userExports: IRExport[],
    funcIdxOf: (name: string) => number,
): WasmBuffer {
    const allExports: Array<{ name: string; type: number; idx: number }> = []
    if (memExport) allExports.push({ name: 'memory', type: 0x02, idx: 0 })
    for (const e of [...funcExports, ...userExports]) {
        if (e.what === 'func') {
            allExports.push({ name: e.alias, type: 0x00, idx: funcIdxOf(e.internalName) })
        } else if (e.what === 'global') {
            // global exports: type=0x03, idx from globalIdxOf
            // (not common in prelude, skip for now — handled in full impl if needed)
        }
    }

    const body = new WasmBuffer()
    body.u32(allExports.length)
    for (const e of allExports) {
        body.name(e.name); body.u8(e.type); body.u32(e.idx)
    }
    return body
}

function buildCodeSection(
    funcs: IRFunction[],
    prelFuncCount: number, // first prelFuncCount are prelude functions (no $addr)
    ctx: EmitCtx,
): WasmBuffer {
    const body = new WasmBuffer()
    body.u32(funcs.length)
    for (let i = 0; i < funcs.length; i++) {
        const isUser = i >= prelFuncCount
        const bodyBuf = emitFunctionBody(funcs[i], isUser, ctx)
        body.prefixed(bodyBuf)
    }
    return body
}

function buildDataSection(segments: IRDataSegment[]): WasmBuffer {
    const body = new WasmBuffer()
    body.u32(segments.length)
    for (const seg of segments) {
        body.u8(0x00)              // active segment, memory 0
        body.u8(0x41); body.i32(seg.offset) // i32.const offset
        body.u8(0x0B)              // end
        // decode the WAT-escaped string to raw bytes
        const bytes = decodeWatString(seg.encoded)
        body.u32(bytes.length)
        body.raw(bytes)
    }
    return body
}

/** Decode a WAT-inline string (with \xx escapes) to raw bytes. */
function decodeWatString(encoded: string): number[] {
    const out: number[] = []
    let i = 0
    while (i < encoded.length) {
        if (encoded[i] === '\\' && i + 1 < encoded.length) {
            const c = encoded[i + 1]
            if (c === 'n') { out.push(10); i += 2 }
            else if (c === 't') { out.push(9); i += 2 }
            else if (c === 'r') { out.push(13); i += 2 }
            else if (c === '\\') { out.push(92); i += 2 }
            else if (c === '"') { out.push(34); i += 2 }
            else if (c === '\'') { out.push(39); i += 2 }
            else if (c === '0') { out.push(0); i += 2 }
            else if (/[0-9a-fA-F]/.test(c) && i + 2 < encoded.length) {
                out.push(parseInt(encoded.slice(i + 1, i + 3), 16)); i += 3
            } else {
                out.push(encoded.charCodeAt(i)); i++
            }
        } else {
            out.push(encoded.charCodeAt(i)); i++
        }
    }
    return out
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function emitWasmBinary(prelude: PreludeSpec, userMod: IRModule): Uint8Array {
    // ── 1. Collect all imports + functions in emission order ──────────────
    const allImports: IRImport[] = [...prelude.imports, ...userMod.imports]
    const prelFunctions: IRFunction[] = prelude.functions
    const userFunctions: IRFunction[] = userMod.functions
    const allFunctions: IRFunction[] = [...prelFunctions, ...userFunctions]
    const allGlobals: IRGlobal[] = [...prelude.globals, ...userMod.globals]

    // ── 2. Type section dedup (first-seen order: imports → funcs) ─────────
    const typeSigs: FuncSig[] = []
    const typeMap = new Map<string, number>()

    function internSig(sig: FuncSig): number {
        const key = sigKey(sig)
        let idx = typeMap.get(key)
        if (idx === undefined) {
            idx = typeSigs.length
            typeSigs.push(sig)
            typeMap.set(key, idx)
        }
        return idx
    }

    for (const imp of allImports) internSig(importSig(imp))
    for (const f of allFunctions) internSig(funcSig(f))

    // ── 3. Function index space ───────────────────────────────────────────
    const funcNameToIdx = new Map<string, number>()
    for (let i = 0; i < allImports.length; i++) {
        funcNameToIdx.set(allImports[i].name, i)
    }
    const baseIdx = allImports.length
    for (let i = 0; i < allFunctions.length; i++) {
        funcNameToIdx.set(allFunctions[i].name, baseIdx + i)
    }

    // ── 4. Global index space ─────────────────────────────────────────────
    const globalNameToIdx = new Map<string, number>()
    for (let i = 0; i < allGlobals.length; i++) {
        globalNameToIdx.set(allGlobals[i].name, i)
    }

    // ── 5. Build emit context ─────────────────────────────────────────────
    const ctx: EmitCtx = {
        typeIdxOf: (sig) => {
            const idx = typeMap.get(sigKey(sig))
            if (idx === undefined) throw new Error(`Missing type: ${sigKey(sig)}`)
            return idx
        },
        funcIdxOf: (name) => {
            const idx = funcNameToIdx.get(name)
            if (idx === undefined) throw new Error(`Unknown function: ${name}`)
            return idx
        },
        globalIdxOf: (name) => {
            const idx = globalNameToIdx.get(name)
            if (idx === undefined) throw new Error(`Unknown global: ${name}`)
            return idx
        },
        depthStack: [],
    }

    // ── 6. Assemble sections ──────────────────────────────────────────────
    const out = new WasmBuffer()

    // Magic + version
    out.raw([0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00])

    // Section 1: Type
    out.section(1, buildTypeSection(typeSigs))

    // Section 2: Import (only if there are imports)
    if (allImports.length > 0) {
        out.section(2, buildImportSection(allImports, ctx.typeIdxOf))
    }

    // Section 3: Function
    out.section(3, buildFunctionSection(allFunctions, ctx.typeIdxOf))

    // Section 5: Memory
    out.section(5, buildMemorySection(prelude.memoryPages))

    // Section 6: Global
    if (allGlobals.length > 0) {
        out.section(6, buildGlobalSection(allGlobals, ctx))
    }

    // Section 7: Export
    const allFuncExports = [...prelude.funcExports, ...userMod.exports.filter(e => e.what === 'func')]
    out.section(7, buildExportSection(true, allFuncExports, [], ctx.funcIdxOf))

    // Section 10: Code
    out.section(10, buildCodeSection(allFunctions, prelFunctions.length, ctx))

    // Section 11: Data (only if non-empty)
    if (userMod.dataSegments.length > 0) {
        out.section(11, buildDataSection(userMod.dataSegments))
    }

    return out.toUint8Array()
}
