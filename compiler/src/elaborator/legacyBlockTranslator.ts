// SPDX-License-Identifier: MIT
/**
 * Legacy-block AST translator (D-E-3 PR 1, Stage 1)
 *
 * Converts an inline-block handler body written in the legacy
 * `&Compiler::*` interpreter syntax into the new-form
 * `&compiler::*` host-imports syntax.  After translation the block
 * can be wrapped in a synthetic `@fn` and compiled through the Phase C
 * engine — no AST-walking interpreter required at fire time.
 *
 * Translation rules:
 *
 *   1. Namespace flattening
 *        &Compiler::a::b::c args            → &compiler::a_b_c <args>
 *      The 'Compiler' segment is dropped; remaining segments are
 *      joined with '_'.  e.g. Compiler::diag::warn → compiler::diag_warn.
 *
 *   2. String-literal wrapping in arg position
 *      Any StringLiteral arg passed to a translated &compiler::* call
 *      is wrapped with a compiler_str_intern call so the host import
 *      receives a StringPool id.  Numeric / handle / variable args
 *      pass through unchanged.
 *
 *   3. Node-field access (Node.x.y dotted Namespace)
 *      Namespace whose first segment matches the handler's param name
 *      and has additional segments → a compiler_ast_str_field call
 *      reading the dotted path as a string id.  Pure-node-handle access
 *      is the same shape (returns string id; callers that need a handle
 *      use compiler_ast_node_field manually).
 *
 *   4. Special-case: &Compiler::state 'stratum' / 'instance'
 *      These have no args in the new form — they pick a dedicated host
 *      import based on the literal.  state 'stratum' → state_stratum,
 *      state 'instance' → state_instance.
 *
 *   5. Scope-variable method calls (&handle::set k, v / &handle::get k)
 *      These look like Namespace path [handleName, 'set'] or
 *      [handleName, 'get'].  The translator can't distinguish state
 *      handles from other locals, so it dispatches by method name:
 *      set/get → state_set / state_get with the handle as the first arg.
 *
 *   6. Untranslated patterns
 *      Constructs the translator doesn't recognise (e.g. arithmetic in
 *      comptime-handler bodies like `arg0 + arg1`) pass through
 *      unchanged.  Silicon's normal lowering handles them when the
 *      synthetic @fn is compiled.
 *
 *   7. @local declarations, @if expressions, literals
 *      Pass through unchanged.  They lower naturally inside a @fn body.
 */

interface TranslatorCtx {
    paramName: string
    /** Names bound by @local declarations inside this block.  Used to
     *  distinguish scope-variable method calls from Compiler:: calls. */
    locals: Set<string>
}

