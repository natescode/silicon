/**
 * IR Lowering: Typed AST → IRModule
 *
 * Walks the type-checked AST and builds a fully-typed IR tree. Every
 * expression node in the output carries its `wasmType` derived from the
 * type checker's `inferredType` field — no sniffing of compiled WAT output.
 *
 * Key improvement over the Ohm codegen:
 *   Float arithmetic is resolved here using `inferredType`, not by inspecting
 *   whether the compiled WAT substring contains "f32.const". For example,
 *   `a + b` where both are Float produces `IRBinOp { instr: 'f32.add' }`,
 *   decided by the actual SiliconType, not string patterns.
 */

import { wasmTypeOf } from '../types/types'
import { type SiliconType, TypeUnknown } from '../types/types'
import { type ElaboratorRegistry, lookupTypedOperator, lookupKeyword, lookupTypedKeyword, lookupDefKindEntry } from '../elaborator/registry'
import { getWasmIntrinsic } from '../intrinsics'
import type { FunctionSig } from '../types/typechecker'
import type {
    WasmValType, WasmType,
    IRModule, IRFunction, IRGlobal, IRImport, IRDataSegment, IRExport,
    IRExpr, IRStmt, IRParam, IRLocal,
    IRConst, IRLocalGet, IRGlobalGet, IRBinOp, IRCall,
    IRBlock, IRIf, IRLoop, IRBreak, IRContinue, IRNop, IRUnreachable, IRExprStmt,
} from './nodes'

// ---------------------------------------------------------------------------
// Lowering context
// ---------------------------------------------------------------------------

interface LowerCtx {
    /** Current function's params and @local vars → wasmType. */
    locals: Map<string, WasmValType>
    /** Module-level globals (@var, sum type variants) → wasmType. */
    globals: Map<string, WasmValType>
    /** Names that are actual WAT globals (@var / sum-type variants), not zero-arg functions. */
    varNames: Set<string>
    /** Known function signatures from the type checker. */
    functions: Map<string, FunctionSig>
    /** Strata registry for operator → WASM instruction lookup. */
    registry: ElaboratorRegistry
    /** Stack of active loop IDs — for @break / @continue. */
    loopStack: number[]
    /** Monotonically increasing loop counter for unique labels. */
    loopCount: { n: number }
    /** @local declarations collected during the current function body walk. */
    pendingLocals: IRLocal[]
    /** String literal allocator state (shared across the module). */
    strings: StringAlloc
}

interface StringAlloc {
    nextOffset: number
    segments: IRDataSegment[]
    /** Deduplication: string content → base address. */
    cache: Map<string, number>
}

function createStringAlloc(): StringAlloc {
    return { nextOffset: 4, segments: [], cache: new Map() }
}

/** Allocate a string in the static data region; returns its base address. */
function allocString(sa: StringAlloc, s: string): number {
    if (sa.cache.has(s)) return sa.cache.get(s)!
    const bytes = new TextEncoder().encode(s)
    const base = sa.nextOffset
    const len = bytes.length
    const lenBytes = [len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >> 24) & 0xff]
    const all = [...lenBytes, ...bytes]
    const encoded = all.map(b => {
        if (b >= 0x20 && b <= 0x7e && b !== 0x22 && b !== 0x5c) return String.fromCharCode(b)
        return '\\' + b.toString(16).padStart(2, '0')
    }).join('')
    sa.segments.push({ offset: base, encoded })
    sa.nextOffset += 4 + len
    sa.cache.set(s, base)
    return base
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class IRLowerError extends Error {
    constructor(msg: string) { super(`[IR lower] ${msg}`) }
}

/**
 * Lower a type-checked Silicon program to an IRModule.
 * The `program` must have been through the type checker so that expression
 * nodes carry `inferredType`.
 */
