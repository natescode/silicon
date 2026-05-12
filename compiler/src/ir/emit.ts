/**
 * IR → WAT Emission
 *
 * Walks an IRModule tree and emits a WebAssembly Text Format string.
 * No type sniffing: every expression node carries its `wasmType` from the
 * IR lowerer, so instruction selection and result-type declarations are exact.
 */

import type {
    IRModule, IRFunction, IRGlobal, IRImport, IRDataSegment,
    IRExpr, IRStmt, IRBlock, WasmType, WasmValType,
} from './nodes'

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
    parts.push(stdWat)

    for (const imp of mod.imports) parts.push(emitImport(imp))
    for (const g of mod.globals)  parts.push(emitGlobal(g))
    for (const f of mod.functions) {
        parts.push(emitFunction(f))
        parts.push(`(export "${f.name}" (func $${f.name}))`)
    }
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
            return `${emitExpr(e.left)}\n${emitExpr(e.right)}\n${e.instr}`

        case 'Call':
            return emitCall(e)

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
            return e.value ? `${emitExpr(e.value)}\nreturn` : 'return'

        case 'Nop':
            return ''
    }
}

function emitCall(e: IRExpr & { kind: 'Call' }): string {
    if (e.callee === '__array_literal') return emitArrayLiteral(e.args)

    const argWat = e.args.map(emitExpr).join('\n')
    if (e.callKind === 'instr') {
        // Inline WASM instruction: push args then emit instruction.
        return argWat ? `${argWat}\n${e.callee}` : e.callee
    }
    // User function call.
    const argStr = e.args.map(a => emitExpr(a)).join(' ')
    return `(call $${e.callee} ${argStr})`
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
        `    (br_if $brk_${id} (i32.eqz`,
        `      ${condWat}`,
        `    ))`,
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
    const count = (args[0] as any).value as number
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

export function emitStmt(s: IRStmt): string {
    switch (s.kind) {
        case 'LocalSet':
            return `${emitExpr(s.value)}\nlocal.set $${s.name}`
        case 'GlobalSet':
            return `${emitExpr(s.value)}\nglobal.set $${s.name}`
        case 'ExprStmt':
            return emitExpr(s.expr)
    }
}
