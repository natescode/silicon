// SPDX-License-Identifier: MIT
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
 *   `a + b` where both are Float produces `IRBinOp { op: 'f32_add' }`,
 *   decided by the actual SiliconType, not string patterns.
 */

import { wasmTypeOf } from '../types/types'
import { type SiliconType } from '../types/types'
import { type ElaboratorRegistry, lookupTypedOperator, lookupKeyword, lookupTypedKeyword, lookupDefKindEntry, fireModuleFinalizeHandlers, fireHandlers } from '../elaborator/registry'
import { resolveIntrinsicWasmInstr, resolveIntrinsicAbstractOp } from '../intrinsics'
import type { FunctionSig } from '../types/typechecker'
import { CAP_ROOT_TYPE } from '../types/typechecker'

/** ADR 0027 — the root capability token the entry shim passes to `main(World)`.
 *  The first WASI non-stdio fd (preopens start here): a `Clock` witness, or the
 *  preopened dir-fd for `Fs`.  The host (wasmtime preopens) is the real grant. */
const CAP_ROOT_TOKEN = 3
import type { ModuleRegistry } from '../modules/registry'
import type { SemanticModel } from '../ast/semanticModel'
import type {
    WasmValType, WasmType, AbstractOp,
    IRModule, IRFunction, IRGlobal, IRImport, IRDataSegment, IRExport,
    IRExpr, IRStmt, IRParam, IRLocal,
    IRLocalGet, IRGlobalGet, IRCall, IRRefSlot,
    IRBlock, IRIf, IRLoop, IRBreak, IRContinue, IRNop, IRUnreachable, IRExprStmt,
} from './nodes'
import { WasmGcTypeRegistry } from './nodes'
import {
    type SpecializedSum, needsHandleSpecialization, mangleSumName,
    buildSpecializedSum, emitSpecializedConstructors,
} from './sumMono'
import { type CompilerAPI, type LowerFns, createCompilerAPI } from '../compiler-api'

/** Built-in modules whose WASM import-module string differs from the Silicon
 *  call prefix.  `&JSString::concat` → `(import "wasm:js-string" "concat" …)`. */
const IMPORT_ENV_OVERRIDE: Record<string, string> = {
    JSString: 'wasm:js-string',
}

/** `JSString::` functions that are the host String↔JSString bridge (import
 *  module `"js-bridge"`), not standardized `wasm:js-string` builtins. */
const JSSTRING_BRIDGE_FNS = new Set(['fromString', 'toString'])

/** `JSString::` CharCodeArray ops that lower to inline `array.*` instructions
 *  on the `(array (mut i16))` GC type (not a host import). */
const CHARCODE_INLINE_OPS = new Set(['codeArray', 'getCode', 'setCode', 'codeLen'])
const ARRAY_I16_NAME = '$Array_i16'

/** Register the `(array (mut i16))` GC type (CharCodeArray's backing array) and
 *  return its type index; marks the program as using it. */
function charCodeArrayTypeIdx(ctx: LowerCtx): number {
    ctx.usesCharCodeArray.v = true
    return ctx.wasmGcTypes.internNominal({
        name: ARRAY_I16_NAME,
        spec: { kind: 'array', element: { storage: { kind: 'packed', type: 'i16' }, mutable: true } },
    })
}

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
    /** ADR 0018 P1 — namespaced `@extern mod::field` host imports keyed by their
     *  qualified call name (`mod::field`).  Lets a `mod::field(…)` call route to
     *  the declared host import instead of demanding a registered Silicon module.
     *  Populated in the lowerProgram pre-scan (so namespaced externs forward-ref
     *  like bare ones); consulted by `lowerModuleCall`. */
    externCalls: Map<string, IRImport>
    /** Stack of active loop IDs — for @break / @continue. */
    loopStack: number[]
    /** Monotonically increasing loop counter for unique labels. */
    loopCount: { n: number }
    /** Phase 5 Workstream B — funcref table state.  Populated by
     *  `@fnref` (adds an entry) and `@call_indirect` (adds a signature).
     *  Drained into IRModule.funcrefTable at the end of lowerProgram. */
    funcrefTable: import('./nodes').FuncrefTable
    /** Phase 4: deferred cleanup expressions for the current function body.
     *  Pushed in source order by `@defer` sites; drained in LIFO order at
     *  function exit (end-of-body in `lowerFunctionBody` and every `@return`
     *  site via `compiler_emitReturn`). */
    deferStack: IRExpr[]
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
    /** CaaS-2: authoritative type map. Preferred over node.inferredType for new code. */
    semanticModel?: SemanticModel
    /** Maps local/global variable names to their Silicon struct type name when they hold a struct pointer. */
    structLocals: Map<string, string>
    /** Phase 9d-5c: compile target — `'wasm-gc'` enables lifecycle
     *  compile-time elision (`@with_arena` / `@move_to_parent_arena`
     *  collapse to no-ops because the engine GC owns reclamation).
     *  Defaults to 'host' (Phase 9c bump-allocator semantics). */
    target: LowerTarget
    /** Host platform (web/bun = JS host; gates JSString / js-string builtins). */
    platform: LowerPlatform
    /** Set when the program uses CharCodeArray (the `(array (mut i16))`): drives
     *  the GC-array helper-function injection + ref-slot stamping. */
    usesCharCodeArray: { v: boolean }
    /** The full program AST being lowered — lets call-site strata (the
     *  generics monomorphization stratum) look up @fn[T] template defs by
     *  name regardless of declaration order. */
    program?: Program
    /** F1 — specialized native host-handle-carrying sum instantiations,
     *  keyed by mangled name (`Result$JSValue_String`).  Populated under
     *  `--target=wasm-gc`; consulted by constructor-call routing, @match
     *  lowering, and ref-slot typing. */
    sumSpecs?: Map<string, import('./sumMono').SpecializedSum>
    /** Phase 9d-7: registry of WasmGC struct/array type declarations
     *  populated as the program is lowered.  Drained into
     *  `IRModule.wasmGcTypes` at the end of `lowerProgram`.  Only
     *  written under `target === 'wasm-gc'`; safe to leave empty
     *  under mvp (preserves byte-equal codegen). */
    wasmGcTypes: WasmGcTypeRegistry
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

/**
 * CaaS-2: read an AST node's inferred SiliconType.
 * Prefers the SemanticModel WeakMap; falls back to the legacy node.inferredType
 * stamp so existing code paths that build synthetic nodes (ir.test.ts, etc.)
 * still work without a SemanticModel.
 */
function inferredTypeOf(node: any, ctx: LowerCtx): SiliconType | undefined {
    // Guard non-object nodes: zero-arg builtin keywords (e.g. `@break`,
    // `@continue`) reach lowerBuiltinCall with `rawArgs[0] === undefined`, and
    // SemanticModel.typeOf → unwrap throws on a `'_node' in <primitive>` test.
    if (!node || typeof node !== 'object') return undefined
    return ctx.semanticModel?.typeOf(node) ?? node?.inferredType as SiliconType | undefined
}

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
    lowerExternImport,
    unwrapNode: unwrap,
    exprWasmType,
    watId,
    lowerWithArena,
    lowerMoveToParentArena,
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
/**
 * Compile target — picks the memory model + stdlib path.
 *
 * - `host` / `wasix`: linear-memory bump allocator (Phase 9c).  Default.
 * - `wasm-gc`: managed-reference types via the engine GC (Phase 9d,
 *   opt-in per ADR 0009).  Lowering routes `@struct` / sum / Vec
 *   through `IRStructNew` / `IRArrayNew` etc.; the wasm-mvp-only
 *   primitives are rejected at typecheck (E0012 introspection,
 *   E0013 physical-byte); lifecycle primitives compile to no-ops.
 */
export type LowerTarget = 'host' | 'wasix' | 'wasm-gc'
export type LowerPlatform = 'native' | 'web' | 'bun'

export interface LowerOptions {
    /** Target runtime — controls emit-time conventions (e.g. _start export). */
    target?: LowerTarget
    /** Host platform (web/bun = JS host).  Under web/bun the module exports
     *  `_start` so the JS runner can invoke the top-level program, and
     *  JS String Builtins / the `JSString` type are available.  Default native. */
    platform?: LowerPlatform
    /** Phase 9c-4: cap wasm memory at this many 64KB pages.  Forwarded
     *  to the prelude memory section.  Powers the `--max-heap=N` CLI
     *  flag for exercising heap-exhaustion paths in tests.  Undefined
     *  → unbounded (existing default). */
    maxHeapPages?: number
    /** Compiler/toolchain version stamped into the emitted `producers`
     *  custom section (`processed-by: sigilc/<version>`). The CLI passes
     *  `SGL_VERSION`; when absent the version field is left empty. */
    compilerVersion?: string
}