export function lowerProgram(
    program: any,
    registry: ElaboratorRegistry,
    functionSigs: Map<string, FunctionSig>,
): IRModule {
    const ctx: LowerCtx = {
        locals: new Map(),
        globals: new Map(),
        varNames: new Set(),
        functions: functionSigs,
        registry,
        loopStack: [],
        loopCount: { n: 0 },
        pendingLocals: [],
        strings: createStringAlloc(),
    }

    const imports: IRImport[] = []
    const globals: IRGlobal[] = []
    const functions: IRFunction[] = []
    const irExports: IRExport[] = []

    // Pre-scan for global definitions so forward references resolve.
    for (const el of program.elements as any[]) {
        const node = unwrap(el)
        if (!node || node.type !== 'Definition') continue
        const hook = node.hook
        if (hook === 'global') {
            const name = watId(node.name?.name ?? '')
            ctx.globals.set(name, 'i32') // refined below
            ctx.varNames.add(name)
        }
        if (hook === 'type_sum') {
            // Sum type variants are i32 globals.
            extractSumVariants(node).forEach(v => {
                const vname = watId(v)
                ctx.globals.set(vname, 'i32')
                ctx.varNames.add(vname)
            })
        }
    }

    for (const el of program.elements as any[]) {
        const node = unwrap(el)
        if (!node) continue

        if (node.type === 'Definition') {
            const result = lowerDefinition(node, ctx)
            if (result) {
                if (result.kind === 'Function') functions.push(result)
                else if (result.kind === 'Global') globals.push(result)
                else if (result.kind === 'Import') imports.push(result)
                else if (result.kind === 'Export') irExports.push(result)
                else if (Array.isArray(result)) {
                    // Sum type: multiple globals
                    for (const g of result) globals.push(g)
                }
            }
        }
    }

    // Collect top-level non-definition expression statements into $__start.
    const startCtx: LowerCtx = {
        ...ctx,
        locals: new Map(),
        pendingLocals: [],
        loopStack: [],
    }
    const startStmts: IRStmt[] = []
    for (const el of program.elements as any[]) {
        const node = unwrap(el)
        if (!node || node.type === 'Definition' || node.type === 'Elaboration') continue
        const stmt = lowerAsStmt(node, startCtx)
        if (stmt) startStmts.push(stmt)
    }
    if (startStmts.length > 0) {
        functions.push({
            kind: 'Function',
            name: '__start',
            params: [],
            returnType: 'void',
            locals: startCtx.pendingLocals,
            body: { kind: 'Block', wasmType: 'void', stmts: startStmts },
        })
    }

    return {
        kind: 'Module',
        imports,
        globals,
        functions,
        dataSegments: ctx.strings.segments,
        exports: irExports,
    }
}

// ---------------------------------------------------------------------------
// Unwrap wrapper nodes from the flat AST
// ---------------------------------------------------------------------------

function unwrap(node: any): any {
    if (!node) return null
    // The flat AST from toAst.ts has no Element/Item/Statement wrappers,
    // but the wrapped shape (from ASTFactory in tests) does. Handle both.
    if (node.type === 'Element') return unwrap(node.value)
    if (node.type === 'Item') return unwrap(node.value)
    if (node.type === 'Statement') return unwrap(node.value)
    return node
}

// ---------------------------------------------------------------------------
// Definition lowering
// ---------------------------------------------------------------------------

function lowerDefinition(node: any, ctx: LowerCtx): any {
    const hook = node.hook
    const name = watId(node.name?.name ?? '')

    switch (hook) {
        case 'function': return lowerFunction(node, name, ctx)
        case 'global':   return lowerGlobal(node, name, ctx)
        case 'extern':   return lowerExtern(node, name, ctx)
        case 'local':    return lowerLocalDef(node, name, ctx)
        case 'type_sum': return lowerSumType(node, name, ctx)
        case 'export':   return lowerExportDecl(node, name, ctx)
        // Type alias / distinct produce no WAT — handled by type checker.
        case 'type_alias':
        case 'type_distinct':
            return null
        default:
            throw new IRLowerError(`Unknown definition keyword: ${node.keyword ?? hook}`)
    }
}

