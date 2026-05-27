/**
 * Silicon IR (Intermediate Representation)
 *
 * A typed tree that sits between the type-checked AST and WAT emission.
 * Every expression node carries `wasmType` derived from the type checker's
 * `inferredType` — eliminating the f32-sniffing heuristic in the Ohm codegen.
 *
 * The key invariant: no node in this tree needs to inspect its children's
 * compiled output to determine a type. The type is always pre-computed.
 *
 * Pipeline position:
 *   TypedAST --[lower.ts]--> IRModule --[emit.ts]--> WAT string
 */

/** The WASM value types Silicon uses. 'void' means no stack value produced. */
export type WasmValType = 'i32' | 'i64' | 'f32'
export type WasmType = WasmValType | 'void'

/**
 * Backend-agnostic binary operation opcode.  Names match the keys in
 * `wasmIntrinsics` (underscore convention: `i32_add`, `i64_lt_s`, …).
 * The WAT emitter converts these to WAT instruction strings via the
 * intrinsics registry; the QBE emitter maps them to QBE mnemonics.
 * IRCall.callee remains a WAT string for memory/control/unary ops.
 */
export type AbstractOp =
    // i32 arithmetic
    | 'i32_add' | 'i32_sub' | 'i32_mul'
    | 'i32_div_s' | 'i32_div_u' | 'i32_rem_s' | 'i32_rem_u'
    // i32 bitwise
    | 'i32_and' | 'i32_or' | 'i32_xor'
    | 'i32_shl' | 'i32_shr_s' | 'i32_shr_u' | 'i32_rotl' | 'i32_rotr'
    // i32 comparisons (result type i32: 0 or 1)
    | 'i32_eq' | 'i32_ne'
    | 'i32_lt_s' | 'i32_gt_s' | 'i32_le_s' | 'i32_ge_s'
    | 'i32_lt_u' | 'i32_gt_u' | 'i32_le_u' | 'i32_ge_u'
    // i64 arithmetic
    | 'i64_add' | 'i64_sub' | 'i64_mul'
    | 'i64_div_s' | 'i64_div_u' | 'i64_rem_s' | 'i64_rem_u'
    // i64 bitwise
    | 'i64_and' | 'i64_or' | 'i64_xor'
    | 'i64_shl' | 'i64_shr_s' | 'i64_shr_u'
    // i64 comparisons (result type i32: 0 or 1)
    | 'i64_eq' | 'i64_ne'
    | 'i64_lt_s' | 'i64_gt_s' | 'i64_le_s' | 'i64_ge_s'
    | 'i64_lt_u' | 'i64_gt_u' | 'i64_le_u' | 'i64_ge_u'
    // f32 arithmetic
    | 'f32_add' | 'f32_sub' | 'f32_mul' | 'f32_div'
    // f32 comparisons (result type i32: 0 or 1)
    | 'f32_eq' | 'f32_ne' | 'f32_lt' | 'f32_gt' | 'f32_le' | 'f32_ge'

// ---------------------------------------------------------------------------
// Expression IR nodes
// ---------------------------------------------------------------------------

/** Literal constant. wasmType is always 'i32' or 'f32'. */
export interface IRConst {
    kind: 'Const'
    wasmType: WasmValType
    value: number
}

/** Read a function parameter or @local variable. */
export interface IRLocalGet {
    kind: 'LocalGet'
    wasmType: WasmValType
    name: string
}

/** Read a module-level global (@var or sum-type variant). */
export interface IRGlobalGet {
    kind: 'GlobalGet'
    wasmType: WasmValType
    name: string
}

/**
 * Binary operation.  `op` is a backend-agnostic `AbstractOp` opcode — NOT a
 * WAT instruction string.  The WAT emitter maps it to the WAT instruction via
 * the intrinsics registry; the QBE emitter maps it to a QBE mnemonic.
 * The wasmType is the RESULT type — for comparison ops this is 'i32' even when
 * operands are 'f32'.
 */
export interface IRBinOp {
    kind: 'BinOp'
    wasmType: WasmValType
    op: AbstractOp
    left: IRExpr
    right: IRExpr
}

/**
 * Function/intrinsic call.
 *  - callKind 'user'  → `(call $callee arg0 arg1 ...)`
 *  - callKind 'instr' → args are pushed then `callee` instruction emitted inline
 */
export interface IRCall {
    kind: 'Call'
    wasmType: WasmType
    callee: string
    callKind: 'user' | 'instr'
    args: IRExpr[]
}

