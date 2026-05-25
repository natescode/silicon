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
import { translateLegacyBlock } from '../elaborator/legacyBlockTranslator'
import { lowerProgram } from '../ir/lower'
import { emitModule } from '../ir/emit'
import { loadStdWat } from '../codegen'
import { watToWasm, watToWasmSync } from '../codegen/toWasm'
import { loadModules } from '../modules/loader'
import type { ModuleRegistry } from '../modules/registry'
import { createComptimeEnv, createComptimeImports, type ComptimeEnv } from './imports'

/**
 * Lazily-loaded ModuleRegistry containing only the built-in env modules
 * (including the `compiler` module).  Handler @fn bodies that use
 * `&compiler::ir_makeConst …` resolve through this so the lowerer
 * generates the right `(import "compiler" "ir_makeConst" …)` IR.
 *
 * Cached for the lifetime of the process — re-reading the .si files on
 * every handler compile would be wasteful.  Tests that need a fresh
 * registry can call `getBuiltinModuleRegistry()` and clear after.
 */
let _builtinModules: ModuleRegistry | undefined
function getBuiltinModuleRegistry(): ModuleRegistry {
    if (!_builtinModules) _builtinModules = loadModules()
    return _builtinModules
}

/**
 * Process-lifetime cache of compiled `WebAssembly.Module` objects for T0
 * (built-in strata) handlers.  T0 handler WAT is deterministic — same body
 * source + same T0 registry state = same WAT every time — so we only pay
 * the `watToWasmSync` + `WebAssembly.Module` cost once per process, not once
 * per `buildStrataRegistry` call.
 *
 * Only populated when `(registry as any).__t0Phase === true` (set by
 * `strataLoader.ts` around the T0 `compileStrataHandlers` call).
 * T1/T2 user-defined handlers are never cached here.
 */
const _t0ModuleCache = new Map<string, WebAssembly.Module>()

/** Clear the T0 handler module cache.  Only needed in tests that swap out
 *  built-in strata source between calls. */