function lowerFunction(node: any, name: string, ctx: LowerCtx): IRFunction {
    const params: IRParam[] = []
    const paramLocals: Map<string, WasmValType> = new Map()

    for (const p of node.params || []) {
        if (p.isLiteral || !p.typeAnnotation) continue
        const wt = siliconTypeNameToWasm(p.typeAnnotation.typename)
        const pname = watId(p.name)
        params.push({ name: pname, wasmType: wt })
        paramLocals.set(pname, wt)
    }

    // Determine return type.
    let returnType: WasmType = 'void'
    if (node.name?.typeAnnotation?.typename) {
        returnType = siliconTypeNameToWasm(node.name.typeAnnotation.typename)
    } else {
        const sig = ctx.functions.get(name)
        if (sig && sig.result.kind !== 'Unknown') {
            returnType = wasmTypeOf(sig.result) as WasmType
        }
    }

    const childCtx: LowerCtx = {
        ...ctx,
        locals: new Map([...ctx.locals, ...paramLocals]),
        pendingLocals: [],
        loopStack: [],
    }

    let body: IRExpr | undefined
    const binding = Array.isArray(node.binding) ? node.binding[0] : node.binding
    if (binding) {
        const expr = binding.expression ?? binding
        body = lowerExpr(expr, childCtx)
        // Refine return type from inferred if not annotated.
        if (returnType === 'void' && body) {
            const bt = exprWasmType(body)
            if (bt !== 'void') returnType = bt
        }
    }

    ctx.globals.set(name, 'i32') // function pointers are i32 (table index)

    return {
        kind: 'Function',
        name,
        params,
        returnType,
        locals: childCtx.pendingLocals,
        body,
    }
}

function lowerGlobal(node: any, name: string, ctx: LowerCtx): IRGlobal {
    let wasmType: WasmValType = 'i32'
    if (node.name?.typeAnnotation?.typename) {
        wasmType = siliconTypeNameToWasm(node.name.typeAnnotation.typename)
    }

    const binding = Array.isArray(node.binding) ? node.binding[0] : node.binding
    let init: IRExpr = { kind: 'Const', wasmType, value: 0 }
    if (binding) {
        const expr = binding.expression ?? binding
        init = lowerExpr(expr, ctx)
        // Refine wasmType from the init expression.
        const it = exprWasmType(init)
        if (it !== 'void') wasmType = it
    }

    ctx.globals.set(name, wasmType)
    ctx.varNames.add(name)
    return { kind: 'Global', name, wasmType, mutable: true, init }
}

function lowerExtern(node: any, name: string, ctx: LowerCtx): IRImport {
    const params: WasmValType[] = []
    for (const p of node.params || []) {
        if (p.isLiteral || !p.typeAnnotation) continue
        params.push(siliconTypeNameToWasm(p.typeAnnotation.typename))
    }
    let result: WasmValType | undefined
    if (node.name?.typeAnnotation?.typename) {
        result = siliconTypeNameToWasm(node.name.typeAnnotation.typename)
    }
    return { kind: 'Import', env: 'env', field: name, name, params, result }
}

function lowerLocalDef(node: any, name: string, ctx: LowerCtx): null {
    // @local inside a function body: collect declaration, emit LocalSet stmt.
    let wasmType: WasmValType = 'i32'
    if (node.name?.typeAnnotation?.typename) {
        wasmType = siliconTypeNameToWasm(node.name.typeAnnotation.typename)
    }
    ctx.pendingLocals.push({ name, wasmType })
    ctx.locals.set(name, wasmType)

    // The initialiser is emitted as an IRLocalSet when we process the block stmt.
    // We return null here; the block lowering will emit it as an IRExprStmt wrapping
    // an IRLocalSet when it encounters the definition in its item list.
    return null
}

function lowerSumType(node: any, name: string, ctx: LowerCtx): IRGlobal[] {
    const variants = extractSumVariants(node)
    return variants.map((v, i) => {
        const gname = watId(v)
        ctx.globals.set(gname, 'i32')
        ctx.varNames.add(gname)
        const init: IRConst = { kind: 'Const', wasmType: 'i32', value: i }
        return { kind: 'Global' as const, name: gname, wasmType: 'i32' as const, mutable: false, init }
    })
}