/** Block expression: zero or more statements then an optional trailing value. */
export interface IRBlock {
    kind: 'Block'
    wasmType: WasmType
    stmts: IRStmt[]
    trailing?: IRExpr
}

/**
 * If/then/else expression. When `wasmType` is not 'void', both branches must be
 * present and the emitter wraps them in `(if (result <type>) ...)`.
 */
export interface IRIf {
    kind: 'If'
    wasmType: WasmType
    cond: IRExpr
    then: IRExpr
    else_?: IRExpr
}

/**
 * While-style loop. Emits:
 *   (block $brk_N (loop $cont_N (br_if $brk_N (i32.eqz cond)) body (br $cont_N)))
 */
export interface IRLoop {
    kind: 'Loop'
    id: number
    cond: IRExpr
    body: IRExpr
}

/** Branch to the enclosing loop's exit label ($brk_N). */
export interface IRBreak    { kind: 'Break';    id: number }
/** Branch to the enclosing loop's header label ($cont_N). */
export interface IRContinue { kind: 'Continue'; id: number }
/** Explicit `return` from the current function. */
export interface IRReturn   { kind: 'Return';   value?: IRExpr }

/** No-op placeholder for nodes that produce no WAT (type declarations, etc.). */
export interface IRNop { kind: 'Nop' }

/** WAT unreachable — bottom type, used as the else-arm of exhaustive match. */
export interface IRUnreachable { kind: 'Unreachable' }

/**
 * Indirect call through a `funcref` table slot.  Phase 5 Workstream B
 * — first-class function values.  `tableIndex` is the i32 slot in the
 * module's funcref table (typically obtained via `@fnref name`);
 * `sigKey` names the function-type entry the call must match.  Args
 * are passed in source order; the table index is emitted last in WAT
 * per the call_indirect convention.
 */
export interface IRCallIndirect {
    kind: 'CallIndirect'
    wasmType: WasmType
    sigKey: string
    args: IRExpr[]
    tableIndex: IRExpr
}

export type IRExpr =
    | IRConst | IRLocalGet | IRGlobalGet | IRBinOp | IRCall | IRCallIndirect
    | IRBlock | IRIf | IRLoop | IRBreak | IRContinue | IRReturn | IRNop | IRUnreachable

// ---------------------------------------------------------------------------
// Statement IR nodes (produce no stack value)
// ---------------------------------------------------------------------------

export interface IRLocalSet  { kind: 'LocalSet';  name: string; value: IRExpr }
export interface IRGlobalSet { kind: 'GlobalSet'; name: string; value: IRExpr }
/** A statement-position expression (result discarded). */
export interface IRExprStmt  { kind: 'ExprStmt';  expr: IRExpr }

export type IRStmt = IRLocalSet | IRGlobalSet | IRExprStmt

// ---------------------------------------------------------------------------
// Module-level IR nodes
// ---------------------------------------------------------------------------

export interface IRParam { name: string; wasmType: WasmValType }
export interface IRLocal { name: string; wasmType: WasmValType }

export interface IRFunction {
    kind: 'Function'
    name: string
    params: IRParam[]
    returnType: WasmType
    /** @local variable declarations (hoisted to function preamble). */
    locals: IRLocal[]
    /** The function body, if any. Absent for @extern. */
    body?: IRExpr
}

export interface IRGlobal {
    kind: 'Global'
    name: string
    wasmType: WasmValType
    mutable: boolean
    init: IRExpr
}

export interface IRImport {
    kind: 'Import'
    env: string
    field: string
    name: string
    params: WasmValType[]
    result?: WasmValType
}

export interface IRDataSegment {
    offset: number
    /** WAT-escaped byte string (e.g. "hello\00"). */
    encoded: string
}

/** Export declaration emitted from an @export strata call. */
export interface IRExport {
    kind: 'Export'
    alias: string        // external name (what consumers see)
    internalName: string // WAT $name (internal identifier)
    what: 'func' | 'global'
}

/** Per-module funcref-table state — Phase 5 Workstream B (first-class
 *  functions).  Populated by `@fnref name` strata; consumed by the
 *  WAT / binary emitters to emit (table funcref), (type ...), and
 *  (elem ...) declarations.  Undefined / empty when no funcref is
 *  used, so non-funcref programs emit identical bytes as before. */
