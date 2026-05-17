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
import { wasmTypeOf } from '../types/types'

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
    functions:       Map<string, FunctionSig>
    moduleRegistry?: ModuleRegistry
    freshIdCounter:  { n: number }
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
    /** Iterate node.params and lower each entry; literal/untyped params are skipped. */
    lowerParams(node: any): IRParam[]
    /** Lower a function's binding expression in a child scope; returns body + collected locals. */
    lowerFunctionBody(node: any, params: IRParam[]): { body: IRExpr | undefined; locals: IRLocal[] }
    /** Resolve a function's return type from annotation, function sig, or body refinement. */
    resolveFunctionReturnType(node: any, name: string, body?: IRExpr): WasmType
    /** Lower a @var initialiser, returning the init expression and its (possibly refined) wasmType. */
    lowerGlobalInit(node: any, defaultType: WasmValType): { init: IRExpr; wasmType: WasmValType }
    /** Iterate the parameters of an @extern and return their WASM types in order. */
    lowerExternParams(node: any): WasmValType[]
    /** Extract the result wasmType of an @extern declaration, or undefined if void. */
    lowerExternResult(node: any): WasmValType | undefined
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
    /** Indexed access into an args array (e.g. rawArgs[i]). Returns undefined past the end. */
    arg(node: any, index: number): any
    /** Lower an expression if defined, otherwise return undefined (preserves IRIf void/typed distinction). */
    lowerExprIfDefined(node: any): IRExpr | undefined
    /** Throw a CompilerAPIError if `value` is null/undefined. Used by strata bodies for guards. */
    assertDefined(value: any, msg: string): void
    /** Throw a CompilerAPIError with optional source location from `node`. */
    error(msg: string, node?: any): never
    /** Build the nested if/else chain for @match. Encapsulates the recursion the body interpreter can't express. */
    expandMatchChain(rawArgs: any[], inferredType: any): IRExpr
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