function lowerExportDecl(_node: any, name: string, ctx: LowerCtx): IRExport {
    // @export foo; — determine whether `foo` is a global or a function.
    const what: 'func' | 'global' = ctx.varNames.has(name) ? 'global' : 'func'
    return { kind: 'Export', alias: name, internalName: name, what }
}

// ---------------------------------------------------------------------------
// Expression lowering
// ---------------------------------------------------------------------------

function lowerExpr(node: any, ctx: LowerCtx): IRExpr {
    if (!node || typeof node !== 'object') return nop()

    // Unwrap wrapper nodes.
    const n = unwrap(node)
    if (!n) return nop()

    switch (n.type) {
        case 'IntLiteral':
            return { kind: 'Const', wasmType: 'i32', value: parseIntLiteral(n) }

        case 'FloatLiteral':
            return { kind: 'Const', wasmType: 'f32', value: parseFloat(n.value) }

        case 'BooleanLiteral':
            return { kind: 'Const', wasmType: 'i32', value: n.value ? 1 : 0 }

        case 'StringLiteral': {
            const addr = allocString(ctx.strings, n.value)
            return { kind: 'Const', wasmType: 'i32', value: addr }
        }

        case 'Namespace':
            return lowerNamespace(n, ctx)

        case 'BinaryOp':
            return lowerBinaryOp(n, ctx)

        case 'FunctionCall':
            return lowerFunctionCall(n, ctx)

        case 'Block':
            return lowerBlock(n, ctx)

        case 'Binding':
            return lowerExpr(n.expression, ctx)

        // Definition inside a block body (e.g. @local).
        case 'Definition':
            return lowerDefinitionAsExpr(n, ctx)

        // Assignment inside an expression context — lower as local/global set + Nop result.
        case 'Assignment':
            return lowerAssignmentAsExpr(n, ctx)

        // Literal wrappers.
        case 'Literal':
        case 'ExpressionStart':
        case 'ExpressionEnd':
            return lowerExpr(n.value, ctx)

        case 'ArrayLiteral':
            return lowerArrayLiteral(n, ctx)

        default:
            return nop()
    }
}

function lowerNamespace(n: any, ctx: LowerCtx): IRExpr {
    const path: string[] = n.path ?? []
    // Join path then apply watId so Color::Red → Color_Red, matching how globals are keyed.
    const key = watId(path.join('::'))

    if (ctx.locals.has(key)) {
        return { kind: 'LocalGet', wasmType: ctx.locals.get(key)!, name: key }
    }
    // @var and sum-type variant globals take priority over zero-arg function calls.
    // The type checker registers every definition in functionSigs (including @var),
    // so we must distinguish actual WAT globals via varNames before consulting functions.
    if (ctx.varNames.has(key)) {
        return { kind: 'GlobalGet', wasmType: ctx.globals.get(key) ?? 'i32', name: key }
    }
    // Zero-arg function call (single-segment name, no args).
    if (path.length === 1) {
        const sig = ctx.functions.get(key)
        if (sig && sig.params.length === 0) {
            const wt = (wasmTypeOf(sig.result) as WasmType) ?? 'void'
            return { kind: 'Call', wasmType: wt, callee: key, callKind: 'user', args: [] }
        }
    }
    if (ctx.globals.has(key)) {
        return { kind: 'GlobalGet', wasmType: ctx.globals.get(key)!, name: key }
    }
    // Fall back to global.get (may be a forward reference).
    const inferT = n.inferredType as SiliconType | undefined
    const wt: WasmValType = (inferT && inferT.kind !== 'Unknown') ? (wasmTypeOf(inferT) as WasmValType) : 'i32'
    return { kind: 'GlobalGet', wasmType: wt, name: key }
}

