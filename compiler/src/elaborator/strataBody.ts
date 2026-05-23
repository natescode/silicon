/**
 * Strata Body Interpreter
 *
 * Compiles "rich" Silicon strata bodies — those that contain `&Compiler::*`
 * API calls or `@local` bindings — into IRDefExpander / IRExpanderFn closures
 * that can be registered into the ElaboratorRegistry.
 *
 * Rich body syntax (see docs/robust-strata-implementation-plan.html §5):
 *
 *   @stratum_keyword LocalDef ('@local', Node) = {
 *     @local wasmType = &Compiler::resolveType Node.name.typeAnnotation;
 *     @local sname    = &Compiler::watId      Node.name.name;
 *     @local decl     = &Compiler::ir::makeLocal sname, wasmType;
 *     &Compiler::ctx::pendingLocals::push decl;
 *     &Compiler::ctx::locals::set        sname, wasmType;
 *     &IR::null;
 *   };
 *
 * Supported constructs:
 *   - `@local name = expr;`              — bind a local in the body's scope
 *   - `&Compiler::a::b::c(args)`         — call into the CompilerAPI
 *   - `&IR::null`                        — sentinel for "return null"
 *   - `Node.x.y`                         — field access on the bound node param
 *   - Int / Float / String / Bool literals
 *
 * The body's result is the value of its last item (or its trailing expression).
 * No control flow, no loops, no recursion — Phase 3 keeps the interpreter
 * minimal; later phases may extend it.
 */

import type { IRDefExpander, IRExpanderFn } from '../ir/expander'
import type { CompilerAPI } from '../compiler-api'

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Returns true if the body contains any `&Compiler::*` call or `@local`
 * definition — signalling that the body needs the rich-body interpreter
 * rather than the simple intrinsic-extraction path.
 */
export function isRichBody(body: any): boolean {
    function scan(node: any): boolean {
        if (!node || typeof node !== 'object') return false
        if (Array.isArray(node)) return node.some(scan)
        if (node.type === 'Namespace' && Array.isArray(node.path) && node.path[0] === 'Compiler') return true
        if (node.type === 'Definition' && node.keyword === '@local') return true
        for (const key of Object.keys(node)) {
            if (key === 'sourceLocation' || key === 'inferredType') continue
            if (scan(node[key])) return true
        }
        return false
    }
    return scan(body)
}

// ---------------------------------------------------------------------------
// Public compilation entry points
// ---------------------------------------------------------------------------

/** Compile a rich strata body into an IRDefExpander. The body sees the AST def node as `nodeParamName`. */
export function compileBodyToDefExpander(body: any, nodeParamName: string): IRDefExpander {
    return {
        expand(def, _name, api) {
            const scope: Scope = { [nodeParamName]: def }
            return evalBody(body, scope, api) as ReturnType<IRDefExpander['expand']>
        },
    }
}

/** Compile a rich strata body into an IRExpanderFn. The body sees the raw call-args array as `nodeParamName`. */
export function compileBodyToExpanderFn(body: any, nodeParamName: string): IRExpanderFn {
    return (rawArgs, api, inferredType) => {
        const scope: Scope = { [nodeParamName]: rawArgs, inferredType }
        return evalBody(body, scope, api) as ReturnType<IRExpanderFn>
    }
}

/**
 * Compile an AST Block node (from a `@stratum` on::* handler) into a
 * PhaseHandler function. The block receives the triggering AST node as
 * `nodeParamName` (default 'node').
 */
export function compileHandlerBlock(block: any, nodeParamName = 'node'): (node: any, api: any) => any {
    return (node, api) => {
        const scope: Scope = { [nodeParamName]: node }
        return evalBody(block, scope, api)
    }
}

/**
 * Compile an AST Block from a `@stratum on::comptime` handler into a
 * ComptimeHandler.  Args are *eagerly* evaluated and bound in the body's
 * scope as `arg0`, `arg1`, …  Lazy comptime forms (like `@if`) can't be
 * authored this way today — they remain intrinsic to the body interpreter.
 *
 * Example user stratum:
 *
 *   &Compiler::on::comptime '+', {
 *       arg0 + arg1
 *   };
 *
 * Caveat: a handler that uses the same operator it overrides recurses
 * infinitely (no super-call mechanism yet).  Override carefully.
 */
