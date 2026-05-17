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
import { resolveIntrinsicWasmInstr } from '../intrinsics'
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
    functions:       Map<string, FunctionSig>
    moduleRegistry?: ModuleRegistry
    freshIdCounter:  { n: number }
}

// ─────────────────────────────────────────────────────────────────────────────
// Function pointers supplied by lower.ts to close over the current ctx
// ─────────────────────────────────────────────────────────────────────────────

export interface LowerFns {
    lowerExpr:   (node: any, ctx: any) => IRExpr
    lowerBlock:  (node: any, ctx: any) => IRBlock
    lowerParam:  (param: any) => IRParam | null
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
    /** Allocate the next monotonic loop/block ID. */
    nextLoopId(): number
    functionSigs: {
        get(name: string): FunctionSig | undefined
    }
    moduleRegistry?: ModuleRegistry
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
// CompilerAPI — the full $compiler surface callable from strata bodies
// ─────────────────────────────────────────────────────────────────────────────

export interface CompilerAPI {
    /** Structured access to the mutable lowering context. */
    readonly ctx: CompilerCtx
    /** IR node constructors — build typed IR without writing object literals. */
    readonly ir: IRBuilders

    /** Map a Silicon type-annotation AST node to a WASM value type. */
    resolveType(annotation: any): WasmValType
    /** Map a raw Silicon type name string (e.g. 'Float', 'Int') to a WASM value type. */
    resolveTypeName(name: string): WasmValType
    /** Get the WASM type of an already-lowered IR expression node. */
    resolveExprType(expr: IRExpr): WasmType
    /** True if `name` is a mutable global (@var / sum-type variant), not a zero-arg function. */
    isVarName(name: string): boolean

    /** Recursively lower an AST expression node to an IRExpr, using the bound context. */
    lowerExpr(node: any): IRExpr
    /** Lower a Block AST node to IRBlock, using the bound context. */
    lowerBlock(node: any): IRBlock
    /** Lower a single function parameter to IRParam, or null for literal / untyped params. */
    lowerParam(param: any): IRParam | null
    /** Unwrap AST wrapper nodes (Element, Item, Statement) to the inner node. */
    unwrapNode(node: any): any

    /** Sanitize a Silicon identifier to a valid WAT identifier (:: → _). */
    watId(name: string): string
    /** Allocate a unique synthetic identifier for compiler-generated temporaries. */
    freshId(prefix?: string): string
    /** Resolve an intrinsic name (WASM::foo or IR::foo) to its WAT instruction string. */
    resolveIntrinsic(name: string): string | undefined
    /** Ternary helper for strata bodies that lack first-class control flow. */
    choose<T>(cond: any, ifTrue: T, ifFalse: T): T
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createCompilerAPI(ctx: CtxShape, fns: LowerFns): CompilerAPI {
    function resolveTypeName(name: string): WasmValType {
        return name === 'Float' ? 'f32' : 'i32'
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
        nextLoopId:    () => ctx.loopCount.n++,
        functionSigs:  { get: (name) => ctx.functions.get(name) },
        moduleRegistry: ctx.moduleRegistry,
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

    const api: CompilerAPI = {
        ctx:  compilerCtx,
        ir,

        resolveTypeName,
        resolveType:     (annotation) => resolveTypeName(annotation?.typename ?? ''),
        resolveExprType: (expr)       => fns.exprWasmType(expr),
        isVarName:       (name)       => ctx.varNames.has(name),

        lowerExpr:  (node)  => fns.lowerExpr(node, ctx),
        lowerBlock: (node)  => fns.lowerBlock(node, ctx),
        lowerParam: (param) => fns.lowerParam(param),
        unwrapNode: (node)  => fns.unwrapNode(node),

        watId:           (name)        => fns.watId(name),
        freshId:         (prefix = 'tmp') => `${prefix}_${ctx.freshIdCounter.n++}`,
        resolveIntrinsic:(name)        => resolveIntrinsicWasmInstr(name),
        choose:          (cond, t, f) => cond ? t : f,
    }

    return api
}
