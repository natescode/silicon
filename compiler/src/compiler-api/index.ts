/**
 * Compiler API — the $compiler surface exposed to Silicon strata.
 *
 * Strata bodies reference this as `$compiler.*`. The API is a stable interface
 * over the internal LowerCtx, IR node constructors, and AST traversal helpers.
 * It is created once per lowering context via createCompilerAPI() and stored on
 * the context as ctx.$compiler so expanders can access it without a circular
 * import on lower.ts.
 *
 * Circular-import safety
 * ----------------------
 * This module imports ONLY from ir/nodes, types/, modules/, and intrinsics/.
 * It never imports from ir/lower.ts. lower.ts imports from here (one-way).
 */

import type { FunctionSig } from '../types/typechecker'
import type { ModuleRegistry } from '../modules/registry'
import type { ElaboratorRegistry, ComptimeHandler, StructLayout } from '../elaborator/registry'
import { getStratumState, lookupComptimeHandler } from '../elaborator/registry'
import { lookupDefKind } from '../elaborator/defkinds'
import { normalizeMatchArgs } from '../ast/matchArms'
import { resolveIntrinsicWasmInstr } from '../intrinsics'
import { wasmTypeOf } from '../types/types'
import type { SiliconType } from '../types/types'
import type { Diagnostic } from '../errors/diagnostic'
import { spanFromLocation } from '../errors/diagnostic'

// ─────────────────────────────────────────────────────────────────────────────
// Errors raised from inside CompilerAPI calls (e.g. assertDefined, error)
// ─────────────────────────────────────────────────────────────────────────────

export class CompilerAPIError extends Error {
    constructor(msg: string) { super(`[strata] ${msg}`) }
}

function formatLoc(node: any): string {
    const loc = node?.sourceLocation
    if (!loc) return ''
    if (loc.line != null && loc.col != null) return ` (line ${loc.line}, col ${loc.col})`
    if (loc.start != null) return ` (offset ${loc.start})`
    return ''
}
import type {
    WasmValType, WasmType,
    IRExpr, IRStmt,
    IRConst, IRLocalGet, IRGlobalGet, IRBinOp, IRCall,
    IRBlock, IRIf, IRLoop, IRBreak, IRContinue, IRReturn,
    IRLocalSet, IRGlobalSet, IRNop, IRUnreachable,
    IRFunction, IRGlobal, IRImport, IRExport,
    IRParam, IRLocal,
} from '../ir/nodes'

// ─────────────────────────────────────────────────────────────────────────────
// Structural mirror of the LowerCtx fields we need
// Defined here so compiler-api never imports lower.ts directly.
// ─────────────────────────────────────────────────────────────────────────────

interface CtxShape {
    locals:         Map<string, WasmValType>
    globals:        Map<string, WasmValType>
    varNames:       Set<string>
    pendingLocals:  IRLocal[]
    loopStack:      number[]
    loopCount:      { n: number }
    /** Phase 4: pending @defer cleanup IR for the current function body. */
    deferStack?:    IRExpr[]
    functions:       Map<string, FunctionSig>
    moduleRegistry?: ModuleRegistry
    freshIdCounter:  { n: number }
    /** Registry reference for state buckets, pendingDefinitions, and diagnostics. */
    registry?:       ElaboratorRegistry
    /** Name of the currently-executing stratum (for 'stratum' state scope). */
    currentStratum?: string
    /** Mutable ref — preferred over currentStratum; set by the lowerer before each handler call. */
    currentStratumRef?: { name: string }
}

// ─────────────────────────────────────────────────────────────────────────────
// Function pointers supplied by lower.ts to close over the current ctx
// ─────────────────────────────────────────────────────────────────────────────

export interface LowerFns {
    lowerExpr:    (node: any, ctx: any) => IRExpr
    lowerBlock:   (node: any, ctx: any) => IRBlock
    lowerParam:   (param: any) => IRParam | null
    lowerParams:  (node: any) => IRParam[]
    lowerFunctionBody: (
        node: any,
        params: IRParam[],
        ctx: any,
    ) => { body: IRExpr | undefined; locals: IRLocal[] }
    resolveFunctionReturnType: (
        node: any,
        name: string,
        body: IRExpr | undefined,
        ctx: any,
    ) => WasmType
    lowerGlobalInit: (
        node: any,
        defaultType: WasmValType,
        ctx: any,
    ) => { init: IRExpr; wasmType: WasmValType }
    lowerExternParams: (node: any) => WasmValType[]
    lowerExternResult: (node: any) => WasmValType | undefined
    unwrapNode:  (node: any) => any
    exprWasmType:(expr: IRExpr) => WasmType
    watId:       (name: string) => string
}

// ─────────────────────────────────────────────────────────────────────────────
// $compiler.ctx — structured access to the mutable lowering context
// ─────────────────────────────────────────────────────────────────────────────