function lowerBinaryOp(n: any, ctx: LowerCtx): IRExpr {
    const op: string = n.operator
    const left = lowerExpr(n.left, ctx)
    const right = lowerExpr(n.right, ctx)

    const inferT = n.inferredType as SiliconType | undefined
    const resultWt: WasmValType = (inferT && inferT.kind !== 'Unknown')
        ? (wasmTypeOf(inferT) as WasmValType)
        : exprWasmType(left)

    // Bitwise ops are always i32; other ops follow the operand type.
    const isBitwise = ['|', '^', '<<', '>>'].includes(op)
    const leftWt = exprWasmType(left)
    const typeKind = (isBitwise || leftWt !== 'f32') ? 'Int' : 'Float'

    // Resolve the operator stratum once; dispatch on its intrinsic rather than the symbol.
    const stratum = lookupTypedOperator(ctx.registry, op, typeKind)
    const intrinsic = stratum?.data?.intrinsic
    if (!intrinsic) throw new IRLowerError(`No stratum registered for operator '${op}'`)

    // Control-flow operators: || maps to WASM::control_or (short-circuit evaluation).
    if (intrinsic === 'WASM::control_or') {
        return {
            kind: 'If',
            wasmType: 'i32',
            cond: left,
            then: { kind: 'Const', wasmType: 'i32', value: 1 },
            else_: right,
        }
    }

    const intr = getWasmIntrinsic(intrinsic)
    if (!intr) throw new IRLowerError(`No WasmIntrinsic for '${intrinsic}'`)

    const primary: IRExpr = { kind: 'BinOp', wasmType: resultWt, instr: intr.wasmInstr, left, right }

    // Multi-step strata: first step is the BinOp; subsequent steps chain on the stack.
    const template = stratum.data?.bodyTemplate ?? []
    const extraSteps = template.length > 1 ? template.slice(1) : []
    if (extraSteps.length === 0) return primary

    const stmts: IRStmt[] = [{ kind: 'ExprStmt', expr: primary }]
    let lastWt: WasmType = resultWt
    for (const step of extraSteps) {
        const stepIntr = getWasmIntrinsic(step.intrinsic)
        if (!stepIntr) throw new IRLowerError(`No WasmIntrinsic for extra step '${step.intrinsic}'`)
        lastWt = step.intrinsic.includes('f32') ? 'f32' : 'i32'
        stmts.push({ kind: 'ExprStmt', expr: { kind: 'Call', wasmType: lastWt as WasmValType, callee: stepIntr.wasmInstr, callKind: 'instr', args: [] } })
    }
    const trailing = (stmts.pop() as IRExprStmt).expr
    return { kind: 'Block', wasmType: lastWt, stmts, trailing }
}

function lowerFunctionCall(n: any, ctx: LowerCtx): IRExpr {
    const name = callName(n)

    if (n.isBuiltin) {
        return lowerBuiltinCall(name, n.args || [], ctx, n.inferredType)
    }

    // WASM intrinsic direct call (e.g. &WASM::i32_add 1, 2).
    if (name.startsWith('WASM::')) {
        const intr = getWasmIntrinsic(name)
        const args = (n.args || []).map((a: any) => lowerExpr(a, ctx))
        if (intr?.emitStructured) {
            // Structured intrinsics (cast, etc.) are emitted via a call node
            // with callKind 'instr' so the emitter can use the wasmInstr.
            const inferT = n.inferredType as SiliconType | undefined
            const wt = resolveWasmType(inferT, 'i32')
            return { kind: 'Call', wasmType: wt, callee: intr.wasmInstr, callKind: 'instr', args }
        }
        const inferT = n.inferredType as SiliconType | undefined
        const wt = resolveWasmType(inferT, 'i32')
        return { kind: 'Call', wasmType: wt, callee: intr?.wasmInstr ?? name, callKind: 'instr', args }
    }

    // User-defined function call.
    const watName = watId(name)
    const args = (n.args || []).map((a: any) => lowerExpr(a, ctx))
    const sig = ctx.functions.get(watName)
    const wt: WasmType = sig
        ? (wasmTypeOf(sig.result) as WasmType) ?? 'void'
        : resolveWasmType(n.inferredType as SiliconType | undefined, 'void')
    return { kind: 'Call', wasmType: wt, callee: watName, callKind: 'user', args }
}

