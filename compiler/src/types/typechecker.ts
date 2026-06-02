// SPDX-License-Identifier: MIT
/**
 * Silicon Type Checker
 *
 * Stage 2.6 of the compilation pipeline — runs after elaboration and before
 * code generation. Walks the AST, infers a `SiliconType` for every expression
 * node, validates operator compatibility, and collects structured errors.
 *
 * The checker is strict: no implicit numeric coercions. `Int + Float` is a
 * type error, and users must call an explicit conversion intrinsic
 * (`&WASM::f32_convert_i32_s`, etc.) to cross between Int and Float.
 *
 * AST shape support
 * -----------------
 * The checker dispatches purely on the `type` discriminator and is happy to
 * walk both shapes that exist in the codebase:
 *
 *   1. The "flat" shape produced by `toAst.ts` — `Program.elements` is a list
 *      of bare nodes like `BinaryOp`, `FunctionCall`, `IntLiteral`, …; the
 *      `Element / Item / ExpressionStart / ExpressionEnd / Literal` wrappers
 *      are skipped. The codegen and AST integration tests treat this as the
 *      ground truth.
 *
 *   2. The "wrapped" shape implied by `astNodes.ts` and emitted by the
 *      `ASTFactory` helpers — the same nodes nested inside the wrappers above.
 *      This is what the unit tests build by hand, so we still walk it.
 *
 * Annotating both shapes from a single dispatcher keeps the checker resilient
 * to whichever convention a future AST consumer settles on.
 *
 * Output
 * - Annotates the visited expression nodes with `inferredType`.
 * - Returns a list of `TypeError`s. An empty list means the program is
 *   well-typed.
 *
 * Scope of this POC pass
 * - Handles all five surface types (Int / Float / String / Bool / Array).
 * - Tracks identifiers introduced by `Assignment` and by `Definition` (with a
 *   binding). A single flat symbol table is enough for now; block-local scopes
 *   can follow once control flow is modelled.
 * - Recognises the WASM intrinsic family (`WASM::i32_add`, `WASM::f32_mul`,
 *   …) and types calls against a small signature table derived from the
 *   intrinsic's name. User-defined functions we haven't seen yet produce
 *   `Unknown` rather than an error — this is a POC, not a sound checker.
 *
 * What the checker deliberately does NOT do
 * - No type inference across function boundaries; function return types must
 *   be either annotated or trivially derivable from the body.
 * - No subtyping. No implicit Bool → Int, no widening, no coercion.
 * - No generics (Array[T] is concrete once T is observed).
 */

import type { Program } from '../ast/astNodes'
import { astChildren } from '../ast/astChildren'
import type { PositionTable } from '../ast/positionTable'
import { SemanticModel, type Symbol as CaaSSymbol, type SymbolKind, symbolDisplayString } from '../ast/semanticModel'
import { toDiagnostic, spanFromLocation, type SourceSpan } from '../errors/diagnostic'
import {
    type SiliconType,
    TypeInt,
    TypeInt64,
    TypeFloat,
    TypeString,
    TypeBool,
    TypeUInt32,
    TypeUInt64,
    TypeUnknown,
    ArrayOf,
    VecOf,
    FunctionOf,
    DistinctOf,
    SumOf,
    typeEquals,
    parseTypeName,
    isNumeric,
    isComparable,
    isEqualityComparable,
} from './types'
import type { ModuleRegistry } from '../modules/registry'
import {
    type TypeError,
    mismatch,
    invalidOperator,
    unbound,
    unknownType,
    heterogeneousArray,
    annotationMismatch,
    immutableAssignment,
    arityMismatch,
    missingReturn,
    mvpOnlyIntrospection,
    mvpOnlyPhysicalByte,
} from './errors'

// ─── Phase 9d-5 — wasm-mvp-only primitive sets ────────────────────────────
//
// ADR 0009's two-layer portability split.  Lifecycle primitives
// (&@with_arena, &@move_to_parent_arena, &rc_new, &rc_clone,
// &rc_drop, &rc_get) compile under both targets via compile-time
// elision and are deliberately NOT in either set.

/** E0012 — values can't be honestly emulated under wasm-gc. */
const MVP_ONLY_INTROSPECTION: ReadonlySet<string> = new Set([
    'rc_count', 'rc_is_unique',
    'heap_used', 'arena_used',
    'heap_get', 'heap_set',
])

/** E0013 — managed refs aren't addressable, no pointer math. */
const MVP_ONLY_PHYSICAL_BYTE: ReadonlySet<string> = new Set([
    'alloc', 'realloc', 'mem_copy',
    'str_ptr',
])
import { closest } from '../errors/diagnostic'
import { getWasmIntrinsic } from '../intrinsics'
import { type ElaboratorRegistry, lookupOperator, lookupTypedOperator, lookupKeyword, lookupTypedKeyword } from '../elaborator/registry'
import { intrinsicSignature, type TypeSig } from './intrinsicSig'
import {
    unify, applySubst, emptySubst, makeFreshGen, UnifyError,
} from './unify'
import type { Subst, FreshGen } from './unify'
import { normalizeMatchArgs } from '../ast/matchArms'

/**
 * Mutable checking context. Threaded through the recursive walk so error
 * accumulation and symbol bookkeeping stay in one place.
 */
interface Ctx {
    /** Source file name, threaded from SyntaxTree.file; used to populate SourceSpan.file. */
    file: string
    errors: TypeError[]
    // Flat symbol table. Keyed by the joined namespace path (e.g. "module::x").
    symbols: Map<string, SiliconType>
    // Function signature table. Populated when a Definition is checked so that
    // call sites can resolve both the return type and validate arg types.
    functions: Map<string, FunctionSig>
    // Names of immutable bindings (@let, @fn, @extern). Assignment to these is
    // a type error.
    immutable: Set<string>
    // User-defined type names from @type_alias and @type_distinct declarations.
    // Passed to parseTypeName so annotations like `x: age` resolve correctly.
    typeAliases: Map<string, SiliconType>
    // Type variables in scope (from a Definition's GenericParams `[T, U, …]`).
    // Names here resolve to `{ kind: 'Variable', name }` instead of being
    // reported as unknown types.  Child scopes (per-definition) extend this.
    typeVars: Set<string>
    // Single fresh-variable generator shared across the whole typecheck pass.
    // Each polymorphic call site instantiates its scheme through THIS gen so
    // nested calls don't collide on names (e.g. outer `unwrap_or` and nested
    // `&None` would both produce `?T1` from their own counters otherwise).
    fresh: FreshGen
    // Variant schemes — for each variant of a parameterised sum type,
    // remember the declared field types and the type variables they were
    // declared with.  Used at pattern-bind time so `$Some v` against
    // `Option[Int]` binds `v:Int`, not the hardcoded TypeInt of yesteryear.
    // Keyed by `${SumName}::${VariantName}`.
    variantSchemes: Map<string, { tvars: string[]; fields: { name: string; type: SiliconType }[] }>
    // Struct field types — maps struct type name → field name → SiliconType.
    // Populated by preRegisterStructType for @struct definitions.
    structFields: Map<string, Map<string, SiliconType>>
    // Stratum registry for user-defined operator type checking (optional).
    registry?: ElaboratorRegistry
    // CaaS-2: authoritative type map — node object → SiliconType.
    // SemanticModel wraps this; node.inferredType is a backward-compat stamp.
    typeMap: WeakMap<object, SiliconType>
    // CaaS-3: symbol resolution maps.
    nodeToSymbolName: WeakMap<object, string>   // Namespace node → resolved name
    symbolToNodes: Map<string, object[]>         // name → all reference nodes
    definitionNodes: Map<string, object>         // name → Definition AST node
    // CaaS-5: source spans for each reference site (for referenceSpans / symbolAtPosition).
    symbolToSpans: Map<string, SourceSpan[]>
    // Phase 9d-5: compile target.  When `'wasm-gc'`, mvp-only primitive
    // calls raise E0012 / E0013 per ADR 0009's two-layer portability
    // split.  Undefined / 'host' / 'wasix' = no rejection (existing behavior).
    target?: import('../ir/lower').LowerTarget
    // CaaS-2g: cross-document symbol types.  Checked as a last resort when a
    // name is not found in the local symbol table.  Suppresses "unbound
    // identifier" errors for names defined in other open Workspace documents.
    externalSymbols?: ReadonlyMap<string, SiliconType>
}

export interface FunctionSig {
    params: SiliconType[]
    result: SiliconType
}

/**
 * Run `fn` in a child scope that inherits all parent symbols but whose new
 * bindings are discarded when `fn` returns. Errors still accumulate into the
 * shared `ctx.errors` list.
 */
/** Resolve a type-name against the context's aliases AND type-variable scope.
 *  Names in `ctx.typeVars` resolve to `{ kind: 'Variable', name }` — this is
 *  what makes `@fn id[T] x:T := x;` typecheck without `unknown type 'T'`. */
function resolveType(name: string, ctx: Ctx): SiliconType | undefined {
    if (ctx.typeVars.has(name)) return { kind: 'Variable', name }
    return parseTypeName(name, ctx.typeAliases)
}