export function compileComptimeHandler(block: any): (rawArgs: any[], api: any, evalArg: (n: any) => any) => any {
    return (rawArgs, api, evalArg) => {
        const evaluated = rawArgs.map(evalArg)
        const scope: Scope = {}
        for (let i = 0; i < evaluated.length; i++) scope[`arg${i}`] = evaluated[i]
        return evalBody(block, scope, api)
    }
}

// ---------------------------------------------------------------------------
// Interpreter
// ---------------------------------------------------------------------------

type Scope = Record<string, any>

export class StrataBodyError extends Error {
    constructor(msg: string) { super(`[strata body] ${msg}`) }
}

/** Unwrap Element / Item / Statement wrapper nodes to their inner value. */
function unwrap(node: any): any {
    if (!node) return null
    if (node.type === 'Element' || node.type === 'Item' || node.type === 'Statement') {
        return unwrap(node.value)
    }
    return node
}

function evalBody(body: any, scope: Scope, api: CompilerAPI): any {
    if (!body) return null
    // Block body: walk items + trailing.  Single-expression body (e.g. an
    // `@fn handler := <expr>` form): evaluate the expression directly.
    if (body.type === 'Block') {
        let result: any = null
        for (const item of body.items ?? []) {
            result = evalStatement(item, scope, api)
        }
        if (body.trailing) {
            result = evalExpr(body.trailing, scope, api)
        }
        return result
    }
    return evalExpr(body, scope, api)
}

function evalStatement(stmt: any, scope: Scope, api: CompilerAPI): any {
    const node = unwrap(stmt)
    if (!node) return null

    // @local name = expr;
    if (node.type === 'Definition' && node.keyword === '@local') {
        const name = node.name?.name
        if (typeof name !== 'string') throw new StrataBodyError('@local definition missing name')
        const binding = Array.isArray(node.binding) ? node.binding[0] : node.binding
        const expr = binding?.expression ?? binding
        scope[name] = expr === undefined ? undefined : evalExpr(expr, scope, api)
        return null
    }

    return evalExpr(node, scope, api)
}

function evalExpr(expr: any, scope: Scope, api: CompilerAPI): any {
    const node = unwrap(expr)
    if (!node) return null

    switch (node.type) {
        case 'IntLiteral':     return parseIntLiteral(node.value)
        case 'FloatLiteral':   return parseFloat(node.value)
        case 'StringLiteral':  return node.value
        case 'BooleanLiteral': return node.value === true || node.value === 'true'

        case 'Namespace':     return evalNamespace(node, scope)
        case 'FunctionCall':  return evalCall(node, scope, api)
        case 'Binding':       return evalExpr(node.expression, scope, api)
        case 'BinaryOp':      return evalBinaryOp(node, scope, api)
        case 'Block':         return evalBody(node, scope, api)

        // Wrappers that should already be stripped, but be defensive.
        case 'Literal':
        case 'ExpressionStart':
        case 'ExpressionEnd':
            return evalExpr(node.value, scope, api)

        default:
            throw new StrataBodyError(`Unsupported expression: ${node.type}`)
    }
}

/**
 * BinaryOp evaluation dispatches to a comptime handler registered under the
 * operator symbol — `+`, `==`, `!=`, `<`, etc.  The built-in handlers live
 * in src/elaborator/comptimeBuiltins.ts and are registered automatically by
 * buildStrataRegistry.  User strata can override by registering a new
 * `on::comptime` handler for the same operator.
 */
function evalBinaryOp(node: any, scope: Scope, api: CompilerAPI): any {
    const op = node.operator
    const handler = api.lookupComptime?.(op)
    if (!handler) {
        throw new StrataBodyError(`No comptime handler for operator '${op}' — register one via on::comptime.`)
    }
    return handler([node.left, node.right], api, (n) => evalExpr(n, scope, api))
}

/** Resolve a `Node.x.y` or local-binding path against the body's scope. */
function evalNamespace(node: any, scope: Scope): any {
    const path: string[] = node.path ?? []
    if (path.length === 0) return undefined
    const head = path[0]
    if (!(head in scope)) {
        throw new StrataBodyError(`Unknown identifier '${head}' in strata body`)
    }
    let value: any = scope[head]
    for (let i = 1; i < path.length; i++) {
        if (value == null) return undefined
        value = value[path[i]]
    }
    return value
}