/** Deep-clone a node so the translator can rewrite without mutating input. */
function clone(node: any): any {
    if (!node || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(clone)
    const out: any = {}
    for (const k of Object.keys(node)) out[k] = clone(node[k])
    return out
}

/** Wrap a StringLiteral node with a `(&compiler::compiler_str_intern <lit>, 0)` call. */
function wrapStringLiteralAsInternCall(litNode: any): any {
    return {
        type: 'FunctionCall',
        name: { type: 'Namespace', path: ['compiler', 'compiler_str_intern'] },
        isBuiltin: false,
        args: [litNode, { type: 'IntLiteral', value: '0' }],
    }
}

/** Build a `&compiler::<fn> args...` call AST node. */
function compilerCall(fn: string, args: any[]): any {
    return {
        type: 'FunctionCall',
        name: { type: 'Namespace', path: ['compiler', fn] },
        isBuiltin: false,
        args,
    }
}

/** Build a StringLiteral with the given content. */
function strLit(s: string): any {
    return { type: 'StringLiteral', value: s }
}

/**
 * Per-call adapters that reshape legacy argument lists to match the
 * new-form host import's signature.  The legacy &Compiler::* APIs took
 * variadic/loosely-typed args; the new &compiler::* imports have
 * fixed-arity i32 schemas.  Adapters bridge the gap.
 *
 * Each entry returns the translated arg list.  `defaultTranslate` is
 * "translate + wrap StringLiteral with intern" — the common case.
 */
type ArgAdapter = (legacyArgs: any[], ctx: TranslatorCtx) => any[]

const intLit0 = (): any => ({ type: 'IntLiteral', value: '0' })

function defaultTranslateArgs(args: any[], ctx: TranslatorCtx): any[] {
    return args.map(a => {
        const t = translateNode(a, ctx)
        if (t?.type === 'StringLiteral') return wrapStringLiteralAsInternCall(t)
        return t
    })
}

const CALL_ADAPTERS: Record<string, ArgAdapter> = {
    // diag::error / diag::warn — legacy (code, span, message, [hint]).
    // New signature: (codeStr, spanH, messageStr, hintStr).  spanH is an
    // env.handles id; legacy's `span` string literal isn't meaningful in
    // the new form, so we pass 0 (empty span).  hint defaults to 0 if
    // legacy didn't supply it.
    diag_error: (args, ctx) => {
        const code = args[0] ? defaultTranslateArgs([args[0]], ctx)[0] : intLit0()
        const msg  = args[2] ? defaultTranslateArgs([args[2]], ctx)[0] : intLit0()
        const hint = args[3] ? defaultTranslateArgs([args[3]], ctx)[0] : intLit0()
        return [code, intLit0(), msg, hint]
    },
    diag_warn: (args, ctx) => {
        const code = args[0] ? defaultTranslateArgs([args[0]], ctx)[0] : intLit0()
        const msg  = args[2] ? defaultTranslateArgs([args[2]], ctx)[0] : intLit0()
        const hint = args[3] ? defaultTranslateArgs([args[3]], ctx)[0] : intLit0()
        return [code, intLit0(), msg, hint]
    },

    // ir::makeIf — legacy (cond, then, else_).  New: (condH, thenH,
    // elseH, wasmTypeStr).  Pad wasmType to 0 (infer from then-branch).
    ir_makeIf: (args, ctx) => {
        const t = defaultTranslateArgs(args, ctx)
        while (t.length < 4) t.push(intLit0())
        return t
    },

    // ir::makeImport — legacy ('env', name, name, params, result).
    // New: (envStr, fieldStr, nameStr, paramsArrH, resultStr).  Identical
    // shape; defaultTranslate handles it.

    // ir::makeReturn — legacy (value?).  New: (valueH).  Pad to 1.
    ir_makeReturn: (args, ctx) => {
        const t = defaultTranslateArgs(args, ctx)
        if (t.length === 0) t.push(intLit0())
        return t
    },
}

/**
 * Translate one Namespace path (FunctionCall.name) and its args.
 * Returns the new-form FunctionCall AST node.
 *
 * Handles `Compiler::*` paths.  Other paths are caller's responsibility.
 */
function translateCompilerCall(path: string[], args: any[], ctx: TranslatorCtx): any {
    // path[0] must be 'Compiler'; path[1..] is the method to translate.
    const rest = path.slice(1)
    if (rest.length === 0) return compilerCall('', defaultTranslateArgs(args, ctx))

    // Special-case: &Compiler::state 'stratum' / 'instance' → state_stratum / state_instance.
    if (rest.length === 1 && rest[0] === 'state' && args.length >= 1) {
        const arg0 = args[0]
        const which = arg0?.type === 'StringLiteral' ? arg0.value : ''
        if (which === 'stratum')  return compilerCall('state_stratum',  [])
        if (which === 'instance') return compilerCall('state_instance', [])
    }

    // Flatten the path: a::b::c → a_b_c.
    const flatName = rest.join('_')

    // Per-call adapter (for APIs whose arg shape differs from legacy)
    // or the default translate-and-wrap-strings.
    const adapter = CALL_ADAPTERS[flatName]
    const translatedArgs = adapter ? adapter(args, ctx) : defaultTranslateArgs(args, ctx)

    return compilerCall(flatName, translatedArgs)
}

/**
 * Translate a &handle::method call where `handle` is a scope-variable
 * (typically a state bucket).  Currently handles set/get.
 */
function translateScopeMethodCall(handleName: string, method: string, args: any[], ctx: TranslatorCtx): any {
    const handleRef = { type: 'Namespace', path: [handleName] }
    if (method === 'set' || method === 'get') {
        // state_set(bucketId, keyId, valueId) — wrap key literal, leave value as-is.
        const translatedArgs = args.map((a, i) => {
            const t = translateNode(a, ctx)
            // First arg (key) is a string id, wrap StringLiteral.  Subsequent args
            // are values, leave alone (the handler will pass them as i32 ids).
            if (i === 0 && t?.type === 'StringLiteral') return wrapStringLiteralAsInternCall(t)
            return t
        })
        return compilerCall(`state_${method}`, [handleRef, ...translatedArgs])
    }
    if (method === 'has') {
        const translatedArgs = args.map(a => {
            const t = translateNode(a, ctx)
            if (t?.type === 'StringLiteral') return wrapStringLiteralAsInternCall(t)
            return t
        })
        return compilerCall('state_has', [handleRef, ...translatedArgs])
    }
    // Unknown method — leave the original call shape so test output surfaces it.
    return {
        type: 'FunctionCall',
        name: { type: 'Namespace', path: [handleName, method] },
        isBuiltin: false,
        args: args.map(a => translateNode(a, ctx)),
    }
}

/**
 * Translate a dotted Namespace path that starts with the handler's
 * param name (e.g. `node.name.name`) into a compiler_ast_str_field call.
 */
function translateNodeFieldAccess(path: string[], ctx: TranslatorCtx): any {
    const fieldPath = path.slice(1).join('.')
    return compilerCall('compiler_ast_str_field', [
        { type: 'Namespace', path: [ctx.paramName] },
        wrapStringLiteralAsInternCall(strLit(fieldPath)),
    ])
}

/**
 * Top-level node translator — recursively rewrites the AST.
 */
function translateNode(node: any, ctx: TranslatorCtx): any {
    if (!node || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(n => translateNode(n, ctx))

    // FunctionCall — the main translation target.
    if (node.type === 'FunctionCall') {
        const name = node.name
        const args: any[] = node.args ?? []

        // &@token (builtin keyword like @if, @local, @true) — pass through.
        if (typeof name === 'string') {
            return { ...node, args: args.map(a => translateNode(a, ctx)) }
        }

        if (name?.type === 'Namespace' && Array.isArray(name.path)) {
            const path: string[] = name.path

            // &Compiler::* — translate via translateCompilerCall.
            if (path[0] === 'Compiler') {
                return translateCompilerCall(path, args, ctx)
            }

            // &handle::method (scope-variable method dispatch) — translate
            // if the handle is a known @local in this block.
            if (path.length === 2 && ctx.locals.has(path[0])) {
                return translateScopeMethodCall(path[0], path[1], args, ctx)
            }

            // Anything else (user @fn call, &@token Namespace form, etc.) — translate args.
            return { ...node, args: args.map(a => translateNode(a, ctx)) }
        }

        // Unknown name shape — recurse into args defensively.
        return { ...node, args: args.map(a => translateNode(a, ctx)) }
    }

    // Namespace (bare reference, not a call): could be a node-field access
    // like `Node.name.name`.  Translate to compiler_ast_str_field.
    if (node.type === 'Namespace' && Array.isArray(node.path)) {
        const path: string[] = node.path
        if (path.length > 1 && path[0] === ctx.paramName) {
            return translateNodeFieldAccess(path, ctx)
        }
        return node
    }

    // @local declaration — track the name in ctx.locals so subsequent
    // scope-variable method calls can be recognised.
    if (node.type === 'Definition' && node.keyword === '@local') {
        const name = node.name?.name
        if (typeof name === 'string') ctx.locals.add(name)
        // Translate the binding's expression.
        const binding = node.binding
        if (binding?.expression) {
            return {
                ...node,
                binding: { ...binding, expression: translateNode(binding.expression, ctx) },
            }
        }
        return node
    }

    // Block — recurse into items + trailing.
    if (node.type === 'Block') {
        return {
            ...node,
            items:    (node.items ?? []).map((it: any) => translateNode(it, ctx)),
            trailing: node.trailing ? translateNode(node.trailing, ctx) : node.trailing,
        }
    }

    // Wrapper nodes (Element, Item, Statement) — translate their inner value.
    if (node.type === 'Element' || node.type === 'Item' || node.type === 'Statement') {
        return { ...node, value: translateNode(node.value, ctx) }
    }

    // Generic recurse — translate every field's value defensively.
    const out: any = {}
    for (const k of Object.keys(node)) {
        out[k] = translateNode(node[k], ctx)
    }
    return out
}

/**
 * Public API: translate an inline-block handler body from the legacy
 * `&Compiler::*` form to the new `&compiler::*` form.
 *
 * The returned AST is deep-cloned — the input is not mutated.  Pass
 * the resulting body to a synthetic `@fn` (paramName-typed `:Int`) and
 * compile via the Phase C engine.
 *
 * @param block      Inline-block AST node (typically a Block or a
 *                   single FunctionCall used as a handler body).
 * @param paramName  Name to use for the synthetic @fn's node parameter
 *                   (defaults to 'node').  Used to detect node-field
 *                   access in the body.
 */
export function translateLegacyBlock(block: any, paramName: string = 'node'): any {
    if (!block) return block
    const ctx: TranslatorCtx = { paramName, locals: new Set() }
    return translateNode(clone(block), ctx)
}
