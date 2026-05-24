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
import { type ElaboratorRegistry, lookupTypedOperator, lookupKeyword, lookupTypedKeyword, lookupDefKindEntry, fireModuleFinalizeHandlers, fireHandlers } from '../elaborator/registry'
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
    /** Current stratum name (for 'stratum' state scope). */
    currentStratum?: string
    /** Mutable ref written by the handler-firing loops so state('stratum') routes correctly. */
    currentStratumRef?: { name: string }
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

const STRING_ENCODER = new TextEncoder()

/** Allocate a string in the static data region; returns its base address.
 *  Strings are encoded as UTF-8. Layout: [byte_len:i32 LE][utf8 bytes...].
 *  Hosts decode with TextDecoder('utf-8'); the bootstrap parser reads source
 *  bytes via fd_read and compares against UTF-8 string literals with no
 *  encoding step. */
function allocString(sa: StringAlloc, s: string): number {
    if (sa.cache.has(s)) return sa.cache.get(s)!
    const payload = STRING_ENCODER.encode(s)
    const byteLen = payload.length
    const base = sa.nextOffset
    const lenBytes = [byteLen & 0xff, (byteLen >> 8) & 0xff, (byteLen >> 16) & 0xff, (byteLen >> 24) & 0xff]
    const all = [...lenBytes, ...payload]
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
    lowerParams,
    lowerFunctionBody,
    resolveFunctionReturnType,
    lowerGlobalInit,
    lowerExternParams,
    lowerExternResult,
    unwrapNode: unwrap,
    exprWasmType,
    watId,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True if `token` (a keyword like '@if' or operator like '+' or a typed
 *  overload key like '+:Float') has at least one compiled handler in
 *  `registry.compiledHandlers`.  Used to gate on::lower dispatch during
 *  handler compilation — see __compilingHandler in lowerDefinition /
 *  lowerBinaryOp / lowerBuiltinCall. */
function hasCompiledHandlerFor(registry: ElaboratorRegistry, token: string): boolean {
    const handlers = registry.handlers.lower.get(token)
    if (!handlers) return false
    for (const h of handlers) {
        const name = (h as any).__handlerName as string | undefined
        if (name && registry.compiledHandlers.has(name)) return true
    }
    return false
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
/** Compilation target. Stage 0's default is the host-embed runner used by
 *  the existing test suite; 'wasix' adds the `_start` export Wasmer-WASIX
 *  invokes by name (bootstrap-plan Phase -1.E). */
export type LowerTarget = 'host' | 'wasix'

export interface LowerOptions {
    /** Target runtime — controls emit-time conventions (e.g. _start export). */
    target?: LowerTarget
}

export function lowerProgram(
    program: any,
    registry: ElaboratorRegistry,
    functionSigs: Map<string, FunctionSig>,
    moduleRegistry?: ModuleRegistry,
    options: LowerOptions = {},
): IRModule {
    const target: LowerTarget = options.target ?? 'host'
    const currentStratumRef = { name: '__global__' }
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
        currentStratumRef,
    }
    // Pass the live ctx (not a snapshot) so $compiler is current when
    // recursively invoked methods (api.lowerExpr → lowerBinaryOp → on::lower
    // handler dispatch) read ctx.$compiler.  A spread snapshot here would
    // freeze ctx.$compiler at undefined.
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
        // Legacy 'global' codegenKind OR migrated @var (D-D-11c — hook is
        // 'stratum_def' but the keyword still needs the same forward-ref
        // global registration).
        if (hook === 'global' || node.keyword === '@var') {
            const name = watId(node.name?.name ?? '')
            ctx.globals.set(name, 'i32') // refined below
            ctx.varNames.add(name)
        }
        // Def expander pre-scan (handles type_sum and any user-registered kinds).
        ctx.registry.defExpanders.get(hook)?.preScan?.(node, ctx.$compiler!)
        // D-D-11d: migrated @enum/@type_sum/@type need the same preScan
        // even though their codegenKind is now 'stratum_def'.  Delegate
        // to the legacy expanders' preScan methods by keyword.
        if (hook === 'stratum_def') {
            const exp =
                node.keyword === '@enum' || node.keyword === '@type_sum' ? ctx.registry.defExpanders.get('type_sum') :
                node.keyword === '@type' ? ctx.registry.defExpanders.get('type_record') :
                undefined
            exp?.preScan?.(node, ctx.$compiler!)
        }
    }

    // Append an IR node (or array of nodes) into the right module bucket.
    function append(result: any): void {
        if (!result) return
        if (Array.isArray(result)) {
            for (const item of result) append(item)
            return
        }
        if (result.kind === 'Function') functions.push(result)
        else if (result.kind === 'Global') globals.push(result)
        else if (result.kind === 'Import') imports.push(result)
        else if (result.kind === 'Export') irExports.push(result)
    }

    for (const el of program.elements as any[]) {
        const node = unwrap(el)
        if (!node) continue
        if (node.type === 'Definition') append(lowerDefinition(node, ctx))
    }

    // Post-expand pass — each registered defExpander gets one final chance to
    // emit module-level items derived from cross-definition state (e.g. an
    // init function or a registry table built from every def seen so far).
    for (const exp of ctx.registry.defExpanders.values()) {
        const post = exp.postExpand?.(ctx.$compiler!)
        if (post !== undefined) append(post)
    }

    // Strata 2.0 §2: fire on::module_finalize handlers (T-5: build never fails).
    // Skipped during handler compilation — each handler's sub-lowerProgram
    // shouldn't fire user finalize hooks (otherwise they'd fire once per
    // handler in addition to the real user-program lowering).
    if (!((registry as any).__compilingHandler)) {
        for (const result of fireModuleFinalizeHandlers(registry, ctx.$compiler!, currentStratumRef)) {
            append(result)
        }
    }

    // Emit definitions pushed by module::push_definition during any phase.
    // Pushed AST Definition nodes are routed through lowerDefinition so they
    // are elaborated/lowered as if they had appeared in the source.  This is
    // the substrate for Approach A generics monomorphization (§7 of the
    // Strata 2.0 spec): on::decl captures a template, swaps the keyword,
    // and pushes a concrete @fn that gets fully lowered here.
    // Use index-based iteration so handlers that push *more* definitions
    // during their own lowering (e.g. nested generics) are processed too.
    for (let i = 0; i < registry.pendingDefinitions.length; i++) {
        const def = registry.pendingDefinitions[i]
        if (def && def.type === 'Definition') {
            append(lowerDefinition(def, ctx))
        } else {
            append(def)
        }
    }
    registry.pendingDefinitions.length = 0

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
    // WASIX runners (wasmer run) invoke the function exported as `_start`.
    // We always synthesise $__start so the module-init wrapper exists; on the
    // 'wasix' target we additionally export it under the WASIX-mandated name.
    // Empty $__start is fine: WASIX semantics treat it as the "no-op init".
    const hasStartBody = startStmts.length > 0
    if (hasStartBody || target === 'wasix') {
        functions.push({
            kind: 'Function',
            name: '__start',
            params: [],
            returnType: 'void',
            locals: startCtx.pendingLocals,
            body: { kind: 'Block', wasmType: 'void', stmts: startStmts },
        })
    }
    if (target === 'wasix') {
        irExports.push({ kind: 'Export', what: 'function', internalName: '__start', alias: '_start' })
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

    // @stratum is a compile-time directive consumed by buildStrataRegistry;
    // it produces no runtime IR.  Guard here so it doesn't fall through to
    // the "Unknown definition keyword" error.
    if (node.keyword === '@stratum') return null

    // Dissolution Phase A: `@fn`s claimed as strata handlers don't lower to
    // WASM — their bodies use `&Compiler::*` calls that only have meaning
    // to the strata interpreter.  Phase C will lower these properly through
    // a compile-time WASM engine; until then, skip them.
    if (node.keyword === '@fn' && ctx.registry.strataHandlerFnNames.has(node.name?.name ?? '')) {
        return null
    }

    // Strata 2.0 §2: fire on::decl handlers before def expansion (real API available here).
    const keyword = node.keyword ?? hook
    if (ctx.registry.handlers.decl.has(keyword)) {
        fireHandlers(ctx.registry, 'decl', keyword, node, ctx.$compiler!, ctx.currentStratumRef)
    }

    // Strata 2.0 §2: fire on::annotation handlers for each annotation on this def.
    const annotations: any[] = node.annotations ?? node.ann ?? []
    for (const ann of annotations) {
        const token: string = ann?.name ?? ann?.token ?? ''
        if (token && ctx.registry.handlers.annotation.has(token)) {
            fireHandlers(ctx.registry, 'annotation', token, { ann, def: node }, ctx.$compiler!, ctx.currentStratumRef)
        }
    }

    // Def expander takes priority over hardcoded switch cases.
    const defExp = ctx.registry.defExpanders.get(hook)
    if (defExp) return defExp.expand(node, name, ctx.$compiler!)

    // Strata 2.0: 'stratum_def' — keyword registered via register::keyword.
    // Fire on::lower handlers; their return value is the IR output.
    //
    // D-E-1 chicken-and-egg break: when the comptime engine is itself
    // compiling a strata handler @fn, it sets registry.__compilingHandler.
    // In that mode, on::lower handlers fire ONLY if the handler is
    // already compiled — otherwise we fall through to legacy code paths
    // to avoid a cycle (compiling LocalDef_lower whose body uses @local
    // would otherwise need LocalDef_lower already compiled).
    const tokenForHandler = node.keyword ?? ''
    const compilingHandler = (ctx.registry as any).__compilingHandler === true
    const canFire = (token: string): boolean =>
        ctx.registry.handlers.lower.has(token) &&
        (!compilingHandler || hasCompiledHandlerFor(ctx.registry, token))
    if (hook === 'stratum_def' || (tokenForHandler && canFire(tokenForHandler))) {
        if (canFire(tokenForHandler)) {
            const results = fireHandlers(ctx.registry, 'lower', tokenForHandler, node, ctx.$compiler!, ctx.currentStratumRef)
            return results.length > 0 ? results[results.length - 1] : null
        }
        if (!compilingHandler) return null  // No on::lower handler → no WAT output (T-5: silent)
        // Fall through to legacy paths for uncompiled handlers during compile.
    }

    // No defExpander registered — type aliases produce no WAT, anything else is an error.
    if (hook === 'type_alias' || hook === 'type_distinct') return null
    throw new IRLowerError(`Unknown definition keyword: ${node.keyword ?? hook}`)
}

/** Lower a single function parameter AST node to IRParam, or null for literal/untyped params. */
export function lowerParam(p: any): IRParam | null {
    if (p.isLiteral || !p.typeAnnotation) return null
    return { name: watId(p.name), wasmType: siliconTypeNameToWasm(p.typeAnnotation.typename) }
}

// ---------------------------------------------------------------------------
// Phase-5 strata helpers
// Bounded TS routines that rich Silicon strata orchestrate over.  Each one
// encapsulates a chunk of lowering state-management that's awkward to express
// in the body interpreter (list iteration, child contexts, type refinement).
// ---------------------------------------------------------------------------

/** Iterate node.params and return one IRParam per typed, non-literal entry. */
export function lowerParams(node: any): IRParam[] {
    const params: IRParam[] = []
    for (const p of node.params || []) {
        const param = lowerParam(p)
        if (param) params.push(param)
    }
    return params
}

/**
 * Create a child lowering context with the given params added to locals,
 * lower the function's binding expression in that child context, and return
 * the body + the locals collected during lowering.  Mirrors what the old
 * lowerFunction did between child-ctx creation and the IRFunction emit.
 */
export function lowerFunctionBody(
    node: any,
    params: IRParam[],
    ctx: LowerCtx,
): { body: IRExpr | undefined; locals: IRLocal[] } {
    const paramLocals = new Map<string, WasmValType>()
    for (const p of params) paramLocals.set(p.name, p.wasmType)

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
    }
    return { body, locals: childCtx.pendingLocals }
}