/**
 * Resolve the concrete field types of a variant given the discriminant's
 * sum type.  Looks up the variant's declared scheme (tvars + field types
 * with Variable placeholders) and substitutes the discriminant's typeArgs.
 *
 *   discT = Option[Int]   variant 'Some'   scheme tvars=['T'], fields=[value:T]
 *   → [TypeInt]
 *
 * Returns an empty array if no scheme is registered (e.g. legacy enums,
 * unparametrised sums whose field info wasn't stashed).  Callers should
 * fall back to a safe default in that case.
 */
function resolveVariantFieldTypes(discT: SiliconType, variantName: string, ctx: Ctx): SiliconType[] {
    if (discT.kind !== 'Sum') return []
    const scheme = ctx.variantSchemes.get(`${discT.name}::${variantName}`)
    if (!scheme) return []
    const tvars = scheme.tvars
    const callArgs = discT.typeArgs ?? []
    if (tvars.length === 0) return scheme.fields.map(f => f.type)
    const subst: Map<string, SiliconType> = new Map()
    for (let i = 0; i < tvars.length && i < callArgs.length; i++) {
        subst.set(tvars[i], callArgs[i])
    }
    return scheme.fields.map(f => applySubst(f.type, subst))
}

/** Resolve a full TypeAnnotation, honouring `typeArgs` for parametric Sums
 *  and `fnReturn`/`fnParams` for sigil function types.
 *
 *  `:Option[Int]` → `Sum('Option', variants, [TypeInt])`.
 *  `:Option[Float]` → `Sum('Option', variants, [TypeFloat])` — distinct
 *  from `:Option[Int]` by typeEquals.
 *  `:$fn _:R _:T1, _:T2` → `Function([T1, T2], R)` — Phase 5d-3 surface
 *  syntax mirrors a function definition's shape.
 *
 *  Falls back to `resolveType` for non-parametric annotations so existing
 *  callers keep working. */
function resolveTypeAnnotation(ann: any, ctx: Ctx): SiliconType | undefined {
    if (!ann) return undefined
    // Phase 5d-3: sigil function-type annotation.  fnReturn is the
    // return-type slot (a typedIdentifier whose typeAnnotation carries
    // the actual return type); fnParams is the comma-separated arg-type
    // slots in the same shape.  Both nest TypeAnnotations so we recurse.
    if (ann.typename === '$fn') {
        const retT = ann.fnReturn?.typeAnnotation
            ? resolveTypeAnnotation(ann.fnReturn.typeAnnotation, ctx)
            : TypeUnknown
        if (!retT) return undefined
        const paramTs: SiliconType[] = []
        for (const slot of (ann.fnParams ?? [])) {
            const pt = slot?.typeAnnotation
                ? resolveTypeAnnotation(slot.typeAnnotation, ctx)
                : TypeUnknown
            if (!pt) return undefined
            paramTs.push(pt)
        }
        return FunctionOf(paramTs, retT)
    }
    // Phase 9d-8 — Vec[T] is a built-in parametric container distinct
    // from the user-defined Sum typeArgs path below.  Recognised
    // *before* `resolveType` so we don't have to register Vec as a
    // type alias.
    if (ann.typename === 'Vec') {
        const typeArgs: any[] = ann.typeArgs ?? []
        if (typeArgs.length !== 1) return undefined
        const elem = resolveTypeAnnotation(
            { typename: typeArgs[0].name, typeArgs: typeArgs[0].args },
            ctx,
        )
        if (!elem) return undefined
        return { kind: 'Vec', element: elem }
    }
    const base = resolveType(ann.typename, ctx)
    if (!base) return undefined
    const typeArgs: any[] = ann.typeArgs ?? []
    if (typeArgs.length === 0) return base
    // Recursively resolve each type-arg.  A TypeArg has { name, args? } so we
    // synthesize an annotation-shaped object and recurse.
    const resolvedArgs: SiliconType[] = []
    for (const ta of typeArgs) {
        const inner = resolveTypeAnnotation(
            { typename: ta.name, typeArgs: ta.args },
            ctx,
        )
        if (!inner) return undefined
        resolvedArgs.push(inner)
    }
    // Attach typeArgs to Sum / Distinct.  Other kinds get the args ignored
    // (they shouldn't be parameterized at the user surface).
    if (base.kind === 'Sum') {
        return { kind: 'Sum', name: base.name, variants: base.variants, typeArgs: resolvedArgs }
    }
    return base
}

function withScope(ctx: Ctx, fn: (inner: Ctx) => SiliconType): SiliconType {
    const savedSymbols = ctx.symbols
    const savedTypeVars = ctx.typeVars
    ctx.symbols = new Map(savedSymbols)
    ctx.typeVars = new Set(savedTypeVars)
    const t = fn(ctx)
    ctx.symbols = savedSymbols
    ctx.typeVars = savedTypeVars
    return t
}

/**
 * Result of `typecheck`: the program plus collected errors and a SemanticModel.
 * The SemanticModel is the authoritative source for inferred types (CaaS-2+).
 * `node.inferredType` is a backward-compat stamp kept for existing consumers.
 */
export interface TypeCheckResult {
    program: Program
    errors: TypeError[]
    functions: Map<string, FunctionSig>
    typeAliases: Map<string, SiliconType>
    /** CaaS-2: queryable semantic info. Use semanticModel.typeOf(node) over node.inferredType. */
    semanticModel: SemanticModel
}

/**
 * Run the type checker. This annotates the AST in-place with `inferredType`
 * fields and returns the collected errors. The original AST is returned for
 * convenience so this can be chained in a pipeline:
 *
 *     const { program: typed, errors } = typecheck(elaborated)
 *     if (errors.length) { ... }
 */
export default function typecheck(
    program: Program,
    registry?: ElaboratorRegistry,
    moduleRegistry?: ModuleRegistry,
    target?: import('../ir/lower').LowerTarget,
    file = '',
    externalSymbols?: ReadonlyMap<string, SiliconType>,
    positions?: PositionTable,
): TypeCheckResult {
    // M3: positions live in an element-relative `relSpan` + element-root
    // `elemBase`; resolve them into absolute `sourceLocation` on this (ephemeral)
    // tree once, up front, so the rest of the checker reads `node.sourceLocation`
    // unchanged.  Idempotent while the parser still also writes `sourceLocation`.
    if (positions) stampSourceLocations(program, positions)
    const typeMap = new WeakMap<object, SiliconType>()
    const nodeToSymbolName = new WeakMap<object, string>()
    const symbolToNodes = new Map<string, object[]>()
    const symbolToSpans = new Map<string, SourceSpan[]>()
    const definitionNodes = new Map<string, object>()
    const ctx: Ctx = {
        file,
        errors: [],
        symbols: new Map(),
        functions: new Map(),
        immutable: new Set(),
        typeAliases: new Map(),
        typeVars: new Set(),
        fresh: makeFreshGen(),
        variantSchemes: new Map(),
        structFields: new Map(),
        registry,
        typeMap,
        nodeToSymbolName,
        symbolToNodes,
        symbolToSpans,
        definitionNodes,
        target,
        externalSymbols,
    }
    // Pre-registration pass: seed module function signatures first so that
    // user-defined functions whose bodies call module functions can resolve
    // the return type correctly via type inference.
    if (moduleRegistry) preRegisterModules(moduleRegistry, ctx)
    preRegisterStdFunctions(ctx)
    // Pre-registration pass: seed the function/symbol tables and type alias
    // table from top-level definitions so forward references resolve correctly.
    preRegisterDefinitions(program.elements as any[], ctx)
    for (const element of program.elements as any[]) {
        checkNode(element, ctx)
    }
    const semanticModel = new SemanticModel({
        types: typeMap,
        nodeToSymbolName,
        symbols: buildSymbolTable(ctx),
        symbolToNodes,
        symbolToSpans,
        diagnostics: ctx.errors.map(e => toDiagnostic(e)),
    })
    return { program, errors: ctx.errors, functions: ctx.functions, typeAliases: ctx.typeAliases, semanticModel }
}

// ---------------------------------------------------------------------------
// Module pre-registration
// ---------------------------------------------------------------------------