export function lowerProgram(
    program: any,
    registry: ElaboratorRegistry,
    functionSigs: Map<string, FunctionSig>,
    moduleRegistry?: ModuleRegistry,
    options: LowerOptions = {},
    semanticModel?: SemanticModel,
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
        externCalls: new Map(),
        loopStack: [],
        loopCount: { n: 0 },
        deferStack: [],
        pendingLocals: [],
        strings: createStringAlloc(),
        freshIdCounter: { n: 0 },
        currentStratumRef,
        semanticModel,
        structLocals: new Map(),
        funcrefTable: { entries: [], signatures: [] },
        target,
        platform: options.platform ?? 'native',
        usesCharCodeArray: { v: false },
        wasmGcTypes: new WasmGcTypeRegistry(),
        program,
        sumSpecs: new Map(),
    }
    // Pass the live ctx (not a snapshot) so $compiler is current when
    // recursively invoked methods (api.lowerExpr → lowerBinaryOp → on::lower
    // handler dispatch) read ctx.$compiler.  A spread snapshot here would
    // freeze ctx.$compiler at undefined.
    ctx.$compiler = createCompilerAPI(ctx, lowerFns)

    // Pre-register $Array_i32 + $Vec_i32 BEFORE user lowering so a `Vec[Int]` arg
    // (the wasm-gc closure env, ADR 0019 C2) can resolve $Vec_i32's typeIdx while
    // `expandCallIndirect` builds the ref-typed call_indirect signature.  Idempotent
    // with the buildGcVecExtension re-registration below (internNominal is name-keyed).
    if (target === 'wasm-gc') {
        require('../codegen/gc-vec').registerGcVecTypes(ctx.wasmGcTypes)
    }

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
        if (hook === 'global' || node.keyword === '@local') {
            const name = watId(node.name?.name ?? '')
            ctx.globals.set(name, 'i32') // refined below
            ctx.varNames.add(name)
        }
        // ADR 0018 P1: pre-register namespaced `@extern mod::field` host imports
        // so a `mod::field(…)` call (lowerModuleCall) can route to them whether
        // declared before or after the call site.  Building the import here is
        // idempotent — ExternDef_lower rebuilds the identical node when it emits
        // the actual import; the externref web/bun gate (which throws) just
        // surfaces from whichever runs first.
        if (node.keyword === '@extern' && (node.name?.name ?? '').includes('::')) {
            ctx.externCalls.set(node.name.name, lowerExternImport(node, ctx))
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
                node.keyword === '@struct' ? ctx.registry.defExpanders.get('struct') :
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

    // F1 — collect + specialize host-handle-carrying sum instantiations
    // (`Result[JSValue, String]`) before any body lowering, so constructor-call
    // routing and @match resolve to the specialized GC struct.  Native ref
    // fields exist only under wasm-gc; on a linear-mem target a host handle
    // can't live in a sum payload (externref is not addressable) → fail fast
    // instead of emitting invalid wasm (the `js::pin` interim is the workaround).
    if (target === 'wasm-gc') {
        collectAndSpecializeHandleSums(program, ctx, append)
    } else {
        assertNoHandleSumsOnLinearMem(program, ctx)
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
        deferStack: [],
        structLocals: new Map(),
    }
    startCtx.$compiler = createCompilerAPI(startCtx, lowerFns)
    const startStmts: IRStmt[] = []
    for (const el of program.elements as any[]) {
        const node = unwrap(el)
        if (!node || node.type === 'Definition') continue
        const stmt = lowerAsStmt(node, startCtx)
        if (stmt) startStmts.push(stmt)
    }
    // ADR 0027 — capability rooting.  When the program defines `@fn main` whose
    // first parameter is the root capability `World`, the entry shim itself
    // calls `main(<root>)` with an inline root token (no user-nameable mint —
    // that would be ambient authority).  The token is the first WASI non-stdio
    // fd (3); for a `Clock` cap it's an ignored witness, for `Fs` (later) it is
    // the preopened dir-fd.  The real grant is host-side (wasmtime preopens).
    for (const el of program.elements as any[]) {
        const def = unwrap(el)
        if (def?.type !== 'Definition' || def.keyword !== '@fn' || def.name?.name !== 'main') continue
        const firstParam = (def.params ?? []).find((p: any) => !p.isLiteral)
        if (firstParam?.typeAnnotation?.typename !== CAP_ROOT_TYPE) continue
        startStmts.push({
            kind: 'ExprStmt',
            expr: { kind: 'Call', wasmType: 'i32', callee: watId('main'), callKind: 'user',
                    args: [{ kind: 'Const', wasmType: 'i32', value: CAP_ROOT_TOKEN }] },
        })
        break
    }
    // WASIX runners (wasmer run) invoke the function exported as `_start`.
    // We always synthesise $__start so the module-init wrapper exists; on the
    // 'wasix' target we additionally export it under the WASIX-mandated name.
    // Empty $__start is fine: WASIX semantics treat it as the "no-op init".
    const platform = options.platform ?? 'native'
    const jsHost = platform === 'web' || platform === 'bun'
    const hasStartBody = startStmts.length > 0
    if (hasStartBody || target === 'wasix' || jsHost) {
        functions.push({
            kind: 'Function',
            name: '__start',
            params: [],
            returnType: 'void',
            locals: startCtx.pendingLocals,
            body: { kind: 'Block', wasmType: 'void', stmts: startStmts },
        })
    }
    // Export `_start` for WASIX (wasmer) and for the JS hosts (web/bun), where the
    // bun/browser runner invokes it to run the top-level program.
    if (target === 'wasix' || jsHost) {
        irExports.push({ kind: 'Export', what: 'func', internalName: '__start', alias: '_start' })
    }

    // Append auto-generated imports from module calls (web::*, Draw::*, …).
    for (const imp of ctx.pendingImports.values()) imports.push(imp)

    // Phase 9d-8: inject hardcoded Vec[Int] gc functions under wasm-gc.
    // Registers $Array_i32 + $Vec_i32 type entries (must come BEFORE any
    // user-defined sums in the wasmGcTypes registry — Vec types are
    // referenced by every program that uses Vec; user sums are only
    // referenced when the user declares them, so giving Vec types stable
    // low indices is safe).  See src/codegen/gc-vec.ts.
    if (target === 'wasm-gc') {
        // M1 — emit the Float/Int64 Vec monomorphs the program ACTUALLY uses
        // (i32 is always emitted).  Detection scans the user program, NOT the
        // function-signature table: the typechecker pre-registers `vec_*_f32`/
        // `_i64` sigs unconditionally under wasm-gc, so scanning `functionSigs`
        // would always force both element types (the on-demand emission would
        // be defeated).  Two signals catch every real use: a stamped
        // `inferredType` of `Vec[Float]`/`Vec[Int64]` (covers calls + their
        // args/results), and a `Vec[Float]`/`Vec[Int64]` TYPE ANNOTATION
        // (covers a param/local typed but never element-accessed) — the latter
        // keeps the detector aligned with `refIdxFromAnnotation`'s ref-typing.
        const extraElems: Array<'f32' | 'i64'> = []
        const noteElem = (e: string | undefined): void => {
            if (e === 'Float' && !extraElems.includes('f32')) extraElems.push('f32')
            if (e === 'Int64' && !extraElems.includes('i64')) extraElems.push('i64')
        }
        const walkVecUse = (n: any): void => {
            if (!n || typeof n !== 'object') return
            if (Array.isArray(n)) { for (const x of n) walkVecUse(x); return }
            const t = n.inferredType
            if (t && t.kind === 'Vec') noteElem(t.element?.kind)
            // `Vec[Float]` / `Vec[Int64]` type annotation (typeArgs[0].name).
            if (n.type === 'TypeAnnotation' && n.typename === 'Vec' &&
                Array.isArray(n.typeArgs) && n.typeArgs.length === 1) {
                noteElem(n.typeArgs[0]?.name)
            }
            for (const k of Object.keys(n)) {
                if (k === 'inferredType' || k === 'sourceLocation' || k === 'relSpan') continue
                walkVecUse(n[k])
            }
        }
        walkVecUse(program.elements)
        const vecFns = require('../codegen/gc-vec').buildGcVecExtension(ctx.wasmGcTypes, extraElems) as IRFunction[]
        functions.unshift(...vecFns)
    }

    // Phase 9d-7 fix-4: under wasm-gc, walk every user-emitted function
    // and inject refResult / refParams when the declared Silicon type
    // is a Sum or Vec.  The IR-level value type stays i32 (refs are
    // i32-shaped on the operand stack and in locals); these annotations
    // only affect the binary type-section encoding.  Constructors
    // already had refResult set by typeRecordExpander — this pass picks
    // up the other functions: anything that *returns* or *takes* a
    // Sum / Vec.
    //
    // Phase 9d-8: also walk every function body looking for @local
    // declarations whose annotation resolves to Vec[Int] (or any
    // ref-typed Sigil type).  Set IRLocal.refType so the wasm-level
    // local is declared as `(local (ref $Vec_i32))` instead of
    // `(local i32)` — `local.set` from a ref-returning call now
    // type-checks at validation.
    if (target === 'wasm-gc') {
        injectRefSlots(functions, functionSigs, ctx.wasmGcTypes)
        injectLocalRefSlots(program, functions, ctx.wasmGcTypes)
    }

    // JS String Builtins (web/bun): encode JSString-typed user params/results/
    // locals as `externref` so `local.set`/calls from the `(ref extern)`-returning
    // builtins validate.  No-op when the program uses no JSString.
    injectExternRefSlots(program, functions, functionSigs)

    // CharCodeArray (web/bun): stamp CharCodeArray-typed params/results/locals as
    // a concrete `(ref null $Array_i16)` so they hold the GC array ref.
    if (ctx.usesCharCodeArray.v) {
        const arrIdx = ctx.wasmGcTypes.lookupByName(ARRAY_I16_NAME)
        if (arrIdx !== undefined) injectCharCodeArrayRefSlots(program, functions, functionSigs, arrIdx)
    }

    return {
        kind: 'Module',
        imports,
        globals,
        functions,
        dataSegments: ctx.strings.segments,
        exports: irExports,
        // Phase 5 Workstream B — populated by `@fnref` / `@call_indirect`
        // strata; absent for programs that don't use them so non-funcref
        // codegen stays byte-equal.  Either entries or signatures being
        // non-empty triggers emission — a program with `@call_indirect`
        // but no `@fnref` still needs the (type) declaration so the
        // call_indirect bytecode references a valid type index.
        funcrefTable: ctx.funcrefTable
            && (ctx.funcrefTable.entries.length > 0 || ctx.funcrefTable.signatures.length > 0)
            ? ctx.funcrefTable
            : undefined,
        // Phase 9d-7: drain the WasmGC type registry into the module.
        // Empty when target !== 'wasm-gc' — preserves byte-equal mvp codegen.
        wasmGcTypes: ctx.wasmGcTypes.size() > 0
            ? ctx.wasmGcTypes.snapshot()
            : undefined,
    }
}