/**
 * Resolve a function's return type from (in priority order):
 *   1. explicit annotation on the function name
 *   2. the typechecker's recorded FunctionSig
 *   3. the lowered body's wasmType (refinement)
 */
export function resolveFunctionReturnType(
    node: any,
    name: string,
    body: IRExpr | undefined,
    ctx: LowerCtx,
): WasmType {
    if (node.name?.typeAnnotation?.typename) {
        return siliconTypeNameToWasmResult(node.name.typeAnnotation.typename)
    }
    const sig = ctx.functions.get(name)
    if (sig && sig.result.kind !== 'Unknown') {
        return wasmTypeOf(sig.result) as WasmType
    }
    if (body) {
        const bt = exprWasmType(body)
        if (bt !== 'void') return bt
    }
    return 'void'
}

/**
 * Lower a @var initialiser to an IRExpr + final wasmType.  Falls back to
 * `(const 0 : defaultType)` when no binding is provided, and refines the
 * type from the lowered init expression when one is.
 */
export function lowerGlobalInit(
    node: any,
    defaultType: WasmValType,
    ctx: LowerCtx,
): { init: IRExpr; wasmType: WasmValType } {
    let wasmType = defaultType
    const binding = Array.isArray(node.binding) ? node.binding[0] : node.binding
    if (binding) {
        const expr = binding.expression ?? binding
        const init = lowerExpr(expr, ctx)
        const it = exprWasmType(init)
        if (it !== 'void') wasmType = it
        return { init, wasmType }
    }
    return { init: { kind: 'Const', wasmType, value: 0 }, wasmType }
}

