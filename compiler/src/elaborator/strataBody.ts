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
    let result: any = null
    for (const item of body.items ?? []) {
        result = evalStatement(item, scope, api)
    }
    if (body.trailing) {
        result = evalExpr(body.trailing, scope, api)
    }
    return result
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
