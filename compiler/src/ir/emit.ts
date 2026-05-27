/**
 * IR → WAT Emission
 *
 * Walks an IRModule tree and emits a WebAssembly Text Format string.
 * No type sniffing: every expression node carries its `wasmType` from the
 * IR lowerer, so instruction selection and result-type declarations are exact.
 */

import type {
    IRModule, IRFunction, IRGlobal, IRImport, IRDataSegment, IRExport,
    IRExpr, IRStmt, IRBlock, IRConst, WasmType, WasmValType, AbstractOp,
} from './nodes'
import { ARRAY_LITERAL_CALLEE } from './nodes'
import { wasmIntrinsics } from '../intrinsics/intrinsics'

/** Map an AbstractOp to its WAT instruction string via the intrinsics registry. */
function abstractOpToWat(op: AbstractOp): string {
    return wasmIntrinsics[op]?.wasmInstr ?? op.replace('_', '.')
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Emit a complete WAT module string from an IRModule.
 * `stdWat` is the Silicon runtime (std.wat) inlined verbatim after the module
 * open — identical to the Ohm codegen's approach.
 */
export function emitModule(mod: IRModule, stdWat: string): string {
    const parts: string[] = ['(module']

    for (const imp of mod.imports) parts.push(emitImport(imp))
    parts.push(stdWat)
    // Phase 5 Workstream B — funcref table declarations.  Emitted only
    // when at least one `@fnref` / `@call_indirect` was used (the field
    // is absent otherwise, preserving byte-equal emission for non-funcref
    // programs).  Signatures and entries are emitted independently so a
    // function body containing `@call_indirect` still compiles even
    // when the program doesn't call `@fnref` (e.g. a stdlib `vec_map`
    // that's defined but never invoked from user code).
    if (mod.funcrefTable) {
        for (const sig of mod.funcrefTable.signatures) {
            const params = sig.params.map(p => `(param ${p})`).join(' ')
            const result = sig.result !== 'void' ? `(result ${sig.result})` : ''
            const header = [params, result].filter(Boolean).join(' ')
            parts.push(`(type $${sig.key} (func ${header}))`)
        }
        // Table size: at least the number of entries.  Size 0 is valid
        // (a table that's declared but never indexed); call_indirect
        // through such a table would trap at runtime, which is the
        // correct semantics for "function with @call_indirect defined
        // but no callable target supplied."
        const tableSize = mod.funcrefTable.entries.length
        parts.push(`(table ${tableSize} funcref)`)
        if (tableSize > 0) {
            const elems = mod.funcrefTable.entries.map(n => `$${n}`).join(' ')
            parts.push(`(elem (i32.const 0) ${elems})`)
        }
    }
    for (const g of mod.globals)  parts.push(emitGlobal(g))
    for (const f of mod.functions) parts.push(emitFunction(f))
    for (const exp of mod.exports) parts.push(emitExplicitExport(exp))
    for (const ds of mod.dataSegments) parts.push(emitDataSegment(ds))

    parts.push(')')
    return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Module-level emitters
// ---------------------------------------------------------------------------

function emitImport(imp: IRImport): string {
    const params = imp.params.map(t => `(param ${t})`).join(' ')
    const result = imp.result ? `(result ${imp.result})` : ''
    const sig = [params, result].filter(Boolean).join(' ')
    return `(import "${imp.env}" "${imp.field}" (func $${imp.name} ${sig}))`
}

function emitGlobal(g: IRGlobal): string {
    const mutDecl = g.mutable ? `(mut ${g.wasmType})` : g.wasmType
    return `(global $${g.name} ${mutDecl} ${emitExpr(g.init)})`
}

function emitFunction(f: IRFunction): string {
    const params = f.params.map(p => `(param $${p.name} ${p.wasmType})`).join(' ')
    const result = f.returnType !== 'void' ? `(result ${f.returnType})` : ''
    // $addr is a scratch local required by array/string allocation helpers.
    const addrLocal = '(local $addr i32)'
    const userLocals = f.locals.map(l => `(local $${l.name} ${l.wasmType})`).join('\n')
    const preamble = [addrLocal, userLocals].filter(Boolean).join('\n')

    const bodyWat = f.body ? emitExpr(f.body) : ''
    const header = [params, result].filter(Boolean).join(' ')
    return `(func $${f.name} ${header}\n${preamble}\n${bodyWat}\n)`
}

function emitDataSegment(ds: IRDataSegment): string {
    return `(data (i32.const ${ds.offset}) "${ds.encoded}")`
}

function emitExplicitExport(exp: IRExport): string {
    const item = exp.what === 'global'
        ? `(global $${exp.internalName})`
        : `(func $${exp.internalName})`
    return `(export "${exp.alias}" ${item})`
}

// ---------------------------------------------------------------------------
// Expression emitters
// ---------------------------------------------------------------------------

export function emitExpr(e: IRExpr): string {
    switch (e.kind) {
        case 'Const':
            return `(${e.wasmType}.const ${e.value})`

        case 'LocalGet':
            return `(local.get $${e.name})`

        case 'GlobalGet':
            return `(global.get $${e.name})`

        case 'BinOp':
            return `(${abstractOpToWat(e.op)} ${emitExpr(e.left)} ${emitExpr(e.right)})`

        case 'Call':
            return emitCall(e)

        case 'CallIndirect': {
            // call_indirect WAT shape:
            //   (call_indirect (type $sig) ARG1 ARG2 ... INDEX)
            // Args come first in source order; the table index is last.
            const args = e.args.map(a => emitExpr(a)).join(' ')
            const idx = emitExpr(e.tableIndex)
            return `(call_indirect (type $${e.sigKey}) ${args} ${idx})`.replace(/\s+/g, ' ')
        }

        case 'Block':
            return emitBlock(e)

        case 'If':
            return emitIf(e)

        case 'Loop':
            return emitLoop(e)

        case 'Break':
            return `(br $brk_${e.id})`

        case 'Continue':
            return `(br $cont_${e.id})`

        case 'Return':
            return e.value ? `(return ${emitExpr(e.value)})` : '(return)'

        case 'Nop':
            return ''

        case 'Unreachable':
            return 'unreachable'

        // ── Phase 9d-3 — WasmGC instructions ──────────────────────────────
        case 'StructNew': {
            const args = e.args.map(emitExpr).join(' ')
            return args
                ? `(struct.new ${e.typeName} ${args})`
                : `(struct.new ${e.typeName})`
        }
        case 'StructGet': {
            const op = e.signed ? `struct.get_${e.signed}` : 'struct.get'
            return `(${op} ${e.typeName} ${e.fieldIdx} ${emitExpr(e.target)})`
        }
        case 'StructSet':
            return `(struct.set ${e.typeName} ${e.fieldIdx} ${emitExpr(e.target)} ${emitExpr(e.value)})`
        case 'ArrayNew':
            return `(array.new ${e.typeName} ${emitExpr(e.init)} ${emitExpr(e.size)})`
        case 'ArrayNewDefault':
            return `(array.new_default ${e.typeName} ${emitExpr(e.size)})`
        case 'ArrayGet': {
            const op = e.signed ? `array.get_${e.signed}` : 'array.get'
            return `(${op} ${e.typeName} ${emitExpr(e.target)} ${emitExpr(e.idx)})`
        }
        case 'ArraySet':
            return `(array.set ${e.typeName} ${emitExpr(e.target)} ${emitExpr(e.idx)} ${emitExpr(e.value)})`
        case 'ArrayLen':
            return `(array.len ${emitExpr(e.target)})`
        case 'ArrayCopy':
            return `(array.copy ${e.dstTypeName} ${e.srcTypeName} ${emitExpr(e.dstRef)} ${emitExpr(e.dstIdx)} ${emitExpr(e.srcRef)} ${emitExpr(e.srcIdx)} ${emitExpr(e.count)})`
    }
}

function emitCall(e: IRExpr & { kind: 'Call' }): string {
    if (e.callee === ARRAY_LITERAL_CALLEE) return emitArrayLiteral(e.args)

    const argWat = e.args.map(emitExpr).join('\n')
    const argStr = e.args.map(emitExpr).join(' ')
    if (e.callKind === 'instr') {
        // Inline WASM instruction in fully-folded form.
        return argStr ? `(${e.callee} ${argStr})` : `(${e.callee})`
    }
    // User function call.
    return argStr ? `(call $${e.callee} ${argStr})` : `(call $${e.callee})`
}

function emitBlock(b: IRExpr & { kind: 'Block' }): string {
    const stmtParts = b.stmts.map(emitStmt).filter(Boolean)
    const trailingWat = b.trailing ? emitExpr(b.trailing) : ''
    return [...stmtParts, trailingWat].filter(Boolean).join('\n')
}

function emitIf(e: IRExpr & { kind: 'If' }): string {
    const condWat = emitExpr(e.cond)
    const thenWat = emitExpr(e.then)
    if (e.else_) {
        const elseWat = emitExpr(e.else_)
        if (e.wasmType !== 'void') {
            return `(if (result ${e.wasmType})\n  ${condWat}\n  (then ${thenWat})\n  (else ${elseWat})\n)`
        }
        return `(if\n  ${condWat}\n  (then ${thenWat})\n  (else ${elseWat})\n)`
    }
    return `(if\n  ${condWat}\n  (then ${thenWat})\n)`
}

function emitLoop(e: IRExpr & { kind: 'Loop' }): string {
    const condWat = emitExpr(e.cond)
    const bodyWat = emitExpr(e.body)
    const id = e.id
    return [
        `(block $brk_${id}`,
        `  (loop $cont_${id}`,
        `    (br_if $brk_${id} (i32.eqz ${condWat}))`,
        `    ${bodyWat}`,
        `    (br $cont_${id})`,
        `  )`,
        `)`,
    ].join('\n')
}

function emitArrayLiteral(args: IRExpr[]): string {
    // args[0] = count (IRConst), args[1] = elemBytes (IRConst), args[2..] = elements
    const countWat = emitExpr(args[0])
    const elemBytesWat = emitExpr(args[1])
    const count = (args[0] as IRConst).value
    const elemExprs = args.slice(2)
    const stores = elemExprs.map((el, i) =>
        `(i32.store offset=${4 + i * 4} (local.get $addr) ${emitExpr(el)})`
    )
    return [
        `(block (result i32)`,
        `  (local.set $addr (call $alloc_array ${countWat} ${elemBytesWat}))`,
        ...stores.map(s => `  ${s}`),
        `  (local.get $addr)`,
        `)`,
    ].join('\n')
}

// ---------------------------------------------------------------------------
// Statement emitters
// ---------------------------------------------------------------------------

/** Mirror of ir/lower.ts's exprWasmType, restricted to the void test
 *  emitStmt needs.  Defined here to avoid a circular import. */
function isVoidIR(e: IRExpr): boolean {
    switch (e.kind) {
        case 'Loop':
        case 'Break':
        case 'Continue':
        case 'Return':
        case 'Nop':
        case 'Unreachable':
            return true
        case 'Block':
        case 'If':
        case 'Call':
        case 'CallIndirect':
        case 'BinOp':
        case 'Const':
        case 'LocalGet':
        case 'GlobalGet':
        // Phase 9d-3 — set/copy nodes carry wasmType: 'void' literally;
        // new/get/len nodes carry 'i32'.  The shared check works for all.
        case 'StructNew': case 'StructGet': case 'StructSet':
        case 'ArrayNew': case 'ArrayNewDefault': case 'ArrayGet':
        case 'ArraySet': case 'ArrayLen': case 'ArrayCopy':
            return (e as any).wasmType === 'void'
    }
}

export function emitStmt(s: IRStmt): string {
    switch (s.kind) {
        case 'LocalSet':
            return `(local.set $${s.name} ${emitExpr(s.value)})`
        case 'GlobalSet':
            return `(global.set $${s.name} ${emitExpr(s.value)})`
        case 'ExprStmt': {
            // Non-void expressions used as statements leak a value on the
            // WASM stack; insert an explicit (drop ...) so the module
            // validates.  Void calls (proc_exit, store, drop, structured
            // control flow like Loop/Break/Return) emit unchanged.
            const watExpr = emitExpr(s.expr)
            if (watExpr === '') return ''
            return isVoidIR(s.expr) ? watExpr : `(drop ${watExpr})`
        }
    }
}