function lowerBuiltinCall(name: string, rawArgs: any[], ctx: LowerCtx, inferredType?: any): IRExpr {
    // Typed dispatch: try the first arg's type kind, fall back to the untyped entry.
    const firstArgKind: string = (rawArgs[0] as any)?.inferredType?.kind ?? 'Int'
    const kwEntry = lookupTypedKeyword(ctx.registry, name, firstArgKind) ?? lookupKeyword(ctx.registry, name)
    const intrinsic = kwEntry?.data?.intrinsic ?? ''

    switch (intrinsic) {
        case 'WASM::control_if': {
            const [condN, thenN, elseN] = rawArgs
            const cond = lowerExpr(condN, ctx)
            const then = lowerExpr(thenN, ctx)
            const else_ = elseN ? lowerExpr(elseN, ctx) : undefined
            const wt = else_ ? exprWasmType(then) : 'void'
            return { kind: 'If', wasmType: wt, cond, then, else_ }
        }

        case 'WASM::control_loop': {
            const [condN, bodyN] = rawArgs
            const id = ctx.loopCount.n++
            ctx.loopStack.push(id)
            const cond = lowerExpr(condN, ctx)
            const body = lowerExpr(bodyN, ctx)
            ctx.loopStack.pop()
            return { kind: 'Loop', id, cond, body }
        }

        case 'WASM::control_break': {
            const id = ctx.loopStack.at(-1)
            if (id === undefined) throw new IRLowerError('@break outside @loop')
            return { kind: 'Break', id }
        }

        case 'WASM::control_continue': {
            const id = ctx.loopStack.at(-1)
            if (id === undefined) throw new IRLowerError('@continue outside @loop')
            return { kind: 'Continue', id }
        }

        case 'WASM::control_return': {
            const value = rawArgs[0] ? lowerExpr(rawArgs[0], ctx) : undefined
            return { kind: 'Return', value }
        }

        case 'WASM::control_and': {
            const [leftN, rightN] = rawArgs
            const left = lowerExpr(leftN, ctx)
            const right = lowerExpr(rightN, ctx)
            return { kind: 'If', wasmType: 'i32', cond: left, then: right, else_: { kind: 'Const', wasmType: 'i32', value: 0 } }
        }

        case 'WASM::control_or': {
            const [leftN, rightN] = rawArgs
            const left = lowerExpr(leftN, ctx)
            const right = lowerExpr(rightN, ctx)
            return { kind: 'If', wasmType: 'i32', cond: left, then: { kind: 'Const', wasmType: 'i32', value: 1 }, else_: right }
        }

        case 'WASM::control_match': {
            return lowerMatchCall(rawArgs, ctx, inferredType)
        }

        default: {
            // Generic builtin (e.g. @toInt, @toFloat, user-defined keyword strata).
            const intr = intrinsic ? getWasmIntrinsic(intrinsic) : undefined
            const args = rawArgs.map((a: any) => lowerExpr(a, ctx))
            const wt = resolveWasmType(inferredType as SiliconType | undefined,
                intr ? (intrinsic.includes('f32') ? 'f32' : 'i32') : 'i32')
            if (intr?.emitStructured) {
                return { kind: 'Call', wasmType: wt, callee: intr.wasmInstr, callKind: 'instr', args }
            }
            if (intr) {
                return { kind: 'Call', wasmType: wt, callee: intr.wasmInstr, callKind: 'instr', args }
            }
            // Unknown builtin — call by name.
            const kwName = watId(name.replace(/^@/, ''))
            return { kind: 'Call', wasmType: wt, callee: kwName, callKind: 'user', args }
        }
    }
}

