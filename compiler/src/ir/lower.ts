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
import { type SiliconType } from '../types/types'
import { type ElaboratorRegistry, lookupTypedOperator, lookupKeyword, lookupTypedKeyword, lookupDefKindEntry } from '../elaborator/registry'
import { resolveIntrinsicWasmInstr } from '../intrinsics'
import type { FunctionSig } from '../types/typechecker'
import type { ModuleRegistry } from '../modules/registry'
import type {
    WasmValType, WasmType,
    IRModule, IRFunction, IRGlobal, IRImport, IRDataSegment, IRExport,
    IRExpr, IRStmt, IRParam, IRLocal,
    IRLocalGet, IRGlobalGet, IRCall,
    IRBlock, IRIf, IRLoop, IRBreak, IRContinue, IRNop, IRUnreachable, IRExprStmt,
} from './nodes'
import { ARRAY_LITERAL_CALLEE } from './nodes'
import { type CompilerAPI, type LowerFns, createCompilerAPI } from '../compiler-api'

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
    /** Module registry for namespace-qualified calls (web::*, Draw::*, etc.). */
    moduleRegistry?: ModuleRegistry
    /** Auto-generated imports from module calls — keyed by WAT name to deduplicate. */
    pendingImports: Map<string, IRImport>
    /** Stack of active loop IDs — for @break / @continue. */
    loopStack: number[]
    /** Monotonically increasing loop counter for unique labels. */
    loopCount: { n: number }
    /** @local declarations collected during the current function body walk. */
    pendingLocals: IRLocal[]
    /** String literal allocator state (shared across the module). */
    strings: StringAlloc
    /** Monotonic counter for $compiler.freshId() — synthetic identifier allocation. */
    freshIdCounter: { n: number }
    /** The $compiler API surface exposed to strata expanders. Set after ctx creation. */
    $compiler?: CompilerAPI
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

/** Allocate a string in the static data region; returns its base address.
 *  Strings are encoded as UTF-16 LE (2 bytes per code unit) so JS can decode
 *  them directly with TextDecoder('utf-16le'). The length prefix stores the
 *  byte count (byteLen = charCount * 2 for BMP characters). */
function allocString(sa: StringAlloc, s: string): number {
    if (sa.cache.has(s)) return sa.cache.get(s)!
    // UTF-16 LE: each JS char is one 16-bit code unit stored little-endian.
    const byteLen = s.length * 2
    const base = sa.nextOffset
    const charBytes: number[] = []
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i)
        charBytes.push(code & 0xff, (code >> 8) & 0xff)
    }
    const lenBytes = [byteLen & 0xff, (byteLen >> 8) & 0xff, (byteLen >> 16) & 0xff, (byteLen >> 24) & 0xff]
    const all = [...lenBytes, ...charBytes]
    const encoded = all.map(b => {
        if (b >= 0x20 && b <= 0x7e && b !== 0x22 && b !== 0x5c) return String.fromCharCode(b)
        return '\\' + b.toString(16).padStart(2, '0')
    }).join('')
    sa.segments.push({ offset: base, encoded })
    sa.nextOffset += 4 + byteLen
    sa.cache.set(s, base)
    return base
}

// ---------------------------------------------------------------------------
// LowerFns — function pointers threaded into CompilerAPI
// All referenced functions are declared later as `function` declarations and
// are therefore hoisted, making this module-level const safe to define here.
// ---------------------------------------------------------------------------

const lowerFns: LowerFns = {
    lowerExpr,
    lowerBlock,
    lowerParam,
    unwrapNode: unwrap,
    exprWasmType,
    watId,
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
    moduleRegistry?: ModuleRegistry,
): IRModule {
    const ctx: LowerCtx = {
        locals: new Map(),
        globals: new Map(),
        varNames: new Set(),
        functions: functionSigs,
        registry,
        moduleRegistry,
        pendingImports: new Map(),
        loopStack: [],
        loopCount: { n: 0 },
        pendingLocals: [],
        strings: createStringAlloc(),
        freshIdCounter: { n: 0 },
    }
    ctx.$compiler = createCompilerAPI(ctx, lowerFns)

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
        // Def expander pre-scan (handles type_sum and any user-registered kinds).
        ctx.registry.defExpanders.get(hook)?.preScan?.(node, ctx.$compiler!)
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
    startCtx.$compiler = createCompilerAPI(startCtx, lowerFns)
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

    // Append auto-generated imports from module calls (web::*, Draw::*, …).
    for (const imp of ctx.pendingImports.values()) imports.push(imp)

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

    // Def expander takes priority over hardcoded switch cases.
    const defExp = ctx.registry.defExpanders.get(hook)
    if (defExp) return defExp.expand(node, name, ctx.$compiler!)

    switch (hook) {
        case 'function': return lowerFunction(node, name, ctx)
        case 'global':   return lowerGlobal(node, name, ctx)
        case 'extern':   return lowerExtern(node, name, ctx)
        // Type alias / distinct produce no WAT — handled by type checker.
        case 'type_alias':
        case 'type_distinct':
            return null
        default:
            throw new IRLowerError(`Unknown definition keyword: ${node.keyword ?? hook}`)
    }
}