/**
 * F1 — find every host-handle-carrying sum instantiation reachable in the
 * typed program, register its specialized flat-union GC struct, and emit its
 * specialized constructors.  wasm-gc only.
 *
 * Instantiations are discovered from two sources that together cover all real
 * uses: the function signatures (param/result types) and every `inferredType`
 * the typechecker stamped (constructor-call results, `@match` discriminants,
 * annotated locals).  The base `@type` def supplies the variant/field layout.
 */
function collectAndSpecializeHandleSums(
    program: Program,
    ctx: LowerCtx,
    append: (r: any) => void,
): void {
    // Base parametric @type defs, by name (`Result` → its AST).
    const baseDefs = new Map<string, any>()
    for (const el of (program.elements ?? []) as any[]) {
        const def = unwrap(el)
        if (def?.type === 'Definition' && def.keyword === '@type' &&
            (def.generics?.params?.length ?? 0) > 0 && def.name?.name) {
            baseDefs.set(def.name.name, def)
        }
    }
    if (baseDefs.size === 0) return

    const seen = ctx.sumSpecs!
    const consider = (t: SiliconType | undefined): void => {
        if (!needsHandleSpecialization(t)) return
        const sum = t as Extract<SiliconType, { kind: 'Sum' }>
        const mangled = mangleSumName(sum.name, sum.typeArgs!)
        if (seen.has(mangled)) return
        const def = baseDefs.get(sum.name)
        if (!def) return   // not a user parametric sum we can specialize
        const spec = buildSpecializedSum(sum.name, sum.typeArgs!, def, ctx.wasmGcTypes)
        seen.set(mangled, spec)
        for (const fn of emitSpecializedConstructors(spec)) append(fn)
    }

    // 1. Function signatures (params + results).
    for (const sig of ctx.functions.values()) {
        sig.params.forEach(consider)
        consider(sig.result)
    }
    // 2. Every stamped inferredType in the typed AST.
    const walk = (n: any): void => {
        if (!n || typeof n !== 'object') return
        if (Array.isArray(n)) { for (const x of n) walk(x); return }
        if (n.inferredType) consider(n.inferredType as SiliconType)
        for (const k of Object.keys(n)) {
            if (k === 'inferredType') continue
            walk(n[k])
        }
    }
    walk(program.elements)
}

/** F1 — on a non-wasm-gc target, a host handle (JSValue/JSString) cannot be a
 *  sum payload: externref isn't addressable in linear memory.  Detect any such
 *  instantiation and fail with a clear, actionable error (rather than emitting
 *  invalid wasm) — directing to `js::pin` / `--target=wasm-gc`. */
function assertNoHandleSumsOnLinearMem(program: Program, ctx: LowerCtx): void {
    const reportFor = (t: SiliconType | undefined): void => {
        if (!needsHandleSpecialization(t)) return
        const sum = t as Extract<SiliconType, { kind: 'Sum' }>
        throw new IRLowerError(
            `a host handle (JSValue/JSString) can't be a payload of '${sum.name}' on a ` +
            `linear-memory target — externref isn't addressable in linear memory. ` +
            `Compile with --target=wasm-gc to carry it natively, or thread it through a ` +
            `Result[Int, …] via js::pin (an Int handle id).`,
        )
    }
    for (const sig of ctx.functions.values()) {
        sig.params.forEach(reportFor)
        reportFor(sig.result)
    }
    const walk = (n: any): void => {
        if (!n || typeof n !== 'object') return
        if (Array.isArray(n)) { for (const x of n) walk(x); return }
        if (n.inferredType) reportFor(n.inferredType as SiliconType)
        for (const k of Object.keys(n)) { if (k !== 'inferredType') walk(n[k]) }
    }
    walk(program.elements)
}

/** Phase 9d-7 fix-4: when target === 'wasm-gc', walk every IRFunction
 *  whose declared Silicon return type or parameter type is a Sum, and
 *  set refResult / refParams so the binary type-section entry encodes
 *  `(ref $Foo)` instead of `i32`.  Constructors already had this set
 *  by typeRecordExpander; this fills in everything else (user
 *  functions that return or take a sum). */
function injectRefSlots(
    functions: IRFunction[],
    functionSigs: Map<string, FunctionSig>,
    wasmGcTypes: WasmGcTypeRegistry,
): void {
    for (const fn of functions) {
        const sig = functionSigs.get(fn.name)
        if (!sig) continue

        // Result: declared as a Sum or Vec → encode as ref.
        if (!fn.refResult) {
            const idx = siliconTypeToRefIdx(sig.result, wasmGcTypes)
            if (idx !== undefined) {
                fn.refResult = { localTypeIdx: idx, nullable: false }
            }
        }
        // Params: each Sum-/Vec-typed param gets refParams entry.
        for (let i = 0; i < sig.params.length; i++) {
            const idx = siliconTypeToRefIdx(sig.params[i], wasmGcTypes)
            if (idx === undefined) continue
            if (!fn.refParams) fn.refParams = new Map()
            if (!fn.refParams.has(i)) {
                fn.refParams.set(i, { localTypeIdx: idx, nullable: false })
            }
        }
    }
}

/** JS String Builtins — mark every JSString-typed user function param/result and
 *  `@local`/`@var` as a nullable `externref` ref slot (`IRRefSlot.extern`).  The
 *  builtins return non-null `(ref extern)`; declaring the holding slots as the
 *  wider nullable `externref` lets `local.set` / calls validate. */
const EXTERN_SLOT: IRRefSlot = { localTypeIdx: 0, nullable: true, extern: true }
/** True for the externref-shaped object-handle types (ADR 0018 P0): the
 *  `wasm:js-string` `JSString` and the generic host-object `JSValue`.  Both lower
 *  to a nullable `externref` ref slot; only their *operations* differ (JSString
 *  has the `wasm:js-string` builtins, JSValue is an opaque host handle). */
function isExternRefKind(t: string | undefined): boolean {
    return t === 'JSString' || t === 'JSValue'
}
function injectExternRefSlots(
    program: any,
    functions: IRFunction[],
    functionSigs: Map<string, FunctionSig>,
): void {
    const fnByName = new Map<string, IRFunction>()
    for (const f of functions) fnByName.set(f.name, f)

    // Params + result from the typechecker's signature.
    for (const fn of functions) {
        const sig = functionSigs?.get(fn.name)
        if (!sig) continue
        if (!fn.refResult && isExternRefKind(sig.result?.kind)) fn.refResult = EXTERN_SLOT
        sig.params.forEach((p, i) => {
            if (isExternRefKind(p?.kind)) {
                if (!fn.refParams) fn.refParams = new Map()
                if (!fn.refParams.has(i)) fn.refParams.set(i, EXTERN_SLOT)
            }
        })
    }

    // `@local`/`@var` declarations annotated `\\ name JSString|JSValue`.
    const items: any[] = (program?.elements ?? program?.items ?? []) as any[]
    for (const item of items) {
        const def = unwrap(item)
        if (!def || def.type !== 'Definition') continue
        if (def.keyword !== '@fn' && def.keyword !== '@global') continue
        const fn = fnByName.get(watId(def.name?.name ?? '')) ?? fnByName.get(def.name?.name ?? '')
        if (!fn) continue
        walkLocalsForExternRef(def.binding?.expression ?? def.binding, fn)
    }
}

function walkLocalsForExternRef(node: any, fn: IRFunction): void {
    if (!node || typeof node !== 'object') return
    if (node.type === 'Definition' && node.keyword === '@local') {
        const localName: string | undefined = node.name?.name
        if (localName && isExternRefKind(node.name?.typeAnnotation?.typename)) {
            const watLocalName = watId(localName)
            for (const l of fn.locals) {
                if (l.name === watLocalName || l.name === localName) { l.refType = EXTERN_SLOT; break }
            }
        }
    }
    for (const key of Object.keys(node)) {
        if (key === 'type' || key === 'sourceLocation') continue
        const val = (node as any)[key]
        if (Array.isArray(val)) for (const v of val) walkLocalsForExternRef(v, fn)
        else if (val && typeof val === 'object') walkLocalsForExternRef(val, fn)
    }
}

/** CharCodeArray — stamp CharCodeArray-typed params/results/locals with a concrete
 *  `(ref null $Array_i16)` slot so they hold the GC array ref (mirror of
 *  injectExternRefSlots, with a concrete typeidx instead of extern). */
function injectCharCodeArrayRefSlots(
    program: any,
    functions: IRFunction[],
    functionSigs: Map<string, FunctionSig>,
    arrIdx: number,
): void {
    const slot: IRRefSlot = { localTypeIdx: arrIdx, nullable: true }
    const fnByName = new Map<string, IRFunction>()
    for (const f of functions) fnByName.set(f.name, f)

    for (const fn of functions) {
        const sig = functionSigs?.get(fn.name)
        if (!sig) continue
        if (!fn.refResult && sig.result?.kind === 'CharCodeArray') fn.refResult = slot
        sig.params.forEach((p, i) => {
            if (p?.kind === 'CharCodeArray') {
                if (!fn.refParams) fn.refParams = new Map()
                if (!fn.refParams.has(i)) fn.refParams.set(i, slot)
            }
        })
    }

    const walk = (node: any, fn: IRFunction): void => {
        if (!node || typeof node !== 'object') return
        if (node.type === 'Definition' && node.keyword === '@local') {
            const localName: string | undefined = node.name?.name
            if (localName && node.name?.typeAnnotation?.typename === 'CharCodeArray') {
                const wln = watId(localName)
                for (const l of fn.locals) {
                    if (l.name === wln || l.name === localName) { l.refType = slot; break }
                }
            }
        }
        for (const key of Object.keys(node)) {
            if (key === 'type' || key === 'sourceLocation') continue
            const val = (node as any)[key]
            if (Array.isArray(val)) for (const v of val) walk(v, fn)
            else if (val && typeof val === 'object') walk(val, fn)
        }
    }
    const items: any[] = (program?.elements ?? program?.items ?? []) as any[]
    for (const item of items) {
        const def = unwrap(item)
        if (!def || def.type !== 'Definition') continue
        if (def.keyword !== '@fn' && def.keyword !== '@global') continue
        const fn = fnByName.get(watId(def.name?.name ?? '')) ?? fnByName.get(def.name?.name ?? '')
        if (fn) walk(def.binding?.expression ?? def.binding, fn)
    }
}