function lowerMatchCall(rawArgs: any[], ctx: LowerCtx, inferredType?: any): IRExpr {
    // @match disc, pat0, res0, pat1, res1, ...
    // Builds nested if/then/else: if disc==pat0 then res0 else (if disc==pat1 ...)
    if (rawArgs.length < 3) return nop()

    const discExpr = lowerExpr(rawArgs[0], ctx)
    const wt = resolveWasmType(inferredType as SiliconType | undefined, 'i32')

    function buildNested(i: number): IRExpr {
        if (i + 1 >= rawArgs.length) return { kind: 'Nop' }
        const pat = lowerExpr(rawArgs[i], ctx)
        const res = lowerExpr(rawArgs[i + 1], ctx)
        const eqInstr = exprWasmType(discExpr) === 'f32' ? 'f32.eq' : 'i32.eq'
        const cond: IRBinOp = {
            kind: 'BinOp',
            wasmType: 'i32',
            instr: eqInstr,
            left: discExpr,
            right: pat,
        }
        // If there are more arms, recurse; otherwise emit unreachable as the final else.
        const else_: IRExpr = i + 2 < rawArgs.length
            ? buildNested(i + 2)
            : { kind: 'Unreachable' }
        return { kind: 'If', wasmType: wt, cond, then: res, else_ }
    }

    return buildNested(1)
}

function lowerBlock(n: any, ctx: LowerCtx): IRExpr {
    const stmts: IRStmt[] = []

    for (const item of n.items || []) {
        const unwrapped = unwrap(item)
        if (!unwrapped) continue
        const stmt = lowerAsStmt(unwrapped, ctx)
        if (stmt) stmts.push(stmt)
    }

    let trailing: IRExpr | undefined
    if (n.trailing) {
        trailing = lowerExpr(n.trailing, ctx)
    }

    const wt: WasmType = trailing ? exprWasmType(trailing) : 'void'
    return { kind: 'Block', wasmType: wt, stmts, trailing }
}

function lowerAsStmt(node: any, ctx: LowerCtx): IRStmt | null {
    if (!node) return null

    if (node.type === 'Assignment') {
        const target = (node.target?.path ?? []).map(watId).join('::')
        const value = lowerExpr(node.value, ctx)
        if (ctx.locals.has(target)) return { kind: 'LocalSet', name: target, value }
        return { kind: 'GlobalSet', name: target, value }
    }

    if (node.type === 'Definition' && node.hook === 'global') {
        // @var inside a function body: treat as a mutable local variable.
        const name = watId(node.name?.name ?? '')
        let wasmType: WasmValType = 'i32'
        if (node.name?.typeAnnotation?.typename) {
            wasmType = siliconTypeNameToWasm(node.name.typeAnnotation.typename)
        }
        ctx.pendingLocals.push({ name, wasmType })
        ctx.locals.set(name, wasmType)
        const binding = Array.isArray(node.binding) ? node.binding[0] : node.binding
        const expr = binding?.expression ?? binding
        if (expr) {
            const value = lowerExpr(expr, ctx)
            const it = exprWasmType(value)
            if (it !== 'void') {
                ctx.locals.set(name, it)
                const existing = ctx.pendingLocals.find(l => l.name === name)
                if (existing) existing.wasmType = it
            }
            return { kind: 'LocalSet', name, value }
        }
        return null
    }

    if (node.type === 'Definition' && node.hook === 'local') {
        const name = watId(node.name?.name ?? '')
        let wasmType: WasmValType = 'i32'
        if (node.name?.typeAnnotation?.typename) {
            wasmType = siliconTypeNameToWasm(node.name.typeAnnotation.typename)
        }
        ctx.pendingLocals.push({ name, wasmType })
        ctx.locals.set(name, wasmType)

        const binding = Array.isArray(node.binding) ? node.binding[0] : node.binding
        const expr = binding?.expression ?? binding
        if (expr) {
            const value = lowerExpr(expr, ctx)
            // Refine type from init if not annotated.
            const it = exprWasmType(value)
            if (it !== 'void') {
                ctx.locals.set(name, it)
                const existing = ctx.pendingLocals.find(l => l.name === name)
                if (existing) existing.wasmType = it
            }
            return { kind: 'LocalSet', name, value }
        }
        return null
    }

    // Expression statement — lower and discard value.
    const expr = lowerExpr(node, ctx)
    if (expr.kind === 'Nop') return null
    return { kind: 'ExprStmt', expr }
}