/** Lower a single function parameter AST node to IRParam, or null for literal/untyped params. */
export function lowerParam(p: any): IRParam | null {
    if (p.isLiteral || !p.typeAnnotation) return null
    return { name: watId(p.name), wasmType: siliconTypeNameToWasm(p.typeAnnotation.typename) }
}

function lowerFunction(node: any, name: string, ctx: LowerCtx): IRFunction {
    const params: IRParam[] = []
    const paramLocals: Map<string, WasmValType> = new Map()

    for (const p of node.params || []) {
        const param = lowerParam(p)
        if (!param) continue
        params.push(param)
        paramLocals.set(param.name, param.wasmType)
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
    childCtx.$compiler = createCompilerAPI(childCtx, lowerFns)

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

function lowerExtern(node: any, name: string, _ctx: LowerCtx): IRImport {
    const params: WasmValType[] = []
    for (const p of node.params || []) {
        if (p.isLiteral || !p.typeAnnotation) continue
        params.push(siliconTypeNameToWasm(p.typeAnnotation.typename))
    }
    let result: WasmValType | undefined
    if (node.name?.typeAnnotation?.typename) {
        result = siliconTypeNameToWasm(node.name.typeAnnotation.typename)
    }
    // Plain @extern always imports from the "env" host namespace.
    return { kind: 'Import', env: 'env', field: name, name, params, result }
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

/** Walk ExpressionEnd / ExpressionStart wrappers to reach a Namespace node. */
function extractNamespacePath(node: any): string[] {
    if (!node) return []
    if (node.type === 'Namespace') return node.path ?? []
    if (node.value !== undefined) return extractNamespacePath(node.value)
    return []
}

function lowerBinaryOp(n: any, ctx: LowerCtx): IRExpr {
    const op: string = n.operator

    // `=` in trailing expression position — the grammar parses `x = val` without
    // a trailing `;` as a BinaryOp rather than an Assignment node. Recover by
    // treating the left side as the assignment target.
    if (op === '=') {
        const path = extractNamespacePath(n.left).map(watId)
        const target = path.join('::')
        const value = lowerExpr(n.right, ctx)
        const setStmt: IRStmt = ctx.locals.has(target)
            ? { kind: 'LocalSet', name: target, value }
            : { kind: 'GlobalSet', name: target, value }
        return { kind: 'Block', wasmType: 'void', stmts: [setStmt] }
    }

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

    if (!intrinsic) {
        // No WASM intrinsic — check for a user function call step in the body template.
        const template = stratum?.data?.bodyTemplate ?? []
        const userStep = template.find(s => s.userFunc)
        if (userStep) {
            const argExprs = userStep.argRefs.map(ref =>
                ref === 'left' ? left : ref === 'right' ? right : left
            )
            return { kind: 'Call', wasmType: resultWt, callee: userStep.userFunc!, callKind: 'user', args: argExprs }
        }
        throw new IRLowerError(`No stratum registered for operator '${op}'`)
    }

    // Control-flow operators: || maps to IR::control_or (short-circuit evaluation).
    if (intrinsic === 'IR::control_or' || intrinsic === 'WASM::control_or') {
        return {
            kind: 'If',
            wasmType: 'i32',
            cond: left,
            then: { kind: 'Const', wasmType: 'i32', value: 1 },
            else_: right,
        }
    }

    const wasmInstr = resolveIntrinsicWasmInstr(intrinsic)
    if (!wasmInstr) throw new IRLowerError(`No WasmIntrinsic for '${intrinsic}'`)

    const primary: IRExpr = { kind: 'BinOp', wasmType: resultWt, instr: wasmInstr, left, right }

    // Multi-step strata: first step is the BinOp; subsequent steps chain on the stack.
    const template = stratum.data?.bodyTemplate ?? []
    const extraSteps = template.length > 1 ? template.slice(1) : []
    if (extraSteps.length === 0) return primary

    const stmts: IRStmt[] = [{ kind: 'ExprStmt', expr: primary }]
    let lastWt: WasmType = resultWt
    for (const step of extraSteps) {
        const stepInstr = resolveIntrinsicWasmInstr(step.intrinsic ?? '')
        if (!stepInstr) throw new IRLowerError(`No WasmIntrinsic for extra step '${step.intrinsic}'`)
        lastWt = (step.intrinsic ?? '').includes('f32') ? 'f32' : 'i32'
        stmts.push({ kind: 'ExprStmt', expr: { kind: 'Call', wasmType: lastWt as WasmValType, callee: stepInstr, callKind: 'instr', args: [] } })
    }
    const trailing = (stmts.pop() as IRExprStmt).expr
    return { kind: 'Block', wasmType: lastWt, stmts, trailing }
}

function lowerFunctionCall(n: any, ctx: LowerCtx): IRExpr {
    const name = callName(n)

    if (n.isBuiltin) {
        return lowerBuiltinCall(name, n.args || [], ctx, n.inferredType)
    }

    // WASM/IR intrinsic direct call (e.g. &WASM::i32_add 1, 2 or &IR::i32_add 1, 2).
    if (name.startsWith('WASM::') || name.startsWith('IR::')) {
        const resolvedInstr = resolveIntrinsicWasmInstr(name)
        const args = (n.args || []).map((a: any) => lowerExpr(a, ctx))
        const inferT = n.inferredType as SiliconType | undefined
        const wt = resolveWasmType(inferT, 'i32')
        return { kind: 'Call', wasmType: wt, callee: resolvedInstr ?? name, callKind: 'instr', args }
    }

    // Module namespaced call: web::console_log_str, Draw::fill_rect, etc.
    const sepIdx = name.indexOf('::')
    if (sepIdx !== -1) {
        return lowerModuleCall(name, sepIdx, n, ctx)
    }

    // User-defined function call.
    const watName = watId(name)
    const args = (n.args || []).map((a: any) => lowerExpr(a, ctx))
    const sig = ctx.functions.get(watName)
    const inferT = n.inferredType as SiliconType | undefined
    const wt: WasmType = sig
        ? resolveWasmType(sig.result, resolveWasmType(inferT, 'void'))
        : resolveWasmType(inferT, 'void')
    return { kind: 'Call', wasmType: wt, callee: watName, callKind: 'user', args }
}

function lowerModuleCall(name: string, sepIdx: number, n: any, ctx: LowerCtx): IRExpr {
    const moduleName = name.slice(0, sepIdx)
    const funcName = name.slice(sepIdx + 2)
    const moduleEntry = ctx.moduleRegistry?.get(moduleName)

    if (!moduleEntry) {
        throw new IRLowerError(
            `Unknown module '${moduleName}' — not found in built-in modules or ./modules/`
        )
    }
    const fnSig = moduleEntry.functions.get(funcName)
    if (!fnSig) {
        throw new IRLowerError(
            `Module '${moduleName}' has no function '${funcName}'`
        )
    }

    // WAT internal name: module__function (double-underscore avoids collision with user names)
    const watName = `${moduleName}__${funcName}`

    // Register the import once per compilation (deduplicated by watName).
    if (!ctx.pendingImports.has(watName)) {
        ctx.pendingImports.set(watName, {
            kind: 'Import',
            env: moduleName,
            field: funcName,
            name: watName,
            params: fnSig.params,
            result: fnSig.result,
        })
    }

    const args = (n.args || []).map((a: any) => lowerExpr(a, ctx))
    const wt: WasmType = fnSig.result ?? 'void'
    return { kind: 'Call', wasmType: wt, callee: watName, callKind: 'user', args }
}

function lowerBuiltinCall(name: string, rawArgs: any[], ctx: LowerCtx, inferredType?: any): IRExpr {
    // Typed dispatch: try the first arg's type kind, fall back to the untyped entry.
    const firstArgKind: string = (rawArgs[0] as any)?.inferredType?.kind ?? 'Int'
    const kwEntry = lookupTypedKeyword(ctx.registry, name, firstArgKind) ?? lookupKeyword(ctx.registry, name)
    const intrinsic = kwEntry?.data?.intrinsic ?? ''

    // Pluggable expander path: strata register expanders for their intrinsic.
    const expander = ctx.registry.expanders.get(intrinsic)
    if (expander) {
        return expander(rawArgs, ctx.$compiler!, inferredType)
    }

    // Generic builtin (e.g. @toInt, @toFloat, user-defined keyword strata).
    const wasmInstr = intrinsic ? resolveIntrinsicWasmInstr(intrinsic) : undefined
    const args = rawArgs.map((a: any) => lowerExpr(a, ctx))
    const wt = resolveWasmType(inferredType as SiliconType | undefined,
        wasmInstr ? (intrinsic.includes('f32') ? 'f32' : 'i32') : 'i32')
    if (wasmInstr) {
        return { kind: 'Call', wasmType: wt, callee: wasmInstr, callKind: 'instr', args }
    }
    // Unknown builtin — call by name (user-defined stratum that calls a Silicon function).
    const kwName = watId(name.replace(/^@/, ''))
    return { kind: 'Call', wasmType: wt, callee: kwName, callKind: 'user', args }
}

function lowerBlock(n: any, ctx: LowerCtx): IRBlock {
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
    return { kind: 'Block', wasmType: 'void', stmts: [stmt] }
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
        callee: ARRAY_LITERAL_CALLEE,
        callKind: 'user',
        args: [...allocArgs, ...elemExprs],
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nop(): IRNop { return { kind: 'Nop' } }

export function exprWasmType(e: IRExpr): WasmType {
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
export function watId(s: string): string {
    return s.replace(/::/g, '_')
}

function parseIntLiteral(n: any): number {
    const raw: string = n.value ?? '0'
    const cleaned = raw.replace(/_/g, '')
    if (cleaned.startsWith('0b') || cleaned.startsWith('0B')) return parseInt(cleaned.slice(2), 2)
    if (cleaned.startsWith('0x') || cleaned.startsWith('0X')) return parseInt(cleaned.slice(2), 16)
    if (cleaned.startsWith('0o') || cleaned.startsWith('0O')) return parseInt(cleaned.slice(2), 8)
    return parseInt(cleaned, 10)
}