/** Phase 9d-8: walk every user `@fn`'s body looking for `@local`
 *  declarations whose annotation resolves to a ref-typed Sigil type
 *  (Vec / Sum).  Set the matching IRLocal.refType so the binary local
 *  declaration encodes `(ref $T)` instead of `i32` — `local.set` from
 *  a ref-returning call (vec_new, constructor) now type-checks at
 *  validation. */
function injectLocalRefSlots(
    program: any,
    functions: IRFunction[],
    wasmGcTypes: WasmGcTypeRegistry,
): void {
    const fnByName = new Map<string, IRFunction>()
    for (const f of functions) fnByName.set(f.name, f)

    const items: any[] = (program?.elements ?? program?.items ?? []) as any[]
    for (const item of items) {
        const def = unwrap(item)
        if (!def || def.type !== 'Definition') continue
        if (def.keyword !== '@fn' && def.keyword !== '@global') continue
        const name = def.name?.name
        if (!name) continue
        const watName = watId(name)
        const fn = fnByName.get(watName) ?? fnByName.get(name)
        if (!fn) continue
        walkLocalsForRefs(def.binding?.expression ?? def.binding, fn, wasmGcTypes)
    }
}

function walkLocalsForRefs(
    node: any, fn: IRFunction, wasmGcTypes: WasmGcTypeRegistry,
): void {
    if (!node || typeof node !== 'object') return
    if (node.type === 'Definition' && node.keyword === '@local') {
        const localName: string | undefined = node.name?.name
        let annot = node.name?.typeAnnotation
        // New-design: locals carry no declared `:Type` annotation any more.
        // The ref type now rides on an ascription binding —
        // `@local v := @as Vec[Int], vec_new 4` — so when the slot has no
        // declared annotation, pick it up from an Ascription binding.
        if (!annot) {
            const be = node.binding?.expression ?? node.binding
            if (be && be.type === 'Ascription') annot = be.typeAnnotation
        }
        if (localName && annot) {
            const refIdx = refIdxFromAnnotation(annot, wasmGcTypes)
            if (refIdx !== undefined) {
                const watLocalName = watId(localName)
                for (const l of fn.locals) {
                    if (l.name === watLocalName || l.name === localName) {
                        l.refType = { localTypeIdx: refIdx, nullable: false }
                        break
                    }
                }
            }
        }
    }
    for (const key of Object.keys(node)) {
        if (key === 'type' || key === 'sourceLocation') continue
        const val = (node as any)[key]
        if (Array.isArray(val)) {
            for (const v of val) walkLocalsForRefs(v, fn, wasmGcTypes)
        } else if (val && typeof val === 'object') {
            walkLocalsForRefs(val, fn, wasmGcTypes)
        }
    }
}

/** Resolve a raw AST `TypeAnnotation` to a ref-typeidx.  Hand-rolled
 *  rather than reusing the typechecker's `resolveTypeAnnotation` to
 *  avoid pulling typechecker context into the lower path. */
function refIdxFromAnnotation(
    annot: any, wasmGcTypes: WasmGcTypeRegistry,
): number | undefined {
    if (!annot) return undefined
    if (annot.typename === 'Vec'
        && Array.isArray(annot.typeArgs) && annot.typeArgs.length === 1) {
        const elem = annot.typeArgs[0].name
        const vecType = elem === 'Float' ? '$Vec_f32'
            : elem === 'Int64' ? '$Vec_i64'
            : elem === 'Int' ? '$Vec_i32'
            : undefined
        if (vecType) return wasmGcTypes.lookupByName(vecType)
    }
    // Bare typename — could be a user-defined sum.  The registry
    // already has `$<typename>` from typeRecordExpander; lookup by name.
    if (annot.typename) {
        return wasmGcTypes.lookupByName('$' + annot.typename)
    }
    return undefined
}

/** Map a SiliconType to its WasmGC localTypeIdx for ref encoding,
 *  or `undefined` if the type is not a ref under wasm-gc.
 *
 *  - `Sum { name }`  → `$<name>` in the registry.
 *  - `Vec { element }` → `$Vec_<elemTag>` (e.g. `$Vec_i32`).
 *  - everything else → `undefined` (encoded as the IR-level valtype).
 *
 *  v1.0 supports `Vec[Int]` only (the gc-vec extension registers
 *  `$Vec_i32`); other element types fall through to `undefined`
 *  and the field/param/local stays valtype-encoded.  v1.1 widens
 *  to f32/i64/ref-typed-T per ADR 0009 §3.
 */
function siliconTypeToRefIdx(
    t: SiliconType,
    wasmGcTypes: WasmGcTypeRegistry,
): number | undefined {
    if (t.kind === 'Sum') {
        // F1 — a host-handle instantiation (`Result[JSValue, String]`) resolves
        // to its specialized flat-union struct, not the all-i32 base `$Result`.
        if (needsHandleSpecialization(t)) {
            const mangled = wasmGcTypes.lookupByName('$' + mangleSumName(t.name, (t as any).typeArgs))
            if (mangled !== undefined) return mangled
        }
        return wasmGcTypes.lookupByName(`$${t.name}`)
    }
    if (t.kind === 'Vec') {
        // M1 — Vec[Int]/Vec[Float]/Vec[Int64] resolve to their per-element
        // GC struct ($Vec_i32 / $Vec_f32 / $Vec_i64).
        const name = t.element.kind === 'Float' ? '$Vec_f32'
            : t.element.kind === 'Int64' ? '$Vec_i64'
            : t.element.kind === 'Int' ? '$Vec_i32'
            : undefined
        return name ? wasmGcTypes.lookupByName(name) : undefined
    }
    return undefined
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
        deferStack: [],
        structLocals: new Map(ctx.structLocals),
    }
    // Track struct-typed params so `.field` access on a param resolves
    // through lowerStructFieldChain instead of falling through to a global
    // lookup.  Generic struct params (`s:Slice[T]`) key by the base name
    // — that's what structTypes is keyed by.
    for (const p of node.params || []) {
        if (p.isLiteral || !p.typeAnnotation) continue
        const rawTypeName = p.typeAnnotation.typename
        if (rawTypeName && ctx.registry?.structTypes?.has(rawTypeName)) {
            childCtx.structLocals.set(watId(p.name), rawTypeName)
        }
    }
    childCtx.$compiler = createCompilerAPI(childCtx, lowerFns)

    let body: IRExpr | undefined
    const binding = Array.isArray(node.binding) ? node.binding[0] : node.binding
    if (binding) {
        const expr = binding.expression ?? binding
        body = lowerExpr(expr, childCtx)
    }
    // Phase 4: drain pending @defer cleanups into the function tail.  Defers
    // run in LIFO order; for a non-void body the trailing value is hoisted
    // into a synthetic local so cleanup can execute between the value's
    // computation and its return.
    if (childCtx.deferStack.length > 0 && body) {
        body = wrapBodyWithDefers(body, childCtx)
    }
    return { body, locals: childCtx.pendingLocals }
}

