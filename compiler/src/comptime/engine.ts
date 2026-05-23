/**
 * Comptime engine — compile strata handler @fns to WASM and run them.
 *
 * Phase C of the dissolution.  The handler @fn body, instead of being
 * interpreted via `compileHandlerBlock`, is compiled through the normal
 * Sigil pipeline (lowerProgram → emitModule → watToWasm), instantiated
 * with the host imports from `imports.ts`, and invoked when the handler
 * fires.
 *
 * Boundary status today:
 *   - Handlers whose body uses NO `&Compiler::*` calls compile and run
 *     end-to-end through this engine.
 *   - Handlers whose body uses `&Compiler::*` calls still need @extern
 *     declarations + a fuller import surface; for those, the interpreter
 *     path (Phase A) keeps working.  Phase D migration is what closes
 *     this gap one handler at a time.
 *
 * The engine is wired in opportunistically: if a handler's body is simple
 * enough that the lowerer can produce a clean WASM function, we use the
 * compiled path; otherwise we fall back to the interpreter.  Same
 * observable behavior either way — that's the whole point of the
 * dissolution as a *bridge*, not a flag-day switch.
 */

import type { Program } from '../ast/astNodes'
import type { ElaboratorRegistry } from '../elaborator/registry'
import elaborate from '../elaborator/elaborator'
import { lowerProgram } from '../ir/lower'
import { emitModule } from '../ir/emit'
import { watToWasm } from '../codegen/toWasm'
import { createComptimeEnv, createComptimeImports, type ComptimeEnv } from './imports'

/** A compiled handler instance — the result of running an @fn through the
 *  WASM pipeline.  `invoke(arg)` calls the exported function with a single
 *  i32 argument (the AST node handle) and returns the i32 result. */
export interface CompiledHandler {
    invoke(arg: number): number
    env: ComptimeEnv
}

/**
 * Compile a single handler @fn into a runnable WASM instance.
 *
 *   1. Build a synthetic program containing just the handler @fn,
 *      with its name temporarily removed from `strataHandlerFnNames`
 *      so the lowerer doesn't skip it.
 *   2. Add an export for the handler so JS can call it.
 *   3. Lower → WAT → WASM via the existing pipeline.
 *   4. Instantiate with the host imports.
 *   5. Return a callable wrapping `instance.exports[name]`.
 *
 * Restrictions today (Phase C minimum):
 *   - Handler body must use no `&Compiler::*` calls (those need @extern
 *     declarations not yet generated here).
 *   - Handler must take a single i32 param and return an i32 (the natural
 *     shape for a handler whose only arg is an AST-node handle).
 *
 * Throws if the handler isn't found or compilation fails — callers
 * (`tryCompileHandler`) catch and fall back to the interpreter.
 */
export async function compileHandlerToWasm(
    handlerName: string,
    program: Program,
    registry: ElaboratorRegistry,
): Promise<CompiledHandler> {
    // Find the handler @fn in the program.
    const handlerDef = findHandlerDef(handlerName, program)
    if (!handlerDef) {
        throw new Error(`[comptime] handler @fn '${handlerName}' not found in program`)
    }

    // Build the synthetic program: just the handler @fn + an explicit
    // export so the JS side can call it.
    const exportDef = {
        type: 'Definition',
        keyword: '@export',
        hook: 'export',
        name: { name: handlerName, type: 'TypedIdentifier' },
        params: [],
    }
    const syntheticProg = {
        type: 'Program',
        elements: [handlerDef, exportDef],
    }

    // Temporarily unclaim the handler name so lowerDefinition processes it.
    // We restore the claim immediately after lowering so the *real* lowering
    // pass (when the user's full program runs) still skips it.
    const wasClaimed = registry.strataHandlerFnNames.has(handlerName)
    registry.strataHandlerFnNames.delete(handlerName)
    let wat: string
    try {
        // Elaborate first so the @fn gets its `hook: 'function'` stamp.
        const elaborated = elaborate(syntheticProg as any, registry)
        const mod = lowerProgram(elaborated.program, registry, new Map())
        wat = emitModule(mod)
    } finally {
        if (wasClaimed) registry.strataHandlerFnNames.add(handlerName)
    }

    // Assemble + instantiate.
    const wasm = await watToWasm(wat)
    const env = createComptimeEnv(registry)
    const imports = createComptimeImports(env)
    let instance: WebAssembly.Instance
    try {
        const result = await WebAssembly.instantiate(wasm, imports)
        instance = result.instance
    } catch (e: any) {
        // Likely an unresolved @extern (`&Compiler::*` call) — Phase C
        // minimum can't handle those yet.  Re-throw with a clearer message.
        throw new Error(
            `[comptime] instantiation failed for '${handlerName}' — likely uses ` +
            `&Compiler::* calls not yet wired to imports. Falling back to interpreter is correct.`
            + ` Cause: ${e.message ?? e}`
        )
    }

    const exportFn = (instance.exports as any)[handlerName]
    if (typeof exportFn !== 'function') {
        throw new Error(`[comptime] export '${handlerName}' not found or not a function`)
    }

    return {
        invoke: (arg: number) => Number(exportFn(arg) ?? 0),
        env,
    }
}

/** Best-effort: try to compile and return the instance, or `null` if
 *  compilation fails for any reason.  Callers should fall back to the
 *  interpreter path on `null`.  This is what makes Phase C an opt-in
 *  bridge: every handler that *can* compile runs as WASM; others stay
 *  on the interpreter until Phase D migrates them. */
export async function tryCompileHandler(
    handlerName: string,
    program: Program,
    registry: ElaboratorRegistry,
): Promise<CompiledHandler | null> {
    try {
        return await compileHandlerToWasm(handlerName, program, registry)
    } catch {
        return null
    }
}

/**
 * Opt-in pre-compile pass.  Walks every `@fn` claimed as a strata handler,
 * attempts to compile each to WASM, and stashes the successful ones in
 * `registry.compiledHandlers`.  The named-handler wrapper in strataLoader
 * checks this cache first at fire time — when a compiled instance exists,
 * the handler runs as WASM; otherwise it falls back to the interpreter.
 *
 * Async by nature (WebAssembly.instantiate).  Call after buildStrataRegistry
 * if you want compile-then-run active for this build.  Default Sigil
 * pipeline doesn't call it — interpreter remains the default until Phase D
 * has migrated every strata.  Returns the count of handlers compiled.
 */
export async function compileStrataHandlers(
    program: Program,
    registry: ElaboratorRegistry,
): Promise<number> {
    // Snapshot the set first — compileHandlerToWasm transiently mutates
    // it (delete-then-readd around the synthetic lowering), and iterating
    // a Set while it's being mutated has surprised us in test runners.
    const names = Array.from(registry.strataHandlerFnNames)
    let count = 0
    for (const name of names) {
        const compiled = await tryCompileHandler(name, program, registry)
        if (compiled) {
            registry.compiledHandlers.set(name, compiled)
            count++
        }
    }
    return count
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function findHandlerDef(name: string, program: Program): any | null {
    for (const el of (program.elements ?? []) as any[]) {
        const def = unwrap(el)
        if (def?.keyword === '@fn' && def.name?.name === name) {
            return def
        }
    }
    return null
}

function unwrap(node: any): any {
    if (!node) return null
    if (node.type === 'Element') return unwrap(node.value)
    if (node.type === 'Item') return unwrap(node.value)
    if (node.type === 'Statement') return unwrap(node.value)
    return node
}