/** Dispatch &IR::null sentinels and &Compiler::*::method(args) calls. */
function evalCall(node: any, scope: Scope, api: CompilerAPI): any {
    const name = node.name

    // Builtin calls — `&@if`, `&@nil`, `&not`, `&@true` etc.
    // The parser stamps `isBuiltin=true` and `name` is a plain string (the
    // keyword token, e.g. '@if').  Builtins that need control flow over
    // their args (like @if) must look at the raw arg AST, not pre-evaluated
    // values — handled inside evalBuiltin.
    if (typeof name === 'string') {
        return evalBuiltin(name, node.args ?? [], scope, api)
    }

    if (!name || name.type !== 'Namespace') {
        throw new StrataBodyError(`Unsupported call name in strata body`)
    }
    const path: string[] = name.path ?? []
    if (path.length === 0) return null

    // &IR::xxx / &WASM::xxx — dispatch markers consumed by the strata loader
    // to identify the codegen kind / intrinsic.  Runtime no-op during body
    // execution.  Rich bodies build IR through &Compiler::ir::* constructors;
    // they never invoke a raw intrinsic, so silencing these is safe.
    if (path[0] === 'IR' || path[0] === 'WASM') {
        return null
    }

    // &Compiler::a::b::c(args) — walk the API object and invoke the method.
    if (path[0] === 'Compiler') {
        return invokeCompilerMethod(path.slice(1), node.args ?? [], scope, api)
    }

    // &compiler::fn_name(args) — interpreter compatibility shim for the
    // new-form host-imports surface (see src/comptime/imports.ts).  When
    // a migrated handler runs through the interpreter (because no
    // compiled instance is in registry.compiledHandlers), we translate
    // the i32-handle ABI into direct-value calls on the JS api.  Lets
    // a migrated `@fn Foo_lower` body work in BOTH the WASM-compiled
    // path AND the interpreter path until full dissolution.
    if (path[0] === 'compiler' && path.length === 2) {
        const fnName = path[1]
        const rawArgs = node.args ?? []
        const args = rawArgs.map((a: any) => evalExpr(a, scope, api))
        return invokeCompilerInteropShim(fnName, args, api)
    }

    // &localVar::method(args) — method call on a scope-bound value.
    // Enables: &stateHandle::set 'key', val  and  &stateHandle::get 'key'.
    if (path[0] in scope) {
        let target: any = scope[path[0]]
        for (let i = 1; i < path.length - 1; i++) {
            if (target == null) throw new StrataBodyError(`Null segment '${path[i]}' on '${path[0]}'`)
            target = target[path[i]]
        }
        const methodName = path[path.length - 1]
        const method = target?.[methodName]
        if (typeof method === 'function') {
            const args = (node.args ?? []).map((a: any) => evalExpr(a, scope, api))
            return method.apply(target, args)
        }
        throw new StrataBodyError(`'${path[0]}.${methodName}' is not a callable method`)
    }

    throw new StrataBodyError(`Unsupported call namespace '${path[0]}' in strata body`)
}

/**
 * Dispatch a `&@token args...` builtin call inside a strata body.
 *
 *   `@if` is the one irreducible primitive — it has to exist so every other
 *   comptime handler can branch internally.  All other builtins (`@nil`,
 *   `@true`, `@false`, `@not`, and the binary operators) are looked up in
 *   the registry's comptime-handler table.  Built-in semantics are
 *   registered into that table by registerBuiltinComptimeHandlers when
 *   the registry is created; user strata can override by registering an
 *   `on::comptime` handler under the same token.
 */
function evalBuiltin(name: string, args: any[], scope: Scope, api: CompilerAPI): any {
    // `@if` is intrinsic.  We can't dispatch it through the registry because
    // any comptime handler we'd write for it would itself need a way to
    // branch — and that's exactly what @if provides.  Pin it here as the
    // bootstrap primitive.
    if (name === '@if') {
        if (args.length < 2) {
            throw new StrataBodyError(`&@if requires at least cond and then-branch`)
        }
        const cond = evalExpr(args[0], scope, api)
        if (strataTruthy(cond)) return evalExpr(args[1], scope, api)
        if (args.length >= 3)   return evalExpr(args[2], scope, api)
        return null
    }

    // Everything else: dispatch through the registry.
    const handler = api.lookupComptime?.(name)
    if (!handler) {
        throw new StrataBodyError(
            `No comptime handler for builtin '${name}' — register one via on::comptime.`
        )
    }
    return handler(args, api, (n) => evalExpr(n, scope, api))
}

/** Strata-body truthiness: null/undefined/false/0/'' are falsy; everything
 *  else (including {} and []) is truthy.  Kept local because @if's intrinsic
 *  branch decision needs it.  The same rule is duplicated in
 *  comptimeBuiltins.ts for the registered handlers (e.g. `@not`); they must
 *  agree, but the duplication is small and self-contained. */