function wrapBodyWithDefers(body: IRExpr, ctx: LowerCtx): IRExpr {
    const defers = ctx.deferStack
    const bodyType = exprWasmType(body)
    const cleanupStmts: IRStmt[] = []
    for (let i = defers.length - 1; i >= 0; i--) {
        cleanupStmts.push({ kind: 'ExprStmt', expr: defers[i] })
    }
    if (bodyType === 'void') {
        return { kind: 'Block', wasmType: 'void', stmts: [{ kind: 'ExprStmt', expr: body }, ...cleanupStmts], trailing: undefined }
    }
    const tmpName = `__defer_result_${ctx.freshIdCounter.n++}`
    const wasmValType = bodyType as WasmValType
    ctx.pendingLocals.push({ name: tmpName, wasmType: wasmValType })
    return {
        kind: 'Block',
        wasmType: bodyType,
        stmts: [{ kind: 'LocalSet', name: tmpName, value: body }, ...cleanupStmts],
        trailing: { kind: 'LocalGet', wasmType: bodyType, name: tmpName },
    }
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

/**
 * Build the full IRImport for an `@extern` declaration (ADR 0018 P0).
 * Generalizes the former hardcoded `(env, name)` form two ways:
 *   - a namespaced name `mod::field` imports from module `mod` (with
 *     IMPORT_ENV_OVERRIDE applied) instead of the hardcoded `env`; and
 *   - `JSString` / `JSValue` params/results become `externref` ref slots
 *     (the object-handle boundary) rather than collapsing to i32.
 * Externref imports require a JS host, so they are gated to web/bun.
 */
export function lowerExternImport(node: any, ctx: LowerCtx): IRImport {
    const rawName: string = node.name?.name ?? ''
    const sep = rawName.indexOf('::')
    const moduleName = sep === -1 ? 'env' : rawName.slice(0, sep)
    const field = sep === -1 ? rawName : rawName.slice(sep + 2)
    const watName = watId(rawName)
    const env = IMPORT_ENV_OVERRIDE[moduleName] ?? moduleName

    const params: WasmValType[] = []
    let refParams: Map<number, IRRefSlot> | undefined
    let usesExternref = false
    for (const p of node.params || []) {
        if (p.isLiteral || !p.typeAnnotation) continue
        const tn: string = p.typeAnnotation.typename
        const idx = params.length
        params.push(siliconTypeNameToWasm(tn))
        if (isExternRefKind(tn)) { (refParams ??= new Map()).set(idx, EXTERN_SLOT); usesExternref = true }
        // ADR 0019 C2 — a `Vec[Int]` param under wasm-gc is the closure handle
        // `(ref $Vec_i32)` crossing the boundary (engine-GC'd); give it a ref slot
        // so the import type matches (else the ref arg fails validation).
        else if (ctx.target === 'wasm-gc' && tn === 'Vec') {
            const vIdx = ctx.wasmGcTypes?.lookupByName('$Vec_i32')
            if (vIdx !== undefined) (refParams ??= new Map()).set(idx, { localTypeIdx: vIdx, nullable: false })
        }
    }

    const resName: string | undefined = node.name?.typeAnnotation?.typename
    const result = resName && resName !== 'Void' ? siliconTypeNameToWasm(resName) : undefined
    // An object-handle import (not a `wasm:js-string` builtin) may return null —
    // its result must be a NULLABLE externref or the host traps on null (e.g. a
    // DOM `getElement` miss, `Headers.get` of an absent header).  Mirrors the
    // module-call import path in lowerModuleCall.
    const refResult: IRRefSlot | undefined = resName && isExternRefKind(resName)
        ? { localTypeIdx: 0, nullable: moduleName !== 'JSString', extern: true }
        : undefined
    if (refResult) usesExternref = true

    if (usesExternref && ctx.platform !== 'web' && ctx.platform !== 'bun') {
        throw new IRLowerError(
            `'@extern ${rawName}' uses an externref object handle (JSString / JSValue) — ` +
            `compile with --platform=web or --platform=bun (sgl.toml: [build] platform = "bun").`,
        )
    }

    return { kind: 'Import', env, field, name: watName, params, result, refParams, refResult }
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

        // Ascription (`@as T, e`) is transparent at runtime — lower inner expr.
        case 'Ascription':
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

/**
 * Resolve a chain of struct field accesses for paths of length >= 1.
 * baseKey is the watId of the first path segment (the root local/global),
 * currentStructName is its struct type, and remaining is path[1..].
 * Returns null if any segment doesn't resolve as a struct field.
 *
 * AUDIT NOTE — field access stays a compiler primitive (deliberately not a
 * stratum), despite docs/strata-feature-audit.html tagging it "should-migrate".
 * On inspection it belongs with literal/BinOp lowering in the irreducible
 * expression substrate, NOT with the keyword strata:
 *   1. There is no keyword and no distinct AST node to dispatch on — `p.x` is a
 *      `Namespace` whose multi-segment `path` is heuristically recognised here
 *      (and `p.x = v` is a `BinaryOp('=')` in lowerBinaryOp).  Unlike @try /
 *      @fnref / @with_arena there is no hardcoded `name === '@...'` branch to
 *      dissolve — this is already part of the normal node-kind switch.
 *   2. The logic is intrinsically host-side: struct-layout registry, field
 *      offsets/wasm types, the struct-local map, recursive chaining.  A `.si`
 *      handler would delegate 100% to new primitives for all of it — a hollow
 *      migration that adds surface without moving real logic to Silicon.
 * A genuine data-driven version needs a member-access dispatch hook + open-tagged
 * IR (bootstrap-plan R1) — i.e. the self-host-port infrastructure, not a
 * standalone change.  See the IRExpr note in src/ir/nodes.ts.
 */
function lowerStructFieldChain(
    baseKey: string,
    currentStructName: string,
    remaining: string[],
    ctx: LowerCtx,
): IRExpr | null {
    // Build the root pointer expression.
    let ptr: IRExpr = ctx.locals.has(baseKey)
        ? { kind: 'LocalGet', wasmType: 'i32', name: baseKey }
        : { kind: 'GlobalGet', wasmType: 'i32', name: baseKey }

    let structName = currentStructName
    for (let i = 0; i < remaining.length; i++) {
        const fieldName = remaining[i]
        const layout = ctx.registry?.structTypes?.get(structName)
        const field = layout?.fields.find(f => f.name === fieldName)
        if (!field) return null

        const addr: IRExpr = field.offset === 0 ? ptr : {
            kind: 'BinOp', wasmType: 'i32', op: 'i32_add',
            left: ptr, right: { kind: 'Const', wasmType: 'i32', value: field.offset },
        }
        const loadInstr = field.wasmType === 'f32' ? 'f32.load'
            : field.wasmType === 'i64' ? 'i64.load' : 'i32.load'
        const loaded: IRExpr = {
            kind: 'Call', wasmType: field.wasmType, callee: loadInstr,
            callKind: 'instr', args: [addr],
        } as any

        if (i === remaining.length - 1) {
            // Last segment — return the loaded value.
            return loaded
        }
        // Intermediate segment — must be a struct-typed field (i32 pointer).
        // Continue chaining with the loaded pointer as the new base.
        if (field.typeName && ctx.registry?.structTypes?.has(field.typeName)) {
            structName = field.typeName
            ptr = loaded
        } else {
            return null
        }
    }
    return null
}

function lowerNamespace(n: any, ctx: LowerCtx): IRExpr {
    const path: string[] = n.path ?? []

    // Struct field read: p.x or p.start.x (nested) where each segment after the
    // first is a struct field name. Path length >= 2 with the first segment being
    // a local/global holding a struct pointer.
    if (path.length >= 2) {
        const baseKey = watId(path[0])
        const structName = ctx.structLocals.get(baseKey)
        if (structName) {
            const result = lowerStructFieldChain(baseKey, structName, path.slice(1), ctx)
            if (result) return result
        }
    }

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
    const inferT = inferredTypeOf(n, ctx)
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

/**
 * Build a store instruction for a nested struct field write.
 * Chains i32.load for all intermediate segments, then emits a store for the last.
 * Returns null if the path doesn't resolve as struct fields.
 */
function lowerStructFieldStore(
    baseKey: string,
    currentStructName: string,
    remaining: string[],
    value: IRExpr,
    ctx: LowerCtx,
): IRExpr | null {
    if (remaining.length === 0) return null
    let ptr: IRExpr = ctx.locals.has(baseKey)
        ? { kind: 'LocalGet', wasmType: 'i32', name: baseKey }
        : { kind: 'GlobalGet', wasmType: 'i32', name: baseKey }

    let structName = currentStructName
    for (let i = 0; i < remaining.length; i++) {
        const fieldName = remaining[i]
        const layout = ctx.registry?.structTypes?.get(structName)
        const field = layout?.fields.find(f => f.name === fieldName)
        if (!field) return null

        const addr: IRExpr = field.offset === 0 ? ptr : {
            kind: 'BinOp', wasmType: 'i32', op: 'i32_add',
            left: ptr, right: { kind: 'Const', wasmType: 'i32', value: field.offset },
        }

        if (i === remaining.length - 1) {
            // Last segment — emit the store.
            const storeInstr = field.wasmType === 'f32' ? 'f32.store'
                : field.wasmType === 'i64' ? 'i64.store' : 'i32.store'
            const storeStmt: IRStmt = {
                kind: 'ExprStmt',
                expr: { kind: 'Call', wasmType: 'void', callee: storeInstr, callKind: 'instr', args: [addr, value] } as any,
            }
            return { kind: 'Block', wasmType: 'void', stmts: [storeStmt] }
        }
        // Intermediate segment — load the pointer and continue.
        if (field.typeName && ctx.registry?.structTypes?.has(field.typeName)) {
            structName = field.typeName
            ptr = { kind: 'Call', wasmType: 'i32', callee: 'i32.load', callKind: 'instr', args: [addr] } as any
        } else {
            return null
        }
    }
    return null
}

function lowerBinaryOp(n: any, ctx: LowerCtx): IRExpr {
    const op: string = n.operator

    // `=` in trailing expression position — the grammar parses `x = val` without
    // a trailing `;` as a BinaryOp rather than an Assignment node. Recover by
    // treating the left side as the assignment target.
    if (op === '=') {
        const rawPath = extractNamespacePath(n.left)
        const path = rawPath.map(watId)
        const value = lowerExpr(n.right, ctx)

        // Struct field write: p.x = val or p.start.x = val (nested)
        if (rawPath.length >= 2) {
            const baseKey = path[0]
            const structName = ctx.structLocals.get(baseKey)
            if (structName) {
                const storeResult = lowerStructFieldStore(baseKey, structName, rawPath.slice(1), value, ctx)
                if (storeResult) return storeResult
            }
        }

        const target = path.join('::')
        const setStmt: IRStmt = ctx.locals.has(target)
            ? { kind: 'LocalSet', name: target, value }
            : { kind: 'GlobalSet', name: target, value }
        return { kind: 'Block', wasmType: 'void', stmts: [setStmt] }
    }

    const left = lowerExpr(n.left, ctx)
    const right = lowerExpr(n.right, ctx)

    const inferT = inferredTypeOf(n, ctx)
    const resultWt: WasmValType = (inferT && inferT.kind !== 'Unknown')
        ? (wasmTypeOf(inferT) as WasmValType)
        : exprWasmType(left)

    // Bitwise ops are always i32; other ops follow the operand type.
    // Operand-type dispatch picks the strata variant: 'Int' (i32),
    // 'Int64' (i64), 'Float' (f32), or — Phase 5b — UInt8/16/32/64.
    // Prefer the inferred SiliconType.kind so unsigned types route to
    // their typed_operator strata instead of getting collapsed into the
    // signed Int / Int64 buckets via wasmTypeOf.
    const isBitwise = ['|', '^', '<<', '>>'].includes(op)
    const leftInferT = inferredTypeOf(n.left, ctx)
    const leftWt = exprWasmType(left)
    const unsignedKind =
        leftInferT?.kind === 'UInt8'  ? 'UInt8'  :
        leftInferT?.kind === 'UInt16' ? 'UInt16' :
        leftInferT?.kind === 'UInt32' ? 'UInt32' :
        leftInferT?.kind === 'UInt64' ? 'UInt64' :
        undefined
    const typeKind = isBitwise
        ? (unsignedKind ?? 'Int')
        : unsignedKind != null ? unsignedKind
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

    const abstractOp = resolveIntrinsicAbstractOp(intrinsic) as AbstractOp | undefined
    if (!abstractOp) throw new IRLowerError(`No WasmIntrinsic for '${intrinsic}'`)

    const primary: IRExpr = { kind: 'BinOp', wasmType: resultWt, op: abstractOp, left, right }

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
    // Skipped while compiling a strata handler @fn: a handler body is
    // compiler-internal code, and firing call-site handlers inside it would
    // deadlock the T0 fixpoint (every body's calls would fire the
    // not-yet-compiled monomorphization handler).
    const inHandlerCompile = (ctx.registry as any).__compilingHandler === true
    const hasNameKeyed = !inHandlerCompile && ctx.registry.handlers.callSite.has(name)
    const hasWildcard  = !inHandlerCompile && ctx.registry.handlers.callSite.has('*')
    if (hasNameKeyed) {
        fireHandlers(ctx.registry, 'callSite', name, n, ctx.$compiler!, ctx.currentStratumRef)
    }
    if (hasWildcard) {
        fireHandlers(ctx.registry, 'callSite', '*', n, ctx.$compiler!, ctx.currentStratumRef)
    }
    if (hasNameKeyed || hasWildcard) name = callName(n)

    if (n.isBuiltin) {
        return lowerBuiltinCall(name, n.args || [], ctx, inferredTypeOf(n, ctx))
    }

    // WASM/IR intrinsic direct call (e.g. &WASM::i32_add 1, 2 or &IR::i32_add 1, 2).
    if (name.startsWith('WASM::') || name.startsWith('IR::')) {
        const resolvedInstr = resolveIntrinsicWasmInstr(name)
        const args = (n.args || []).map((a: any) => lowerExpr(a, ctx))
        const inferT = inferredTypeOf(n, ctx)
        // WASM store / drop instructions are void at the WASM level — pin their
        // wasmType so downstream emit doesn't try to (drop ...) their non-result.
        const instr = resolvedInstr ?? name
        const isVoidInstr = instr === 'i32.store' || instr === 'i32.store8'
            || instr === 'i64.store' || instr === 'f32.store' || instr === 'drop'
            || instr === 'memory.copy' || instr === 'memory.fill'
        const wt = isVoidInstr ? 'void' : resolveWasmType(inferT, 'i32')
        return { kind: 'Call', wasmType: wt, callee: instr, callKind: 'instr', args }
    }

    // Module namespaced call: web::console_log_str, Draw::fill_rect, etc.
    const sepIdx = name.indexOf('::')
    if (sepIdx !== -1) {
        return lowerModuleCall(name, sepIdx, n, ctx)
    }

    // F1 — route a variant constructor call (`Ok(h)`) whose result is a
    // host-handle instantiation (`Result[JSValue, String]`) to its specialized
    // constructor (`Ok$JSValue_String`), which struct.news the flat-union GC
    // struct with the handle in a native externref field.
    if (ctx.sumSpecs && ctx.sumSpecs.size > 0) {
        const ctorInfer = inferredTypeOf(n, ctx)
        if (needsHandleSpecialization(ctorInfer)) {
            const sum = ctorInfer as Extract<SiliconType, { kind: 'Sum' }>
            const spec = ctx.sumSpecs.get(mangleSumName(sum.name, sum.typeArgs!))
            const variant = spec?.variants.find(v => v.name === name)
            if (variant) {
                const cargs = (n.args || []).map((a: any) => lowerExpr(a, ctx))
                return { kind: 'Call', wasmType: 'i32', callee: variant.ctorName, callKind: 'user', args: cargs }
            }
        }
    }

    // User-defined function call.
    const watName = watId(name)
    const args = (n.args || []).map((a: any) => lowerExpr(a, ctx))
    const sig = ctx.functions.get(watName)
    const inferT = inferredTypeOf(n, ctx)
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
        // ADR 0018 P1 — a declared `@extern mod::field` is a direct host import
        // (import module = `mod`), not a Silicon module.  Route the call to it.
        // The import itself is emitted by ExternDef_lower; here we just emit the
        // call.  The call's wasmType is the base valtype; externref results are
        // tracked via the import's refResult + injectExternRefSlots, same as the
        // bare-extern path.
        const externImp = ctx.externCalls.get(name)
        if (externImp) {
            const args = (n.args || []).map((a: any) => lowerExpr(a, ctx))
            return { kind: 'Call', wasmType: externImp.result ?? 'void', callee: externImp.name, callKind: 'user', args }
        }
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

    // externref needs a JS host: gate JSString / JSValue object handles on
    // `--platform=web|bun` (wasmtime / native can't provide externref).
    const usesExternref = moduleName === 'JSString'
        || isExternRefKind(fnSig.siliconResult) || fnSig.siliconParams.some(isExternRefKind)
    if (usesExternref && ctx.platform !== 'web' && ctx.platform !== 'bun') {
        throw new IRLowerError(
            `'${moduleName}::${funcName}' uses an externref object handle (JSString / JSValue) — ` +
            `compile with --platform=web or --platform=bun (sgl.toml: [build] platform = "bun").`
        )
    }

    // CharCodeArray ops lower to inline `array.*` on the GC i16 array — no host
    // import.  (`codeArray`/`getCode`/`setCode`/`codeLen`.)
    if (moduleName === 'JSString' && CHARCODE_INLINE_OPS.has(funcName)) {
        const idx = charCodeArrayTypeIdx(ctx)
        const a = (n.args || []).map((x: any) => lowerExpr(x, ctx))
        switch (funcName) {
            case 'codeArray': return { kind: 'ArrayNewDefault', wasmType: 'i32', typeIdx: idx, typeName: ARRAY_I16_NAME, size: a[0] }
            case 'getCode':   return { kind: 'ArrayGet', wasmType: 'i32', typeIdx: idx, typeName: ARRAY_I16_NAME, signed: 'u', target: a[0], idx: a[1] }
            case 'setCode':   return { kind: 'ArraySet', wasmType: 'void', typeIdx: idx, typeName: ARRAY_I16_NAME, target: a[0], idx: a[1], value: a[2] }
            case 'codeLen':   return { kind: 'ArrayLen', wasmType: 'i32', target: a[0] }
        }
    }

    // WAT internal name: module__function (double-underscore avoids collision with user names)
    const watName = `${moduleName}__${funcName}`

    // Register the import once per compilation (deduplicated by watName).
    if (!ctx.pendingImports.has(watName)) {
        // JS-host modules whose import-module string differs from the call prefix
        // (e.g. `&JSString::concat` → `(import "wasm:js-string" "concat" …)`).
        // The String↔JSString bridge functions are host-provided (`js-bridge`),
        // not standardized builtins.
        const env = JSSTRING_BRIDGE_FNS.has(funcName) && moduleName === 'JSString'
            ? 'js-bridge'
            : IMPORT_ENV_OVERRIDE[moduleName] ?? moduleName

        // JSString-typed params/results become `externref` / `(ref extern)` slots
        // (JS String Builtins).  String params are nullable `externref`; a
        // string-returning builtin must declare a non-null `(ref extern)` result
        // (the host validates the exact signature — verified under Bun).
        // A CharCodeArray param/result is a concrete `(ref null $Array_i16)` GC
        // ref (for fromCharCodeArray / intoCharCodeArray).
        let refParams: Map<number, IRRefSlot> | undefined
        fnSig.siliconParams.forEach((t, i) => {
            if (isExternRefKind(t)) {
                (refParams ??= new Map()).set(i, { localTypeIdx: 0, nullable: true, extern: true })
            } else if (t === 'CharCodeArray') {
                (refParams ??= new Map()).set(i, { localTypeIdx: charCodeArrayTypeIdx(ctx), nullable: true })
            }
        })
        // A `wasm:js-string` builtin result is the spec's non-null `(ref extern)`
        // (the host validates the exact signature).  But a general object-handle
        // import (`json`/`bun`/`url`/… — our own host shim) can legitimately
        // return `null` (e.g. `Headers.get` of a missing header, `URL.parse` of an
        // invalid URL); its result must be a NULLABLE `externref` or the host
        // traps ("returned null for a nonnullable result").
        const refResult: IRRefSlot | undefined = isExternRefKind(fnSig.siliconResult)
            ? { localTypeIdx: 0, nullable: moduleName !== 'JSString', extern: true }
            : fnSig.siliconResult === 'CharCodeArray'
                ? { localTypeIdx: charCodeArrayTypeIdx(ctx), nullable: true }
                : undefined

        ctx.pendingImports.set(watName, {
            kind: 'Import',
            env,
            field: funcName,
            name: watName,
            params: fnSig.params,
            result: fnSig.result,
            refParams,
            refResult,
        })
    }

    const args = (n.args || []).map((a: any) => lowerExpr(a, ctx))
    const wt: WasmType = fnSig.result ?? 'void'
    return { kind: 'Call', wasmType: wt, callee: watName, callKind: 'user', args }
}

function lowerBuiltinCall(name: string, rawArgs: any[], ctx: LowerCtx, inferredType?: any): IRExpr {
    // Phase 5 Workstream B — `@fnref` / `@call_indirect` are now data-driven
    // strata (src/strata/funcref.si); they fall through to the on::lower
    // handler-firing path below (the funcref-table state they mutate is
    // reachable via the CompilerAPI `funcref` surface).
    // Phase 5a-3 — `@try` is now a data-driven stratum (src/strata/try.si);
    // it falls through to the on::lower handler-firing path below.
    // Phase 9c (ADR 0008) — `@with_arena` / `@move_to_parent_arena` are now
    // data-driven strata (src/strata/arena.si) whose handlers delegate to the
    // host arena expander (lowerWithArena / lowerMoveToParentArena, surfaced
    // via the CompilerAPI); they fall through to the handler-firing path below.
    // Typed dispatch: try the first arg's type kind, fall back to the untyped entry.
    const firstArgKind: string = (inferredTypeOf(rawArgs[0], ctx) ?? (rawArgs[0] as any)?.inferredType)?.kind ?? 'Int'
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
    if (!intrinsic) {
        const compilingHandler = (ctx.registry as any).__compilingHandler === true
        const typedKey = `${name}:${firstArgKind}`
        const canFire = (key: string): boolean =>
            ctx.registry.handlers.lower.has(key) &&
            (!compilingHandler || hasCompiledHandlerFor(ctx.registry, key))
        const handlerKey =
            canFire(typedKey) ? typedKey :
            canFire(name)     ? name     :
            ''
        if (handlerKey) {
            const synthNode = { type: 'FunctionCall', name: { type: 'Namespace', path: [name] }, args: rawArgs, inferredType }
            const results = fireHandlers(ctx.registry, 'lower', handlerKey, synthNode, ctx.$compiler!, ctx.currentStratumRef)
            const result = results.length > 0 ? results[results.length - 1] : null
            if (result) return result as IRExpr
            // Handler fired but returned no IR (e.g. @defer registers a side-effect
            // into ctx state and emits nothing at the call site).  Treat as Nop —
            // never fall through to the phantom "(call $defer ...)" generic path.
            return nop()
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

// ── Phase 9c (ADR 0008) — explicit-arena memory management ────────────
//
// `@with_arena { body }` saves the heap pointer at entry and resets
// it at exit.  `@move_to_parent_arena value` (tail position only)
// memcpys a flat heap value to the saved boundary so the block result
// survives the reset.  v1.0 supports value types and `String`; arrays
// and sum-with-payloads are recognised but their byte-size computation
// is gated to Phase 9c follow-up stories.  Nested heap types are
// rejected with a lower-time diagnostic.
//
// Lowering shape (heap-typed tail with promotion):
//
//   {
//     __arena_saved := heap_get
//     <body stmts>
//     __arena_ptr   := <lowered promoted expr>
//     trailing: arena_promote(__arena_saved, __arena_ptr, sizeof(T))
//   }
//
// Lowering shape (value-typed tail, with or without &move_to_parent_arena):
//
//   {
//     __arena_saved := heap_get
//     <body stmts>
//     __arena_result := <lowered trailing>
//     heap_set(__arena_saved)
//     trailing: __arena_result
//   }
//
// Lowering shape (void body):
//
//   {
//     __arena_saved := heap_get
//     <body stmts>
//     heap_set(__arena_saved)
//   }

function isMoveToParentArenaCall(node: any): boolean {
    if (!node || node.type !== 'FunctionCall') return false
    return callName(node) === '@move_to_parent_arena'
}

/** Is this type stored entirely as a value (no pointer dereference)? */
function isValueType(t: SiliconType | undefined): boolean {
    if (!t) return false
    switch (t.kind) {
        case 'Int': case 'Int64': case 'Float': case 'Bool':
        case 'UInt8': case 'UInt16': case 'UInt32': case 'UInt64':
        case 'Void':
            return true
        // Distinct over a value type is also a value type.
        case 'Distinct':
            return isValueType(t.underlying)
        // Payload-free Sum (variants are i32 globals) is a value type;
        // payload-bearing Sum is heap.  Without per-variant inspection
        // here we conservatively treat all Sum as heap (it falls through
        // to the not-yet-supported branch in sizeExprForFlatHeap).
        default:
            return false
    }
}

/** Compute the byte size of a flat heap value as an IRExpr.  Returns
 *  `null` for types whose size computation isn't supported in v1.0
 *  (caller turns that into a structured lower-time error).
 *
 *  Supported in v1.0:
 *    - String                 → 4 + i32.load(ptr)
 *    - Array[T] (T value)     → 4 + i32.load(ptr) * sizeof(T)
 *    - Sum with flat payloads → 4 + 4 * maxFields (constant per type;
 *                                pad-to-max layout from defExpanders.ts)
 *    - Distinct over flat     → recurse on underlying
 *
 *  Rejected (caller emits structured error):
 *    - Array of heap T  (nested heap; v1.1 trace-and-copy)
 *    - Sum whose any variant has a heap-typed field (nested heap)
 *    - Function, Variable, Unknown, Void
 */
function sizeExprForFlatHeap(
    type: SiliconType | undefined,
    ptrGet: () => IRExpr,
    ctx: LowerCtx,
): IRExpr | null {
    if (!type) return null

    if (type.kind === 'Distinct') {
        return sizeExprForFlatHeap(type.underlying, ptrGet, ctx)
    }

    if (type.kind === 'String') {
        // [byte_len:i32 LE][utf8 bytes…] — total size = 4 + byte_len.
        const lenLoad: IRExpr = {
            kind: 'Call', wasmType: 'i32', callee: 'i32.load', callKind: 'instr',
            args: [ptrGet()],
        } as IRExpr
        return {
            kind: 'BinOp', wasmType: 'i32', op: 'i32_add',
            left: { kind: 'Const', wasmType: 'i32', value: 4 },
            right: lenLoad,
        }
    }

    if (type.kind === 'Array') {
        // [count:i32][elem_0][elem_1]… — total size = 4 + count * elemBytes.
        // Reject Array-of-heap as nested (caller emits the diagnostic).
        const elemBytes = valueTypeByteSize(type.element)
        if (elemBytes === null) return null
        const countLoad: IRExpr = {
            kind: 'Call', wasmType: 'i32', callee: 'i32.load', callKind: 'instr',
            args: [ptrGet()],
        } as IRExpr
        return {
            kind: 'BinOp', wasmType: 'i32', op: 'i32_add',
            left: { kind: 'Const', wasmType: 'i32', value: 4 },
            right: {
                kind: 'BinOp', wasmType: 'i32', op: 'i32_mul',
                left: countLoad,
                right: { kind: 'Const', wasmType: 'i32', value: elemBytes },
            },
        }
    }

    if (type.kind === 'Sum') {
        // Layout in `src/strata/defExpanders.ts:typeRecordExpander`:
        //   [tag:i32, field0:i32, …, field<maxFields-1>:i32]   (4 + 4*maxFields bytes)
        // The size is *constant* per sum type because pad-to-max means
        // every variant uses the same record width.  No runtime load
        // needed; emit an i32.const.
        const layout = ctx.registry.sumLayouts.get(type.name)
        if (!layout) return null   // sum declared but layout not registered → reject

        // Reject if any variant has a heap-typed field — that's nested
        // heap, deferred to v1.1.  Conservative across all variants
        // because the runtime tag isn't known here; even if the live
        // value's variant happens to be all-value, a future Sum
        // construction with a heap variant would dangle on promotion.
        for (const v of layout.variants) {
            for (const ft of v.fieldTypes) {
                if (valueTypeByteSize(ft) === null) return null
            }
        }
        return { kind: 'Const', wasmType: 'i32', value: 4 + 4 * layout.maxFields }
    }

    return null
}

/** Byte size of a *value-typed* SiliconType, or null for heap types
 *  (= "nested heap, refuse to promote"). */
function valueTypeByteSize(t: SiliconType): number | null {
    switch (t.kind) {
        case 'Int':
        case 'Float':
        case 'Bool':
        case 'UInt8':
        case 'UInt16':
        case 'UInt32':
            return 4
        case 'Int64':
        case 'UInt64':
            return 8
        case 'Distinct':
            return valueTypeByteSize(t.underlying)
        // String, Array, Sum, Function, Variable, Unknown, Void → not value.
        default:
            return null
    }
}

function lowerWithArena(rawArgs: any[], ctx: LowerCtx): IRExpr {
    if (rawArgs.length !== 1) {
        throw new IRLowerError(
            `@with_arena expects exactly 1 argument (a block { … }), got ${rawArgs.length}`,
        )
    }
    const bodyNode = unwrap(rawArgs[0])
    if (!bodyNode || bodyNode.type !== 'Block') {
        throw new IRLowerError(
            `@with_arena: argument must be a block { … }, got ${bodyNode?.type ?? typeof bodyNode}`,
        )
    }

    // ── Phase 9d-5c — wasm-gc compile-time elision ───────────────────────
    //
    // Under wasm-gc the engine GC owns reclamation; the save/restore
    // envelope is unnecessary and `@move_to_parent_arena` is identity
    // (GC keeps the value alive as long as it's reachable from the
    // parent scope).  Lower the body directly, drop the
    // `@move_to_parent_arena` wrapper at the tail if present.
    if (ctx.target === 'wasm-gc') {
        const stripped = isMoveToParentArenaCall(bodyNode.trailing)
            ? { ...bodyNode, trailing: unwrap(bodyNode.trailing.args?.[0]) }
            : bodyNode
        return lowerBlock(stripped, ctx)
    }

    const savedName = `__arena_saved_${ctx.freshIdCounter.n++}`
    ctx.pendingLocals.push({ name: savedName, wasmType: 'i32' })
    ctx.locals.set(savedName, 'i32')

    const heapGet = (): IRExpr => ({ kind: 'GlobalGet', wasmType: 'i32', name: 'heap' })
    const heapSetStmt = (v: IRExpr): IRStmt => ({ kind: 'GlobalSet', name: 'heap', value: v })
    const savedSetStmt = (v: IRExpr): IRStmt => ({ kind: 'LocalSet', name: savedName, value: v })
    const savedGet = (): IRExpr => ({ kind: 'LocalGet', wasmType: 'i32', name: savedName })

    const stmts: IRStmt[] = [savedSetStmt(heapGet())]
    for (const item of bodyNode.items || []) {
        const unwrapped = unwrap(item)
        if (!unwrapped) continue
        const stmt = lowerAsStmt(unwrapped, ctx)
        if (stmt) stmts.push(stmt)
    }

    const trailing = bodyNode.trailing
    const tailIsPromote = isMoveToParentArenaCall(trailing)

    // ── Tail-position @move_to_parent_arena ────────────────────────────
    if (tailIsPromote) {
        const promotedExprNode = unwrap(trailing.args?.[0])
        if (!promotedExprNode) {
            throw new IRLowerError('@move_to_parent_arena requires a single value argument')
        }
        const promotedType = inferredTypeOf(promotedExprNode, ctx)
        const promotedIR = lowerExpr(promotedExprNode, ctx)

        // Value types: identity — the bytes-to-copy is 0, and the "pointer"
        // returned is just the value itself.  Skip arena_promote and emit
        // the standard reset envelope to avoid trying to memcpy from a
        // value-bit-pattern address.
        if (isValueType(promotedType)) {
            const wt = (promotedIR as any).wasmType ?? 'i32'
            const resName = `__arena_result_${ctx.freshIdCounter.n++}`
            ctx.pendingLocals.push({ name: resName, wasmType: wt })
            ctx.locals.set(resName, wt)
            stmts.push({ kind: 'LocalSet', name: resName, value: promotedIR })
            stmts.push(heapSetStmt(savedGet()))
            return {
                kind: 'Block', wasmType: wt, stmts,
                trailing: { kind: 'LocalGet', wasmType: wt, name: resName },
            }
        }

        // Heap type: stash the inside-arena pointer in a local, compute
        // the byte size, then arena_promote — that helper owns the
        // memcpy + heap reset in one call.
        const ptrName = `__arena_ptr_${ctx.freshIdCounter.n++}`
        ctx.pendingLocals.push({ name: ptrName, wasmType: 'i32' })
        ctx.locals.set(ptrName, 'i32')
        stmts.push({ kind: 'LocalSet', name: ptrName, value: promotedIR })
        const ptrGet = (): IRExpr => ({ kind: 'LocalGet', wasmType: 'i32', name: ptrName })

        const sizeExpr = sizeExprForFlatHeap(promotedType, ptrGet, ctx)
        if (!sizeExpr) {
            const tname = promotedType ? promotedType.kind : '<unknown>'
            throw new IRLowerError(
                `@move_to_parent_arena: byte-size computation for type '${tname}' is not implemented yet. ` +
                `0.1 supports value types and String; arrays / sum-with-payloads / nested heap are Phase 9c follow-up stories.`,
            )
        }

        const promoteCall: IRExpr = {
            kind: 'Call', wasmType: 'i32', callee: 'arena_promote', callKind: 'user',
            args: [savedGet(), ptrGet(), sizeExpr],
        }
        return { kind: 'Block', wasmType: 'i32', stmts, trailing: promoteCall }
    }

    // ── No tail promotion ──────────────────────────────────────────────
    if (!trailing) {
        stmts.push(heapSetStmt(savedGet()))
        return { kind: 'Block', wasmType: 'void', stmts, trailing: undefined }
    }

    const trailingIR = lowerExpr(trailing, ctx)
    const trailingType = inferredTypeOf(trailing, ctx)
    const trailingWasmType: WasmType = (trailingIR as any).wasmType ?? 'i32'

    // Heap-typed return without @move_to_parent_arena → the pointer would
    // dangle once heap resets.  Surface the fix explicitly.
    if (trailingType && !isValueType(trailingType)) {
        throw new IRLowerError(
            `@with_arena: body returns heap type '${trailingType.kind}' — wrap the result in @move_to_parent_arena(...) to escape it to the parent arena, ` +
            `or restructure so the block returns a value type (ADR 0008, Phase 9c).`,
        )
    }

    // Void-typed trailing (e.g. body ends with a side-effecting call) —
    // treat it as the no-trailing case: run the expression for its
    // effects, reset, evaluate to void.
    if (trailingWasmType === 'void') {
        stmts.push({ kind: 'ExprStmt', expr: trailingIR })
        stmts.push(heapSetStmt(savedGet()))
        return { kind: 'Block', wasmType: 'void', stmts, trailing: undefined }
    }

    const valType: WasmValType = trailingWasmType
    const resName = `__arena_result_${ctx.freshIdCounter.n++}`
    ctx.pendingLocals.push({ name: resName, wasmType: valType })
    ctx.locals.set(resName, valType)
    stmts.push({ kind: 'LocalSet', name: resName, value: trailingIR })
    stmts.push(heapSetStmt(savedGet()))
    return {
        kind: 'Block', wasmType: valType, stmts,
        trailing: { kind: 'LocalGet', wasmType: valType, name: resName },
    }
}

function lowerMoveToParentArena(rawArgs: any[], ctx: LowerCtx): IRExpr {
    // Phase 9d-5c — wasm-gc compile-time elision.
    // Under wasm-gc the engine GC keeps reachable values alive automatically,
    // so `@move_to_parent_arena v` is identity.  Allowed anywhere (not just
    // tail position) because there's no save/restore envelope to subvert.
    if (ctx.target === 'wasm-gc') {
        if (rawArgs.length !== 1) {
            throw new IRLowerError(
                `@move_to_parent_arena expects exactly 1 argument, got ${rawArgs.length}`,
            )
        }
        return lowerExpr(unwrap(rawArgs[0]), ctx)
    }
    // Reached only when `@move_to_parent_arena value` appears *outside*
    // the tail of a `@with_arena { … }` block — the tail-position case
    // is short-circuited by lowerWithArena before this dispatch runs.
    throw new IRLowerError(
        `@move_to_parent_arena may only appear in the tail position of a @with_arena({ … }) block ` +
        `(ADR 0008, Phase 9c; v1.1 will lift this restriction via pointer-fixup).` +
        (rawArgs.length === 0 ? ' (no arguments given)' : ''),
    )
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

    // Legacy 'global' codegenKind binding inside a function body: treat as a
    // mutable local variable (Local declaration + LocalSet, not a module
    // Global).  In-function @local is handled by the @local branch below.
    if (node.type === 'Definition' && node.hook === 'global') {
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
        const rawTypeName = node.name?.typeAnnotation?.typename
        if (rawTypeName) {
            wasmType = siliconTypeNameToWasm(rawTypeName)
        }
        // Track struct locals so field-access lowering can find the layout.
        // Inline local annotations were removed (signature-lines), so a struct
        // local is recognised from its declared type OR the binding's inferred
        // type (e.g. `@local p := &Point 3, 4` infers Point from the ctor).
        let localStructName = (rawTypeName && ctx.registry?.structTypes?.has(rawTypeName)) ? rawTypeName : undefined
        if (!localStructName) {
            const b0 = Array.isArray(node.binding) ? node.binding[0] : node.binding
            const inferredName = ((b0?.expression ?? b0) as any)?.inferredType?.name
            if (inferredName && ctx.registry?.structTypes?.has(inferredName)) localStructName = inferredName
        }
        if (localStructName) ctx.structLocals.set(name, localStructName)
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
        // Track @local vars that hold struct pointers so field-access lowering works.
        if (keyword === '@local') {
            const localName = watId(node.name?.name ?? '')
            const rawTypeName = node.name?.typeAnnotation?.typename
            if (rawTypeName && ctx.registry?.structTypes?.has(rawTypeName)) {
                ctx.structLocals.set(localName, rawTypeName)
            }
        }
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
    // $[a, b, …] → IRArrayLiteral.  The emitters (src/ir/emit.ts and
    // src/codegen/wasm-emitter.ts) lower it to alloc_array + per-element stores
    // into the implicit `$addr` local.  Element type is i32 for v1.0 (4 bytes).
    const elements = (n.elements || []).map((e: any) => lowerExpr(e, ctx))
    return {
        kind: 'ArrayLiteral',
        wasmType: 'i32',
        count: elements.length,
        elemBytes: 4,
        elements,
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
        case 'CallIndirect': return e.wasmType
        case 'Block':   return e.wasmType
        case 'If':      return e.wasmType
        case 'Loop':        return 'void'
        case 'Break':       return 'void'
        case 'Continue':    return 'void'
        case 'Return':      return 'void'
        case 'Nop':         return 'void'
        case 'Unreachable': return 'void'
        // Phase 9d-3 — WasmGC instructions.
        case 'StructNew':        return e.wasmType
        case 'StructGet':        return e.wasmType
        case 'StructSet':        return 'void'
        case 'ArrayNew':         return e.wasmType
        case 'ArrayNewDefault':  return e.wasmType
        case 'ArrayGet':         return e.wasmType
        case 'ArraySet':         return 'void'
        case 'ArrayLen':         return e.wasmType
        case 'ArrayCopy':        return 'void'
        case 'ArrayLiteral':     return e.wasmType
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
    // i64-width types: Int64, u64, and the low-level escape hatch alias.
    if (typename === 'Int64' || typename === 'UInt64' || typename === 'u64' || typename === 'i64') return 'i64'
    // Everything else (Int, Bool, String, Array, Function, u8/u16/u32, …)
    // shares the i32 WASM representation.
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
