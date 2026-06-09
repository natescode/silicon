// SPDX-License-Identifier: MIT
/**
 * Compiler-as-imports surface for compile-then-run strata handlers.
 *
 * !! CANONICAL SOURCE: wit/comptime.wit !!
 *
 * This file is the TypeScript implementation of the `sigil:comptime`
 * world declared in `wit/comptime.wit`.  When the surface changes:
 *   1. Edit `wit/comptime.wit` FIRST.
 *   2. Mirror the change in this file.
 *   3. Mirror in any Silicon `@extern` declarations downstream handlers use.
 *   4. `npx changeset add` if the change is observable to handler authors.
 *
 * Story W-1 will replace step 2 with `wit-bindgen --ts`; until then the
 * propagation is manual but auditable against the single .wit file.
 *
 * Each function here is a JS implementation of a WASM-callable host import.
 * Strata handler bodies, once lowered to WASM, call these via WebAssembly
 * import declarations:
 *
 *     (import "compiler" "state_set" (func (param i32) (param i32) (param i32)))
 *
 * Signatures are all-i32 in, i32 out (or void).  Non-primitive args pass as
 * handles into the `HandleTable`; strings pass as ids into the `StringPool`.
 * The host's `createComptimeImports(registry, env)` returns an `imports`
 * object you hand to `WebAssembly.instantiate`.
 *
 * What's here (initial Phase B coverage, can grow):
 *   - register::*               (keyword / operator / annotation)
 *   - on::*                     (decl, call_site, annotation, module_finalize, comptime)
 *   - state::stratum / instance and state.has/get/set
 *   - callee::name
 *   - ast::capture_template / with_keyword / with_name / rewrite_call
 *   - type::bind_template_args / mangle_suffix
 *   - module::push_definition
 *   - diag::error / warn
 *   - test::observe — host-side hook so tests can verify a handler fired
 *
 * What's not here yet (would be Phase B continuation):
 *   - ast::clone, patch_types (need handle copy semantics decisions)
 *   - type::* primitives (int/int64/float/bool/string singletons)
 *   - Complex AST field accessors (node.name.name, etc.)
 *   - String operations (concat, etc.) — currently builtin operators handle these
 */

import type { ElaboratorRegistry, ComptimeHandler } from '../elaborator/registry'
import {
    registerElaborator, registerAnnotation, registerPhaseHandler,
    registerModuleFinalizeHandler, registerComptimeHandler,
} from '../elaborator/registry'
import { registerDefKind, lookupDefKind } from './../elaborator/defkinds'
import { StrataType, type StrataNode } from '../elaborator/strataenum'
import { HandleTable, StringPool } from './handles'
import type {
    IRExpr, IRStmt, IRFunction, IRGlobal, IRImport, IRExport, IRLocal, IRParam,
    IRConst, IRLocalGet, IRGlobalGet, IRBinOp, IRBlock,
    WasmValType,
} from '../ir/nodes'
import type { CompilerAPI, CompilerCtx } from '../compiler-api'
import {
    TypeInt, TypeInt64, TypeFloat, TypeString, TypeBool,
    formatType, type SiliconType,
} from '../types/types'

/** Anything that can sit in the IR handle table.  Stays loose because
 *  `compiler_arr_*` also returns arrays of these (or of IRParam / IRLocal
 *  records), and a single tagged union doesn't help — handlers know what
 *  shape they're stashing. */
export type IRHandleValue =
    | IRExpr | IRStmt
    | IRFunction | IRGlobal | IRImport | IRExport
    | IRLocal  | IRParam
    | IRHandleValue[]

/** Per-firing environment passed to import implementations. */
export interface ComptimeEnv {
    registry: ElaboratorRegistry
    /** All non-primitive objects (AST nodes, templates, state buckets, bindings, …). */
    handles: HandleTable<any>
    /** Strings — interned by content. */
    strings: StringPool
    /** IR-node handle table.  Compiled handlers build IR through
     *  `ir_make*` imports that return an id into this table; the
     *  firing wrapper recovers the JS object after the handler
     *  returns.  See `src/comptime/IR_HANDLE_ABI.md`. */
    irHandles: HandleTable<IRHandleValue>
    /** The lowering ctx for the current firing.  Set by the strataLoader
     *  wrapper before invoking the compiled handler; undefined outside
     *  a firing (so accessors are no-ops in unit tests that don't
     *  install one). */
    ctx?: CompilerCtx
    /** The CompilerAPI for the current firing.  Used by `lowerExpr`,
     *  `lowerParams`, etc.  Same lifetime model as `ctx`. */
    api?: CompilerAPI
    /** The compiled handler module's exported memory.  Installed by the
     *  engine right after `WebAssembly.instantiate`.  Used by
     *  `compiler_str_intern` to read Silicon string literals out of
     *  the WASM module's linear memory (Silicon string layout:
     *  4-byte little-endian length header + UTF-8 bytes — but the
     *  intern import accepts an explicit (ptr, len) pair to also
     *  cover non-headered byte ranges). */
    memory?: WebAssembly.Memory
    /** Per-firing module-mutation accumulator.  `module::push_definition`
     *  pushes here; the firing wrapper drains it after the handler
     *  returns and feeds them into `registry.pendingTopLevelInjections`. */
    pendingDefinitions: any[]
    /** Per-firing global-mutation accumulator.  Same model as
     *  pendingDefinitions, but the firing wrapper turns each into an
     *  IRGlobal and adds to the module. */
    pendingGlobals: Array<{ name: string; type: any; init: any }>
    /** Test-only observation log.  Pushed via `test::observe`; consulted
     *  by tests to verify handlers actually fired. */
    testLog: any[]
}

export function createComptimeEnv(registry: ElaboratorRegistry): ComptimeEnv {
    // Share ONE handle table across every handler env of a registry.  Strata
    // 2.0 §7 monomorphization stores a captured-template HANDLE in the shared
    // `state('stratum')` bucket during the on::decl firing and reads it back in
    // a *different* handler (the on::call_site firing).  Per-env tables would
    // make that id meaningless across the boundary; a registry-shared table
    // keeps handle ids portable.  Ids are globally unique, and each firing only
    // releases its own input-node id, so sharing is collision-free.  (irHandles
    // and the string pool stay per-env — they don't cross handler boundaries.)
    const sharedHandles: HandleTable<any> =
        (registry as any).__sharedHandles ?? ((registry as any).__sharedHandles = new HandleTable<any>())
    return {
        registry,
        handles: sharedHandles,
        strings: new StringPool(),
        irHandles: new HandleTable<IRHandleValue>(),
        ctx: undefined,
        api: undefined,
        memory: undefined,
        pendingDefinitions: [],
        pendingGlobals: [],
        testLog: [],
    }
}

/**
 * Drain a handler env's per-firing module-mutation accumulators into the
 * registry so lowerProgram re-lowers them (Strata 2.0 §7 monomorphization
 * substrate: `module::push_definition` captures+patches a template and pushes
 * a concrete `@fn`, which must reach `registry.pendingDefinitions` — the list
 * lowerProgram drains after the main definition pass).  Called by every
 * compiled-handler firing wrapper after `compiled.invoke` returns.
 *
 * Without this the pushed monomorphs are stranded in `env.pendingDefinitions`
 * (which lowerProgram never reads) and produce no output.
 */
export function drainModuleMutations(env: ComptimeEnv, registry: ElaboratorRegistry): void {
    if (env.pendingDefinitions.length > 0) {
        for (const d of env.pendingDefinitions) registry.pendingDefinitions.push(d)
        env.pendingDefinitions.length = 0
    }
    if (env.pendingGlobals.length > 0) {
        for (const g of env.pendingGlobals) {
            // Materialise an IRGlobal; lowerProgram's append routes 'Global' kinds
            // straight into the module (no re-elaboration needed).
            registry.pendingDefinitions.push({
                kind: 'Global', name: g.name, wasmType: g.type, mutable: 1, init: g.init,
            })
        }
        env.pendingGlobals.length = 0
    }
}

/**
 * Build the WebAssembly import object for a strata handler module.
 *
 *     const env = createComptimeEnv(registry)
 *     const imports = createComptimeImports(env)
 *     await WebAssembly.instantiate(wasm, imports)
 *
 * The returned import object lives under the `compiler` namespace so user
 * `@extern compiler.<name>` declarations in handler Silicon source can
 * link against it.  All host functions are bound to `env` so they share
 * the handle table and string pool.
 */