function strataTruthy(v: any): boolean {
    if (v == null) return false
    if (v === false) return false
    if (v === 0) return false
    if (v === '') return false
    return true
}

function invokeCompilerMethod(
    pathFromCompiler: string[],
    rawArgs: any[],
    scope: Scope,
    api: CompilerAPI,
): any {
    if (pathFromCompiler.length === 0) {
        throw new StrataBodyError('&Compiler:: call requires at least one segment')
    }
    let target: any = api
    for (let i = 0; i < pathFromCompiler.length - 1; i++) {
        if (target == null) {
            throw new StrataBodyError(`Compiler path segment '${pathFromCompiler[i]}' is null/undefined`)
        }
        target = target[pathFromCompiler[i]]
    }
    const methodName = pathFromCompiler[pathFromCompiler.length - 1]
    const method = target?.[methodName]
    if (typeof method !== 'function') {
        throw new StrataBodyError(
            `&Compiler::${pathFromCompiler.join('::')} is not a function on the CompilerAPI`
        )
    }
    const args = rawArgs.map(a => evalExpr(a, scope, api))
    return method.apply(target, args)
}

// ---------------------------------------------------------------------------
// Interpreter compatibility shim for the new-form `&compiler::*` imports.
//
// The host imports in src/comptime/imports.ts are designed for the WASM
// boundary — strings cross as i32 string-pool ids, AST nodes as handle
// ids, IR nodes as handle ids.  The interpreter operates on raw JS
// values directly.  This shim translates between the two so a single
// `@fn handler := { &compiler::ir_makeConst 42, 'i32' }` body works
// in both paths.
//
// Each `&compiler::fn_name args` here gets the same arg ordering as the
// WASM import, but the args themselves are raw JS values (strings, AST
// nodes, IR objects) instead of i32 ids.  The return is also a raw
// value — IRConst object instead of an irHandle id.
// ---------------------------------------------------------------------------