function lowerDefinitionAsExpr(node: any, ctx: LowerCtx): IRExpr {
    // Definition inside a block body: treat as void.
    lowerAsStmt(node, ctx) // side-effects on ctx (adds to pendingLocals, locals)
    return nop()
}

function lowerAssignmentAsExpr(node: any, ctx: LowerCtx): IRExpr {
    const stmt = lowerAsStmt(node, ctx)
    if (!stmt) return nop()
    // Wrap as a void ExprStmt and return Nop so the block doesn't count it as trailing.
    return nop()
}

function lowerArrayLiteral(n: any, ctx: LowerCtx): IRExpr {
    const count = (n.elements || []).length
    const elemExprs = (n.elements || []).map((e: any) => lowerExpr(e, ctx))
    // Inline the alloc_array pattern as an IRCall chain.
    // This mirrors the Ohm codegen's ArrayLiteral handler.
    // For the IR, we represent it as a raw WAT block via a special Call node.
    // Full array IR lowering is deferred — emit as a placeholder.
    const allocArgs: IRExpr[] = [
        { kind: 'Const', wasmType: 'i32', value: count },
        { kind: 'Const', wasmType: 'i32', value: 4 },
    ]
    // We'll build the array block in emit.ts for now.
    // Store elem exprs as extra args so emitter can use them.
    return {
        kind: 'Call',
        wasmType: 'i32',
        callee: '__array_literal',
        callKind: 'user',
        args: [...allocArgs, ...elemExprs],
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nop(): IRNop { return { kind: 'Nop' } }

function exprWasmType(e: IRExpr): WasmType {
    switch (e.kind) {
        case 'Const':    return e.wasmType
        case 'LocalGet': return e.wasmType
        case 'GlobalGet': return e.wasmType
        case 'BinOp':   return e.wasmType
        case 'Call':    return e.wasmType
        case 'Block':   return e.wasmType
        case 'If':      return e.wasmType
        case 'Loop':        return 'void'
        case 'Break':       return 'void'
        case 'Continue':    return 'void'
        case 'Return':      return 'void'
        case 'Nop':         return 'void'
        case 'Unreachable': return 'void'
    }
}

function resolveWasmType(t: SiliconType | undefined, fallback: WasmType): WasmType {
    if (!t || t.kind === 'Unknown') return fallback
    return wasmTypeOf(t) as WasmType
}


function callName(n: any): string {
    if (typeof n.name === 'string') return n.name
    if (n.name?.path) return (n.name.path as string[]).join('::')
    return ''
}

function siliconTypeNameToWasm(typename: string): WasmValType {
    return typename === 'Float' ? 'f32' : 'i32'
}

/** Convert a Silicon identifier to a safe WAT identifier (:: → _). */
function watId(s: string): string {
    return s.replace(/::/g, '_')
}

/** Extract sum-type variant full names (e.g. 'Color::Red') from a @type_sum def. */
function extractSumVariants(node: any): string[] {
    const binding = Array.isArray(node.binding) ? node.binding[0] : node.binding
    const expr = binding?.expression ?? binding
    const typeName = node.name?.name ?? ''

    function collect(e: any): string[] {
        if (!e) return []
        if (e.expression) return collect(e.expression)
        if (e.value && e.type !== 'BinaryOp') return collect(e.value)
        if (e.type === 'BinaryOp' && e.operator === '|') {
            return [...collect(e.left), ...collect(e.right)]
        }
        if (e.type === 'Namespace' && e.path?.length > 0) {
            return [`${typeName}::${e.path[e.path.length - 1]}`]
        }
        return []
    }
    return collect(expr)
}

function parseIntLiteral(n: any): number {
    const raw: string = n.value ?? '0'
    const cleaned = raw.replace(/_/g, '')
    if (cleaned.startsWith('0b') || cleaned.startsWith('0B')) return parseInt(cleaned.slice(2), 2)
    if (cleaned.startsWith('0x') || cleaned.startsWith('0X')) return parseInt(cleaned.slice(2), 16)
    if (cleaned.startsWith('0o') || cleaned.startsWith('0O')) return parseInt(cleaned.slice(2), 8)
    return parseInt(cleaned, 10)
}