export function createComptimeImports(env: ComptimeEnv): WebAssembly.Imports {
    const { registry, handles, strings, testLog } = env

    // ── Registration imports (one-shot at strata-load time) ─────────────────
    // Today these run via the interpreted strata body; Phase C compile-then-run
    // for the strata BODY itself is a follow-up.  The host implementations
    // exist so handler @fns can call them too (rare but legal).

    const register_keyword = (token: number): void => {
        const s = strings.get(token)
        if (!s) return
        const stub: StrataNode = { type: StrataType.Keyword, discriminant: s, data: { nodeParamName: 'node' } }
        registerElaborator(registry, 'keyword', s, stub)
        registerDefKind(registry.defKinds, {
            keyword: s, codegenKind: 'stratum_def',
            allowsParams: true, allowsBinding: true, allowsGenerics: true,
        })
    }

    /**
     * Variant for expression-style keywords (`@if`, `@loop`, `@match`,
     * `@return`, …): registers the elaborator entry but does NOT
     * register a def-kind.  Without this, callers like `&@if cond, …`
     * would be parsed as a definition-style usage.  Strata that
     * migrate from `@stratum_keyword` (the legacy expression form,
     * not the def form) call this from their body.
     */
    const register_expression_keyword = (token: number): void => {
        const s = strings.get(token)
        if (!s) return
        const stub: StrataNode = { type: StrataType.Keyword, discriminant: s, data: { nodeParamName: 'node' } }
        registerElaborator(registry, 'keyword', s, stub)
    }

    const register_operator = (token: number): void => {
        const s = strings.get(token); if (!s) return
        const stub: StrataNode = { type: StrataType.Operator, discriminant: s, data: { nodeParamName: 'node' } }
        registerElaborator(registry, 'operator', s, stub)
    }

    const register_annotation = (token: number): void => {
        const s = strings.get(token); if (!s) return
        const stub: StrataNode = { type: StrataType.Keyword, discriminant: s, data: { nodeParamName: 'node' } }
        registerAnnotation(registry, s, stub)
    }

    const on_decl = (token: number, handlerName: number): void => {
        const t = strings.get(token); const h = strings.get(handlerName)
        if (!t || !h) return
        registerPhaseHandler(registry, 'decl', t, makeNamedHandler(registry, h))
    }

    const on_call_site = (token: number, handlerName: number): void => {
        const t = strings.get(token); const h = strings.get(handlerName)
        if (!h) return
        registerPhaseHandler(registry, 'callSite', t || '*', makeNamedHandler(registry, h))
    }

    const on_annotation = (token: number, handlerName: number): void => {
        const t = strings.get(token); const h = strings.get(handlerName)
        if (!t || !h) return
        registerPhaseHandler(registry, 'annotation', t, makeNamedHandler(registry, h))
    }

    const on_module_finalize = (handlerName: number): void => {
        const h = strings.get(handlerName); if (!h) return
        registerModuleFinalizeHandler(registry, makeNamedHandler(registry, h))
    }

    const on_comptime = (token: number, handlerName: number): void => {
        const t = strings.get(token); const h = strings.get(handlerName)
        if (!t || !h) return
        registerComptimeHandler(registry, t, makeNamedComptimeHandler(registry, h))
    }

    // ── State buckets ───────────────────────────────────────────────────────
    // 'stratum' returns the registry-shared per-stratum map; 'instance' returns
    // a fresh map per call.  Both wrapped in handles so the WASM side passes
    // them around as i32 ids.

    const state_stratum = (): number => {
        const name = (registry as any).__currentStratum?.name ?? '__global__'
        let bucket = registry.stratumState.get(name)
        if (!bucket) { bucket = new Map(); registry.stratumState.set(name, bucket) }
        return handles.intern(bucket)
    }

    const state_instance = (): number => handles.fresh(new Map<string, any>())

    const state_has = (bucketId: number, keyId: number): number => {
        const m = handles.get(bucketId) as Map<string, any> | undefined
        if (!m) return 0
        return m.has(strings.get(keyId)) ? 1 : 0
    }

    const state_get = (bucketId: number, keyId: number): number => {
        const m = handles.get(bucketId) as Map<string, any> | undefined
        if (!m) return 0
        const v = m.get(strings.get(keyId))
        if (v === undefined || v === null) return 0
        // Auto-intern: primitives → strings if string-shaped; objects → handles.
        if (typeof v === 'string') return strings.intern(v)
        if (typeof v === 'number') return v | 0   // i32-coerce
        return handles.intern(v)
    }

    const state_set = (bucketId: number, keyId: number, valueId: number): void => {
        const m = handles.get(bucketId) as Map<string, any> | undefined
        if (!m) return
        // We can't distinguish string-id from handle-id at this boundary;
        // store the raw integer and let readers interpret consistently.
        m.set(strings.get(keyId), valueId)
    }

    // ── Array builders ──────────────────────────────────────────────────────
    // Block / Function / Import IR builders need arrays of sub-nodes (or of
    // IRParam / IRLocal records).  The handler builds one with these two
    // imports, then passes its handle to the IR builder.  Arrays live in
    // `irHandles` because their lifetime matches IR nodes (single firing).
    //
    // Arrays store handle *ids* (i32), not resolved JS objects, so that
    // `compiler_arr_get` round-trips through `arr_push` cleanly.  The IR
    // builders that take an array (`ir_makeBlock`, `ir_makeFunction`,
    // `ir_makeImport`) resolve each id to a JS value when assembling the
    // IR node.

    const compiler_arr_new = (): number => env.irHandles.fresh([] as any)

    const compiler_arr_push = (arrId: number, valueId: number): void => {
        const arr = env.irHandles.get(arrId)
        if (!Array.isArray(arr)) return
        if (valueId === 0) return
        // Skip stale/unknown handles so callers don't accidentally seed the
        // array with values that will resolve to undefined downstream.
        if (env.irHandles.get(valueId) === undefined) return
        arr.push(valueId as any)
    }

    // ── IR builders (D-B-3 — basic expression nodes) ────────────────────────
    // Each wrapper recovers JS values from handle/string ids, calls the
    // matching IRBuilder, and interns the result in `irHandles`.  Returns
    // the new i32 handle id.

    const ir_makeConst = (value: number, wasmTypeStr: number): number => {
        const wt = strings.get(wasmTypeStr) || 'i32'
        return env.irHandles.fresh({
            kind: 'Const',
            wasmType: wt as IRConst['wasmType'],
            value: value | 0,
        })
    }

    const ir_makeLocalGet = (nameStr: number, wasmTypeStr: number): number => {
        const wt = strings.get(wasmTypeStr) || 'i32'
        return env.irHandles.fresh({
            kind: 'LocalGet',
            wasmType: wt as IRLocalGet['wasmType'],
            name: strings.get(nameStr),
        })
    }

    const ir_makeLocalSet = (nameStr: number, valueH: number): number => {
        const value = env.irHandles.get(valueH) as IRExpr | undefined
        if (!value) return 0
        return env.irHandles.fresh({
            kind: 'LocalSet',
            name: strings.get(nameStr),
            value,
        })
    }

    const ir_makeGlobalGet = (nameStr: number, wasmTypeStr: number): number => {
        const wt = strings.get(wasmTypeStr) || 'i32'
        return env.irHandles.fresh({
            kind: 'GlobalGet',
            wasmType: wt as IRGlobalGet['wasmType'],
            name: strings.get(nameStr),
        })
    }

    const ir_makeGlobalSet = (nameStr: number, valueH: number): number => {
        const value = env.irHandles.get(valueH) as IRExpr | undefined
        if (!value) return 0
        return env.irHandles.fresh({
            kind: 'GlobalSet',
            name: strings.get(nameStr),
            value,
        })
    }

    const ir_makeBinOp = (
        instrStr: number, leftH: number, rightH: number, wasmTypeStr: number,
    ): number => {
        const left  = env.irHandles.get(leftH)  as IRExpr | undefined
        const right = env.irHandles.get(rightH) as IRExpr | undefined
        if (!left || !right) return 0
        const wt = strings.get(wasmTypeStr) || 'i32'
        // Normalize WAT dot notation ('i32.add') to AbstractOp underscore form ('i32_add').
        // Strata bodies pass WAT-style strings; the IR layer stores AbstractOp.
        const raw = strings.get(instrStr) ?? ''
        const op = raw.replace('.', '_') as IRBinOp['op']
        return env.irHandles.fresh({
            kind: 'BinOp',
            wasmType: wt as IRBinOp['wasmType'],
            op,
            left,
            right,
        })
    }

    /**
     * Block IR.  Three positional args:
     *   - stmtsArrH:    handle of an array of IRStmt (built via compiler_arr_*)
     *   - trailingH:    handle of an IRExpr, or 0 for no trailing value
     *   - wasmTypeStr:  type id, or 0 to infer (then trailing's wasmType if any, else 'void')
     */
    const ir_makeBlock = (
        stmtsArrH: number, trailingH: number, wasmTypeStr: number,
    ): number => {
        const rawStmts = env.irHandles.get(stmtsArrH)
        const stmts: IRStmt[] = Array.isArray(rawStmts)
            ? (rawStmts as number[]).map(id => env.irHandles.get(id) as IRStmt).filter(Boolean)
            : []
        const trailing = trailingH === 0 ? undefined : (env.irHandles.get(trailingH) as IRExpr)
        const wt = wasmTypeStr === 0
            ? (trailing ? (trailing as any).wasmType : 'void')
            : strings.get(wasmTypeStr) as IRBlock['wasmType']
        return env.irHandles.fresh({
            kind: 'Block',
            wasmType: wt,
            stmts,
            trailing,
        })
    }

    /** Sentinel — `&IR::null` legacy marker.  Handlers return this when
     *  they emit no IR (purely declaration-like passes).  Always returns 0. */
    const ir_null = (): number => 0

    /**
     * Call IR.  `argsArrH` is a handle of an array of IRExpr-handle ids
     * (built via compiler_arr_*).  `callKindStr` is 'user' (default) or
     * 'instr' (for raw WASM instruction calls).
     */
    const ir_makeCall = (
        calleeStr: number, argsArrH: number, wasmTypeStr: number, callKindStr: number,
    ): number => {
        const rawArgs = env.irHandles.get(argsArrH)
        const args = Array.isArray(rawArgs)
            ? (rawArgs as number[]).map(id => env.irHandles.get(id) as any).filter(Boolean)
            : []
        const wt = wasmTypeStr === 0 ? 'i32' : strings.get(wasmTypeStr)
        const ck = (callKindStr === 0 ? 'user' : strings.get(callKindStr)) as 'user' | 'instr'
        return env.irHandles.fresh({
            kind: 'Call',
            wasmType: wt as any,
            callee: strings.get(calleeStr),
            callKind: ck,
            args,
        })
    }

    /**
     * CallIndirect IR.  `tableIndexH` is the IRExpr handle of the slot
     * index; `argsArrH` is a handle of an array of IRExpr-handle ids;
     * `sigKeyStr` is the signature key (0 → '__fn_i_i'); `wasmTypeStr` is
     * the result type (0 → 'i32').  Mirrors lowerCallIndirect — see
     * src/strata/funcref.si.
     */
    const ir_makeCallIndirect = (
        tableIndexH: number, argsArrH: number, sigKeyStr: number, wasmTypeStr: number,
    ): number => {
        const tableIndex = env.irHandles.get(tableIndexH) as IRExpr | undefined
        if (!tableIndex) return 0
        const rawArgs = env.irHandles.get(argsArrH)
        const args = Array.isArray(rawArgs)
            ? (rawArgs as number[]).map(id => env.irHandles.get(id) as IRExpr).filter(Boolean)
            : []
        const wt = wasmTypeStr === 0 ? 'i32' : strings.get(wasmTypeStr)
        const sigKey = sigKeyStr === 0 ? '__fn_i_i' : strings.get(sigKeyStr)
        return env.irHandles.fresh({
            kind: 'CallIndirect',
            wasmType: wt as IRExpr['wasmType'],
            sigKey,
            args,
            tableIndex,
        } as IRExpr)
    }

    // ── IR builders (D-B-4 — control flow) ──────────────────────────────────
    // The whole point of strata is to emit control IR.  These four imports
    // close out the basic surface needed by `if.si`, `loop.si`, `control.si`.

    /**
     * If IR.  `elseH=0` means no else-branch (void if statement).  When
     * `wasmTypeStr=0`, infer from `then.wasmType` if else_ is present,
     * otherwise 'void'.  Matches the legacy `&Compiler::ir::makeIf` signature.
     */
    const ir_makeIf = (
        condH: number, thenH: number, elseH: number, wasmTypeStr: number,
    ): number => {
        const cond  = env.irHandles.get(condH)  as IRExpr | undefined
        const then  = env.irHandles.get(thenH)  as IRExpr | undefined
        if (!cond || !then) return 0
        const else_ = elseH === 0 ? undefined : (env.irHandles.get(elseH) as IRExpr)
        const wt = wasmTypeStr === 0
            ? (else_ ? (then as any).wasmType : 'void')
            : strings.get(wasmTypeStr)
        return env.irHandles.fresh({
            kind: 'If',
            wasmType: wt as IRExpr['wasmType'] as any,
            cond, then, else_,
        })
    }

    /** Loop IR.  `id` is the loop's break/continue label id (typically
     *  allocated via `compiler_ctx_nextLoopId` — see D-B-11). */
    const ir_makeLoop = (id: number, condH: number, bodyH: number): number => {
        const cond = env.irHandles.get(condH) as IRExpr | undefined
        const body = env.irHandles.get(bodyH) as IRExpr | undefined
        if (!cond || !body) return 0
        return env.irHandles.fresh({ kind: 'Loop', id: id | 0, cond, body })
    }

    /** Break out of the loop with label id `id`. */
    const ir_makeBreak = (id: number): number =>
        env.irHandles.fresh({ kind: 'Break', id: id | 0 })

    /** Continue to the next iteration of the loop with label id `id`. */
    const ir_makeContinue = (id: number): number =>
        env.irHandles.fresh({ kind: 'Continue', id: id | 0 })

    /** Return from the enclosing function.  `valueH=0` means a void return. */
    const ir_makeReturn = (valueH: number): number => {
        const value = valueH === 0 ? undefined : (env.irHandles.get(valueH) as IRExpr)
        return env.irHandles.fresh({ kind: 'Return', value })
    }

    // ── IR builders (D-B-5 — module-level definitions) ──────────────────────
    // Required by defkinds.si migration: @export, @var, @let/@fn, @extern,
    // and the local/param sub-records hoisted into functions.

    /**
     * Export IR.  `whatStr` is "func" or "global".  Maps directly to the
     * legacy `&Compiler::ir::makeExport alias, internalName, what` form.
     */
    const ir_makeExport = (
        aliasStr: number, internalNameStr: number, whatStr: number,
    ): number => {
        const what = strings.get(whatStr) as IRExport['what']
        return env.irHandles.fresh({
            kind: 'Export',
            alias: strings.get(aliasStr),
            internalName: strings.get(internalNameStr),
            what,
        })
    }

    /** Local declaration (hoisted into a function preamble). */
    const ir_makeLocal = (nameStr: number, wasmTypeStr: number): number => {
        const wt = strings.get(wasmTypeStr) || 'i32'
        return env.irHandles.fresh({
            name: strings.get(nameStr),
            wasmType: wt as IRLocal['wasmType'],
        } satisfies IRLocal)
    }

    /** Parameter declaration (for function signatures). */
    const ir_makeParam = (nameStr: number, wasmTypeStr: number): number => {
        const wt = strings.get(wasmTypeStr) || 'i32'
        return env.irHandles.fresh({
            name: strings.get(nameStr),
            wasmType: wt as IRParam['wasmType'],
        } satisfies IRParam)
    }

    /**
     * Global IR.  `mutable` is i32 (0=false, non-zero=true).  `initH` is
     * the handle of the init expression.
     */
    const ir_makeGlobal = (
        nameStr: number, wasmTypeStr: number, mutable: number, initH: number,
    ): number => {
        const init = env.irHandles.get(initH) as IRExpr | undefined
        if (!init) return 0
        const wt = strings.get(wasmTypeStr) || 'i32'
        return env.irHandles.fresh({
            kind: 'Global',
            name: strings.get(nameStr),
            wasmType: wt as IRGlobal['wasmType'],
            mutable: mutable !== 0,
            init,
        })
    }

    /**
     * Function IR.  `paramsArrH` and `localsArrH` are handles of arrays
     * built via compiler_arr_*.  `bodyH=0` for @extern-style declarations
     * with no body.  `returnTypeStr=0` means 'void'.
     */
    const ir_makeFunction = (
        nameStr: number, paramsArrH: number, returnTypeStr: number,
        localsArrH: number, bodyH: number,
    ): number => {
        const rawParams = env.irHandles.get(paramsArrH)
        const rawLocals = env.irHandles.get(localsArrH)
        const params: IRParam[] = Array.isArray(rawParams)
            ? (rawParams as number[]).map(id => env.irHandles.get(id) as IRParam).filter(Boolean)
            : []
        const locals: IRLocal[] = Array.isArray(rawLocals)
            ? (rawLocals as number[]).map(id => env.irHandles.get(id) as IRLocal).filter(Boolean)
            : []
        const body = bodyH === 0 ? undefined : (env.irHandles.get(bodyH) as IRExpr)
        const rt = returnTypeStr === 0 ? 'void' : strings.get(returnTypeStr)
        return env.irHandles.fresh({
            kind: 'Function',
            name: strings.get(nameStr),
            params,
            returnType: rt as IRFunction['returnType'],
            locals,
            body,
        })
    }

    /**
     * Import IR.  `paramsArrH` is an array-handle of WasmValType strings
     * (each is a string-pool id pushed via compiler_arr_push of a const
     * string).  `resultStr=0` means no result.  Matches legacy
     * `&Compiler::ir::makeImport 'env', name, name, params, result`.
     */
    const ir_makeImport = (
        envStr: number, fieldStr: number, nameStr: number,
        paramsArrH: number, resultStr: number,
    ): number => {
        const rawParams = env.irHandles.get(paramsArrH)
        // For Import, the params array holds WasmValType *strings*.
        // Callers push string-pool ids via `compiler_arr_push_str`; we
        // resolve them here.
        const params: IRImport['params'] = Array.isArray(rawParams)
            ? (rawParams as number[]).map(id => strings.get(id) as IRImport['params'][number])
            : []
        const result = resultStr === 0 ? undefined : (strings.get(resultStr) as IRImport['result'])
        return env.irHandles.fresh({
            kind: 'Import',
            env: strings.get(envStr),
            field: strings.get(fieldStr),
            name: strings.get(nameStr),
            params,
            result,
        })
    }

    /**
     * Push a string-pool id onto an array-handle.  Specifically for
     * Import's `params: WasmValType[]` slot where we can't push an
     * IR-handle value (there's no IR node — just a type tag).  Reuses
     * the array storage in irHandles.
     */
    const compiler_arr_push_str = (arrId: number, strId: number): void => {
        const arr = env.irHandles.get(arrId)
        if (!Array.isArray(arr)) return
        if (strId === 0) return
        arr.push(strId as any)
    }

    // ── Diagnostics (D-B-10) ────────────────────────────────────────────────
    // The T-5 runtime-trap model: diag::error/warn never throw — they
    // accumulate into `registry.diagnostics` and the host renders later.
    // Spans are nullable here (handler often doesn't have one) — the
    // accumulator records an empty span if `spanH=0`.

    const EMPTY_SPAN = { file: '', line: 0, col: 0, length: 0 } as const

    const diag_error = (
        codeStr: number, spanH: number, messageStr: number, hintStr: number,
    ): void => {
        const span = spanH === 0 ? EMPTY_SPAN : (env.handles.get(spanH) as typeof EMPTY_SPAN) || EMPTY_SPAN
        const hint = hintStr === 0 ? undefined : strings.get(hintStr)
        registry.diagnostics.push({
            phase: 'lower',
            code: strings.get(codeStr) || 'E0000',
            span,
            message: strings.get(messageStr),
            hint,
        })
    }

    // ── Utility helpers (D-B-13) ────────────────────────────────────────────
    // Pure host functions used pervasively across legacy strata bodies.
    // `watId` and `choose` are stateless; `freshId` uses a per-env counter.
    // `arg` reads the i-th child of an AST node (the node is a host handle).
    // `isVarName` and `resolveType` need the per-firing lowering ctx — not
    // wired into ComptimeEnv yet (that's a strataLoader follow-up).

    /**
     * Read a UTF-8 byte range from the compiled handler's exported memory
     * and intern it as a string-pool id.  This is the bridge that lets
     * handler @fn source pass string literals to host imports — Silicon
     * literals live in linear memory; the host's import surface uses
     * string-pool ids.
     *
     * Two call forms:
     *   `compiler_str_intern(ptr, 0)` — Silicon literal layout: 4-byte
     *      little-endian length header at `ptr`, then `len` UTF-8 bytes
     *      starting at `ptr + 4`.  Pass `0` for `lenOrZero` to use this
     *      form.  This is what `&compiler::compiler_str_intern 'global'`
     *      produces in handler source: the literal is laid down with a
     *      header and the pointer is passed.
     *   `compiler_str_intern(ptr, len)` — raw range without header.
     *      Useful for substrings or strings constructed by handlers.
     *
     * Returns 0 if `env.memory` is unset (no firing in progress) or the
     * range is out of bounds.
     */
    const compiler_str_intern = (ptr: number, lenOrZero: number): number => {
        if (!env.memory) return 0
        const buf = new Uint8Array(env.memory.buffer)
        let start: number
        let end: number
        if (lenOrZero === 0) {
            // Silicon-literal form: read length from ptr, bytes from ptr+4.
            if (ptr < 0 || ptr + 4 > buf.length) return 0
            const len = buf[ptr] | (buf[ptr + 1] << 8) | (buf[ptr + 2] << 16) | (buf[ptr + 3] << 24)
            start = ptr + 4
            end = start + (len | 0)
        } else {
            start = ptr
            end = ptr + (lenOrZero | 0)
        }
        if (start < 0 || end > buf.length || end < start) return 0
        const bytes = buf.subarray(start, end)
        // TextDecoder is fine — handler strings are small.
        const s = new TextDecoder('utf-8').decode(bytes)
        return strings.intern(s)
    }

    /** Convert a Silicon identifier into a WAT-safe identifier. */
    const compiler_watId = (nameStr: number): number => {
        const s = strings.get(nameStr)
        return strings.intern(s.replace(/::/g, '_'))
    }

    /** Concatenate two pooled strings → a new pooled string id.  The comptime
     *  engine has no string `+` operator (operator strata route `+` to numeric
     *  i32.add), so monomorphization name-building (`callee + suffix`) uses this
     *  explicit primitive instead. */
    const str_concat = (aStr: number, bStr: number): number => {
        return strings.intern((strings.get(aStr) ?? '') + (strings.get(bStr) ?? ''))
    }

    /** Per-env fresh-id counter — local to a firing. */
    let freshIdCounter = 0
    const compiler_freshId = (prefixStr: number): number => {
        const prefix = prefixStr === 0 ? 'tmp' : (strings.get(prefixStr) || 'tmp')
        return strings.intern(`${prefix}_${freshIdCounter++}`)
    }

    /** `arg(nodeH, i)` — return a handle of the i-th argument of an AST
     *  node.  Same access pattern the strata body interpreter used.  The
     *  node is expected to have an `args` array (FunctionCall, Keyword
     *  invocation, etc.); if absent or out-of-range, returns 0. */
    const compiler_arg = (nodeH: number, index: number): number => {
        const node = handles.get(nodeH)
        const args = node?.args
        if (!Array.isArray(args)) return 0
        const i = index | 0
        if (i < 0 || i >= args.length) return 0
        return handles.intern(args[i])
    }

    /** `choose(cond, aH, bH)` — non-zero `cond` returns `aH`; zero returns `bH`.
     *  Plain wrapper for symmetry with the legacy `&Compiler::choose` form;
     *  handlers can also use a direct `@if` since they're real Silicon. */
    const compiler_choose = (cond: number, aH: number, bH: number): number =>
        cond !== 0 ? aH : bH

    /** Hard precondition check for an on::lower handler: throw a fatal
     *  compile-time error unless the firing node has exactly `expected`
     *  args.  The diagnostic imports (`diag_error`/`diag_warn`) are
     *  non-throwing by design (T-5 accumulator model), so this is a
     *  handler's only path to the kind of fatal arity error the legacy
     *  hardcoded lowerings raised via `IRLowerError`.  `msgStr` is the
     *  human-readable prefix; the actual count is appended as ", got N". */
    const compiler_require_argc = (nodeH: number, expected: number, msgStr: number): void => {
        const node = handles.get(nodeH)
        const n = Array.isArray(node?.args) ? node.args.length : 0
        if (n !== (expected | 0)) {
            throw new Error(`${strings.get(msgStr)}, got ${n}`)
        }
    }

    // ── Ctx accessors (D-B-11) ─────────────────────────────────────────────
    // All of these are no-ops when `env.ctx` is undefined (handler is
    // running outside a firing — e.g. during unit tests with no full
    // lowering pass).  The firing wrapper installs `env.ctx` before
    // invoking the compiled handler so these become live.
    //
    // Each accessor returns 0 / no-op for "absent" so handlers that
    // probe for state behave gracefully.

    const compiler_ctx_locals_set = (nameStr: number, wasmTypeStr: number): void => {
        if (!env.ctx) return
        env.ctx.locals.set(strings.get(nameStr), (strings.get(wasmTypeStr) || 'i32') as WasmValType)
    }

    const compiler_ctx_locals_get = (nameStr: number): number => {
        if (!env.ctx) return 0
        const t = env.ctx.locals.get(strings.get(nameStr))
        return t ? strings.intern(t) : 0
    }

    const compiler_ctx_globals_set = (nameStr: number, wasmTypeStr: number): void => {
        if (!env.ctx) return
        env.ctx.globals.set(strings.get(nameStr), (strings.get(wasmTypeStr) || 'i32') as WasmValType)
    }

    const compiler_ctx_globals_get = (nameStr: number): number => {
        if (!env.ctx) return 0
        const t = env.ctx.globals.get(strings.get(nameStr))
        return t ? strings.intern(t) : 0
    }

    const compiler_ctx_varNames_add = (nameStr: number): void => {
        if (!env.ctx) return
        env.ctx.varNames.add(strings.get(nameStr))
    }

    const compiler_ctx_varNames_has = (nameStr: number): number => {
        if (!env.ctx) return 0
        return env.ctx.varNames.has(strings.get(nameStr)) ? 1 : 0
    }

    /** Same logical purpose as legacy `&Compiler::isVarName name` — i.e.,
     *  "is this top-level name a mutable @var?"  Routes through ctx. */
    const compiler_isVarName = compiler_ctx_varNames_has

    const compiler_ctx_pendingLocals_push = (localH: number): void => {
        if (!env.ctx) return
        const local = env.irHandles.get(localH) as IRLocal | undefined
        if (local) env.ctx.pendingLocals.push(local)
    }

    /** @fnref: slot index for a wat-id'd function name (find-or-append),
     *  also registering the default i32→i32 funcref signature. */
    const compiler_ctx_funcref_index = (watNameStr: number): number => {
        if (!env.ctx) return 0
        return env.ctx.funcref.index(strings.get(watNameStr))
    }

    const compiler_ctx_loopStack_push = (id: number): void => {
        if (!env.ctx) return
        env.ctx.loopStack.push(id | 0)
    }

    const compiler_ctx_loopStack_pop = (): number => {
        if (!env.ctx) return 0
        const top = env.ctx.loopStack.pop()
        return top === undefined ? 0 : (top | 0)
    }

    const compiler_ctx_loopStack_peek = (): number => {
        if (!env.ctx) return 0
        const top = env.ctx.loopStack.peek()
        return top === undefined ? 0 : (top | 0)
    }

    const compiler_ctx_nextLoopId = (): number => {
        if (!env.ctx) return 0
        return env.ctx.nextLoopId() | 0
    }

    // ── Module accumulators (D-B-9) ────────────────────────────────────────
    // `module::push_definition def_h` — push an AST node (already a complete
    // Definition AST subtree) onto the per-firing accumulator.  The firing
    // wrapper drains these after the handler returns and re-elaborates +
    // re-lowers them.
    //
    // `module::push_global name_str, type_h, init_h` — same but for globals;
    // the firing wrapper materialises an IRGlobal from each entry.

    const module_push_definition = (defH: number): void => {
        const def = env.handles.get(defH)
        if (def != null) env.pendingDefinitions.push(def)
    }

    // ── AST field accessor (D-B-7) ─────────────────────────────────────────
    // Replaces JS-side `node.name.name` dot-paths in legacy strata bodies.
    // Returns a tagged i32:
    //
    //   tag 0x0  →  null/undefined (full result = 0)
    //   tag 0x1  →  child AST-node handle (low 28 bits = env.handles id)
    //   tag 0x2  →  string-pool id (low 28 bits = strings id)
    //   tag 0x3  →  small signed-int literal (low 28 bits, sign-extended)
    //   tag 0x4  →  boolean (low bit = 0/1)
    //   tag 0x5  →  array — value is an irHandles id whose entry is an
    //              array of resolved child handles (each tagged the same
    //              way; clients iterate via compiler_arr_len + index).
    //
    // The full layout:  (tag << 28) | (value & 0x0fffffff)
    //
    // Callers know what shape they're asking for, so the tag is mostly a
    // correctness check.  Mixed-shape fields (e.g. `args` where each child
    // could be a different node kind) use the array tag.

    const TAG_NULL   = 0
    const TAG_NODE   = 1
    const TAG_STR    = 2
    const TAG_INT    = 3
    const TAG_BOOL   = 4
    const TAG_ARR    = 5

    function tag(tagBits: number, value: number): number {
        return (tagBits << 28) | (value & 0x0fffffff)
    }

    function classify(v: any): number {
        if (v === null || v === undefined) return 0
        if (typeof v === 'boolean') return tag(TAG_BOOL, v ? 1 : 0)
        if (typeof v === 'number' && Number.isInteger(v) && v >= -(1 << 27) && v < (1 << 27)) {
            // 28-bit signed range:  -2^27 .. 2^27-1
            return tag(TAG_INT, v & 0x0fffffff)
        }
        if (typeof v === 'number') {
            // Large int outside the 28-bit window: cross as a string id.
            return tag(TAG_STR, strings.intern(String(v)))
        }
        if (typeof v === 'string') return tag(TAG_STR, strings.intern(v))
        if (Array.isArray(v)) {
            // Resolve each element, build an array of those tagged values
            // into the irHandles table.  Clients iterate via array imports.
            const resolved: any[] = v.map(classify)
            return tag(TAG_ARR, env.irHandles.fresh(resolved as any))
        }
        // Object: treat as an AST node.
        return tag(TAG_NODE, env.handles.intern(v))
    }

    /**
     * Walk a dotted path on the AST node and return the tagged result.
     *
     *   compiler_ast_field(nodeH, "name.name") → tagged string id of node.name.name
     *   compiler_ast_field(nodeH, "args.0")    → tagged handle of node.args[0]
     */
    const compiler_ast_field = (nodeH: number, pathStr: number): number => {
        let cur: any = env.handles.get(nodeH)
        if (cur == null) return 0
        const path = strings.get(pathStr)
        if (!path) return classify(cur)
        for (const part of path.split('.')) {
            if (cur == null) return 0
            // Numeric segment → array index
            if (/^\d+$/.test(part)) {
                const i = parseInt(part, 10)
                cur = Array.isArray(cur) ? cur[i] : undefined
                continue
            }
            cur = cur[part]
        }
        return classify(cur)
    }

    /** Helpers to decode a tagged result on the host side.  Tests use
     *  these to keep tag arithmetic out of assertion bodies. */
    const compiler_tag_kind  = (tagged: number): number => (tagged >>> 28) & 0xf
    const compiler_tag_value = (tagged: number): number => {
        // 28-bit value field, sign-extended for the INT tag.
        const kind = (tagged >>> 28) & 0xf
        const raw  = tagged & 0x0fffffff
        if (kind === TAG_INT) {
            // sign-extend from 28 bits
            return (raw << 4) >> 4
        }
        return raw
    }

    const compiler_arr_len = (arrId: number): number => {
        const arr = env.irHandles.get(arrId)
        return Array.isArray(arr) ? arr.length : 0
    }

    /**
     * Convenience: walk a dotted path on an AST node and return the leaf
     * value as a string-pool id, no tag unwrapping needed.  Returns 0 if
     * the field is missing, null, or not a string-shaped value (numbers
     * get string-formatted).  Migrations use this for the common pattern
     *
     *     @local sname := &Compiler::watId Node.name.name;
     *
     * which becomes
     *
     *     @let sname := &compiler::compiler_watId
     *         (&compiler::compiler_ast_str_field node, '<path>');
     */
    const compiler_ast_str_field = (nodeH: number, pathStr: number): number => {
        let cur: any = handles.get(nodeH)
        if (cur == null) return 0
        const path = strings.get(pathStr)
        if (path) {
            for (const part of path.split('.')) {
                if (cur == null) return 0
                if (/^\d+$/.test(part)) {
                    const i = parseInt(part, 10)
                    cur = Array.isArray(cur) ? cur[i] : undefined
                    continue
                }
                cur = cur[part]
            }
        }
        if (cur == null) return 0
        if (typeof cur === 'string') return strings.intern(cur)
        if (typeof cur === 'number') return strings.intern(String(cur))
        return 0
    }

    /** Convenience: walk a dotted path and return a child-node handle
     *  directly (TAG_NODE without the tag).  Returns 0 if the leaf
     *  isn't a node-shaped value. */
    const compiler_ast_node_field = (nodeH: number, pathStr: number): number => {
        let cur: any = handles.get(nodeH)
        if (cur == null) return 0
        const path = strings.get(pathStr)
        if (path) {
            for (const part of path.split('.')) {
                if (cur == null) return 0
                if (/^\d+$/.test(part)) {
                    const i = parseInt(part, 10)
                    cur = Array.isArray(cur) ? cur[i] : undefined
                    continue
                }
                cur = cur[part]
            }
        }
        if (cur == null || typeof cur !== 'object') return 0
        return handles.intern(cur)
    }

    const compiler_arr_get = (arrId: number, index: number): number => {
        const arr = env.irHandles.get(arrId)
        if (!Array.isArray(arr)) return 0
        const i = index | 0
        if (i < 0 || i >= arr.length) return 0
        return arr[i] as any
    }

    // ── Types-as-data (D-B-8) ──────────────────────────────────────────────
    // SiliconType objects live in `handles` (the generic handle table).
    // Type primitives are singletons; type constructors mint fresh objects.

    const type_int    = (): number => handles.intern(TypeInt)
    const type_int64  = (): number => handles.intern(TypeInt64)
    const type_float  = (): number => handles.intern(TypeFloat)
    const type_bool   = (): number => handles.intern(TypeBool)
    const type_string = (): number => handles.intern(TypeString)
    const type_void   = (): number => handles.intern({ kind: 'Void' } satisfies SiliconType)

    const type_variable = (nameStr: number): number =>
        handles.intern({ kind: 'Variable', name: strings.get(nameStr) } satisfies SiliconType)

    const type_array = (elemTypeH: number): number => {
        const elem = handles.get(elemTypeH) as SiliconType | undefined
        if (!elem) return 0
        return handles.intern({ kind: 'Array', element: elem } satisfies SiliconType)
    }

    /**
     * Equality on SiliconType structures.  Uses `formatType` as a robust
     * structural comparison — slower than a dedicated walker, but it
     * matches what `types::equals` does in the JS-side compiler-api.
     */
    const type_equals = (aH: number, bH: number): number => {
        const a = handles.get(aH) as SiliconType | undefined
        const b = handles.get(bH) as SiliconType | undefined
        if (!a || !b) return 0
        return formatType(a) === formatType(b) ? 1 : 0
    }

    /** Render a SiliconType to a human-readable string, returning the string id. */
    const type_format = (tH: number): number => {
        const t = handles.get(tH) as SiliconType | undefined
        if (!t) return 0
        return strings.intern(formatType(t))
    }

    /**
     * Substitute type variables in `templateT` per `bindings` (a Map handle).
     * If `bindings` doesn't resolve to a Map, returns the template id.
     */
    const type_substitute = (templateH: number, bindingsH: number): number => {
        const tmpl = handles.get(templateH) as SiliconType | undefined
        const bindings = handles.get(bindingsH) as Map<string, SiliconType> | undefined
        if (!tmpl) return 0
        if (!(bindings instanceof Map) || bindings.size === 0) return templateH

        function go(t: SiliconType): SiliconType {
            switch (t.kind) {
                case 'Variable': return bindings!.get(t.name) ?? t
                case 'Array': return { kind: 'Array', element: go(t.element) }
                case 'Function': return {
                    kind: 'Function',
                    params: t.params.map(go),
                    result: go(t.result),
                }
                case 'Sum':
                    if (t.typeArgs) {
                        return { kind: 'Sum', name: t.name, variants: t.variants, typeArgs: t.typeArgs.map(go) }
                    }
                    return t
                case 'Distinct': return { kind: 'Distinct', name: t.name, underlying: go(t.underlying) }
                default: return t
            }
        }
        return handles.intern(go(tmpl))
    }

    /**
     * Human-readable mangling suffix from a bindings Map handle.  Order
     * follows insertion order of the Map (JS-spec stable).  Returns the
     * string id ("Int_Float" etc.) — empty pool id if bindings is empty.
     */
    const type_mangle_suffix = (bindingsH: number): number => {
        const bindings = handles.get(bindingsH) as Map<string, SiliconType> | undefined
        if (!(bindings instanceof Map) || bindings.size === 0) return strings.intern('')
        const parts: string[] = []
        for (const [_, v] of bindings) parts.push(formatType(v))
        return strings.intern(parts.join('_'))
    }

    /** `Compiler::callee::name node` — the callee identifier of a FunctionCall
     *  node, as a string-pool id.  Delegates to the CompilerAPI so the rule
     *  matches the legacy interpreter exactly.  0 if api/node unavailable. */
    const callee_name = (callH: number): number => {
        if (!env.api) return 0
        const node = handles.get(callH)
        if (!node) return 0
        const name = env.api.callee.name(node)
        return name ? strings.intern(name) : 0
    }

    /** `Compiler::type::bind_template_args tmplDef, callNode` — infer the
     *  concrete type each of the template's type variables takes at this call
     *  site, returning a Map<varName, SiliconType> handle.  `tmplDefH` is the
     *  bare Definition (a template wrapper's `::ast`); `callH` the call node.
     *  Delegates to the CompilerAPI (uses its inferArgType / BUILTIN_TYPE_NAMES
     *  so the host and legacy engines agree). */
    const type_bind_template_args = (tmplDefH: number, callH: number): number => {
        if (!env.api) return 0
        const tmplDef = handles.get(tmplDefH)
        const call = handles.get(callH)
        if (!tmplDef || !call) return 0
        const bindings = (env.api.type as any).bind_template_args(tmplDef, call)
        return bindings ? handles.intern(bindings) : 0
    }

    // ── AST manipulation (D-B-6) ───────────────────────────────────────────
    // Templates are deep-cloned AST subtrees with a `kind` discriminator
    // ('pre' = captured before elaboration; 'post' = after).  All `with_*`
    // wrappers produce a *new* template handle — never mutate the original.
    //
    // Implementation mirrors the JS-side CompilerAst (see compiler-api/index.ts).

    function deepCloneAst(node: any): any {
        if (!node || typeof node !== 'object') return node
        if (Array.isArray(node)) return node.map(deepCloneAst)
        const out: any = {}
        for (const k of Object.keys(node)) out[k] = deepCloneAst(node[k])
        return out
    }

    function siliconTypeToTypeName(t: SiliconType): string {
        switch (t.kind) {
            case 'Int':    return 'Int'
            case 'Int64':  return 'Int64'
            case 'Float':  return 'Float'
            case 'Bool':   return 'Bool'
            case 'String': return 'String'
            case 'Void':   return 'Void'
            case 'Distinct': return (t as any).name ?? 'Unknown'
            case 'Sum':      return (t as any).name ?? 'Unknown'
            default:       return 'Unknown'
        }
    }

    const ast_capture_template = (nodeH: number, kindStr: number): number => {
        const node = handles.get(nodeH)
        if (!node) return 0
        const kind = (strings.get(kindStr) === 'post' ? 'post' : 'pre') as 'pre' | 'post'
        return handles.intern({ ast: deepCloneAst(node), kind })
    }

    const ast_clone = (templateH: number): number => {
        const tmpl = handles.get(templateH) as { ast: any; kind: 'pre' | 'post' } | undefined
        if (!tmpl) return 0
        return handles.intern({ ast: deepCloneAst(tmpl.ast), kind: tmpl.kind })
    }

    const ast_with_keyword = (templateH: number, keywordStr: number): number => {
        const tmpl = handles.get(templateH) as { ast: any; kind: 'pre' | 'post' } | undefined
        if (!tmpl) return 0
        const next = deepCloneAst(tmpl.ast)
        const keyword = strings.get(keywordStr)
        if (next && typeof next === 'object' && next.type === 'Definition') {
            next.keyword = keyword
            const defKind = lookupDefKind(registry.defKinds, keyword)
            if (defKind) next.hook = defKind.codegenKind
        }
        return handles.intern({ ast: next, kind: tmpl.kind })
    }

    const ast_with_name = (templateH: number, nameStr: number): number => {
        const tmpl = handles.get(templateH) as { ast: any; kind: 'pre' | 'post' } | undefined
        if (!tmpl) return 0
        const next = deepCloneAst(tmpl.ast)
        const newName = strings.get(nameStr)
        if (next && typeof next === 'object' && next.type === 'Definition') {
            if (next.name && typeof next.name === 'object') {
                next.name = { ...next.name, name: newName }
            } else {
                next.name = { name: newName }
            }
        }
        return handles.intern({ ast: next, kind: tmpl.kind })
    }

    /** Mutate a FunctionCall node in place so the lowerer resolves to
     *  `newName` instead of its original callee.  Returns 0 on success. */
    const ast_rewrite_call = (callH: number, newNameStr: number): number => {
        const callNode = handles.get(callH)
        if (!callNode || typeof callNode !== 'object') return 0
        const newName = strings.get(newNameStr)
        if (callNode.name && typeof callNode.name === 'object') {
            if (Array.isArray(callNode.name.path)) {
                callNode.name.path = [newName]
            } else {
                callNode.name = { type: 'Namespace', path: [newName] }
            }
        } else {
            callNode.name = { type: 'Namespace', path: [newName] }
        }
        return 0
    }

    /** Walk a template's AST replacing Variable type annotations with
     *  concrete types per `bindings` (a Map handle). */
    // ── Lowering helpers (D-B-12) ──────────────────────────────────────────
    // These delegate to `env.api` (a CompilerAPI installed by the firing
    // wrapper).  When `api` is not set (e.g. unit tests), they return 0
    // / no-op so handlers can be exercised in isolation.

    const compiler_lowerExpr = (nodeH: number): number => {
        if (!env.api) return 0
        const node = handles.get(nodeH)
        if (!node) return 0
        const ir = env.api.lowerExpr(node)
        return ir ? env.irHandles.fresh(ir) : 0
    }

    const compiler_lowerExprIfDefined = (nodeH: number): number => {
        if (!env.api) return 0
        const node = handles.get(nodeH)
        if (!node) return 0
        const ir = env.api.lowerExprIfDefined(node)
        return ir ? env.irHandles.fresh(ir) : 0
    }

    /** Phase 4 (@defer): lower args[0] of `node` and push the result onto
     *  the current function's deferStack.  Site itself emits no IR — the
     *  cleanup is materialised at function exit (end-of-body or @return).
     *  Returns 0 (IR_NULL). */
    const compiler_registerDefer = (nodeH: number): number => {
        if (!env.api || !env.ctx) return 0
        const node = handles.get(nodeH)
        const args = node?.args
        if (!Array.isArray(args) || args.length === 0) return 0
        const ir = env.api.lowerExprIfDefined(args[0])
        if (ir) env.ctx.deferStack.push(ir)
        return 0
    }

    /** Phase 4: emit a return that runs any pending defers in LIFO order
     *  before the return itself.  Used by Return_lower in place of the
     *  plain `ir_makeReturn` so early returns honour deferred cleanup.
     *  `argNodeH` is the argument-node handle returned by `compiler_arg`
     *  (or 0 for a void return).  Peeks (does not drain) the deferStack —
     *  the end-of-body wrap in `lowerFunctionBody` owns drain lifetime so
     *  the fall-through exit path also gets cleanup. */
    const compiler_emitReturn = (argNodeH: number): number => {
        const valueIR = argNodeH === 0 || !env.api
            ? undefined
            : (env.api.lowerExprIfDefined(handles.get(argNodeH)) ?? undefined)
        const deferAccess = env.ctx?.deferStack
        const defersLen = deferAccess?.length() ?? 0
        if (defersLen === 0) {
            return env.irHandles.fresh({ kind: 'Return', value: valueIR } as IRExpr)
        }
        // Peek via drain+refill (no read-only accessor exists today).
        const snapshot = deferAccess!.drain()
        for (const d of snapshot) deferAccess!.push(d)
        const cleanupStmts: any[] = []
        for (let i = snapshot.length - 1; i >= 0; i--) {
            cleanupStmts.push({ kind: 'ExprStmt', expr: snapshot[i] })
        }
        const retStmt = { kind: 'ExprStmt', expr: { kind: 'Return', value: valueIR } }
        return env.irHandles.fresh({
            kind: 'Block',
            wasmType: 'void',
            stmts: [...cleanupStmts, retStmt],
            trailing: undefined,
        } as IRExpr)
    }

    /** Lower a definition node's parameter list to IRParam[]; returns an
     *  arr handle whose elements are IRParam-handle ids. */
    const compiler_lowerParams = (nodeH: number): number => {
        if (!env.api) return env.irHandles.fresh([])
        const node = handles.get(nodeH)
        if (!node) return env.irHandles.fresh([])
        const params = env.api.lowerParams(node)
        const ids = params.map(p => env.irHandles.fresh(p))
        return env.irHandles.fresh(ids as any)
    }

    /**
     * Lower a function body — returns a handle to `{ bodyH, localsArrH }`
     * stashed in irHandles so callers can fetch the two pieces.
     */
    const compiler_lowerFunctionBody = (nodeH: number, paramsArrH: number): number => {
        if (!env.api) return 0
        const node = handles.get(nodeH)
        if (!node) return 0
        const rawParams = env.irHandles.get(paramsArrH)
        const params = Array.isArray(rawParams)
            ? (rawParams as number[]).map(id => env.irHandles.get(id) as IRParam).filter(Boolean)
            : []
        const result = env.api.lowerFunctionBody(node, params)
        const localIds = result.locals.map(l => env.irHandles.fresh(l))
        return env.irHandles.fresh({
            bodyH:    result.body ? env.irHandles.fresh(result.body) : 0,
            localsH:  env.irHandles.fresh(localIds as any),
        } as any)
    }

    /** Read the `body` slot from a `lowerFunctionBody` result handle. */
    const compiler_funcResult_body = (resultH: number): number => {
        const r = env.irHandles.get(resultH) as any
        return r?.bodyH ?? 0
    }

    /** Read the `locals` slot (array of IRLocal handles). */
    const compiler_funcResult_locals = (resultH: number): number => {
        const r = env.irHandles.get(resultH) as any
        return r?.localsH ?? 0
    }

    const compiler_resolveFunctionReturnType = (
        nodeH: number, nameStr: number, bodyH: number,
    ): number => {
        if (!env.api) return 0
        const node = handles.get(nodeH)
        if (!node) return 0
        const body = bodyH === 0 ? undefined : (env.irHandles.get(bodyH) as IRExpr | undefined)
        try {
            const rt = env.api.resolveFunctionReturnType(node, strings.get(nameStr), body)
            return strings.intern(rt)
        } catch {
            return 0
        }
    }

    /** Lower a @var's init expression — returns a handle to
     *  `{ initH, wasmTypeStr }` so the handler can read both fields.
     *  Used by D-D-11c @var migration. */
    const compiler_lowerGlobalInit = (nodeH: number, defaultTypeStr: number): number => {
        if (!env.api) return 0
        const node = handles.get(nodeH)
        if (!node) return 0
        const defaultType = (strings.get(defaultTypeStr) || 'i32') as 'i32' | 'i64' | 'f32'
        try {
            const result = env.api.lowerGlobalInit(node, defaultType as any)
            return env.irHandles.fresh({
                initH:      env.irHandles.fresh(result.init),
                wasmTypeStr: strings.intern(result.wasmType),
            } as any)
        } catch {
            return 0
        }
    }

    /** Read the `init` IR handle from a lowerGlobalInit result. */
    const compiler_globalInit_init = (resultH: number): number => {
        const r = env.irHandles.get(resultH) as any
        return r?.initH ?? 0
    }
    /** Read the `wasmType` string id from a lowerGlobalInit result. */
    const compiler_globalInit_wasmType = (resultH: number): number => {
        const r = env.irHandles.get(resultH) as any
        return r?.wasmTypeStr ?? 0
    }

    /** Lower an @extern's param-type list to WasmValType[] — returns an
     *  array handle whose entries are string-pool ids of the types. */
    const compiler_lowerExternParams = (nodeH: number): number => {
        if (!env.api) return env.irHandles.fresh([])
        const node = handles.get(nodeH)
        if (!node) return env.irHandles.fresh([])
        try {
            const params = env.api.lowerExternParams(node)
            const ids = params.map(t => strings.intern(t))
            return env.irHandles.fresh(ids as any)
        } catch {
            return env.irHandles.fresh([])
        }
    }

    /** Lower an @extern's result type — returns a string-pool id, or 0
     *  if the extern has no result. */
    /** Delegate to the TS-side sumTypeExpander.expand for the migrated
     *  @enum / @type_sum handler — returns a handle of an array of
     *  IRGlobal handles.  See src/strata/defExpanders.ts. */
    const compiler_expandSumType = (nodeH: number): number => {
        if (!env.api) return env.irHandles.fresh([])
        const node = handles.get(nodeH)
        if (!node) return env.irHandles.fresh([])
        try {
            const { sumTypeExpander } = require('../strata/defExpanders') as typeof import('../strata/defExpanders')
            const name = strings.get(0) // unused by the expander
            const irs = sumTypeExpander.expand(node, name, env.api) as any[]
            const ids = irs.map(ir => env.irHandles.fresh(ir))
            return env.irHandles.fresh(ids as any)
        } catch {
            return env.irHandles.fresh([])
        }
    }

    /** Delegate to typeRecordExpander.expand for the migrated @type
     *  (sum-with-payloads) handler. */
    const compiler_expandTypeRecord = (nodeH: number): number => {
        if (!env.api) return env.irHandles.fresh([])
        const node = handles.get(nodeH)
        if (!node) return env.irHandles.fresh([])
        try {
            const { typeRecordExpander } = require('../strata/defExpanders') as typeof import('../strata/defExpanders')
            const name = strings.get(0)
            const irs = typeRecordExpander.expand(node, name, env.api) as any[]
            const ids = irs.map(ir => env.irHandles.fresh(ir))
            return env.irHandles.fresh(ids as any)
        } catch {
            return env.irHandles.fresh([])
        }
    }

    const compiler_expandStruct = (nodeH: number): number => {
        if (!env.api) return env.irHandles.fresh(null)
        const node = handles.get(nodeH)
        if (!node) return env.irHandles.fresh(null)
        try {
            const { structExpander } = require('../strata/defExpanders') as typeof import('../strata/defExpanders')
            const ir = structExpander.expand(node, '', env.api)
            return env.irHandles.fresh(ir)
        } catch {
            return env.irHandles.fresh(null)
        }
    }

    const compiler_lowerExternResult = (nodeH: number): number => {
        if (!env.api) return 0
        const node = handles.get(nodeH)
        if (!node) return 0
        try {
            const result = env.api.lowerExternResult(node)
            return result ? strings.intern(result) : 0
        } catch {
            return 0
        }
    }

    const compiler_resolveType = (annotH: number): number => {
        if (!env.api) return 0
        const annot = handles.get(annotH)
        if (!annot) return 0
        try {
            return strings.intern(env.api.resolveType(annot))
        } catch {
            return 0
        }
    }

    /** Build the full IRImport for an @extern (src/strata/defkinds.si).  ADR
     *  0018 P0/P1: derives the import module from a `mod::field` name and
     *  stamps JSString/JSValue externref slots.  Like the arena expanders,
     *  does NOT catch — the externref web/bun gate throws IRLowerError, and
     *  that message must reach the user as a compile error. */
    const compiler_expandExtern = (nodeH: number): number => {
        if (!env.api) return 0
        const node = handles.get(nodeH)
        if (!node) return 0
        const ir = env.api.expandExtern(node)
        return ir ? env.irHandles.fresh(ir) : 0
    }

    /** Match-chain expansion — delegate to api.expandMatchChain.
     *  `rawArgsArrH` is a handles id of the AST args array; `inferredTypeH`
     *  is a handle of the inferredType.  Returns an IR-handle of the
     *  resulting IRExpr.  Used by the migrated @match handler. */
    const compiler_expandMatchChain = (rawArgsArrH: number, inferredTypeH: number): number => {
        if (!env.api) return 0
        const rawArgs = handles.get(rawArgsArrH)
        const inferredType = inferredTypeH === 0 ? undefined : handles.get(inferredTypeH)
        try {
            const ir = env.api.expandMatchChain(Array.isArray(rawArgs) ? rawArgs : [], inferredType)
            return ir ? env.irHandles.fresh(ir) : 0
        } catch {
            return 0
        }
    }

    // @with_arena / @move_to_parent_arena (src/strata/arena.si).  Unlike the
    // match expander, these do NOT catch: lowerWithArena throws IRLowerError on
    // invalid use (heap-return without promote, non-tail promote, nested-heap
    // sizing), and those messages must reach the CaaS surface as compile errors.
    const compiler_expandWithArena = (rawArgsArrH: number): number => {
        if (!env.api) return 0
        const rawArgs = handles.get(rawArgsArrH)
        const ir = env.api.expandWithArena(Array.isArray(rawArgs) ? rawArgs : [])
        return ir ? env.irHandles.fresh(ir) : 0
    }

    const compiler_expandMoveToParentArena = (rawArgsArrH: number): number => {
        if (!env.api) return 0
        const rawArgs = handles.get(rawArgsArrH)
        const ir = env.api.expandMoveToParentArena(Array.isArray(rawArgs) ? rawArgs : [])
        return ir ? env.irHandles.fresh(ir) : 0
    }

    // @call_indirect (src/strata/funcref.si).  Like the arena expanders, does
    // NOT catch — invalid arity throws a fatal error that must reach the user.
    const compiler_expandCallIndirect = (rawArgsArrH: number, inferredTypeH: number): number => {
        if (!env.api) return 0
        const rawArgs = handles.get(rawArgsArrH)
        const inferredType = inferredTypeH === 0 ? undefined : handles.get(inferredTypeH)
        const ir = env.api.expandCallIndirect(Array.isArray(rawArgs) ? rawArgs : [], inferredType)
        return ir ? env.irHandles.fresh(ir) : 0
    }

    const ast_patch_types = (templateH: number, bindingsH: number): number => {
        const tmpl = handles.get(templateH) as { ast: any; kind: 'pre' | 'post' } | undefined
        const bindings = handles.get(bindingsH) as Map<string, SiliconType> | undefined
        if (!tmpl) return 0
        if (!(bindings instanceof Map) || bindings.size === 0) return templateH

        function patchNode(n: any): any {
            if (!n || typeof n !== 'object') return n
            if (Array.isArray(n)) return n.map(patchNode)
            const out: any = { ...n }
            if (out.inferredType?.kind === 'Variable' && bindings!.has(out.inferredType.name)) {
                out.inferredType = bindings!.get(out.inferredType.name)
            }
            if (out.type === 'TypeAnnotation' && typeof out.typename === 'string' && bindings!.has(out.typename)) {
                const target = bindings!.get(out.typename)!
                out.typename = siliconTypeToTypeName(target)
            }
            for (const k of Object.keys(out)) {
                if (k === 'inferredType') continue
                out[k] = patchNode(out[k])
            }
            return out
        }
        return handles.intern({ ast: patchNode(deepCloneAst(tmpl.ast)), kind: tmpl.kind })
    }

    const module_push_global = (nameStr: number, typeH: number, initH: number): void => {
        // type is a SiliconType handle; init is an AST or IR-handle (either
        // works — the firing wrapper inspects the shape).
        const type = env.handles.get(typeH)
        const init = env.handles.get(initH) ?? env.irHandles.get(initH)
        env.pendingGlobals.push({
            name: strings.get(nameStr),
            type,
            init,
        })
    }

    const diag_warn = (
        codeStr: number, spanH: number, messageStr: number, hintStr: number,
    ): void => {
        const span = spanH === 0 ? EMPTY_SPAN : (env.handles.get(spanH) as typeof EMPTY_SPAN) || EMPTY_SPAN
        const hint = hintStr === 0 ? undefined : strings.get(hintStr)
        registry.diagnostics.push({
            phase: 'lower',
            code: strings.get(codeStr) || 'W0000',
            span,
            message: strings.get(messageStr),
            hint,
        })
    }

    // ── Test-only observation hook ──────────────────────────────────────────
    // Strata handlers under test call this to make their firing visible to
    // assertions.  Not part of the long-term API surface.

    const test_observe = (value: number): void => { testLog.push(value) }

    return {
        compiler: {
            register_keyword, register_expression_keyword,
            register_operator, register_annotation,
            on_decl, on_call_site, on_annotation, on_module_finalize, on_comptime,
            state_stratum, state_instance, state_has, state_get, state_set,
            compiler_arr_new, compiler_arr_push,
            ir_makeConst, ir_makeLocalGet, ir_makeLocalSet,
            ir_makeGlobalGet, ir_makeGlobalSet,
            ir_makeBinOp, ir_makeBlock, ir_null, ir_makeCall, ir_makeCallIndirect,
            ir_makeIf, ir_makeLoop, ir_makeBreak, ir_makeContinue, ir_makeReturn,
            ir_makeExport, ir_makeLocal, ir_makeParam, ir_makeGlobal,
            ir_makeFunction, ir_makeImport, compiler_arr_push_str,
            diag_error, diag_warn,
            compiler_str_intern,
            compiler_watId, compiler_freshId, compiler_arg, compiler_choose, compiler_require_argc, str_concat,
            compiler_ctx_locals_set, compiler_ctx_locals_get,
            compiler_ctx_globals_set, compiler_ctx_globals_get,
            compiler_ctx_varNames_add, compiler_ctx_varNames_has,
            compiler_isVarName,
            compiler_ctx_pendingLocals_push,
            compiler_ctx_funcref_index,
            compiler_ctx_loopStack_push, compiler_ctx_loopStack_pop, compiler_ctx_loopStack_peek,
            compiler_ctx_nextLoopId,
            module_push_definition, module_push_global,
            compiler_ast_field, compiler_tag_kind, compiler_tag_value,
            compiler_ast_str_field, compiler_ast_node_field,
            compiler_arr_len, compiler_arr_get,
            type_int, type_int64, type_float, type_bool, type_string, type_void,
            type_variable, type_array,
            type_equals, type_format, type_substitute, type_mangle_suffix,
            type_bind_template_args, callee_name,
            ast_capture_template, ast_clone, ast_with_keyword, ast_with_name,
            ast_rewrite_call, ast_patch_types,
            compiler_lowerExpr, compiler_lowerExprIfDefined,
            compiler_registerDefer, compiler_emitReturn,
            compiler_lowerParams, compiler_lowerFunctionBody,
            compiler_funcResult_body, compiler_funcResult_locals,
            compiler_resolveFunctionReturnType, compiler_resolveType,
            compiler_lowerGlobalInit, compiler_globalInit_init, compiler_globalInit_wasmType,
            compiler_lowerExternParams, compiler_lowerExternResult, compiler_expandExtern,
            compiler_expandMatchChain, compiler_expandSumType, compiler_expandTypeRecord, compiler_expandStruct,
            compiler_expandWithArena, compiler_expandMoveToParentArena, compiler_expandCallIndirect,
            test_observe,
        },
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — make handler wrappers that look up a named @fn at fire time.
//
// These mirror buildPhaseHandler / buildComptimeHandler in strataLoader.ts;
// the duplication is intentional for now — the strataLoader version is for
// strata bodies executed via the interpreter, this version is for handler
// references registered from WASM-side strata bodies (Phase C+).
// ─────────────────────────────────────────────────────────────────────────────

function makeNamedHandler(registry: ElaboratorRegistry, handlerName: string) {
    const wrapper = (node: any, api: any) => {
        // D-E-3 PR 2: no interpreter fallback.  Every named handler must
        // be pre-compiled — buildStrataRegistry runs compileStrataHandlers
        // before any code paths that fire handlers.
        const compiled = registry.compiledHandlers.get(handlerName)
        if (!compiled) {
            throw new Error(`[strata compile-then-run] handler '${handlerName}' has no compiled instance`)
        }
        const env = compiled.env
        const prevCtx = env.ctx
        const prevApi = env.api
        env.ctx = api?.ctx
        env.api = api
        const nodeId = env.handles.intern(node)
        const resultId = compiled.invoke(nodeId)
        let result: any = resultId === 0 ? null : env.irHandles.get(resultId)
        if (Array.isArray(result)) {
            result = result.map((v) => typeof v === 'number' ? env.irHandles.get(v) : v).filter(Boolean)
        }
        drainModuleMutations(env, registry)
        env.handles.release(nodeId)
        env.ctx = prevCtx
        env.api = prevApi
        return result ?? null
    }
    ;(wrapper as any).__handlerName = handlerName
    return wrapper
}

function makeNamedComptimeHandler(registry: ElaboratorRegistry, handlerName: string): ComptimeHandler {
    return (rawArgs, api, evalArg) => {
        // D-E-3 PR 2: comptime handlers also pre-compiled — no interpreter.
        const compiled = registry.compiledHandlers.get(handlerName)
        if (!compiled) {
            throw new Error(`[strata compile-then-run] comptime handler '${handlerName}' has no compiled instance`)
        }
        const env = compiled.env
        const prevCtx = env.ctx, prevApi = env.api
        env.ctx = api?.ctx
        env.api = api
        const evaluated = rawArgs.map(evalArg)
        const nodeId = env.handles.intern(evaluated)
        const resultId = compiled.invoke(nodeId)
        const result = resultId === 0 ? null : env.irHandles.get(resultId)
        env.handles.release(nodeId)
        env.ctx = prevCtx
        env.api = prevApi
        return result
    }
}