export interface CompilerCtx {
    locals: {
        get(name: string): WasmValType | undefined
        set(name: string, type: WasmValType): void
    }
    globals: {
        get(name: string): WasmValType | undefined
        set(name: string, type: WasmValType): void
    }
    varNames: {
        has(name: string): boolean
        add(name: string): void
    }
    pendingLocals: {
        push(local: IRLocal): void
    }
    loopStack: {
        push(id: number): void
        pop(): number | undefined
        peek(): number | undefined
    }
    /** Phase 4: per-function deferred cleanup expressions. */
    deferStack: {
        push(expr: IRExpr): void
        drain(): IRExpr[]
        length(): number
    }
    /** Allocate the next monotonic loop/block ID. */
    nextLoopId(): number
    functionSigs: {
        get(name: string): FunctionSig | undefined
    }
    moduleRegistry?: ModuleRegistry
    structTypes: {
        set(name: string, layout: StructLayout): void
        get(name: string): StructLayout | undefined
        has(name: string): boolean
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// $compiler.ir — IR node constructors
// ─────────────────────────────────────────────────────────────────────────────

export interface IRBuilders {
    makeConst(value: number, wasmType: WasmValType): IRConst
    makeLocalGet(name: string, wasmType: WasmValType): IRLocalGet
    makeLocalSet(name: string, value: IRExpr): IRLocalSet
    makeGlobalGet(name: string, wasmType: WasmValType): IRGlobalGet
    makeGlobalSet(name: string, value: IRExpr): IRGlobalSet
    makeBinOp(instr: string, left: IRExpr, right: IRExpr, wasmType: WasmValType): IRBinOp
    makeCall(callee: string, args: IRExpr[], wasmType: WasmType, callKind?: 'user' | 'instr'): IRCall
    makeBlock(stmts: IRStmt[], trailing?: IRExpr, wasmType?: WasmType): IRBlock
    makeIf(cond: IRExpr, then: IRExpr, else_?: IRExpr, wasmType?: WasmType): IRIf
    makeLoop(id: number, cond: IRExpr, body: IRExpr): IRLoop
    makeBreak(id: number): IRBreak
    makeContinue(id: number): IRContinue
    makeReturn(value?: IRExpr): IRReturn
    makeNop(): IRNop
    makeUnreachable(): IRUnreachable
    makeExport(alias: string, internalName: string, what: 'func' | 'global'): IRExport
    makeGlobal(name: string, wasmType: WasmValType, mutable: boolean, init: IRExpr): IRGlobal
    makeFunction(
        name: string,
        params: IRParam[],
        returnType: WasmType,
        locals: IRLocal[],
        body?: IRExpr,
    ): IRFunction
    makeImport(
        env: string,
        field: string,
        name: string,
        params: WasmValType[],
        result?: WasmValType,
    ): IRImport
    /** Build an IRLocal value (used by pendingLocals.push for @local hoisting). */
    makeLocal(name: string, wasmType: WasmValType): IRLocal
    /** Explicit no-op lowering result — return from a def expander that emits nothing. */
    null(): null
}

// ─────────────────────────────────────────────────────────────────────────────
// Strata 2.0 — types-as-data, AST synthesis, state, module, diagnostics
// ─────────────────────────────────────────────────────────────────────────────

/** Opaque handle for a captured (and cloneable) AST template. */
export interface TemplateHandle {
    /** Deep clone of the captured AST subtree. */
    ast: any
    /** 'pre' = captured before elaboration; 'post' = after. */
    kind: 'pre' | 'post'
}

/** Per-stratum or per-invocation mutable state bucket. */
export interface StateHandle {
    get(key: string): any
    set(key: string, value: any): this
    has(key: string): boolean
    each(fn: (key: string, value: any) => void): void
}

/** Types-as-data namespace (§5.4 of the Strata 2.0 spec). */
export interface CompilerTypes {
    readonly int:    SiliconType
    readonly int64:  SiliconType
    readonly float:  SiliconType
    readonly bool:   SiliconType
    readonly string: SiliconType
    readonly void:   SiliconType
    array(elem: SiliconType): SiliconType
    function(params: SiliconType[], result: SiliconType): SiliconType
    variable(name: string): SiliconType
    equals(a: SiliconType, b: SiliconType): boolean
    infer_args(callNode: any): SiliconType[]
    substitute(tmpl: SiliconType, bindings: Map<string, SiliconType>): SiliconType
    format(t: SiliconType): string
    /** Given a generic template Definition node and a concrete call site, return
     *  a Map of type-variable bindings (e.g. T → Int) suitable for ast::patch_types.
     *  Type variables are identified as parameter type annotations whose name is
     *  not a built-in Silicon type (Int, Int64, Float, Bool, String, Void).
     *  The corresponding concrete type is inferred from each call argument. */
    bind_template_args(tmplDef: any, callNode: any): Map<string, SiliconType>
    /** Human-readable suffix for monomorph mangling: bind_template_args(...) → "Int_Float". */
    mangle_suffix(bindings: Map<string, SiliconType>): string
}

/** AST read + synthesis namespace (§5.3 / §5.5 of the Strata 2.0 spec). */
export interface CompilerAst {
    children(node: any): any[]
    span(node: any): { file: string; line: number; col: number; length: number }
    doc(node: any): string
    capture_template(node: any, kind: 'pre' | 'post'): TemplateHandle
    clone(handle: TemplateHandle): TemplateHandle
    substitute(handle: TemplateHandle, bindings: Record<string, any>): TemplateHandle
    re_elaborate(handle: TemplateHandle): any
    patch_types(handle: TemplateHandle, bindings: Map<string, SiliconType>): TemplateHandle
    /** Return a new template with the root Definition's keyword replaced and
     *  re-stamped with the codegen hook implied by the new keyword. Used to
     *  convert a captured @generic template into an @fn (or any other) def
     *  before pushing it via module::push_definition. */
    with_keyword(handle: TemplateHandle, keyword: string): TemplateHandle
    /** Return a new template with the root Definition's name replaced. Used
     *  by monomorphization to mangle generated instances (e.g. identity → identity$Int). */
    with_name(handle: TemplateHandle, name: string): TemplateHandle
    /** Mutate a FunctionCall node so the lowerer resolves the call to `newName`
     *  instead of its original callee.  Used at on::call_site to redirect a
     *  generic call to its monomorph (e.g. id → id$Int). */
    rewrite_call(callNode: any, newName: string): void
}

/** Module mutation namespace (§5.6 of the Strata 2.0 spec). */
export interface CompilerModule {
    push_definition(def: any): void
    push_global(name: string, type: SiliconType, init: any): void
}

/** Structured diagnostics namespace — T-5 runtime-trap model (§6). */
export interface CompilerDiag {
    error(code: string, span: any, message: string, hint?: string): void
    warn(code: string, span: any, message: string, hint?: string): void
}

// ─────────────────────────────────────────────────────────────────────────────
// CompilerAPI — the full $compiler surface callable from strata bodies
// ─────────────────────────────────────────────────────────────────────────────

export interface CompilerAPI {
    /** Structured access to the mutable lowering context. */
    readonly ctx: CompilerCtx
    /** IR node constructors — build typed IR without writing object literals. */
    readonly ir: IRBuilders

    // ── Strata 2.0 namespaces ─────────────────────────────────────────────────
    /** Types as first-class values (§5.4). */
    readonly type: CompilerTypes
    /** AST read + synthesis (§5.3 / §5.5). */
    readonly ast: CompilerAst
    /** Module mutation — emit new top-level items (§5.6). */
    readonly module: CompilerModule
    /** Structured diagnostics — T-5 runtime-trap model (§6). */
    readonly diag: CompilerDiag

    /** Check whether an annotation token is present on an AST node (§5.3). */
    ann_present(node: any, token: string): boolean
    /** Return the argument list of an annotation node (§5.3). */
    ann_args(annNode: any): any[]
    /** Access per-stratum or per-invocation state bucket (§5.7). */
    state(scope: 'stratum' | 'instance'): StateHandle
    /** Inspect a call site's callee (§5 spec — `&Compiler::callee::*`). */
    readonly callee: { name(callNode: any): string }
    /** Look up a comptime handler registered for an operator/keyword token.
     *  Used by the strata body interpreter to dispatch built-in forms
     *  (`@nil`, `@not`, `+`, `==`, etc.) and any user-defined comptime
     *  semantics registered via `on::comptime`.  Returns undefined if no
     *  handler is registered for the token. */
    lookupComptime(token: string): ComptimeHandler | undefined

    // ── Legacy / existing surface ─────────────────────────────────────────────
    resolveType(annotation: any): WasmValType
    resolveTypeName(name: string): WasmValType
    resolveExprType(expr: IRExpr): WasmType
    isVarName(name: string): boolean

    lowerExpr(node: any): IRExpr
    lowerBlock(node: any): IRBlock
    lowerParam(param: any): IRParam | null
    lowerParams(node: any): IRParam[]
    lowerFunctionBody(node: any, params: IRParam[]): { body: IRExpr | undefined; locals: IRLocal[] }
    resolveFunctionReturnType(node: any, name: string, body?: IRExpr): WasmType
    lowerGlobalInit(node: any, defaultType: WasmValType): { init: IRExpr; wasmType: WasmValType }
    lowerExternParams(node: any): WasmValType[]
    lowerExternResult(node: any): WasmValType | undefined
    unwrapNode(node: any): any

    watId(name: string): string
    freshId(prefix?: string): string
    resolveIntrinsic(name: string): string | undefined
    choose<T>(cond: any, ifTrue: T, ifFalse: T): T
    arg(node: any, index: number): any
    lowerExprIfDefined(node: any): IRExpr | undefined
    assertDefined(value: any, msg: string): void
    error(msg: string, node?: any): never
    expandMatchChain(rawArgs: any[], inferredType: any): IRExpr
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createCompilerAPI(ctx: CtxShape, fns: LowerFns): CompilerAPI {
    function resolveTypeName(name: string): WasmValType {
        if (name === 'Float') return 'f32'
        // Int64 is the only fixed-width 64-bit type; the surface alias `i64`
        // is the low-level escape hatch mirroring how `i32`/`f32` work.
        if (name === 'Int64' || name === 'i64') return 'i64'
        return 'i32'
    }

    const compilerCtx: CompilerCtx = {
        locals: {
            get:  (name)       => ctx.locals.get(name),
            set:  (name, type) => { ctx.locals.set(name, type) },
        },
        globals: {
            get:  (name)       => ctx.globals.get(name),
            set:  (name, type) => { ctx.globals.set(name, type) },
        },
        varNames: {
            has:  (name) => ctx.varNames.has(name),
            add:  (name) => { ctx.varNames.add(name) },
        },
        pendingLocals: {
            push: (local) => { ctx.pendingLocals.push(local) },
        },
        loopStack: {
            push: (id) => { ctx.loopStack.push(id) },
            pop:  ()   => ctx.loopStack.pop(),
            peek: ()   => ctx.loopStack.at(-1),
        },
        deferStack: {
            push:   (expr) => { (ctx.deferStack ??= []).push(expr) },
            drain:  ()     => {
                const arr = ctx.deferStack ?? []
                ctx.deferStack = []
                return arr
            },
            length: ()     => (ctx.deferStack?.length ?? 0),
        },
        nextLoopId:    () => ctx.loopCount.n++,
        functionSigs:  { get: (name) => ctx.functions.get(name) },
        moduleRegistry: ctx.moduleRegistry,
        structTypes: {
            set: (name, layout) => ctx.registry?.structTypes?.set(name, layout),
            get: (name)         => ctx.registry?.structTypes?.get(name),
            has: (name)         => ctx.registry?.structTypes?.has(name) ?? false,
        },
    }

    const ir: IRBuilders = {
        makeConst:       (value, wasmType)                     => ({ kind: 'Const', wasmType, value }),
        makeLocalGet:    (name, wasmType)                      => ({ kind: 'LocalGet', wasmType, name }),
        makeLocalSet:    (name, value)                         => ({ kind: 'LocalSet', name, value }),
        makeGlobalGet:   (name, wasmType)                      => ({ kind: 'GlobalGet', wasmType, name }),
        makeGlobalSet:   (name, value)                         => ({ kind: 'GlobalSet', name, value }),
        makeBinOp:       (instr, left, right, wasmType)        => ({ kind: 'BinOp', wasmType, instr, left, right }),
        makeCall:        (callee, args, wasmType, callKind = 'user') => ({ kind: 'Call', wasmType, callee, callKind, args }),
        makeBlock:       (stmts, trailing, wasmType)           => ({
            kind: 'Block',
            wasmType: wasmType ?? (trailing ? fns.exprWasmType(trailing) : 'void'),
            stmts,
            trailing,
        }),
        makeIf:          (cond, then, else_, wasmType)         => ({
            kind: 'If',
            wasmType: wasmType ?? (else_ ? fns.exprWasmType(then) : 'void'),
            cond, then, else_,
        }),
        makeLoop:        (id, cond, body)                      => ({ kind: 'Loop', id, cond, body }),
        makeBreak:       (id)                                  => ({ kind: 'Break', id }),
        makeContinue:    (id)                                  => ({ kind: 'Continue', id }),
        makeReturn:      (value)                               => ({ kind: 'Return', value }),
        makeNop:         ()                                    => ({ kind: 'Nop' }),
        makeUnreachable: ()                                    => ({ kind: 'Unreachable' }),
        makeExport:      (alias, internalName, what)           => ({ kind: 'Export', alias, internalName, what }),
        makeGlobal:      (name, wasmType, mutable, init)       => ({ kind: 'Global', name, wasmType, mutable, init }),
        makeFunction:    (name, params, returnType, locals, body) => ({ kind: 'Function', name, params, returnType, locals, body }),
        makeImport:      (env, field, name, params, result)    => ({ kind: 'Import', env, field, name, params, result }),
        makeLocal:       (name, wasmType)                      => ({ name, wasmType }),
        null:            ()                                    => null,
    }

    // ── Types-as-data (§5.4) ─────────────────────────────────────────────────

    function siliconTypeEquals(a: SiliconType, b: SiliconType): boolean {
        if (a.kind !== b.kind) return false
        if (a.kind === 'Array' && b.kind === 'Array') return siliconTypeEquals(a.element, b.element)
        if (a.kind === 'Function' && b.kind === 'Function') {
            return siliconTypeEquals(a.result, b.result)
                && a.params.length === b.params.length
                && a.params.every((p, i) => siliconTypeEquals(p, (b as any).params[i]))
        }
        if (a.kind === 'Variable' && b.kind === 'Variable') return a.name === b.name
        if (a.kind === 'Distinct' && b.kind === 'Distinct') return a.name === b.name
        if (a.kind === 'Sum' && b.kind === 'Sum') return a.name === b.name
        return true  // primitives — kind match is sufficient
    }

    function formatSiliconType(t: SiliconType): string {
        switch (t.kind) {
            case 'Int':      return 'Int'
            case 'Int64':    return 'Int64'
            case 'Float':    return 'Float'
            case 'String':   return 'String'
            case 'Bool':     return 'Bool'
            case 'UInt8':    return 'u8'
            case 'UInt16':   return 'u16'
            case 'UInt32':   return 'u32'
            case 'UInt64':   return 'u64'
            case 'Void':     return 'Void'
            case 'Unknown':  return 'Unknown'
            case 'Array':    return `Array[${formatSiliconType(t.element)}]`
            case 'Function': return `(${t.params.map(formatSiliconType).join(', ')}) -> ${formatSiliconType(t.result)}`
            case 'Variable': return `$${t.name}`
            case 'Distinct': return t.name
            case 'Sum':      return t.name
        }
    }

    function siliconTypeToTypeName(t: SiliconType): string {
        switch (t.kind) {
            case 'Int':    return 'Int'
            case 'Int64':  return 'Int64'
            case 'Float':  return 'Float'
            case 'Bool':   return 'Bool'
            case 'String': return 'String'
            case 'UInt8':  return 'u8'
            case 'UInt16': return 'u16'
            case 'UInt32': return 'u32'
            case 'UInt64': return 'u64'
            case 'Void':   return 'Void'
            case 'Distinct': return (t as any).name ?? 'Unknown'
            case 'Sum':      return (t as any).name ?? 'Unknown'
            default:       return 'Unknown'
        }
    }

    const BUILTIN_TYPE_NAMES = new Set([
        'Int', 'Int32', 'Int64', 'Float', 'Bool', 'String', 'Void',
        'u8', 'u16', 'u32', 'u64',
    ])

    function siliconTypeForName(name: string | undefined): SiliconType {
        switch (name) {
            case 'Int':    return { kind: 'Int' }
            case 'Int32':  return { kind: 'Int' }
            case 'Int64':  return { kind: 'Int64' }
            case 'Float':  return { kind: 'Float' }
            case 'Bool':   return { kind: 'Bool' }
            case 'String': return { kind: 'String' }
            case 'u8':     return { kind: 'UInt8' }
            case 'u16':    return { kind: 'UInt16' }
            case 'u32':    return { kind: 'UInt32' }
            case 'u64':    return { kind: 'UInt64' }
            case 'Void':   return { kind: 'Void' }
            default:       return { kind: 'Unknown' }
        }
    }

    /** Infer a literal AST node's type so monomorphization can drive
     *  off-the-arg shape even when the typechecker hasn't run. */
    function literalNodeType(node: any): SiliconType | undefined {
        if (!node || typeof node !== 'object') return undefined
        // Unwrap common wrappers (Element/Item/Statement) and Binding/expression.
        let cur = node
        for (let i = 0; i < 8 && cur && typeof cur === 'object'; i++) {
            if (cur.type === 'IntLiteral')     return { kind: 'Int' }
            if (cur.type === 'FloatLiteral')   return { kind: 'Float' }
            if (cur.type === 'StringLiteral')  return { kind: 'String' }
            if (cur.type === 'BooleanLiteral') return { kind: 'Bool' }
            cur = cur.value ?? cur.expression
        }
        return undefined
    }

    /** Best-effort SiliconType for a call argument.  Priority:
     *    1. SemanticModel (CaaS-2) or legacy node.inferredType stamp
     *    2. literal AST shape
     *    3. local/param reference via ctx.locals (wasmType-only — i32→Int,
     *       i64→Int64, f32→Float; lossy but the common case in user code). */
    function inferArgType(arg: any): SiliconType | undefined {
        const fromModel = ctx.semanticModel?.typeOf(arg) ?? (arg?.inferredType as SiliconType | undefined)
        if (fromModel && fromModel.kind !== 'Unknown') return fromModel
        const lit = literalNodeType(arg)
        if (lit) return lit
        let cur = arg
        for (let i = 0; i < 8 && cur && typeof cur === 'object'; i++) {
            if (cur.type === 'Namespace' && Array.isArray(cur.path) && cur.path.length === 1) {
                const wt = ctx.locals.get(cur.path[0])
                if (wt === 'i32') return { kind: 'Int' }
                if (wt === 'i64') return { kind: 'Int64' }
                if (wt === 'f32') return { kind: 'Float' }
                break
            }
            cur = cur.value ?? cur.expression
        }
        return undefined
    }

    function substituteType(tmpl: SiliconType, bindings: Map<string, SiliconType>): SiliconType {
        if (tmpl.kind === 'Variable' && bindings.has(tmpl.name)) return bindings.get(tmpl.name)!
        if (tmpl.kind === 'Array') return { kind: 'Array', element: substituteType(tmpl.element, bindings) }
        if (tmpl.kind === 'Function') return {
            kind: 'Function',
            params: tmpl.params.map(p => substituteType(p, bindings)),
            result: substituteType(tmpl.result, bindings),
        }
        return tmpl
    }

    const compilerType: CompilerTypes = {
        int:    { kind: 'Int' },
        int64:  { kind: 'Int64' },
        float:  { kind: 'Float' },
        bool:   { kind: 'Bool' },
        string: { kind: 'String' },
        void:   { kind: 'Void' },
        array:      (elem) => ({ kind: 'Array', element: elem }),
        function:   (params, result) => ({ kind: 'Function', params, result }),
        variable:   (name) => ({ kind: 'Variable', name }),
        equals:     siliconTypeEquals,
        infer_args: (callNode) => {
            const args: any[] = callNode?.args ?? []
            return args.map((a: any) => inferArgType(a) ?? ({ kind: 'Unknown' } as SiliconType))
        },
        substitute: substituteType,
        format:     formatSiliconType,
        bind_template_args: (tmplDef, callNode) => {
            const bindings = new Map<string, SiliconType>()
            const params: any[] = tmplDef?.params ?? []
            const args:   any[] = callNode?.args   ?? []
            for (let i = 0; i < params.length; i++) {
                const paramType: string | undefined = params[i]?.typeAnnotation?.typename
                if (!paramType || BUILTIN_TYPE_NAMES.has(paramType)) continue
                if (bindings.has(paramType)) continue
                const argType = inferArgType(args[i])
                if (argType) bindings.set(paramType, argType)
            }
            return bindings
        },
        mangle_suffix: (bindings) => {
            const parts: string[] = []
            // Sort for deterministic output regardless of insertion order.
            const keys = Array.from(bindings.keys()).sort()
            for (const k of keys) parts.push(siliconTypeToTypeName(bindings.get(k)!))
            return parts.join('_')
        },
    }

    // ── AST read + synthesis (§5.3 / §5.5) ───────────────────────────────────

    function deepClone(node: any): any {
        if (!node || typeof node !== 'object') return node
        if (Array.isArray(node)) return node.map(deepClone)
        const out: any = {}
        for (const k of Object.keys(node)) out[k] = deepClone(node[k])
        return out
    }

    function substituteAst(node: any, bindings: Record<string, any>): any {
        if (!node || typeof node !== 'object') return node
        if (Array.isArray(node)) return node.map(n => substituteAst(n, bindings))
        if (node.type === 'Namespace' && Array.isArray(node.path) && node.path.length === 1) {
            const name = node.path[0]
            if (name in bindings) return bindings[name]
        }
        const out: any = {}
        for (const k of Object.keys(node)) out[k] = substituteAst(node[k], bindings)
        return out
    }

    const compilerAst: CompilerAst = {
        children: (node) => {
            if (!node || typeof node !== 'object') return []
            return Object.values(node).filter(v => v && typeof v === 'object') as any[]
        },
        span: (node) => {
            const loc = node?.sourceLocation
            if (!loc) return { file: '', line: 0, col: 0, length: 0 }
            // Support both { startLine, startColumn } (SourceLocation) and { line, col } (test mocks).
            const line = loc.startLine ?? loc.line ?? 0
            const col  = loc.startColumn ?? loc.col ?? 0
            return { file: loc.file ?? '', line, col, length: loc.length ?? 0 }
        },
        doc: (node) => node?.doc ?? node?.docComment ?? '',
        capture_template: (node, kind) => ({ ast: deepClone(node), kind }),
        clone: (handle) => ({ ast: deepClone(handle.ast), kind: handle.kind }),
        substitute: (handle, bindings) => ({
            ast: substituteAst(deepClone(handle.ast), bindings),
            kind: handle.kind,
        }),
        re_elaborate: (handle) => handle.ast,
        with_keyword: (handle, keyword) => {
            const next = deepClone(handle.ast)
            if (next && typeof next === 'object' && next.type === 'Definition') {
                next.keyword = keyword
                // Re-stamp the codegen hook so lowerDefinition routes to the
                // right expander (e.g. @fn → 'function'). If the keyword isn't
                // registered, leave the hook untouched — lowerDefinition will
                // surface a clear error.
                const defKind = ctx.registry
                    ? lookupDefKind(ctx.registry.defKinds, keyword)
                    : undefined
                if (defKind) next.hook = defKind.codegenKind
            }
            return { ast: next, kind: handle.kind }
        },
        with_name: (handle, name) => {
            const next = deepClone(handle.ast)
            if (next && typeof next === 'object' && next.type === 'Definition') {
                if (next.name && typeof next.name === 'object') {
                    next.name = { ...next.name, name }
                } else {
                    next.name = { name }
                }
            }
            return { ast: next, kind: handle.kind }
        },
        rewrite_call: (callNode, newName) => {
            if (!callNode || typeof callNode !== 'object') return
            if (callNode.name && typeof callNode.name === 'object') {
                // FunctionCall.name is a Namespace { path: [...] }.  Single-segment
                // path is the common case; preserve any tail (module::fn) by replacing
                // only the last segment, but typically generic calls are single-name.
                if (Array.isArray(callNode.name.path)) {
                    callNode.name.path = [newName]
                } else {
                    callNode.name = { type: 'Namespace', path: [newName] }
                }
            } else {
                callNode.name = { type: 'Namespace', path: [newName] }
            }
        },
        patch_types: (handle, bindings) => {
            function patchNode(n: any): any {
                if (!n || typeof n !== 'object') return n
                if (Array.isArray(n)) return n.map(patchNode)
                const out = { ...n }
                // 1. Already-inferred type Variable → concrete (existing semantics).
                if (out.inferredType?.kind === 'Variable' && bindings.has(out.inferredType.name)) {
                    out.inferredType = bindings.get(out.inferredType.name)
                }
                // 2. Syntactic type annotation — `x:T`, return type `:T`, etc. —
                //    needs the typename string rewritten so the lowerer reads
                //    the concrete type.  This is what makes pre-elaboration
                //    monomorphization actually produce typed param/result IR.
                if (out.type === 'TypeAnnotation' && typeof out.typename === 'string' && bindings.has(out.typename)) {
                    const target = bindings.get(out.typename)!
                    out.typename = siliconTypeToTypeName(target)
                }
                for (const k of Object.keys(out)) {
                    if (k === 'inferredType') continue
                    out[k] = patchNode(out[k])
                }
                return out
            }
            return { ast: patchNode(deepClone(handle.ast)), kind: handle.kind }
        },
    }

    // ── Module mutation (§5.6) ────────────────────────────────────────────────

    const compilerModule: CompilerModule = {
        push_definition: (def) => {
            if (!ctx.registry) return
            ctx.registry.pendingDefinitions.push(def)
            // Pre-register the signature so call sites lowered *after* this
            // push can resolve to the new function.  Without this, the @fn
            // test := { (&identity 42) } pattern would fail because lowering
            // for `test` happens before pendingDefinitions are flushed.
            if (def && def.type === 'Definition' && def.hook === 'function') {
                const name = def.name?.name
                if (typeof name === 'string') {
                    const params: SiliconType[] = (def.params ?? []).map((p: any) => {
                        const t = p?.typeAnnotation?.typename
                        return siliconTypeForName(t)
                    })
                    const result = siliconTypeForName(def.name?.typeAnnotation?.typename)
                    ctx.functions.set(name, { params, result } as any)
                }
            }
        },
        push_global: (name, _type, init) => {
            const wt = wasmTypeOf(_type as any) as any ?? 'i32'
            const g = ir.makeGlobal(name, wt, true, init)
            if (ctx.registry) ctx.registry.pendingDefinitions.push(g)
        },
    }

    // ── Diagnostics (§6, T-5 runtime-trap model) ─────────────────────────────

    const compilerDiag: CompilerDiag = {
        error: (code, span, message, hint) => {
            const diag: Diagnostic = {
                phase: 'lower',
                code,
                span: typeof span === 'object' && 'line' in span
                    ? span
                    : spanFromLocation(span),
                message,
                hint,
            }
            if (ctx.registry) ctx.registry.diagnostics.push(diag)
        },
        warn: (code, span, message, hint) => {
            const diag: Diagnostic = {
                phase: 'lower',
                code,
                span: typeof span === 'object' && 'line' in span
                    ? span
                    : spanFromLocation(span),
                message,
                hint,
            }
            if (ctx.registry) ctx.registry.diagnostics.push(diag)
        },
    }

    // ── State buckets (§5.7) ──────────────────────────────────────────────────

    function makeStateHandle(map: Map<string, any>): StateHandle {
        return {
            get: (k) => map.get(k),
            set: (k, v) => { map.set(k, v); return makeStateHandle(map) },
            has: (k) => map.has(k),
            each: (fn) => map.forEach((v, k) => fn(k, v)),
        }
    }

    const api: CompilerAPI = {
        ctx:    compilerCtx,
        ir,
        type:   compilerType,
        ast:    compilerAst,
        module: compilerModule,
        diag:   compilerDiag,

        callee: {
            name: (callNode) => {
                const path = callNode?.name?.path
                if (Array.isArray(path)) return path.join('::')
                if (typeof callNode?.name === 'string') return callNode.name
                return ''
            },
        },

        lookupComptime: (token) =>
            ctx.registry ? lookupComptimeHandler(ctx.registry, token) : undefined,


        ann_present: (node, token) => {
            const anns: any[] = node?.annotations ?? node?.ann ?? []
            return anns.some((a: any) => a?.name === token || a?.token === token)
        },
        ann_args: (annNode) => annNode?.args ?? annNode?.arguments ?? [],

        state: (scope) => {
            if (scope === 'stratum') {
                const name = ctx.currentStratumRef?.name ?? ctx.currentStratum ?? '__global__'
                const map = ctx.registry ? getStratumState(ctx.registry, name) : new Map()
                return makeStateHandle(map)
            }
            // 'instance' scope: fresh bucket per call (no persistence across handler invocations).
            return makeStateHandle(new Map())
        },

        resolveTypeName,
        resolveType:     (annotation) => resolveTypeName(annotation?.typename ?? ''),
        resolveExprType: (expr)       => fns.exprWasmType(expr),
        isVarName:       (name)       => ctx.varNames.has(name),

        lowerExpr:    (node)          => fns.lowerExpr(node, ctx),
        lowerBlock:   (node)          => fns.lowerBlock(node, ctx),
        lowerParam:   (param)         => fns.lowerParam(param),
        lowerParams:  (node)          => fns.lowerParams(node),
        lowerFunctionBody:        (node, params)        => fns.lowerFunctionBody(node, params, ctx),
        resolveFunctionReturnType:(node, name, body)    => fns.resolveFunctionReturnType(node, name, body, ctx),
        lowerGlobalInit:          (node, defaultType)   => fns.lowerGlobalInit(node, defaultType, ctx),
        lowerExternParams:        (node)                => fns.lowerExternParams(node),
        lowerExternResult:        (node)                => fns.lowerExternResult(node),
        unwrapNode:   (node)          => fns.unwrapNode(node),

        watId:           (name)        => fns.watId(name),
        freshId:         (prefix = 'tmp') => `${prefix}_${ctx.freshIdCounter.n++}`,
        resolveIntrinsic:(name)        => resolveIntrinsicWasmInstr(name),
        choose:          (cond, t, f) => cond ? t : f,
        arg:             (node, index) => node?.[index],
        lowerExprIfDefined: (node) => node == null ? undefined : fns.lowerExpr(node, ctx),
        assertDefined: (value, msg) => {
            if (value == null) throw new CompilerAPIError(msg)
        },
        error: (msg, node) => {
            throw new CompilerAPIError(`${msg}${formatLoc(node)}`)
        },
        expandMatchChain: (rawArgs, inferredType) => {
            // Normalise arm-expression form (`pat => body`, with `|`-alternation)
            // into the flat `[disc, pat, body, …]` form the rest of this
            // routine consumes.  Pass-through for legacy callers.
            rawArgs = normalizeMatchArgs(rawArgs)
            if (rawArgs.length < 3) return ir.makeNop()
            const discNode = rawArgs[0]
            const discExpr = fns.lowerExpr(discNode, ctx)
            const wt: WasmType = (inferredType && inferredType.kind !== 'Unknown')
                ? (wasmTypeOf(inferredType) as WasmType)
                : 'i32'

            // For VariantDecl patterns we need the discriminant's sum type
            // to map variant name → tag and to construct field-load offsets.
            // The typechecker stamps `inferredType` on the discriminant AST.
            const discType: any = discNode?.inferredType
            const isSumDisc = discType && discType.kind === 'Sum'
            // SumOf stores variants as "TypeName::VariantName" strings.
            const variantTag = (variantName: string): number => {
                if (!isSumDisc) return -1
                const full = `${discType.name}::${variantName}`
                const idx = (discType.variants as string[]).indexOf(full)
                return idx
            }

            // Unwrap an arg node down to a VariantDecl, or undefined.
            const unwrapVariant = (node: any): any | undefined => {
                let cur = node
                while (cur && typeof cur === 'object') {
                    if (cur.type === 'VariantDecl') return cur
                    if (cur.expression) { cur = cur.expression; continue }
                    if (cur.value && cur.type !== 'BinaryOp') { cur = cur.value; continue }
                    return undefined
                }
                return undefined
            }

            const buildNested = (i: number): IRExpr => {
                if (i >= rawArgs.length) return ir.makeUnreachable()
                if (i + 1 >= rawArgs.length) return fns.lowerExpr(rawArgs[i], ctx)
                const patNode = rawArgs[i]
                const variant = unwrapVariant(patNode)

                if (variant && isSumDisc) {
                    // Variant pattern: cond = (i32.eq (i32.load disc) (i32.const tag))
                    // arm = (block [bind fields ...] (arm body))
                    const tag = variantTag(variant.name)
                    const loadTag: IRExpr = {
                        kind: 'Call',
                        wasmType: 'i32',
                        callee: 'i32.load',
                        callKind: 'instr',
                        args: [discExpr],
                    } as any
                    const cond = ir.makeBinOp('i32.eq', loadTag, ir.makeConst(tag, 'i32'), 'i32')

                    // Build field-binding stmts: @local f := i32.load offset=(idx+1)*4 (disc)
                    const fields = (variant.fields || []) as any[]
                    const stmts: IRStmt[] = []
                    for (let fi = 0; fi < fields.length; fi++) {
                        const fname: string = fields[fi].name
                        const offset = (fi + 1) * 4
                        const loadField: IRExpr = {
                            kind: 'Call',
                            wasmType: 'i32',
                            callee: 'i32.load',
                            callKind: 'instr',
                            args: [
                                ir.makeBinOp('i32.add', discExpr, ir.makeConst(offset, 'i32'), 'i32'),
                            ],
                        } as any
                        // Register field as a function-scoped local (hoisted).
                        ctx.pendingLocals.push({ name: fname, wasmType: 'i32' })
                        ctx.locals.set(fname, 'i32')
                        stmts.push(ir.makeLocalSet(fname, loadField))
                    }
                    const armBody = fns.lowerExpr(rawArgs[i + 1], ctx)
                    const armBlock = stmts.length > 0
                        ? ir.makeBlock(stmts, armBody, wt)
                        : armBody

                    return ir.makeIf(cond, armBlock, buildNested(i + 2), wt)
                }

                // Non-variant pattern: original equality-arm logic.
                const pat = fns.lowerExpr(rawArgs[i], ctx)
                const res = fns.lowerExpr(rawArgs[i + 1], ctx)
                const eqInstr = fns.exprWasmType(discExpr) === 'f32' ? 'f32.eq' : 'i32.eq'
                const cond = ir.makeBinOp(eqInstr, discExpr, pat, 'i32')
                return ir.makeIf(cond, res, buildNested(i + 2), wt)
            }
            return buildNested(1)
        },
    }

    return api
}