function preRegisterModules(moduleRegistry: ModuleRegistry, ctx: Ctx): void {
    for (const [modName, entry] of moduleRegistry) {
        for (const [fnName, sig] of entry.functions) {
            const key = `${modName}::${fnName}`
            const paramTypes = sig.siliconParams.map(n => parseTypeName(n, ctx.typeAliases) ?? TypeUnknown)
            const resultType = sig.siliconResult ? (parseTypeName(sig.siliconResult, ctx.typeAliases) ?? TypeUnknown) : TypeUnknown
            ctx.functions.set(key, { params: paramTypes, result: resultType })
            if (paramTypes.length > 0) {
                ctx.symbols.set(key, FunctionOf(paramTypes, resultType))
            } else {
                ctx.symbols.set(key, resultType)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// std.wat built-in runtime functions callable from Silicon
// ---------------------------------------------------------------------------

function preRegisterStdFunctions(ctx: Ctx): void {
    const defs: Array<{ name: string; params: SiliconType[]; result: SiliconType }> = [
        { name: 'alloc',          params: [TypeInt],                     result: TypeInt },
        { name: 'alloc_string',   params: [TypeInt],                     result: TypeString },
        { name: 'alloc_array',    params: [TypeInt, TypeInt],            result: TypeInt },
        { name: 'arr_len',        params: [TypeInt],                     result: TypeInt },
        { name: 'arr_load_i32',   params: [TypeInt, TypeInt],            result: TypeInt },
        { name: 'arr_load_f32',   params: [TypeInt, TypeInt],            result: TypeFloat },
        { name: 'arr_store_i32',  params: [TypeInt, TypeInt, TypeInt],   result: TypeUnknown },
        // String views — stdlib uses these to thread String literals through
        // the byte-level WASI surface.  Both are identity at runtime; the
        // typechecker uses them to bridge String ↔ Int safely.
        { name: 'scratch_alloc',  params: [TypeInt],                     result: TypeInt },
        { name: 'str_ptr',        params: [TypeString],                  result: TypeInt },
        { name: 'str_len',        params: [TypeString],                  result: TypeInt },
        // Arena bump-pointer helpers — src/stdlib wraps these.
        { name: 'heap_get',       params: [],                            result: TypeInt },
        { name: 'heap_set',       params: [TypeInt],                     result: TypeUnknown },
        // Phase 9c-8: memory introspection.
        // &heap_used  → bytes bump-allocated since program start (= heap - heap_base).
        // &arena_used → bytes since `saved` was captured (pair with &heap_get).
        { name: 'heap_used',      params: [],                            result: TypeInt },
        { name: 'arena_used',     params: [TypeInt],                     result: TypeInt },
    ]
    for (const { name, params, result } of defs) {
        ctx.functions.set(name, { params, result })
        ctx.symbols.set(name, FunctionOf(params, result))
    }

    // Phase 9d-8c: under wasm-gc, the Vec[Int] gc functions are
    // compiler-generated (see src/codegen/gc-vec.ts).  Register their
    // signatures so user calls (`&vec_new 8`, etc.) typecheck.  Under
    // wasm-mvp these come from src/stdlib/vec.si's @fn declarations —
    // skipping registration here avoids shadowing the user's @fn
    // bodies, which the resolver pulls in via @use.
    if (ctx.target === 'wasm-gc') {
        const vecInt = VecOf(TypeInt)
        const vecDefs: Array<{ name: string; params: SiliconType[]; result: SiliconType }> = [
            { name: 'vec_new',       params: [TypeInt],                       result: vecInt },
            { name: 'vec_len',       params: [vecInt],                        result: TypeInt },
            { name: 'vec_capacity',  params: [vecInt],                        result: TypeInt },
            { name: 'vec_get_i32',   params: [vecInt, TypeInt],               result: TypeInt },
            { name: 'vec_set_i32',   params: [vecInt, TypeInt, TypeInt],      result: TypeUnknown },
            { name: 'vec_push_i32',  params: [vecInt, TypeInt],               result: TypeUnknown },
            { name: 'vec_pop_i32',   params: [vecInt],                        result: TypeInt },
        ]
        for (const { name, params, result } of vecDefs) {
            ctx.functions.set(name, { params, result })
            ctx.symbols.set(name, FunctionOf(params, result))
        }
    }
}

// ---------------------------------------------------------------------------
// Pre-registration pass (forward-reference support)
// ---------------------------------------------------------------------------

/**
 * Extract the innermost Definition node from either the flat AST shape
 * (Definition directly) or the wrapped shape (Element → Item → Statement →
 * Definition). Returns null for non-definition elements.
 */
function extractDefinitionNode(el: any): any {
    if (!el || typeof el !== 'object') return null
    if (el.type === 'Definition') return el
    if (el.type === 'Element' && el.kind === 'item' && el.value) return extractDefinitionNode(el.value)
    if (el.type === 'Item' && el.value) return extractDefinitionNode(el.value)
    if (el.type === 'Statement' && el.kind === 'definition') return el.value
    return null
}

/**
 * Seed `ctx.typeAliases`, `ctx.functions`, `ctx.symbols`, and `ctx.immutable`
 * from every top-level definition before the main checking pass begins.
 *
 * Two sub-passes are needed: type declarations are collected first so that
 * subsequent function/variable annotations can reference user-defined type names.
 */
/** `@enum` is an alias for the enum-only form of `@type_sum`. */
function isSumKeyword(kw: string): boolean {
    return kw === '@type_sum' || kw === '@enum'
}

/** `@type` declares a sum type with payload-carrying variants. */
function isRecordSumKeyword(kw: string): boolean {
    return kw === '@type'
}

function isTypeDeclKeyword(kw: string): boolean {
    return kw === '@type_alias' || kw === '@type_distinct'
        || isSumKeyword(kw) || isRecordSumKeyword(kw)
        || kw === '@struct'
}

function preRegisterDefinitions(elements: any[], ctx: Ctx): void {
    // Sub-pass 1: collect @type_alias and @type_distinct declarations.
    for (const el of elements) {
        const def = extractDefinitionNode(el)
        if (!def || !def.name?.name) continue
        const kw: string = def.keyword ?? ''
        if (isTypeDeclKeyword(kw)) {
            preRegisterTypeDecl(def, ctx)
        }
    }

    // Sub-pass 2: register functions and value bindings using the now-populated
    // alias table so that annotations like `x: age` resolve correctly.
    for (const el of elements) {
        const def = extractDefinitionNode(el)
        if (!def || !def.name?.name) continue
        const kw: string = def.keyword ?? ''
        // Type declarations were handled above; skip them here.
        // @export references an existing name — never defines new params.
        if (isTypeDeclKeyword(kw) || kw === '@export') continue

        // Establish per-def type-variable scope from GenericParams `[T, U, …]`
        // so type names like `T` in param/result annotations resolve to Variable
        // rather than triggering "unknown type" errors.
        const savedTypeVars = ctx.typeVars
        ctx.typeVars = new Set(savedTypeVars)
        for (const tv of def.generics?.params ?? []) ctx.typeVars.add(tv)

        const paramTypes: SiliconType[] = []
        for (const p of def.params || []) {
            if (p.isLiteral || !p.typeAnnotation) continue
            paramTypes.push(resolveTypeAnnotation(p.typeAnnotation, ctx) ?? TypeUnknown)
        }

        let resultType: SiliconType = TypeUnknown
        if (def.name.typeAnnotation) {
            const parsed = resolveTypeAnnotation(def.name.typeAnnotation, ctx)
            if (parsed) resultType = parsed
        }

        ctx.typeVars = savedTypeVars

        ctx.functions.set(def.name.name, { params: paramTypes, result: resultType })

        // Store as FunctionOf when there are parameters; otherwise store the
        // result type directly so value-position references work naturally.
        if (paramTypes.length > 0) {
            ctx.symbols.set(def.name.name, FunctionOf(paramTypes, resultType))
        } else {
            ctx.symbols.set(def.name.name, resultType)
        }

        // Mark immutable for non-mutable definitions. @var / hook==='global'
        // is the only mutable def-kind.
        const hook = def.hook
        const isMutable = hook === 'global' || kw === '@var'
        if (!isMutable) {
            ctx.immutable.add(def.name.name)
        }

        // CaaS-3: record definition node for symbol table construction.
        ctx.definitionNodes.set(def.name.name, def)
    }
}

/**
 * Register a single `@type_alias` or `@type_distinct` definition into
 * `ctx.typeAliases`. The RHS must be a recognised type name; unknown names
 * are recorded as errors and skipped.
 */
function preRegisterTypeDecl(def: any, ctx: Ctx): void {
    const name: string = def.name.name
    const kw: string = def.keyword ?? ''

    if (kw === '@struct') {
        preRegisterStructType(def, ctx)
        return
    }

    if (isSumKeyword(kw)) {
        preRegisterSumType(def, ctx)
        return
    }

    if (isRecordSumKeyword(kw)) {
        preRegisterRecordSumType(def, ctx)
        return
    }

    // The RHS of a type declaration is the type annotation on the name
    // (e.g. `@type_alias age = Int` parses `Int` as the binding typename)
    // OR the binding expression if the annotation is absent.
    // We read the typename from the binding's annotation or from the
    // binding expression when it is a simple namespace.
    const underlying = resolveTypeDeclUnderlying(def, ctx)
    if (!underlying) return  // error already pushed by resolveTypeDeclUnderlying

    if (kw === '@type_alias') {
        // Alias: transparent — `age` IS `Int` for all type-checking purposes.
        ctx.typeAliases.set(name, underlying)
    } else {
        // Distinct: opaque — `age` is a new type incompatible with `Int`.
        ctx.typeAliases.set(name, DistinctOf(name, underlying))
    }
}

/**
 * Register an `@struct` definition: creates a named pointer type in
 * typeAliases, records field names+types in structFields for field-access
 * type-checking, and registers the constructor function signature.
 */
function preRegisterStructType(def: any, ctx: Ctx): void {
    const name: string = def.name.name
    const structType = DistinctOf(name, TypeInt)
    ctx.typeAliases.set(name, structType)

    const fieldMap = new Map<string, SiliconType>()
    const paramTypes: SiliconType[] = []
    for (const p of def.params ?? []) {
        const param = p.value ?? p
        const fieldName: string = param.name ?? ''
        const typeName: string = param.typeAnnotation?.typename ?? 'Int'
        const fieldType = resolveType(typeName, ctx) ?? TypeInt
        if (fieldName) fieldMap.set(fieldName, fieldType)
        paramTypes.push(fieldType)
    }
    ctx.structFields.set(name, fieldMap)

    ctx.functions.set(name, { params: paramTypes, result: structType })
    ctx.symbols.set(name, FunctionOf(paramTypes, structType))
    ctx.immutable.add(name)
}

/**
 * Register a `@type_sum` declaration. Extracts variant names from the
 * `|`-separated binding expression, registers the sum type in the alias table,
 * and registers each variant as an immutable symbol of the sum type so that
 * `Color::Red` resolves correctly at use sites.
 */
function preRegisterSumType(def: any, ctx: Ctx): void {
    const name: string = def.name.name
    const binding = Array.isArray(def.binding) ? def.binding[0] : def.binding
    const bindingExpr = binding?.expression ?? binding

    const variants = extractSumVariants(bindingExpr)
    if (variants.length === 0) {
        ctx.errors.push({
            kind: 'UnknownType',
            message: `'${name}' sum type has no variants`,
            sourceLocation: def.sourceLocation,
        })
        return
    }

    const sumType = SumOf(name, variants)
    ctx.typeAliases.set(name, sumType)

    // Register each variant as a value of the sum type.
    // Variants are accessed as `Name::Variant` in code, matching how the
    // namespace resolver joins path segments with `::`.
    for (const variant of variants) {
        const key = `${name}::${variant}`
        ctx.symbols.set(key, sumType)
        ctx.immutable.add(key)
    }
}

/**
 * Register an `@type` declaration with payload-carrying variants.
 * Each VariantDecl in the binding becomes (1) a member of the sum type and
 * (2) a callable constructor function returning a value of that sum type.
 */
function preRegisterRecordSumType(def: any, ctx: Ctx): void {
    const name: string = def.name.name
    const binding = Array.isArray(def.binding) ? def.binding[0] : def.binding
    const bindingExpr = binding?.expression ?? binding

    const variants = extractRecordSumVariants(bindingExpr)
    if (variants.length === 0) {
        ctx.errors.push({
            kind: 'UnknownType',
            message: `'${name}' @type has no variants`,
            sourceLocation: def.sourceLocation,
        })
        return
    }

    // Type-variable scope from the type def's GenericParams.  Without this,
    // variant fields like `value:T` register as Unknown instead of Variable.
    const savedTypeVars = ctx.typeVars
    ctx.typeVars = new Set(savedTypeVars)
    const tvars: string[] = def.generics?.params ?? []
    for (const tv of tvars) ctx.typeVars.add(tv)

    // Register the sum type itself.  Variant names are stored as Name::Variant
    // to keep parity with @enum.  The alias entry stays *non-parametric* (the
    // bare `Option` resolves to a Sum without typeArgs) so that
    // `resolveTypeAnnotation` can attach the call-site typeArgs.
    const variantNames = variants.map(v => `${name}::${v.name}`)
    const aliasType = SumOf(name, variantNames)
    ctx.typeAliases.set(name, aliasType)

    // For each variant, the return type carries the type parameters as
    // Variables — `Some : ∀T. T → Option[T]`.  That way the unifier
    // at the call site propagates the concrete T into the result.
    const sumTypeAsResult: SiliconType = tvars.length > 0
        ? SumOf(name, variantNames, tvars.map(t => ({ kind: 'Variable', name: t } as SiliconType)))
        : aliasType

    // Phase 9c-3a: track per-variant field types so the lowerer can size
    // `&@move_to_parent_arena` promotions of sum values.
    const layoutVariants: { name: string; fieldTypes: SiliconType[] }[] = []

    for (const v of variants) {
        const paramTypes = v.fields.map(f =>
            resolveType(f.typeName, ctx) ?? TypeUnknown)
        ctx.functions.set(v.name, { params: paramTypes, result: sumTypeAsResult })
        ctx.symbols.set(v.name, FunctionOf(paramTypes, sumTypeAsResult))
        ctx.immutable.add(v.name)

        // Also register the qualified `Name::Variant` path so explicit
        // namespace references (`Color::Red`, used in @match patterns or as
        // a value) typecheck.  Payload-free variants resolve to the sum
        // type itself (like @enum); payload-bearing variants resolve to
        // their constructor's function type.
        const qualified = `${name}::${v.name}`
        if (paramTypes.length === 0) {
            ctx.symbols.set(qualified, sumTypeAsResult)
        } else {
            ctx.symbols.set(qualified, FunctionOf(paramTypes, sumTypeAsResult))
        }
        ctx.immutable.add(qualified)

        // Stash the variant's declared field types keyed by qualified name.
        // Pattern-binding (`$Some v` against `Option[Int]`) reads this and
        // substitutes the sum's typeArgs for the original tvars to get
        // concrete field types per call site.
        ctx.variantSchemes.set(`${name}::${v.name}`, {
            tvars,
            fields: v.fields.map((f, i) => ({ name: f.name, type: paramTypes[i] })),
        })

        layoutVariants.push({ name: v.name, fieldTypes: paramTypes })
    }

    // Phase 9c-3a: publish the pad-to-max layout to the registry so
    // `src/ir/lower.ts:sizeExprForFlatHeap` can size sum values during
    // arena promotion.  Matches the constructor emit in
    // `src/strata/defExpanders.ts:typeRecordExpander` (4 + 4 × maxFields).
    if (ctx.registry) {
        const maxFields = layoutVariants.reduce(
            (m, v) => Math.max(m, v.fieldTypes.length), 0)
        ctx.registry.sumLayouts.set(name, {
            name,
            maxFields,
            variants: layoutVariants,
        })
    }

    ctx.typeVars = savedTypeVars
}

interface RecordVariantSummary {
    name: string
    fields: { name: string; typeName: string }[]
}

function extractRecordSumVariants(expr: any): RecordVariantSummary[] {
    if (!expr || typeof expr !== 'object') return []
    if (expr.expression) return extractRecordSumVariants(expr.expression)
    if (expr.type === 'ExpressionEnd' && expr.kind === 'variantDecl') {
        return extractRecordSumVariants(expr.value)
    }
    if (expr.value && expr.type !== 'BinaryOp' && expr.type !== 'VariantDecl') {
        return extractRecordSumVariants(expr.value)
    }
    if (expr.type === 'BinaryOp' && expr.operator === '|') {
        return [...extractRecordSumVariants(expr.left), ...extractRecordSumVariants(expr.right)]
    }
    if (expr.type === 'VariantDecl') {
        return [{
            name: expr.name,
            fields: (expr.fields || []).map((f: any) => ({
                name: f.name,
                typeName: f.typeAnnotation?.typename ?? 'Int',
            })),
        }]
    }
    return []
}

/**
 * Walk a BinaryOp tree collecting all operands of `|` operators as variant
 * names. A single-variant sum (`@type_sum Unit := Only`) produces one entry.
 */
function extractSumVariants(expr: any): string[] {
    if (!expr || typeof expr !== 'object') return []
    // Unwrap Binding / ExpressionStart / wrapper nodes.
    if (expr.expression) return extractSumVariants(expr.expression)
    if (expr.value && expr.type !== 'BinaryOp') return extractSumVariants(expr.value)
    // BinaryOp with '|' — collect from both sides.
    if (expr.type === 'BinaryOp' && expr.operator === '|') {
        return [...extractSumVariants(expr.left), ...extractSumVariants(expr.right)]
    }
    // Namespace leaf — the variant name is the last path segment.
    if (expr.type === 'Namespace' && Array.isArray(expr.path) && expr.path.length > 0) {
        return [expr.path[expr.path.length - 1]]
    }
    return []
}

/**
 * Resolve the underlying type for a type declaration. The RHS is either a
 * type annotation on the identifier (`@type_alias age:Int`) or a binding
 * expression that is a simple namespace reference (`@type_alias age = Int`).
 */
function resolveTypeDeclUnderlying(def: any, ctx: Ctx): SiliconType | undefined {
    // Form 1: `@type_alias age:Int` — annotation on the identifier itself.
    if (def.name?.typeAnnotation?.typename) {
        const t = parseTypeName(def.name.typeAnnotation.typename, ctx.typeAliases)
        if (!t) ctx.errors.push({ kind: 'UnknownType', message: `unknown type '${def.name.typeAnnotation.typename}'`, sourceLocation: def.sourceLocation })
        return t
    }

    // Form 2: `@type_alias age = Int` — binding whose expression is a namespace.
    const bindingExpr = def.binding?.expression ?? def.binding
    if (bindingExpr) {
        const tyName = extractTypeNameFromExpr(bindingExpr)
        if (tyName) {
            const t = parseTypeName(tyName, ctx.typeAliases)
            if (!t) ctx.errors.push({ kind: 'UnknownType', message: `unknown type '${tyName}'`, sourceLocation: def.sourceLocation })
            return t
        }
    }

    ctx.errors.push({ kind: 'UnknownType', message: `'${def.name.name}' type declaration has no resolvable underlying type`, sourceLocation: def.sourceLocation })
    return undefined
}

/** Pull a plain type name out of a Namespace or StringLiteral expression node. */
function extractTypeNameFromExpr(expr: any): string | undefined {
    if (!expr) return undefined
    if (expr.type === 'Namespace' && Array.isArray(expr.path) && expr.path.length === 1) {
        return expr.path[0]
    }
    if (expr.type === 'StringLiteral') return expr.value
    // Unwrap Binding / ExpressionStart / ExpressionEnd wrappers.
    if (expr.expression) return extractTypeNameFromExpr(expr.expression)
    if (expr.value) return extractTypeNameFromExpr(expr.value)
    return undefined
}

// ---------------------------------------------------------------------------
// Single dispatch entry point — handles both flat and wrapped AST shapes.
// ---------------------------------------------------------------------------

function checkNode(node: any, ctx: Ctx): SiliconType {
    if (!node || typeof node !== 'object') return TypeUnknown
    let t: SiliconType
    switch (node.type) {
        // --- Wrapper nodes (the "wrapped" AST shape) ---
        case 'Element':
            // `kind` is 'item' | 'docComment' | 'elaboration'.
            t = node.kind === 'item' ? checkNode(node.value, ctx) : TypeUnknown
            break
        case 'Item':
            t = checkNode(node.value, ctx)
            break
        case 'Statement':
            t = checkNode(node.value, ctx)
            break
        case 'ExpressionStart':
        case 'ExpressionEnd':
            t = checkNode(node.value, ctx)
            break
        case 'Literal':
            t = checkNode(node.value, ctx)
            break

        // --- Concrete leaf / structural nodes (the "flat" AST shape) ---
        case 'IntLiteral': t = TypeInt; break
        case 'FloatLiteral': t = TypeFloat; break
        case 'BooleanLiteral': t = TypeBool; break
        case 'StringLiteral': t = TypeString; break
        case 'ArrayLiteral': t = checkArrayLiteral(node, ctx); break
        case 'TupleLiteral':
        case 'ObjectLiteral': t = TypeUnknown; break
        case 'BinaryOp': t = checkBinaryOp(node, ctx); break
        case 'FunctionCall': t = checkFunctionCall(node, ctx); break
        case 'Assignment': t = checkAssignment(node, ctx); break
        case 'Definition': t = checkDefinition(node, ctx); break
        case 'Namespace': t = typeOfNamespace(node, ctx); break
        case 'Block': t = typeOfBlock(node, ctx); break
        case 'Binding': t = checkNode(node.expression, ctx); break
        case 'Ascription': {
            // `&@as T, e` — pin e's type to T; error on mismatch.  The result
            // type is T (so a binding to an ascription is typed T).
            const annT = resolveTypeAnnotation(node.typeAnnotation, ctx)
            const exprT = checkNode(node.expression, ctx)
            if (!annT) {
                ctx.errors.push(unknownType(node.typeAnnotation?.typename ?? '<unknown>', node.sourceLocation))
                t = TypeUnknown
                break
            }
            if (exprT.kind !== 'Unknown') {
                try { unify(annT, exprT) }
                catch (e) {
                    if (e instanceof UnifyError) ctx.errors.push(annotationMismatch('ascription', annT, exprT, node.sourceLocation))
                    else throw e
                }
            }
            t = annT
            break
        }

        // Anything we don't model (DocComment, Elaboration, TypedIdentifier
        // when reached out of a Definition context, etc.) is benign — we just
        // don't contribute a type for it.
        default: t = TypeUnknown
    }
    // Populate the authoritative WeakMap (CaaS-2 SemanticModel backing store).
    ctx.typeMap.set(node, t)
    // Backward-compat stamp so existing tests and consumers reading node.inferredType still work.
    if (t.kind !== 'Unknown') (node as any).inferredType = t
    else if ((node as any).inferredType === undefined) (node as any).inferredType = t
    return t
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

function checkAssignment(a: any, ctx: Ctx): SiliconType {
    const valueT = checkNode(a.value, ctx)
    const target = a.target
    const path: string[] = target && target.path ? target.path : []
    const key = path.join('::')

    if (ctx.immutable.has(key)) {
        ctx.errors.push(immutableAssignment(key, a.sourceLocation))
        return valueT
    }

    const existing = ctx.symbols.get(key)
    if (existing && !typeEquals(existing, valueT) && valueT.kind !== 'Unknown') {
        ctx.errors.push(mismatch(existing, valueT, `assignment to '${key}'`, a.sourceLocation))
    } else if (!existing) {
        ctx.symbols.set(key, valueT)
    }
    return valueT
}

function checkDefinition(d: any, ctx: Ctx): SiliconType {
    const keyword: string = d.keyword ?? ''

    // Type declarations and export markers are handled at pre-registration time
    // or by the IR; they have no body to check and must not overwrite existing sigs.
    if (isTypeDeclKeyword(keyword) || keyword === '@export') {
        return TypeUnknown
    }

    // Per-def type-variable scope from GenericParams.  Saved/restored around
    // the body so generics don't leak between sibling definitions.
    const savedTypeVars = ctx.typeVars
    ctx.typeVars = new Set(savedTypeVars)
    for (const tv of d.generics?.params ?? []) ctx.typeVars.add(tv)

    // Resolve the declared type annotation (if any).
    let annotated: SiliconType | undefined
    const annotation = d.name && d.name.typeAnnotation
    if (annotation) {
        const parsed = resolveTypeAnnotation(annotation, ctx)
        if (!parsed) {
            ctx.errors.push(unknownType(annotation.typename, d.sourceLocation))
        } else {
            annotated = parsed
        }
    }

    // Type of the binding (body) if present, else Unknown.
    // Parameters are scoped to the body so they don't pollute the outer table.
    let bodyType: SiliconType = TypeUnknown
    if (d.binding) {
        bodyType = withScope(ctx, inner => {
            // Inherit the typeVars we just set (withScope clones ctx.typeVars).
            for (const param of d.params || []) {
                if (param.isLiteral) continue
                if (param.typeAnnotation) {
                    const pt = resolveTypeAnnotation(param.typeAnnotation, inner)
                    if (!pt) {
                        ctx.errors.push(unknownType(param.typeAnnotation.typename, d.sourceLocation))
                    } else {
                        inner.symbols.set(param.name, pt)
                    }
                }
            }
            const binding = Array.isArray(d.binding) ? d.binding[0] : d.binding
            return checkNode(binding.expression ?? binding, inner)
        })
    }

    // Reconcile annotation with body — via unification so polymorphic body
    // results (like `Option[?T1]` from a no-arg `&None`) can be pinned by
    // an explicit annotation (`Option[Int]`).  Strict typeEquals here would
    // reject the alignment because `?T1` doesn't equal `Int`.
    const finalType = annotated ?? bodyType
    if (annotated && d.binding && bodyType.kind !== 'Unknown') {
        try {
            unify(annotated, bodyType)
        } catch (e) {
            if (e instanceof UnifyError) {
                ctx.errors.push(annotationMismatch(d.name.name, annotated, bodyType, d.sourceLocation))
            } else {
                throw e
            }
        }
    }

    // Missing-return check: if a function has a declared non-void return type
    // and a body, but the body type came out Unknown, the body doesn't produce
    // a value on (at least) the primary path.  Only flag when the annotation is
    // explicit — without an annotation we have no expectation to enforce.
    const hasParams = (d.params ?? []).some((p: any) => !p.isLiteral)
    if (
        d.name?.name &&
        d.binding &&
        annotated &&
        annotated.kind !== 'Unknown' &&
        bodyType.kind === 'Unknown' &&
        hasParams
    ) {
        ctx.errors.push(missingReturn(d.name.name, annotated, d.sourceLocation))
    }

    if (d.name && d.name.name) {
        const paramTypes: SiliconType[] = []
        for (const param of d.params || []) {
            if (param.isLiteral || !param.typeAnnotation) continue
            paramTypes.push(resolveTypeAnnotation(param.typeAnnotation, ctx) ?? TypeUnknown)
        }
        ctx.functions.set(d.name.name, { params: paramTypes, result: finalType })

        // Store FunctionOf in symbols for definitions that accept parameters so
        // namespace references to function names don't emit false "unbound" errors.
        if (paramTypes.length > 0) {
            ctx.symbols.set(d.name.name, FunctionOf(paramTypes, finalType))
        } else {
            ctx.symbols.set(d.name.name, finalType)
        }

        // Mark immutable. @var, @local, and hook==='global'/'local' are mutable.
        const hook = (d as any).hook
        const isMutable = hook === 'global' || hook === 'local' || keyword === '@var' || keyword === '@local'
        if (!isMutable) {
            ctx.immutable.add(d.name.name)
        }
    }
    ctx.typeVars = savedTypeVars
    return finalType
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

/** Bool and Int share the i32 wasmType.  In arithmetic / bitwise / user-op
 *  positions we treat a Bool operand as if it were Int so byte-level code
 *  (lexers, packed bit checks) doesn't have to wrap every comparison in
 *  `@if c, { 1 }, { 0 }`.  Equality / ordering / `||` still *return* Bool;
 *  this only widens what they're allowed to *accept*. */
function coerceBoolToInt(t: SiliconType): SiliconType {
    return t.kind === 'Bool' ? TypeInt : t
}

function checkBinaryOp(b: any, ctx: Ctx): SiliconType {
    const leftRaw  = checkNode(b.left, ctx)
    const rightRaw = checkNode(b.right, ctx)

    // Propagate Unknown without cascading additional errors.
    if (leftRaw.kind === 'Unknown' || rightRaw.kind === 'Unknown') {
        return TypeUnknown
    }

    const leftT  = coerceBoolToInt(leftRaw)
    const rightT = coerceBoolToInt(rightRaw)

    switch (b.operator) {
        // Arithmetic — both sides must be the same numeric type.
        case '+':
        case '-':
        case '*':
        case '/':
        case '%':
            if (!isNumeric(leftT) || !isNumeric(rightT) || !typeEquals(leftT, rightT)) {
                ctx.errors.push(invalidOperator(b.operator, leftRaw, rightRaw, b.sourceLocation))
                return TypeUnknown
            }
            return leftT
        // Equality — same type on both sides; String allowed (pointer equality).
        case '==':
        case '!=':
            if (!isEqualityComparable(leftT) || !isEqualityComparable(rightT) || !typeEquals(leftT, rightT)) {
                ctx.errors.push(invalidOperator(b.operator, leftT, rightT, b.sourceLocation))
                return TypeUnknown
            }
            return TypeBool
        // Ordering — same comparable type, String excluded (pointer order is meaningless).
        case '<':
        case '>':
        case '<=':
        case '>=':
            if (!isComparable(leftT) || !isComparable(rightT) || !typeEquals(leftT, rightT)) {
                ctx.errors.push(invalidOperator(b.operator, leftT, rightT, b.sourceLocation))
                return TypeUnknown
            }
            return TypeBool
        // Logical short-circuit OR — both sides must be Bool or Int; result is Bool.
        case '||':
            if (leftT.kind !== 'Unknown' && !isNumeric(leftT) && !typeEquals(leftT, TypeBool)) {
                ctx.errors.push(invalidOperator('||', leftT, rightT, b.sourceLocation))
                return TypeUnknown
            }
            return TypeBool
        // String concatenation — both operands must be String; result is String.
        case '++':
            if (!typeEquals(leftT, TypeString) || !typeEquals(rightT, TypeString)) {
                ctx.errors.push(invalidOperator('++', leftT, rightT, b.sourceLocation))
                return TypeUnknown
            }
            return TypeString
        default: {
            // User-defined operators: read the pre-derived TypeSig from the
            // registry, using the left-operand type to pick the right overload
            // (e.g. Int variant vs Float variant of the same operator symbol).
            const stratum = ctx.registry && lookupTypedOperator(ctx.registry, b.operator, leftT.kind)
            const sig: TypeSig | undefined =
                stratum?.data?.typeSignature ??
                (stratum?.data?.intrinsic ? intrinsicSignature(stratum.data.intrinsic) : undefined)
            if (sig) {
                if (leftT.kind !== 'Unknown' && !typeEquals(sig.params[0], leftT)) {
                    ctx.errors.push(mismatch(sig.params[0], leftT, `${b.operator} left operand`, b.sourceLocation))
                }
                if (rightT.kind !== 'Unknown' && !typeEquals(sig.params[1] ?? sig.params[0], rightT)) {
                    ctx.errors.push(mismatch(sig.params[1] ?? sig.params[0], rightT, `${b.operator} right operand`, b.sourceLocation))
                }
                return sig.result
            }
            return TypeUnknown
        }
    }
}

/**
 * Unwrap an arg node to find a VariantDecl (or undefined).  Patterns appear
 * inside ExpressionStart > ExpressionEnd > VariantDecl wrappers.
 */
function unwrapVariantDecl(node: any): any | undefined {
    let cur = node
    while (cur && typeof cur === 'object') {
        if (cur.type === 'VariantDecl') return cur
        if (cur.expression) { cur = cur.expression; continue }
        if (cur.value && cur.type !== 'BinaryOp') { cur = cur.value; continue }
        return undefined
    }
    return undefined
}

/**
 * Special-cased @match arg walker: pattern positions that carry a VariantDecl
 * introduce per-field bindings visible to the arm body.  Returns the per-arg
 * SiliconType list (same shape as a regular args map).
 *
 * Layout: args = [discriminant, pat0, arm0, pat1, arm1, ..., (default)?]
 */
function checkMatchArgs(args: any[], ctx: Ctx): SiliconType[] {
    const out: SiliconType[] = []
    if (args.length === 0) return out

    const discT = checkNode(args[0], ctx)
    out.push(discT)                                        // discriminant
    const hasDefault = (args.length - 1) % 2 === 1         // total even -> trailing default
    const armsEnd = hasDefault ? args.length - 1 : args.length

    for (let i = 1; i < armsEnd; i += 2) {
        const patNode = args[i]
        const armNode = args[i + 1]
        const variant = unwrapVariantDecl(patNode)

        if (variant) {
            // VariantDecl pattern: the pattern's "type" is the discriminant's
            // sum type (it picks one tag from it).  Bind each field with its
            // declared type from the variant's scheme, substituting the
            // discriminant's concrete typeArgs for any tvars the variant
            // was declared with.
            out.push(discT)
            const armT = withScope(ctx, inner => {
                const fieldTypes = resolveVariantFieldTypes(discT, variant.name, ctx)
                const declaredFields = (variant.fields || []) as any[]
                for (let fi = 0; fi < declaredFields.length; fi++) {
                    const fname: string = declaredFields[fi].name
                    // Fall back to TypeInt for variants whose scheme we
                    // don't have (e.g. legacy `@type_sum`-style enums) so
                    // existing code keeps working.
                    inner.symbols.set(fname, fieldTypes[fi] ?? TypeInt)
                }
                return armNode !== undefined ? checkNode(armNode, inner) : TypeUnknown
            })
            out.push(armT)
        } else {
            out.push(checkNode(patNode, ctx))
            out.push(armNode !== undefined ? checkNode(armNode, ctx) : TypeUnknown)
        }
    }

    if (hasDefault) out.push(checkNode(args[args.length - 1], ctx))
    return out
}

function isMatchCall(call: any): boolean {
    if (!call.isBuiltin) return false
    const name = typeof call.name === 'string'
        ? call.name
        : (call.name && Array.isArray(call.name.path) ? call.name.path.join('::') : '')
    return name === '@match'
}

function checkFunctionCall(call: any, ctx: Ctx): SiliconType {
    // @match has scoped pattern bindings — handle it before the generic walk.
    if (isMatchCall(call)) {
        // Accept both flat form (`disc, pat, body, …`) and arm-expression
        // form (`disc, pat => body, …`).  normalize collapses the latter
        // into the former so existing match-arg checking works unchanged.
        const flatArgs = normalizeMatchArgs(call.args || [])
        const matchArgTypes = checkMatchArgs(flatArgs, ctx)
        return typeOfMatchCall(matchArgTypes, call.sourceLocation, ctx)
    }

    // Type-check every argument regardless of whether we know the signature,
    // so inner type errors still surface.
    const argTypes: SiliconType[] = (call.args || []).map((a: any) => checkNode(a, ctx))

    // The grammar can collapse `&WASM::i32_add 1, 2` such that `name` is just
    // a Namespace pointing at `['WASM']` and the rest of the path is lost
    // before it gets to us. Sniff the bound identifier path off the args list
    // when the head looks like a builtin namespace — but the safer path is to
    // accept whatever name shape we've been handed and stringify it.
    let name: string
    if (typeof call.name === 'string') name = call.name
    else if (call.name && Array.isArray(call.name.path)) name = call.name.path.join('::')
    else name = ''

    // CaaS-5: record the call-site namespace node as a reference so that
    // symbolAtPosition / referenceSpans can navigate to it.
    if (name && call.name && typeof call.name === 'object') {
        recordSymbolRef(call.name, name, ctx)
    }

    // Phase 9d-5a / 9d-5b — wasm-mvp-only primitive rejection.
    // Two-layer portability split (ADR 0009):
    //   E0012 introspection — values have no honest wasm-gc semantics,
    //   conservative no-ops would silently change branch behavior.
    //   E0013 physical-byte — managed refs aren't addressable, no
    //   stable integer address for raw pointer math.
    if (ctx.target === 'wasm-gc' && name) {
        if (MVP_ONLY_INTROSPECTION.has(name)) {
            ctx.errors.push(mvpOnlyIntrospection(name, call.sourceLocation))
        } else if (MVP_ONLY_PHYSICAL_BYTE.has(name)) {
            ctx.errors.push(mvpOnlyPhysicalByte(name, call.sourceLocation))
        }
    }

    // WASM intrinsics have known signatures derivable from their names.
    const intr = getWasmIntrinsic(name)
    if (intr) {
        const sig = intrinsicSignature(name)
        if (sig) {
            // Arity check — avoids silent acceptance of `&WASM::i32_add 1`.
            if (argTypes.length !== sig.params.length) {
                ctx.errors.push(arityMismatch(name, sig.params.length, argTypes.length, call.sourceLocation))
            } else {
                for (let i = 0; i < sig.params.length; i++) {
                    const expected = sig.params[i]
                    const actual = argTypes[i]
                    if (actual.kind !== 'Unknown' && !typeEquals(expected, actual)) {
                        ctx.errors.push(mismatch(expected, actual, `${name} arg ${i}`, call.sourceLocation))
                    }
                }
            }
            return sig.result
        }
    }

    // User-defined function: look up its registered signature.
    let sig = ctx.functions.get(name)
    // CaaS-2g: fall back to external symbols when no local sig exists.
    if (!sig && ctx.externalSymbols) {
        const extType = ctx.externalSymbols.get(name)
        if (extType?.kind === 'Function') {
            sig = { params: extType.params, result: extType.result }
        }
    }
    if (sig) {
        if (argTypes.length !== sig.params.length) {
            ctx.errors.push(arityMismatch(name, sig.params.length, argTypes.length, call.sourceLocation))
            return sig.result
        }
        return checkPolymorphicCall(name, sig, argTypes, call, ctx)
    }

    // Builtin keyword strata (@if, @loop, @match, @toInt, @toFloat, …) — look up via the registry.
    // Use typed dispatch when the first argument's type is known (e.g. @toFloat:Int).
    if (call.isBuiltin && ctx.registry) {
        const firstArgKind: string = argTypes[0]?.kind ?? 'Int'
        const kwEntry = lookupTypedKeyword(ctx.registry, name, firstArgKind) ?? lookupKeyword(ctx.registry, name)
        if (kwEntry) {
            const intr = kwEntry.data?.intrinsic
            // Recognise control-flow keywords by name OR by legacy intrinsic
            // marker — D-D-* migrations to the new @stratum form drop the
            // intrinsic field, but the typechecker still needs the special
            // typing rules (branch unification for @if/@match, void for @loop).
            if (intr === 'WASM::control_if'    || intr === 'IR::control_if'    || name === '@if')    return typeOfIfCall(argTypes, call.sourceLocation, ctx)
            if (intr === 'WASM::control_loop'  || intr === 'IR::control_loop'  || name === '@loop')  return TypeUnknown  // loops are void
            if (intr === 'WASM::control_match' || intr === 'IR::control_match' || name === '@match') return typeOfMatchCall(argTypes, call.sourceLocation, ctx)
            // D-D-5 migrated cast keywords don't carry a typeSignature on
            // their primary entry.  Hardcode their signatures here so the
            // typechecker keeps rejecting mismatched arguments (e.g.
            // @toFloat on an already-Float operand).  @toInt has two
            // forms — Float→Int (primary) and Int64→Int (typed overload,
            // picked when the operand is Int64).
            const migratedCastSig: TypeSig | undefined =
                name === '@toFloat' ? { params: [TypeInt],   result: TypeFloat } :
                name === '@toInt' && firstArgKind === 'Int64' ? { params: [TypeInt64], result: TypeInt } :
                name === '@toInt'   ? { params: [TypeFloat], result: TypeInt   } :
                name === '@toInt64' ? { params: [TypeInt],   result: TypeInt64 } :
                // Phase 5b-4 — unsigned-integer casts.  @toU32 is a pure
                // type relabel (Int → u32 shares i32 at the WASM level);
                // @toU64 zero-extends from Int (→ u64) or relabels from
                // Int64 (→ u64).  Used for WASI bindings + any user code
                // that wants explicit unsigned types.
                name === '@toU32' ? { params: [TypeInt],   result: TypeUInt32 } :
                name === '@toU64' && firstArgKind === 'Int64' ? { params: [TypeInt64], result: TypeUInt64 } :
                name === '@toU64' ? { params: [TypeInt],   result: TypeUInt64 } :
                undefined
            // Prefer the pre-derived TypeSig stored in the registry; fall back to
            // deriving from the intrinsic name for strata loaded before Round 30.
            const sig: TypeSig | undefined =
                kwEntry.data?.typeSignature ??
                (intr ? intrinsicSignature(intr) : undefined) ??
                migratedCastSig
            if (sig) {
                for (let i = 0; i < sig.params.length; i++) {
                    const actual = argTypes[i]
                    if (actual !== undefined && actual.kind !== 'Unknown' && !typeEquals(sig.params[i], actual)) {
                        ctx.errors.push(mismatch(sig.params[i], actual, `${name} arg ${i}`, call.sourceLocation))
                    }
                }
                return sig.result
            }
        }
    }

    // Truly unknown — don't cascade errors.
    return TypeUnknown
}

function typeOfIfCall(argTypes: SiliconType[], loc: any, ctx: Ctx): SiliconType {
    const condT = argTypes[0] ?? TypeUnknown
    const thenT = argTypes[1] ?? TypeUnknown
    const elseT = argTypes[2] ?? TypeUnknown

    // Condition must be a numeric or boolean value (truthy check in WAT).
    if (condT.kind !== 'Unknown' && !isNumeric(condT) && !typeEquals(condT, TypeBool)) {
        ctx.errors.push(mismatch(TypeInt, condT, '@if condition', loc))
    }

    // Void form (no else branch) — result is always unknown.
    if (argTypes.length < 3 || elseT.kind === 'Unknown') return TypeUnknown
    if (thenT.kind === 'Unknown') return TypeUnknown

    // Both branches present and typed — they must agree.
    if (!typeEquals(thenT, elseT)) {
        ctx.errors.push(mismatch(thenT, elseT, '@if branch type mismatch', loc))
        return TypeUnknown
    }
    return thenT
}

function typeOfMatchCall(argTypes: SiliconType[], loc: any, ctx: Ctx): SiliconType {
    // args = [discriminant, pat0, res0, pat1, res1, ...]
    // Odd total: all arms explicit, ends unreachable.
    // Even total (≥ 4): last arg is a trailing catch-all default value (no pattern).
    if (argTypes.length < 3) {
        ctx.errors.push({
            kind: 'Mismatch',
            message: `@match requires at least 3 arguments: discriminant, pattern, result [, ...default]`,
            sourceLocation: loc,
        })
        return TypeUnknown
    }

    const discT = argTypes[0]
    const hasDefault = argTypes.length % 2 === 0
    const armsEnd = hasDefault ? argTypes.length - 1 : argTypes.length
    let resultT: SiliconType = TypeUnknown

    // HM-lite: track the accumulated substitution so type-variable info
    // flows between arms.  A pattern of `$Some v` against a discriminant of
    // `Option[?T]` should pin `?T` and let that pinning carry forward.
    let subst: Subst = emptySubst()
    const tryUnify = (a: SiliconType, b: SiliconType, ctxStr: string): void => {
        if (a.kind === 'Unknown' || b.kind === 'Unknown') return
        try {
            subst = unify(a, b, subst)
        } catch (e) {
            if (e instanceof UnifyError) {
                ctx.errors.push(mismatch(applySubst(a, subst), applySubst(b, subst), ctxStr, loc))
            } else {
                throw e
            }
        }
    }

    for (let i = 1; i < armsEnd; i += 2) {
        const patT = argTypes[i]
        const resT = argTypes[i + 1] ?? TypeUnknown

        // Each pattern's type must unify with the discriminant.
        tryUnify(discT, patT, `@match pattern ${Math.floor(i / 2)}`)

        // All arm results must unify with the accumulated result type.
        if (resT.kind !== 'Unknown') {
            if (resultT.kind === 'Unknown') {
                resultT = resT
            } else {
                tryUnify(resultT, resT, `@match arm ${Math.floor(i / 2)} result`)
            }
        }
    }

    // Trailing default — must unify with the arm result type.
    if (hasDefault) {
        const defaultT = argTypes[argTypes.length - 1]
        if (defaultT.kind !== 'Unknown') {
            if (resultT.kind === 'Unknown') resultT = defaultT
            else tryUnify(resultT, defaultT, `@match default arm`)
        }
    }

    // Apply the accumulated subst so the returned type reflects everything
    // we learned across all arms.
    return applySubst(resultT, subst)
}

// ---------------------------------------------------------------------------
// Literals, namespaces, blocks
// ---------------------------------------------------------------------------

function checkArrayLiteral(arr: any, ctx: Ctx): SiliconType {
    const elements: any[] = arr.elements || []
    if (elements.length === 0) {
        // Empty array: element type is Unknown. We could support an
        // annotation-driven path here once `Array[Int]` is a real grammar
        // production, but for now flagging as Unknown is honest.
        return ArrayOf(TypeUnknown)
    }
    const firstT = checkNode(elements[0], ctx)
    for (let i = 1; i < elements.length; i++) {
        const t = checkNode(elements[i], ctx)
        if (t.kind !== 'Unknown' && !typeEquals(firstT, t)) {
            ctx.errors.push(heterogeneousArray(firstT, t, arr.sourceLocation))
        }
    }
    return ArrayOf(firstT)
}

function typeOfNamespace(ns: any, ctx: Ctx): SiliconType {
    const path: string[] = ns && ns.path ? ns.path : []
    const key = path.join('::')
    const t = ctx.symbols.get(key)
    if (t) {
        recordSymbolRef(ns, key, ctx)
        return t
    }
    // Single-segment references — search by plain name too, so `x` and
    // `module::x` both resolve if one was registered.
    if (path.length === 1) {
        const t2 = ctx.symbols.get(path[0])
        if (t2) {
            recordSymbolRef(ns, path[0], ctx)
            return t2
        }
        // Cross-check the function signature table. Function names stored there
        // but not yet in symbols (e.g. @extern with no binding) should not
        // produce false "unbound identifier" errors.
        const sig = ctx.functions.get(path[0])
        if (sig) {
            recordSymbolRef(ns, path[0], ctx)
            return FunctionOf(sig.params, sig.result)
        }
    }
    // Struct field access: `p.x` or `p.start.x` (nested) — walk the path chain.
    if (path.length >= 2) {
        const baseType = ctx.symbols.get(path[0])
        if (baseType) {
            let currentType: SiliconType = baseType
            for (let i = 1; i < path.length; i++) {
                const structName = currentType.kind === 'Distinct' ? currentType.name : undefined
                if (!structName) break
                const fields = ctx.structFields.get(structName)
                if (!fields) break
                const fieldType = fields.get(path[i])
                if (fieldType === undefined) {
                    ctx.errors.push(unbound(`${structName}.${path[i]}`, ns.sourceLocation))
                    return TypeUnknown
                }
                if (i === path.length - 1) {
                    recordSymbolRef(ns, key, ctx)
                    return fieldType
                }
                currentType = fieldType
            }
        }
    }
    // CaaS-2g: cross-document fallback — check external symbols before erroring.
    if (ctx.externalSymbols) {
        const ext = ctx.externalSymbols.get(key)
            ?? (path.length === 1 ? ctx.externalSymbols.get(path[0]) : undefined)
        if (ext) {
            recordSymbolRef(ns, path.length === 1 ? path[0] : key, ctx)
            return ext
        }
    }
    const candidates = [...ctx.symbols.keys(), ...ctx.functions.keys()]
    const suggestion = closest(key, candidates)
    const err = unbound(key, ns.sourceLocation)
    if (suggestion) err.hint = `did you mean '${suggestion}'?`
    ctx.errors.push(err)
    return TypeUnknown
}

/**
 * Resolve the M3 relative-position encoding (`relSpan` + element `elemBase`) into
 * absolute `node.sourceLocation` for every positioned node, in one walk.  Run on
 * the ephemeral elaborated tree at the start of `typecheck` so the rest of the
 * checker reads `sourceLocation` exactly as before (output-preserving).
 */
function stampSourceLocations(node: any, positions: PositionTable): void {
    if (node === null || typeof node !== 'object') return
    if (node.relSpan) {
        const loc = positions.loc(node)
        if (loc) node.sourceLocation = loc
    }
    for (const child of astChildren(node)) stampSourceLocations(child, positions)
}

function recordSymbolRef(node: object, name: string, ctx: Ctx): void {
    ctx.nodeToSymbolName.set(node, name)
    const refs = ctx.symbolToNodes.get(name)
    if (refs) refs.push(node)
    else ctx.symbolToNodes.set(name, [node])
    // CaaS-5: record the source span for this reference so symbolAtPosition works.
    const loc = (node as any).sourceLocation
    if (loc) {
        const span = spanFromLocation(loc, ctx.file)
        const spans = ctx.symbolToSpans.get(name)
        if (spans) spans.push(span)
        else ctx.symbolToSpans.set(name, [span])
    }
}

function typeOfBlock(block: any, ctx: Ctx): SiliconType {
    for (const item of block.items || []) {
        checkNode(item, ctx)
    }
    if (block.trailing) {
        return checkNode(block.trailing, ctx)
    }
    return TypeUnknown
}

// intrinsicSignature is imported from ./intrinsicSig and used above for
// direct WASM intrinsic calls (&WASM::...) and as a fallback for strata
// whose typeSignature field was not populated by the loader.

// ---------------------------------------------------------------------------
// HM-lite call-site checking
// ---------------------------------------------------------------------------

/** Collect the names of all unique Variable types appearing in `t`.  Used to
 *  reconstruct a Scheme from a registered FunctionSig — if the sig has free
 *  Variables, those are its scheme's bound vars (Roc-style: only declared
 *  polymorphism, never auto-generalised from inferred locals). */
function freeTypeVars(t: SiliconType, into: Set<string> = new Set()): Set<string> {
    switch (t.kind) {
        case 'Variable': into.add(t.name); break
        case 'Array':    freeTypeVars(t.element, into); break
        case 'Function':
            t.params.forEach(p => freeTypeVars(p, into))
            freeTypeVars(t.result, into)
            break
        case 'Sum':
            ;(t.typeArgs ?? []).forEach(a => freeTypeVars(a, into))
            break
        case 'Distinct':
            freeTypeVars(t.underlying, into)
            break
    }
    return into
}

/**
 * Type-check a call to a user-defined function, applying HM-lite unification
 * if the signature is polymorphic (contains free Variables).
 *
 * For monomorphic sigs (the common case), this collapses to the existing
 * strict-equality check, so existing behaviour is preserved.  For
 * polymorphic sigs (`@fn id[T] x:T := x`, variant constructors of `@type Option[T]`),
 * each call instantiates the Variables to fresh `?Ti`, unifies with arg
 * types, and returns the substituted result.
 */
function checkPolymorphicCall(
    name: string,
    sig: FunctionSig,
    argTypes: SiliconType[],
    call: any,
    ctx: Ctx,
): SiliconType {
    const tvarNames = Array.from(freeTypeVars(FunctionOf(sig.params, sig.result)))

    // Monomorphic — fall back to strict-equality path (preserves existing semantics).
    if (tvarNames.length === 0) {
        for (let i = 0; i < sig.params.length; i++) {
            const expected = sig.params[i]
            const actual = argTypes[i]
            if (actual.kind !== 'Unknown' && !typeEquals(expected, actual)) {
                ctx.errors.push(mismatch(expected, actual, `'${name}' arg ${i}`, call.sourceLocation))
            }
        }
        return sig.result
    }

    // Polymorphic — instantiate the scheme with fresh `?Ti`s shared across
    // params and result, then unify pointwise.  Uses ctx.fresh so nested
    // calls (e.g. `&unwrap_or x, (&None)`) don't recycle the same `?T1`
    // name for two different schemes and accidentally unify them.
    const instMap = new Map<string, SiliconType>()
    for (const tv of tvarNames) instMap.set(tv, ctx.fresh.next(tv))
    const instParams = sig.params.map(p => applySubst(p, instMap))
    const instResult = applySubst(sig.result, instMap)

    let subst: Subst = emptySubst()
    for (let i = 0; i < instParams.length; i++) {
        const actual = argTypes[i]
        if (actual.kind === 'Unknown') continue  // suppress cascading errors
        try {
            subst = unify(instParams[i], actual, subst)
        } catch (e) {
            if (e instanceof UnifyError) {
                // Report against the instantiated-then-substituted param so the
                // user sees the *contextual* expected type, not raw `?Ti`.
                const expectedShown = applySubst(instParams[i], subst)
                ctx.errors.push(mismatch(expectedShown, actual, `'${name}' arg ${i}`, call.sourceLocation))
            } else {
                throw e
            }
        }
    }
    return applySubst(instResult, subst)
}

// ---------------------------------------------------------------------------
// CaaS-3: symbol table construction
// ---------------------------------------------------------------------------

function symbolKindFromKeyword(kw: string, paramCount: number): SymbolKind {
    if (kw === '@stratum') return 'stratum'
    if (kw === '@type' || kw === '@type_sum' || kw === '@enum' || kw === '@type_alias'
        || kw === '@type_distinct' || kw === '@generic') return 'type'
    if (kw === '@var' || kw === '@local') return 'variable'
    if (paramCount > 0 || kw === '@fn' || kw === '@extern') return 'function'
    return 'variable'
}

function buildSymbolTable(ctx: Ctx): Map<string, CaaSSymbol> {
    const table = new Map<string, CaaSSymbol>()
    for (const [name, defNode] of ctx.definitionNodes) {
        const def = defNode as any
        const kw: string = def.keyword ?? ''
        const paramCount = (def.params || []).filter((p: any) => !p.isLiteral).length
        const kind = symbolKindFromKeyword(kw, paramCount)
        const type = ctx.symbols.get(name)
        const definitionSpan = def.sourceLocation ? spanFromLocation(def.sourceLocation, ctx.file) : undefined
        const locations: import('../errors/diagnostic').SourceSpan[] = definitionSpan ? [definitionSpan] : []
        const partial = { name, kind, definitionNode: defNode, type, definitionSpan, locations, containingSymbol: undefined }
        const displayString = symbolDisplayString(partial as CaaSSymbol)
        table.set(name, { ...partial, displayString })
    }
    return table
}