/** Iterate node.params and return one WasmValType per typed, non-literal entry. */
export function lowerExternParams(node: any): WasmValType[] {
    const params: WasmValType[] = []
    for (const p of node.params || []) {
        if (p.isLiteral || !p.typeAnnotation) continue
        params.push(siliconTypeNameToWasm(p.typeAnnotation.typename))
    }
    return params
}

/** Extract the result type of an @extern from its name's type annotation. */
export function lowerExternResult(node: any): WasmValType | undefined {
    if (node.name?.typeAnnotation?.typename) {
        return siliconTypeNameToWasm(node.name.typeAnnotation.typename)
    }
    return undefined
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
    // Operand-type dispatch picks the strata variant: 'Int' (i32),
    // 'Int64' (i64), or 'Float' (f32).  Bitwise ops short-circuit
    // to 'Int' since the i64 bitwise overloads aren't implemented yet.
    const isBitwise = ['|', '^', '<<', '>>'].includes(op)
    const leftWt = exprWasmType(left)
    const typeKind = isBitwise
        ? 'Int'
        : leftWt === 'f32' ? 'Float'
        : leftWt === 'i64' ? 'Int64'
        : 'Int'

    // Resolve the operator stratum once; dispatch on its intrinsic rather than the symbol.
    const stratum = lookupTypedOperator(ctx.registry, op, typeKind)
    const intrinsic = stratum?.data?.intrinsic

    // New-form operator strata (D-D-3, D-D-4, D-D-6, D-D-7*): when this
    // operand-type dispatch falls through (no intrinsic on the resolved
    // stratum entry) AND an on::lower handler is registered for the
    // operator, fire it with a synthesised BinaryOp-like node so the
    // handler can read `left`/`right` via compiler_ast_node_field.  The
    // handler's IR return value is the emitted IR.
    //
    // Typed dispatch first (e.g. `+:Float`) — preserves the Float / Int64
    // overloads' precedence after they migrate to the new form (D-D-7c).
    // Falls back to the bare-key handler (`+`) for the primary type.
    //
    // Gated on `!intrinsic` so a typed legacy overload (e.g. `+:Float` →
    // IR::f32_add) keeps its precedence — without the gate, a migrated
    // primary `+` handler would override the Float overload.
    if (!intrinsic) {
        const compilingHandler = (ctx.registry as any).__compilingHandler === true
        const typedKey = `${op}:${typeKind}`
        const canFire = (key: string): boolean =>
            ctx.registry.handlers.lower.has(key) &&
            (!compilingHandler || hasCompiledHandlerFor(ctx.registry, key))
        const handlerKey =
            canFire(typedKey) ? typedKey :
            canFire(op)       ? op       :
            ''
        if (handlerKey) {
            const synthNode = { type: 'BinaryOp', operator: op, left: n.left, right: n.right, inferredType: inferT }
            const results = fireHandlers(ctx.registry, 'lower', handlerKey, synthNode, ctx.$compiler!, ctx.currentStratumRef)
            const result = results.length > 0 ? results[results.length - 1] : null
            if (result) return result as IRExpr
        }
    }

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
    let name = callName(n)

    // Strata 2.0 §2: fire on::callSite handlers.  Wildcard '*' handlers fire
    // for every call site (used by monomorphization / instrumentation strata
    // that filter by inspecting the callee themselves).  After handlers run,
    // re-read the call name so a rewrite_call has effect downstream.
    const hasNameKeyed = ctx.registry.handlers.callSite.has(name)
    const hasWildcard  = ctx.registry.handlers.callSite.has('*')
    if (hasNameKeyed) {
        fireHandlers(ctx.registry, 'callSite', name, n, ctx.$compiler!, ctx.currentStratumRef)
    }
    if (hasWildcard) {
        fireHandlers(ctx.registry, 'callSite', '*', n, ctx.$compiler!, ctx.currentStratumRef)
    }
    if (hasNameKeyed || hasWildcard) name = callName(n)

    if (n.isBuiltin) {
        return lowerBuiltinCall(name, n.args || [], ctx, n.inferredType)
    }

    // WASM/IR intrinsic direct call (e.g. &WASM::i32_add 1, 2 or &IR::i32_add 1, 2).
    if (name.startsWith('WASM::') || name.startsWith('IR::')) {
        const resolvedInstr = resolveIntrinsicWasmInstr(name)
        const args = (n.args || []).map((a: any) => lowerExpr(a, ctx))
        const inferT = n.inferredType as SiliconType | undefined
        // WASM store / drop instructions are void at the WASM level — pin their
        // wasmType so downstream emit doesn't try to (drop ...) their non-result.
        const instr = resolvedInstr ?? name
        const isVoidInstr = instr === 'i32.store' || instr === 'i32.store8'
            || instr === 'f32.store' || instr === 'drop'
        const wt = isVoidInstr ? 'void' : resolveWasmType(inferT, 'i32')
        return { kind: 'Call', wasmType: wt, callee: instr, callKind: 'instr', args }
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

    // New-form strata: when the keyword has a registered on::lower handler
    // (D-D-* migrations) AND the typed-overload dispatch didn't find a
    // legacy intrinsic, fire the handler.  The `!intrinsic` gate
    // preserves legacy typed overloads' precedence — without it, a
    // migrated `@toInt` primary handler would override the legacy
    // `@toInt:Int64` overload.
    if (!intrinsic && ctx.registry.handlers.lower.has(name)) {
        const compilingHandler = (ctx.registry as any).__compilingHandler === true
        if (!compilingHandler || hasCompiledHandlerFor(ctx.registry, name)) {
            const synthNode = { type: 'FunctionCall', name: { type: 'Namespace', path: [name] }, args: rawArgs, inferredType }
            const results = fireHandlers(ctx.registry, 'lower', name, synthNode, ctx.$compiler!, ctx.currentStratumRef)
            const result = results.length > 0 ? results[results.length - 1] : null
            if (result) return result as IRExpr
        }
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

    // @var inside a function body: treat as a mutable local variable.
    // Recognise by hook (legacy 'global') or by keyword (D-D-11c migrated @var
    // with hook='stratum_def').  Either way, in-function @var emits a Local
    // declaration + LocalSet, not a module Global.
    if (node.type === 'Definition' && (node.hook === 'global' || node.keyword === '@var')) {
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

    // Legacy @local in-function declaration.  After D-D-11a, @local has
    // hook='stratum_def' instead of 'local', so we recognise by keyword
    // too — only relevant during handler compilation (when on::lower
    // dispatch is skipped) since the on::lower branch above normally
    // handles migrated @local.
    if (node.type === 'Definition' && (node.hook === 'local' || node.keyword === '@local')) {
        const name = watId(node.name?.name ?? '')
        let wasmType: WasmValType = 'i32'
        if (node.name?.typeAnnotation?.typename) {
            wasmType = siliconTypeNameToWasm(node.name.typeAnnotation.typename)
        }
        // Hoist by name: multiple `@local x := ...` in different branches
        // (lexer / parser dispatch loops do this heavily) collapse to a
        // single `(local $x i32)` declaration in the function preamble.
        if (!ctx.locals.has(name)) {
            ctx.pendingLocals.push({ name, wasmType })
        }
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

    // New-form (D-D-* migrated) Definition with stratum_def hook used inside
    // a function body: fire the on::lower handler, treat the return value
    // (often null IR for declaration-only kinds) as a void statement.
    // Without this branch, the generic "expression statement" fallback below
    // would recurse via lowerDefinitionAsExpr → lowerAsStmt → infinite loop.
    //
    // Skipped during handler compilation (D-E-1 chicken-and-egg break) —
    // see lowerDefinition's comment for context.
    if (node.type === 'Definition' && node.hook === 'stratum_def' && !((ctx.registry as any).__compilingHandler)) {
        const keyword = node.keyword ?? ''
        if (ctx.registry.handlers.lower.has(keyword)) {
            const results = fireHandlers(ctx.registry, 'lower', keyword, node, ctx.$compiler!, ctx.currentStratumRef)
            const result = results.length > 0 ? results[results.length - 1] : null
            // null / Nop / no-IR — produces no statement.
            if (!result || (result as any).kind === 'Nop') return null
            // LocalSet / GlobalSet / ExprStmt return as-is.
            if ((result as any).kind === 'LocalSet' || (result as any).kind === 'GlobalSet') {
                return result as IRStmt
            }
            // Other IR — wrap as an expression statement.
            return { kind: 'ExprStmt', expr: result as IRExpr }
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
    if (typename === 'Float') return 'f32'
    if (typename === 'Int64' || typename === 'i64') return 'i64'
    return 'i32'
}

// Used by resolveFunctionReturnType — Void becomes the WAT 'void'
// sentinel so the emitter omits the (result i32) clause; everything
// else funnels through siliconTypeNameToWasm.
function siliconTypeNameToWasmResult(typename: string): WasmType {
    return typename === 'Void' ? 'void' : siliconTypeNameToWasm(typename)
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
