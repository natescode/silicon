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
export type WasmValType = 'i32' | 'f32'
export type WasmType = WasmValType | 'void'

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
 * Binary operation. `instr` is the exact WAT instruction string (e.g. 'f32.add').
 * The wasmType is the RESULT type — for comparison ops this is 'i32' even when
 * operands are 'f32'.
 */
export interface IRBinOp {
    kind: 'BinOp'
    wasmType: WasmValType
    instr: string
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

export type IRExpr =
    | IRConst | IRLocalGet | IRGlobalGet | IRBinOp | IRCall
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

export interface IRModule {
    kind: 'Module'
    imports: IRImport[]
    globals: IRGlobal[]
    functions: IRFunction[]
    dataSegments: IRDataSegment[]
}
