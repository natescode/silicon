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
    typeEquals,
    parseTypeName,
    isNumeric,
    isComparable,
} from './types'
import {
    type TypeError,
    mismatch,
    invalidOperator,
    unbound,
    unknownType,
    heterogeneousArray,
    annotationMismatch,
} from './errors'
import { getWasmIntrinsic } from '../intrinsics'

/**
 * Mutable checking context. Threaded through the recursive walk so error
 * accumulation and symbol bookkeeping stay in one place.
 */
interface Ctx {
    errors: TypeError[]
    // Flat symbol table. Keyed by the joined namespace path (e.g. "module::x").
    symbols: Map<string, SiliconType>
}

/**
 * Run `fn` in a child scope that inherits all parent symbols but whose new
 * bindings are discarded when `fn` returns. Errors still accumulate into the
 * shared `ctx.errors` list.
 */
function withScope(ctx: Ctx, fn: (inner: Ctx) => SiliconType): SiliconType {
    const saved = ctx.symbols
    ctx.symbols = new Map(saved)
    const t = fn(ctx)
    ctx.symbols = saved
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
}

/**
 * Run the type checker. This annotates the AST in-place with `inferredType`
 * fields and returns the collected errors. The original AST is returned for
 * convenience so this can be chained in a pipeline:
 *
 *     const { program: typed, errors } = typecheck(elaborated)
 *     if (errors.length) { ... }
 */
export default function typecheck(program: Program): TypeCheckResult {
    const ctx: Ctx = { errors: [], symbols: new Map() }
    for (const element of program.elements as any[]) {
        checkNode(element, ctx)
    }
    return { program, errors: ctx.errors }
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
        case 'IfExpr': t = checkIfExpr(node, ctx); break
        case 'WhileExpr': t = checkWhileExpr(node, ctx); break
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
    const existing = ctx.symbols.get(key)
    if (existing && !typeEquals(existing, valueT) && valueT.kind !== 'Unknown') {
        ctx.errors.push(mismatch(existing, valueT, `assignment to '${key}'`, a.sourceLocation))
    } else if (!existing) {
        ctx.symbols.set(key, valueT)
    }
    return valueT
}

function checkDefinition(d: any, ctx: Ctx): SiliconType {
    // Resolve the declared type annotation (if any).
    let annotated: SiliconType | undefined
    const annotation = d.name && d.name.typeAnnotation
    if (annotation) {
        const parsed = parseTypeName(annotation.typename)
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
                    const pt = parseTypeName(param.typeAnnotation.typename)
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

    if (d.name && d.name.name) ctx.symbols.set(d.name.name, finalType)
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
        // Comparison — same comparable type on both sides, result is Bool.
        case '==':
        case '!=':
        case '<':
        case '>':
        case '<=':
        case '>=':
            if (!isComparable(leftT) || !isComparable(rightT) || !typeEquals(leftT, rightT)) {
                ctx.errors.push(invalidOperator(b.operator, leftT, rightT, b.sourceLocation))
                return TypeUnknown
            }
            return TypeBool
        default:
            // Custom operators (user strata): we don't yet know their types.
            // Leave as Unknown rather than erroring — the elaborator has
            // already attached semantics for these.
            return TypeUnknown
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

    // Unknown user function: don't cascade errors into the surrounding
    // expression. Record the call type as Unknown.
    return TypeUnknown
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
    }
    ctx.errors.push(unbound(key, ns.sourceLocation))
    return TypeUnknown
}

function typeOfBlock(block: any, ctx: Ctx): SiliconType {
    let last: SiliconType = TypeUnknown
    for (const item of block.items || []) {
        last = checkNode(item, ctx)
    }
    return last
}

function checkIfExpr(node: any, ctx: Ctx): SiliconType {
    checkNode(node.condition, ctx)
    const thenT = withScope(ctx, inner => typeOfBlock(node.thenBlock, inner))
    if (node.elseBlock) {
        const elseT = withScope(ctx, inner => typeOfBlock(node.elseBlock, inner))
        if (thenT.kind !== 'Unknown' && elseT.kind !== 'Unknown' && typeEquals(thenT, elseT)) {
            return thenT
        }
    }
    return TypeUnknown
}

function checkWhileExpr(node: any, ctx: Ctx): SiliconType {
    checkNode(node.condition, ctx)
    withScope(ctx, inner => typeOfBlock(node.body, inner))
    return TypeUnknown
}

// ---------------------------------------------------------------------------
// Intrinsic signatures
// ---------------------------------------------------------------------------

/**
 * Map a WASM intrinsic name to its argument and result types. The pattern is
 * highly regular: "i32_add" → i32 × i32 → i32, "f32_convert_i32_s" → i32 → f32.
 * Rather than hand-rolling every entry, we derive it from the name.
 */
interface IntrinsicSig {
    params: SiliconType[]
    result: SiliconType
}

function intrinsicSignature(fullName: string): IntrinsicSig | undefined {
    const m = fullName.match(/^WASM::(.+)$/)
    if (!m) return undefined
    const short = m[1]

    // Arithmetic / bitwise / comparison binary ops: <type>_<op>
    // Pull the prefix (i32 or f32) and dispatch by op.
    const binaryOp = /^(i32|f32)_(add|sub|mul|div(_[su])?|rem(_[su])?|and|or|xor|shl|shr_s|shr_u|rotl|rotr|eq|ne|lt(_[su])?|gt(_[su])?|le(_[su])?|ge(_[su])?)$/
    if (binaryOp.test(short)) {
        const prefix = short.startsWith('i32') ? TypeInt : TypeFloat
        const isComparison = /^(eq|ne|lt|gt|le|ge)(_[su])?$/.test(short.slice(4))
        return {
            params: [prefix, prefix],
            result: isComparison ? TypeBool : prefix,
        }
    }

    // Unary ops per type.
    const unaryI32 = ['clz', 'ctz', 'popcnt']
    if (short.startsWith('i32_') && unaryI32.includes(short.slice(4))) {
        return { params: [TypeInt], result: TypeInt }
    }
    const unaryF32 = ['abs', 'neg', 'sqrt']
    if (short.startsWith('f32_') && unaryF32.includes(short.slice(4))) {
        return { params: [TypeFloat], result: TypeFloat }
    }

    // Conversions.
    if (short === 'i32_trunc_f32_s' || short === 'i32_trunc_f32_u') {
        return { params: [TypeFloat], result: TypeInt }
    }
    if (short === 'f32_convert_i32_s' || short === 'f32_convert_i32_u') {
        return { params: [TypeInt], result: TypeFloat }
    }

    // Memory ops.
    if (short === 'i32_load' || short === 'i32_load8_s' || short === 'i32_load8_u') {
        return { params: [TypeInt], result: TypeInt }
    }
    if (short === 'f32_load') {
        return { params: [TypeInt], result: TypeFloat }
    }
    if (short === 'i32_store' || short === 'i32_store8') {
        return { params: [TypeInt, TypeInt], result: TypeUnknown }
    }
    if (short === 'f32_store') {
        return { params: [TypeInt, TypeFloat], result: TypeUnknown }
    }
    if (short === 'data_memory') {
        return { params: [], result: TypeInt }
    }
    if (short === 'mem_grow') {
        return { params: [TypeInt], result: TypeInt }
    }

    return undefined
}