function invokeCompilerInteropShim(fnName: string, args: any[], api: CompilerAPI): any {
    // String interning is a no-op on the interpreter side — return the
    // raw string back so subsequent calls can use it directly.
    if (fnName === 'compiler_str_intern') return args[0] ?? ''

    // AST field accessors — walk dotted path; return value directly.
    if (fnName === 'compiler_ast_str_field' || fnName === 'compiler_ast_node_field') {
        return walkAstPath(args[0], args[1])
    }

    // Tagged-field interface — return raw value (interpreter ignores tag).
    if (fnName === 'compiler_ast_field') return walkAstPath(args[0], args[1])
    if (fnName === 'compiler_tag_kind')  return 0
    if (fnName === 'compiler_tag_value') return args[0]

    // Utility helpers — direct delegation.
    if (fnName === 'compiler_watId')       return api.watId(String(args[0] ?? ''))
    if (fnName === 'compiler_freshId')     return api.freshId(String(args[0] ?? 'tmp'))
    if (fnName === 'compiler_arg')         return args[0]?.args?.[args[1] | 0]
    if (fnName === 'compiler_choose')      return args[0] ? args[1] : args[2]
    if (fnName === 'compiler_isVarName')   return api.isVarName(String(args[0] ?? '')) ? 1 : 0

    // Lowering helpers.
    if (fnName === 'compiler_lowerExpr')          return api.lowerExpr(args[0])
    if (fnName === 'compiler_lowerExprIfDefined') return api.lowerExprIfDefined(args[0])
    if (fnName === 'compiler_lowerParams')        return api.lowerParams(args[0])
    if (fnName === 'compiler_lowerFunctionBody')  return api.lowerFunctionBody(args[0], args[1])
    if (fnName === 'compiler_resolveFunctionReturnType') {
        return api.resolveFunctionReturnType(args[0], String(args[1] ?? ''), args[2])
    }
    if (fnName === 'compiler_resolveType')        return api.resolveType(args[0])

    // funcResult struct accessors — interpreter just sees plain objects.
    if (fnName === 'compiler_funcResult_body')   return args[0]?.body
    if (fnName === 'compiler_funcResult_locals') return args[0]?.locals

    // Array builders — interpreter uses plain arrays.
    if (fnName === 'compiler_arr_new')      return []
    if (fnName === 'compiler_arr_push')     { if (Array.isArray(args[0])) args[0].push(args[1]); return undefined }
    if (fnName === 'compiler_arr_push_str') { if (Array.isArray(args[0])) args[0].push(args[1]); return undefined }
    if (fnName === 'compiler_arr_len')      return Array.isArray(args[0]) ? args[0].length : 0
    if (fnName === 'compiler_arr_get')      return Array.isArray(args[0]) ? args[0][args[1] | 0] : undefined

    // IR builders — translate kebab-style flat-arg form to api.ir.* calls.
    if (fnName === 'ir_makeConst')     return api.ir.makeConst(args[0] | 0, String(args[1] || 'i32') as any)
    if (fnName === 'ir_makeLocalGet')  return api.ir.makeLocalGet(String(args[0] ?? ''), String(args[1] || 'i32') as any)
    if (fnName === 'ir_makeLocalSet')  return api.ir.makeLocalSet(String(args[0] ?? ''), args[1])
    if (fnName === 'ir_makeGlobalGet') return api.ir.makeGlobalGet(String(args[0] ?? ''), String(args[1] || 'i32') as any)
    if (fnName === 'ir_makeGlobalSet') return api.ir.makeGlobalSet(String(args[0] ?? ''), args[1])
    if (fnName === 'ir_makeBinOp')     return api.ir.makeBinOp(String(args[0] ?? ''), args[1], args[2], String(args[3] || 'i32') as any)
    if (fnName === 'ir_makeBlock') {
        const stmts = Array.isArray(args[0]) ? args[0] : []
        const wt: any = args[2] ? String(args[2]) : undefined
        return api.ir.makeBlock(stmts, args[1] || undefined, wt)
    }
    if (fnName === 'ir_null')          return api.ir.null()
    if (fnName === 'ir_makeCall') {
        const callArgs = Array.isArray(args[1]) ? args[1] : []
        return api.ir.makeCall(
            String(args[0] ?? ''), callArgs,
            args[2] ? String(args[2]) as any : 'i32',
            args[3] ? String(args[3]) as 'user' | 'instr' : 'user',
        )
    }
    if (fnName === 'ir_makeIf')        return api.ir.makeIf(args[0], args[1], args[2] || undefined, args[3] ? String(args[3]) as any : undefined)
    if (fnName === 'ir_makeLoop')      return api.ir.makeLoop(args[0] | 0, args[1], args[2])
    if (fnName === 'ir_makeBreak')     return api.ir.makeBreak(args[0] | 0)
    if (fnName === 'ir_makeContinue')  return api.ir.makeContinue(args[0] | 0)
    if (fnName === 'ir_makeReturn')    return api.ir.makeReturn(args[0] || undefined)
    if (fnName === 'ir_makeExport')    return api.ir.makeExport(String(args[0] ?? ''), String(args[1] ?? ''), String(args[2] ?? 'func') as any)
    if (fnName === 'ir_makeLocal')     return api.ir.makeLocal(String(args[0] ?? ''), String(args[1] || 'i32') as any)
    if (fnName === 'ir_makeParam')     return { name: String(args[0] ?? ''), wasmType: String(args[1] || 'i32') }
    if (fnName === 'ir_makeGlobal')    return api.ir.makeGlobal(String(args[0] ?? ''), String(args[1] || 'i32') as any, !!args[2], args[3])
    if (fnName === 'ir_makeFunction')  return api.ir.makeFunction(String(args[0] ?? ''), args[1] ?? [], String(args[2] || 'void') as any, args[3] ?? [], args[4])
    if (fnName === 'ir_makeImport')    return api.ir.makeImport(String(args[0] ?? ''), String(args[1] ?? ''), String(args[2] ?? ''), args[3] ?? [], args[4] ? String(args[4]) as any : undefined)

    // Ctx accessors.
    if (fnName === 'compiler_ctx_locals_set')  { api.ctx.locals.set(String(args[0] ?? ''), String(args[1] || 'i32') as any); return }
    if (fnName === 'compiler_ctx_locals_get')  return api.ctx.locals.get(String(args[0] ?? '')) ?? ''
    if (fnName === 'compiler_ctx_globals_set') { api.ctx.globals.set(String(args[0] ?? ''), String(args[1] || 'i32') as any); return }
    if (fnName === 'compiler_ctx_globals_get') return api.ctx.globals.get(String(args[0] ?? '')) ?? ''
    if (fnName === 'compiler_ctx_varNames_add'){ api.ctx.varNames.add(String(args[0] ?? '')); return }
    if (fnName === 'compiler_ctx_varNames_has')return api.ctx.varNames.has(String(args[0] ?? '')) ? 1 : 0
    if (fnName === 'compiler_ctx_pendingLocals_push') { api.ctx.pendingLocals.push(args[0]); return }
    if (fnName === 'compiler_ctx_loopStack_push')     { api.ctx.loopStack.push(args[0] | 0); return }
    if (fnName === 'compiler_ctx_loopStack_pop')      return api.ctx.loopStack.pop() ?? 0
    if (fnName === 'compiler_ctx_loopStack_peek')     return api.ctx.loopStack.peek() ?? 0
    if (fnName === 'compiler_ctx_nextLoopId')         return api.ctx.nextLoopId()

    // Diagnostics.
    if (fnName === 'diag_error' || fnName === 'diag_warn') {
        // No accumulator available on api — silently drop.  The
        // WASM-side path goes through env.registry.diagnostics; the
        // interpreter doesn't have the same accumulator wiring.
        return
    }

    // Module accumulators.
    if (fnName === 'module_push_definition') { api.module.push_definition(args[0]); return }
    if (fnName === 'module_push_global')     { api.module.push_global(String(args[0] ?? ''), args[1], args[2]); return }

    // Type primitives.
    if (fnName === 'type_int')    return api.type.int
    if (fnName === 'type_int64')  return api.type.int64
    if (fnName === 'type_float')  return api.type.float
    if (fnName === 'type_bool')   return api.type.bool
    if (fnName === 'type_string') return api.type.string
    if (fnName === 'type_void')   return api.type.void
    if (fnName === 'type_variable') return api.type.variable(String(args[0] ?? 'T'))
    if (fnName === 'type_array')    return api.type.array(args[0])
    if (fnName === 'type_equals')   return api.type.equals(args[0], args[1]) ? 1 : 0
    if (fnName === 'type_format')   return api.type.format(args[0])
    if (fnName === 'type_substitute')    return api.type.substitute(args[0], args[1] instanceof Map ? args[1] : new Map())
    if (fnName === 'type_mangle_suffix') return api.type.mangle_suffix(args[0] instanceof Map ? args[0] : new Map())

    // AST manipulation.
    if (fnName === 'ast_capture_template') return api.ast.capture_template(args[0], args[1] === 'post' ? 'post' : 'pre')
    if (fnName === 'ast_clone')            return api.ast.clone(args[0])
    if (fnName === 'ast_with_keyword')     return api.ast.with_keyword(args[0], String(args[1] ?? ''))
    if (fnName === 'ast_with_name')        return api.ast.with_name(args[0], String(args[1] ?? ''))
    if (fnName === 'ast_rewrite_call')     { api.ast.rewrite_call(args[0], String(args[1] ?? '')); return }
    if (fnName === 'ast_patch_types')      return api.ast.patch_types(args[0], args[1] instanceof Map ? args[1] : new Map())

    throw new StrataBodyError(`Unsupported compiler shim function '${fnName}' in strata body`)
}