export interface FuncrefTable {
    /** Function names tagged for inclusion in the table, in slot order
     *  (entries[i] is at table slot i). */
    entries: string[]
    /** Distinct function signatures used by call_indirect sites, keyed
     *  by `sigKey` (e.g. '__fn_i_i').  The order is the type-section
     *  index — `signatures[0]` is type index 0 in the (type) section.
     *  This is module-level state shared by every call_indirect site
     *  in the module. */
    signatures: Array<{ key: string; params: WasmValType[]; result: WasmType }>
}

export interface IRModule {
    kind: 'Module'
    imports: IRImport[]
    globals: IRGlobal[]
    functions: IRFunction[]
    dataSegments: IRDataSegment[]
    /** Exports emitted from @export declarations. */
    exports: IRExport[]
    /** Funcref + call_indirect machinery.  Undefined for non-funcref
     *  programs (keeps the byte-equal codegen test passing). */
    funcrefTable?: FuncrefTable
    /** Phase 9d-2 — WasmGC struct/array type declarations emitted in
     *  the type section after the function types.  Populated by
     *  Phase 9d-3's collection pass when `--target=wasm-gc`; undefined
     *  or empty for `--target=wasm-mvp` (keeps byte-equal codegen). */
    wasmGcTypes?: WasmGcType[]
}

// ─── Phase 9d-2 — WasmGC type-section registry ─────────────────────────────
//
// Mirrors the bytecode-emit contract in `wit/wasm-gc.wit`.  v1.0 emits
// `(struct (field …))` and `(array (mut …))` directly — no `sub` /
// `sub final` wrappers, no `rec` groups.  Subtype hierarchy is a v1.1
// optimization (story 9.1-d-1 in v1.1-user-stories.html).

/** Packed and value storage types valid as struct fields or array
 *  elements in the WasmGC type section.  Packed types (`i8`, `i16`)
 *  are only legal inside struct/array declarations — never as wasm
 *  value types on the operand stack. */
export type WasmGcStorageType =
    | { kind: 'val';    type: WasmValType }       // i32 | i64 | f32
    | { kind: 'packed'; type: 'i8' | 'i16' }      // struct/array only
    | { kind: 'ref';    typeIdx: number; nullable: boolean }  // (ref $T) / (ref null $T)

/** A struct or array field declaration: storage type + mutability bit. */
export interface WasmGcField {
    storage: WasmGcStorageType
    mutable: boolean
}

/** WasmGC type declaration.  `name` is a Sigil-side debug label
 *  (e.g. `$Point`, `$Array_i32`); the binary emit assigns its type
 *  index by position in `IRModule.wasmGcTypes`. */
export interface WasmGcType {
    name: string
    spec:
        | { kind: 'struct'; fields: WasmGcField[] }
        | { kind: 'array';  element: WasmGcField }
}

/** Structural key for a WasmGcType — two declarations with identical
 *  spec produce the same key and dedup to the same type-section entry
 *  even if they have different Sigil-side names. */
export function wasmGcTypeKey(t: WasmGcType): string {
    if (t.spec.kind === 'struct') {
        return 's:' + t.spec.fields.map(wasmGcFieldKey).join(',')
    }
    return 'a:' + wasmGcFieldKey(t.spec.element)
}

function wasmGcFieldKey(f: WasmGcField): string {
    const mut = f.mutable ? 'm' : 'i'
    const s = f.storage
    switch (s.kind) {
        case 'val':    return `${mut}${s.type}`
        case 'packed': return `${mut}${s.type}`
        case 'ref':    return `${mut}r${s.nullable ? '?' : ''}${s.typeIdx}`
    }
}

/** Stateful interner that builds up an `IRModule.wasmGcTypes` array
 *  while collecting types from the typed AST.  Returns the type index
 *  of `spec` — either freshly added (with the supplied `name`) or
 *  re-used from a previous structurally-identical entry. */
export class WasmGcTypeRegistry {
    private readonly types: WasmGcType[] = []
    private readonly byKey: Map<string, number> = new Map()

    intern(t: WasmGcType): number {
        const key = wasmGcTypeKey(t)
        const existing = this.byKey.get(key)
        if (existing !== undefined) return existing
        const idx = this.types.length
        this.types.push(t)
        this.byKey.set(key, idx)
        return idx
    }

    /** Position-stable snapshot of every interned type. */
    snapshot(): WasmGcType[] { return [...this.types] }

    size(): number { return this.types.length }
}

/** Sentinel callee name for array-literal IR nodes, shared between lower.ts and emit.ts. */
export const ARRAY_LITERAL_CALLEE = '__array_literal'