export function clearT0ModuleCache(): void {
    _t0ModuleCache.clear()
}

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
export function compileHandlerToWasm(
    handlerName: string,
    program: Program,
    registry: ElaboratorRegistry,
): CompiledHandler {
    const isT0Phase = (registry as any).__t0Phase === true

    // T0 fast path: if we already compiled this handler's WebAssembly.Module
    // in a prior buildStrataRegistry call, skip the entire elaborate/lower/emit/
    // watToWasmSync pipeline — just re-instantiate with the new registry's imports.
    let cachedMod = isT0Phase ? _t0ModuleCache.get(handlerName) : undefined
    if (!cachedMod) {
        // Full pipeline — find the @fn, elaborate, lower, emit WAT, compile.
        // Mutates nothing on the hot path; the result is stashed in cachedMod
        // and optionally added to _t0ModuleCache below.
        cachedMod = _compileHandlerToModule(handlerName, program, registry)
        if (isT0Phase) _t0ModuleCache.set(handlerName, cachedMod)
    }

    // Always instantiate fresh so the handler's imports are bound to the
    // current registry (pendingDefinitions, diagnostics, etc. are per-compile).
    const env = createComptimeEnv(registry)
    const imports = createComptimeImports(env)
    // std.wat declares `env::print` / `env::read` for host-embed runtimes.
    // Handlers never use these — but the module still requires the imports
    // to instantiate.  Stub them: print is a no-op, read returns 0.
    ;(imports as any).env = {
        print: (_: number) => {},
        read:  () => 0,
        ...((imports as any).env ?? {}),
    }
    let instance: WebAssembly.Instance
    try {
        instance = new WebAssembly.Instance(cachedMod, imports)
    } catch (e: any) {
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
    const memory = (instance.exports as any).memory as WebAssembly.Memory | undefined
    if (memory) env.memory = memory

    return {
        invoke: (arg: number) => Number(exportFn(arg) ?? 0),
        env,
    }
}

/**
 * Compile an @fn body to a `WebAssembly.Module` (no instantiation).
 * This is the expensive part: elaborate → lower → emit → watToWasmSync.
 * Called only when the T0 module cache misses.
 */
function _compileHandlerToModule(
    handlerName: string,
    program: Program,
    registry: ElaboratorRegistry,
): WebAssembly.Module {
    // Find the handler @fn — first in the user program, then fall back
    // to `registry.namedHandlers` which carries the body for built-in
    // strata handlers (loaded from src/strata/*.si).  Built-in handler
    // bodies aren't in the user program's AST, so without this lookup
    // every built-in handler migration would fail compilation.
    let handlerDef = findHandlerDef(handlerName, program)
    if (handlerDef) {
        // Pre-stamp `hook: 'function'` so the elaborator preserves it
        // (handler def takes the legacy functionExpander path, bypassing the
        // migrated LetOrFn_lower handler — chicken-and-egg break).
        // Also translate the body via the legacy-block translator so
        // bodies written in the old `&Compiler::*` API still compile.
        const binding = Array.isArray(handlerDef.binding) ? handlerDef.binding[0] : handlerDef.binding
        const body = binding?.expression ?? binding
        const translatedBody = body ? translateLegacyBlock(body, handlerDef.params?.[0]?.name ?? 'node') : body
        handlerDef = {
            ...handlerDef,
            hook: 'function',
            binding: { type: 'Binding', expression: translatedBody },
        }
    }
    if (!handlerDef) {
        const entry = registry.namedHandlers.get(handlerName)
        if (entry) {
            // Synthesise a minimal Definition node so the rest of the
            // pipeline (elaborate → lower) can process it.  We pin
            // `hook: 'function'` and bypass the elaborator's hook
            // re-stamp by passing it through unchanged.  Without this,
            // post-D-D-11b migration the synthetic @fn would itself
            // fire LetOrFn_lower (chicken-and-egg).
            // Translate the body too — bodies authored in legacy
            // `&Compiler::*` style get auto-rewritten to `&compiler::*`.
            const translatedBody = translateLegacyBlock(entry.body, entry.paramName ?? 'node')
            handlerDef = {
                type: 'Definition',
                keyword: '@fn',
                hook: 'function',
                name: { type: 'TypedIdentifier', name: handlerName },
                params: [{
                    type: 'Param', name: entry.paramName ?? 'node',
                    typeAnnotation: { type: 'TypeAnnotation', typename: 'Int' },
                }],
                binding: { type: 'Binding', expression: translatedBody },
            }
        }
    }
    if (!handlerDef) {
        throw new Error(`[comptime] handler @fn '${handlerName}' not found in program or namedHandlers`)
    }

    // Build the synthetic program: just the handler @fn.  We *don't* add
    // an @export Definition because once @export is itself migrated to
    // the new @stratum form, lowering @export here would fire the
    // ExportDecl_lower handler — which can't run yet (we're in the middle
    // of compiling handlers).  Instead, we mutate the lowered IRModule
    // to add the export directly.
    const syntheticProg = {
        type: 'Program',
        elements: [handlerDef],
    }

    // Temporarily unclaim the handler name so lowerDefinition processes it.
    // We restore the claim immediately after lowering so the *real* lowering
    // pass (when the user's full program runs) still skips it.
    const wasClaimed = registry.strataHandlerFnNames.has(handlerName)
    registry.strataHandlerFnNames.delete(handlerName)
    let wat: string
    // Set a "compiling handler" flag on the registry so lower.ts knows to
    // skip on::lower dispatch for migrated keywords inside this handler's
    // body — breaks the chicken-and-egg where compiling LocalDef_lower
    // needs LocalDef_lower already compiled (its body uses @local).
    ;(registry as any).__compilingHandler = true
    try {
        // Elaborate first so the @fn gets its `hook: 'function'` stamp.
        const elaborated = elaborate(syntheticProg as any, registry)
        const mod = lowerProgram(
            elaborated.program, registry, new Map(),
            getBuiltinModuleRegistry(),
        )
        // Add the export to the IRModule directly — equivalent to having
        // `@export <handlerName>;` in the source, but immune to @export
        // itself being migrated to a new-form stratum.
        mod.exports.push({
            kind: 'Export',
            alias: handlerName,
            internalName: handlerName,
            what: 'func',
        })
        // Wrap with std.wat so memory + alloc helpers are present.
        // Handlers that use string literals need the data segment + memory
        // declaration — same shape that compileToWat in src/codegen/ uses.
        wat = emitModule(mod, loadStdWat())
    } finally {
        if (wasClaimed) registry.strataHandlerFnNames.add(handlerName)
        ;(registry as any).__compilingHandler = false
    }

    // Assemble — sync path (wabt was pre-init'd at module load).
    // Returns the compiled module; instantiation happens in compileHandlerToWasm
    // so each call gets a fresh instance bound to its own registry.
    const wasm = watToWasmSync(wat)
    return new WebAssembly.Module(wasm)
}

/** Best-effort: try to compile and return the instance, or `null` if
 *  compilation fails for any reason.  After D-E-1 the named-handler
 *  wrapper requires a compiled instance — no interpreter fallback — so
 *  null returns surface as build-time errors when the handler fires. */
export function tryCompileHandler(
    handlerName: string,
    program: Program,
    registry: ElaboratorRegistry,
): CompiledHandler | null {
    try {
        return compileHandlerToWasm(handlerName, program, registry)
    } catch {
        return null
    }
}

/**
 * Pre-compile every `@fn` claimed as a strata handler, stashing the
 * results in `registry.compiledHandlers`.  Synchronous — wabt is
 * pre-initialised at module load and WebAssembly.Instance is sync.
 *
 * After D-E-1, this must be called before any user code is lowered:
 * the strataLoader wrapper requires a cached compiled handler and
 * has no interpreter fallback.  Returns the count of handlers compiled.
 */
export function compileStrataHandlers(
    program: Program,
    registry: ElaboratorRegistry,
): number {
    // Snapshot the set first — compileHandlerToWasm transiently mutates
    // it (delete-then-readd around the synthetic lowering), and iterating
    // a Set while it's being mutated has surprised us in test runners.
    const names = Array.from(registry.strataHandlerFnNames)

    // Iterate until stable: a handler may depend on another handler being
    // already compiled (e.g. LocalDef_lower's body uses &@if, which fires
    // If_lower).  Each pass compiles handlers whose dependencies are now
    // available; loop until no progress.  Bounded by 2× the handler count
    // to guard against infinite loops on genuinely-uncompilable handlers.
    let pass = 0
    const maxPasses = Math.max(names.length * 2, 2)
    while (pass < maxPasses) {
        pass++
        let progressed = false
        for (const name of names) {
            if (registry.compiledHandlers.has(name)) continue
            const compiled = tryCompileHandler(name, program, registry)
            if (compiled) {
                registry.compiledHandlers.set(name, compiled)
                progressed = true
            }
        }
        if (!progressed) break
    }
    return registry.compiledHandlers.size
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