/** Walk a dotted path (with numeric segments for array indexing) on an
 *  AST node and return the leaf value.  Mirrors compiler_ast_field /
 *  compiler_ast_str_field / compiler_ast_node_field on the host side. */
function walkAstPath(node: any, path: any): any {
    if (node == null) return undefined
    const p: string = typeof path === 'string' ? path : ''
    if (!p) return node
    let cur = node
    for (const part of p.split('.')) {
        if (cur == null) return undefined
        if (/^\d+$/.test(part)) {
            const i = parseInt(part, 10)
            cur = Array.isArray(cur) ? cur[i] : undefined
        } else {
            cur = cur[part]
        }
    }
    return cur
}

// ---------------------------------------------------------------------------
// Literal helpers (mirror the IR lowerer's parseIntLiteral semantics).
// ---------------------------------------------------------------------------

function parseIntLiteral(raw: string | number | undefined): number {
    if (typeof raw === 'number') return raw
    if (typeof raw !== 'string') return 0
    const cleaned = raw.replace(/_/g, '')
    if (cleaned.startsWith('0b') || cleaned.startsWith('0B')) return parseInt(cleaned.slice(2), 2)
    if (cleaned.startsWith('0x') || cleaned.startsWith('0X')) return parseInt(cleaned.slice(2), 16)
    if (cleaned.startsWith('0o') || cleaned.startsWith('0O')) return parseInt(cleaned.slice(2), 8)
    return parseInt(cleaned, 10)
}
