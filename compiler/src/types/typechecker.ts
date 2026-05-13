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
import {
    type SiliconType,
    TypeInt,
    TypeFloat,
    TypeString,
    TypeBool,
    TypeUnknown,
    ArrayOf,
    FunctionOf,
    DistinctOf,
    SumOf,
    typeEquals,
    parseTypeName,
    isNumeric,
    isComparable,
    isEqualityComparable,
} from './types'
import {
    type TypeError,
    mismatch,
    invalidOperator,
    unbound,
    unknownType,
    heterogeneousArray,
    annotationMismatch,
    immutableAssignment,
} from './errors'
import { getWasmIntrinsic } from '../intrinsics'
import { type ElaboratorRegistry, lookupOperator, lookupTypedOperator, lookupKeyword } from '../elaborator/registry'
import { intrinsicSignature, type TypeSig } from './intrinsicSig'

/**
 * Mutable checking context. Threaded through the recursive walk so error
 * accumulation and symbol bookkeeping stay in one place.
 */
interface Ctx {
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
    // Stratum registry for user-defined operator type checking (optional).
    registry?: ElaboratorRegistry
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
function withScope(ctx: Ctx, fn: (inner: Ctx) => SiliconType): SiliconType {
    const savedSymbols = ctx.symbols
    ctx.symbols = new Map(savedSymbols)
    const t = fn(ctx)
    ctx.symbols = savedSymbols
    return t
}

/**
 * Result of `typecheck`: the (mutated in place) program plus collected errors.
 * Returning the program keeps this pass compositional with `elaborate` which
 * has the same shape.
 */
export interface TypeCheckResult {
    program: Program
    errors: TypeError[]
    functions: Map<string, FunctionSig>
    typeAliases: Map<string, SiliconType>
}

/**
 * Run the type checker. This annotates the AST in-place with `inferredType`
 * fields and returns the collected errors. The original AST is returned for
 * convenience so this can be chained in a pipeline:
 *
 *     const { program: typed, errors } = typecheck(elaborated)
 *     if (errors.length) { ... }
 */
export default function typecheck(program: Program, registry?: ElaboratorRegistry): TypeCheckResult {
    const ctx: Ctx = {
        errors: [],
        symbols: new Map(),
        functions: new Map(),
        immutable: new Set(),
        typeAliases: new Map(),
        registry,
    }
    // Pre-registration pass: seed the function/symbol tables and type alias
    // table from top-level definitions so forward references resolve correctly.
    preRegisterDefinitions(program.elements as any[], ctx)
    for (const element of program.elements as any[]) {
        checkNode(element, ctx)
    }
    return { program, errors: ctx.errors, functions: ctx.functions, typeAliases: ctx.typeAliases }
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
function preRegisterDefinitions(elements: any[], ctx: Ctx): void {
    // Sub-pass 1: collect @type_alias and @type_distinct declarations.
    for (const el of elements) {
        const def = extractDefinitionNode(el)
        if (!def || !def.name?.name) continue
        const kw: string = def.keyword ?? ''
        if (kw === '@type_alias' || kw === '@type_distinct' || kw === '@type_sum') {
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
        if (kw === '@type_alias' || kw === '@type_distinct' || kw === '@type_sum') continue

        const paramTypes: SiliconType[] = []
        for (const p of def.params || []) {
            if (p.isLiteral || !p.typeAnnotation) continue
            paramTypes.push(parseTypeName(p.typeAnnotation.typename, ctx.typeAliases) ?? TypeUnknown)
        }

        let resultType: SiliconType = TypeUnknown
        if (def.name.typeAnnotation) {
            const parsed = parseTypeName(def.name.typeAnnotation.typename, ctx.typeAliases)
            if (parsed) resultType = parsed
        }

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

    if (kw === '@type_sum') {
        preRegisterSumType(def, ctx)
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

        // Anything we don't model (DocComment, Elaboration, TypedIdentifier
        // when reached out of a Definition context, etc.) is benign — we just
        // don't contribute a type for it.
        default: t = TypeUnknown
    }
    // Stamp the inferred type onto every node we visited. Nodes whose type
    // declaration doesn't include `inferredType` simply gain an extra field;
    // this is harmless and lets downstream consumers (codegen, debug dumps)
    // read it uniformly.
    if (t.kind !== 'Unknown') node.inferredType = t
    else if (node.inferredType === undefined) node.inferredType = t
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

    // Type declarations are fully handled at pre-registration time; they emit
    // no WAT and have no body to check.
    if (keyword === '@type_alias' || keyword === '@type_distinct' || keyword === '@type_sum') {
        return TypeUnknown
    }

    // Resolve the declared type annotation (if any).
    let annotated: SiliconType | undefined
    const annotation = d.name && d.name.typeAnnotation
    if (annotation) {
        const parsed = parseTypeName(annotation.typename, ctx.typeAliases)
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
            for (const param of d.params || []) {
                if (param.isLiteral) continue
                if (param.typeAnnotation) {
                    const pt = parseTypeName(param.typeAnnotation.typename, inner.typeAliases)
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

    // Reconcile annotation with body.
    const finalType = annotated ?? bodyType
    if (annotated && d.binding && !typeEquals(annotated, bodyType) && bodyType.kind !== 'Unknown') {
        ctx.errors.push(annotationMismatch(d.name.name, annotated, bodyType, d.sourceLocation))
    }

    if (d.name && d.name.name) {
        const paramTypes: SiliconType[] = []
        for (const param of d.params || []) {
            if (param.isLiteral || !param.typeAnnotation) continue
            paramTypes.push(parseTypeName(param.typeAnnotation.typename, ctx.typeAliases) ?? TypeUnknown)
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
    return finalType
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

function checkBinaryOp(b: any, ctx: Ctx): SiliconType {
    const leftT = checkNode(b.left, ctx)
    const rightT = checkNode(b.right, ctx)

    // Propagate Unknown without cascading additional errors.
    if (leftT.kind === 'Unknown' || rightT.kind === 'Unknown') {
        return TypeUnknown
    }

    switch (b.operator) {
        // Arithmetic — both sides must be the same numeric type.
        case '+':
        case '-':
        case '*':
        case '/':
        case '%':
            if (!isNumeric(leftT) || !isNumeric(rightT) || !typeEquals(leftT, rightT)) {
                ctx.errors.push(invalidOperator(b.operator, leftT, rightT, b.sourceLocation))
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

function checkFunctionCall(call: any, ctx: Ctx): SiliconType {
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

    // WASM intrinsics have known signatures derivable from their names.
    const intr = getWasmIntrinsic(name)
    if (intr) {
        const sig = intrinsicSignature(name)
        if (sig) {
            // Arity check — avoids silent acceptance of `&WASM::i32_add 1`.
            if (argTypes.length !== sig.params.length) {
                ctx.errors.push({
                    kind: 'Mismatch',
                    message: `${name} expects ${sig.params.length} argument(s), got ${argTypes.length}`,
                    sourceLocation: call.sourceLocation,
                })
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
    const sig = ctx.functions.get(name)
    if (sig) {
        if (argTypes.length !== sig.params.length) {
            ctx.errors.push({
                kind: 'Mismatch',
                message: `'${name}' expects ${sig.params.length} argument(s), got ${argTypes.length}`,
                sourceLocation: call.sourceLocation,
            })
        } else {
            for (let i = 0; i < sig.params.length; i++) {
                const expected = sig.params[i]
                const actual = argTypes[i]
                if (actual.kind !== 'Unknown' && !typeEquals(expected, actual)) {
                    ctx.errors.push(mismatch(expected, actual, `'${name}' arg ${i}`, call.sourceLocation))
                }
            }
        }
        return sig.result
    }

    // Builtin keyword strata (@if, @loop, @match, @toInt, @toFloat, …) — look up via the registry.
    if (call.isBuiltin && ctx.registry) {
        const kwEntry = lookupKeyword(ctx.registry, name)
        if (kwEntry) {
            const intr = kwEntry.data?.intrinsic
            if (intr === 'WASM::control_if') return typeOfIfCall(argTypes, call.sourceLocation, ctx)
            if (intr === 'WASM::control_loop') return TypeUnknown  // loops are void
            if (intr === 'WASM::control_match') return typeOfMatchCall(argTypes, call.sourceLocation, ctx)
            // Prefer the pre-derived TypeSig stored in the registry; fall back to
            // deriving from the intrinsic name for strata loaded before Round 30.
            const sig: TypeSig | undefined =
                kwEntry.data?.typeSignature ??
                (intr ? intrinsicSignature(intr) : undefined)
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
    // Must have at least 3 args (discriminant + 1 arm) and an odd total count.
    if (argTypes.length < 3 || argTypes.length % 2 === 0) {
        ctx.errors.push({
            kind: 'Mismatch',
            message: `@match requires an odd number of arguments ≥ 3: discriminant, pattern, result, ...`,
            sourceLocation: loc,
        })
        return TypeUnknown
    }

    const discT = argTypes[0]
    let resultT: SiliconType = TypeUnknown

    for (let i = 1; i < argTypes.length; i += 2) {
        const patT = argTypes[i]
        const resT = argTypes[i + 1] ?? TypeUnknown

        // Each pattern must have the same type as the discriminant.
        if (discT.kind !== 'Unknown' && patT.kind !== 'Unknown' && !typeEquals(discT, patT)) {
            ctx.errors.push(mismatch(discT, patT, `@match pattern ${Math.floor(i / 2)}`, loc))
        }

        // All arm results must agree on one type.
        if (resT.kind !== 'Unknown') {
            if (resultT.kind === 'Unknown') {
                resultT = resT
            } else if (!typeEquals(resultT, resT)) {
                ctx.errors.push(mismatch(resultT, resT, `@match arm ${Math.floor(i / 2)} result`, loc))
            }
        }
    }

    return resultT
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
    if (t) return t
    // Single-segment references — search by plain name too, so `x` and
    // `module::x` both resolve if one was registered.
    if (path.length === 1) {
        const t2 = ctx.symbols.get(path[0])
        if (t2) return t2
        // Cross-check the function signature table. Function names stored there
        // but not yet in symbols (e.g. @extern with no binding) should not
        // produce false "unbound identifier" errors.
        const sig = ctx.functions.get(path[0])
        if (sig) return FunctionOf(sig.params, sig.result)
    }
    ctx.errors.push(unbound(key, ns.sourceLocation))
    return TypeUnknown
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
