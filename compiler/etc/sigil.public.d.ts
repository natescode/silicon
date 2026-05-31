/**
 * Backend-agnostic binary operation opcode.  Names match the keys in
 * `wasmIntrinsics` (underscore convention: `i32_add`, `i64_lt_s`, …).
 * The WAT emitter converts these to WAT instruction strings via the
 * intrinsics registry; the QBE emitter maps them to QBE mnemonics.
 * IRCall.callee remains a WAT string for memory/control/unary ops.
 */
declare type AbstractOp = 'i32_add' | 'i32_sub' | 'i32_mul' | 'i32_div_s' | 'i32_div_u' | 'i32_rem_s' | 'i32_rem_u' | 'i32_and' | 'i32_or' | 'i32_xor' | 'i32_shl' | 'i32_shr_s' | 'i32_shr_u' | 'i32_rotl' | 'i32_rotr' | 'i32_eq' | 'i32_ne' | 'i32_lt_s' | 'i32_gt_s' | 'i32_le_s' | 'i32_ge_s' | 'i32_lt_u' | 'i32_gt_u' | 'i32_le_u' | 'i32_ge_u' | 'i64_add' | 'i64_sub' | 'i64_mul' | 'i64_div_s' | 'i64_div_u' | 'i64_rem_s' | 'i64_rem_u' | 'i64_and' | 'i64_or' | 'i64_xor' | 'i64_shl' | 'i64_shr_s' | 'i64_shr_u' | 'i64_eq' | 'i64_ne' | 'i64_lt_s' | 'i64_gt_s' | 'i64_le_s' | 'i64_ge_s' | 'i64_lt_u' | 'i64_gt_u' | 'i64_le_u' | 'i64_ge_u' | 'f32_add' | 'f32_sub' | 'f32_mul' | 'f32_div' | 'f32_eq' | 'f32_ne' | 'f32_lt' | 'f32_gt' | 'f32_le' | 'f32_ge';

declare interface ArrayLiteral {
    type: 'ArrayLiteral';
    elements: ExpressionStart[];
    sourceLocation?: SourceLocation;
}

declare interface Assignment {
    type: 'Assignment';
    target: Namespace;
    value: ExpressionStart;
    sourceLocation?: SourceLocation;
}

/**
 * Abstract Syntax Tree Node Definitions
 *
 * This module defines all the TypeScript interfaces and types that make up the
 * Silicon Abstract Syntax Tree (AST). The AST is a strongly-typed representation
 * of Silicon programs that preserves semantic information.
 *
 * Design decisions:
 * - All nodes have a discriminating `type` field for safe pattern matching
 * - Complex nodes use a `kind` field to distinguish between variants
 * - Optional `sourceLocation` for error reporting and debugging
 * - Factory functions (ASTFactory) ensure consistent node creation
 *
 * @see toAst.ts  - Converts parse trees to AST nodes
 * @see lower.ts  - Lowers typed AST nodes to IR
 */
declare type ASTNode = Program | Element_2 | Item | Statement | Assignment | Definition | ExpressionStart | BinOp | FunctionCall | ExpressionEnd | Literal | ArrayLiteral | ObjectLiteral | TupleLiteral | StringLiteral | IntLiteral | FloatLiteral | BooleanLiteral | KeyValuePair | Block | Binding | Namespace | TypeAnnotation | Parameter | GenericParams | DocComment;

declare interface Binding {
    type: 'Binding';
    expression: ASTNode;
    sourceLocation?: SourceLocation;
}

declare interface BinOp {
    type: 'BinaryOp';
    left: ExpressionStart;
    operator: string;
    right: ExpressionEnd;
    sourceLocation?: SourceLocation;
    semantics?: any;
    readonly inferredType?: any;
}

declare interface Block {
    type: 'Block';
    items: Item[];
    trailing?: ExpressionStart;
    sourceLocation?: SourceLocation;
}

declare interface BooleanLiteral {
    type: 'BooleanLiteral';
    value: boolean;
    sourceLocation?: SourceLocation;
}

/**
 * Build the strata registry from the tree's @stratum_* declarations.
 * Call this after parse() and before elaborate().
 */
export declare function buildRegistry(tree: SyntaxTree, extraSources?: string[]): ElaboratorRegistry;

/** A definition site — a name introduced by @let, @fn, @type, @var, etc. */
export declare interface CaaSSymbol {
    readonly name: string;
    readonly kind: SymbolKind;
    readonly definitionNode: object;
    readonly type: SiliconType | undefined;
    /** Source span of the definition's name identifier, if location info is available. */
    readonly definitionSpan?: SourceSpan;
}

export declare type ChangeListener = (event: DocumentChangeEvent) => void;

export declare interface CheckOptions {
    /**
     * Module registry built from `loadModules()`.  When provided, module
     * function signatures (e.g. `wasi_snapshot_preview1::fd_write`) are
     * pre-registered so call sites type-check correctly.
     */
    moduleRegistry?: ModuleRegistry;
}

export declare interface CheckResult {
    readonly tree: SyntaxTree;
    readonly model: SemanticModel;
    readonly diagnostics: readonly Diagnostic[];
    /* Excluded from this release type: _functions */
}

/**
 * Def-Kind Registry
 *
 * Def-Kinds categorize definition keywords (@let, @fn, @type, etc.) and describe
 * how the compiler should elaborate and lower them. Built-in Def-Kinds are
 * registered here; user-defined ones will use the same mechanism.
 *
 * Per the Silicon spec: "Built-in Def-Kinds are implemented using the same
 * mechanism as user-defined ones. There are no 'magic' keywords in the compiler."
 */
/**
 * What WAT construct a definition keyword lowers to.
 * 'function' → WAT (func ...), 'global' → WAT (global ...) mutable global.
 */
declare type CodegenKind = 'function' | 'global' | 'local' | 'extern' | 'type_alias' | 'type_distinct' | 'type_sum' | 'type_record' | 'export' | 'platform' | 'stratum_def';

/**
 * Full pipeline: parse → elaborate → typecheck → lower.
 *
 * Returns at the first phase that produces diagnostics (errors).
 * On success, `wat` holds the emitted WAT text.
 */
export declare function compile(source: string, options?: ParseOptions & ElabOptions & LowerOptions2): CompileResult;

declare interface CompilerAPI {
    /** Structured access to the mutable lowering context. */
    readonly ctx: CompilerCtx;
    /** IR node constructors — build typed IR without writing object literals. */
    readonly ir: IRBuilders;
    /** Types as first-class values (§5.4). */
    readonly type: CompilerTypes;
    /** AST read + synthesis (§5.3 / §5.5). */
    readonly ast: CompilerAst;
    /** Module mutation — emit new top-level items (§5.6). */
    readonly module: CompilerModule;
    /** Structured diagnostics — T-5 runtime-trap model (§6). */
    readonly diag: CompilerDiag;
    /** Check whether an annotation token is present on an AST node (§5.3). */
    ann_present(node: any, token: string): boolean;
    /** Return the argument list of an annotation node (§5.3). */
    ann_args(annNode: any): any[];
    /** Access per-stratum or per-invocation state bucket (§5.7). */
    state(scope: 'stratum' | 'instance'): StateHandle;
    /** Inspect a call site's callee (§5 spec — `&Compiler::callee::*`). */
    readonly callee: {
        name(callNode: any): string;
    };
    /** Look up a comptime handler registered for an operator/keyword token.
     *  Used by the strata body interpreter to dispatch built-in forms
     *  (`@nil`, `@not`, `+`, `==`, etc.) and any user-defined comptime
     *  semantics registered via `on::comptime`.  Returns undefined if no
     *  handler is registered for the token. */
    lookupComptime(token: string): ComptimeHandler | undefined;
    resolveType(annotation: any): WasmValType;
    resolveTypeName(name: string): WasmValType;
    resolveExprType(expr: IRExpr): WasmType;
    isVarName(name: string): boolean;
    lowerExpr(node: any): IRExpr;
    lowerBlock(node: any): IRBlock;
    lowerParam(param: any): IRParam | null;
    lowerParams(node: any): IRParam[];
    lowerFunctionBody(node: any, params: IRParam[]): {
        body: IRExpr | undefined;
        locals: IRLocal[];
    };
    resolveFunctionReturnType(node: any, name: string, body?: IRExpr): WasmType;
    lowerGlobalInit(node: any, defaultType: WasmValType): {
        init: IRExpr;
        wasmType: WasmValType;
    };
    lowerExternParams(node: any): WasmValType[];
    lowerExternResult(node: any): WasmValType | undefined;
    unwrapNode(node: any): any;
    watId(name: string): string;
    freshId(prefix?: string): string;
    resolveIntrinsic(name: string): string | undefined;
    choose<T>(cond: any, ifTrue: T, ifFalse: T): T;
    arg(node: any, index: number): any;
    lowerExprIfDefined(node: any): IRExpr | undefined;
    assertDefined(value: any, msg: string): void;
    error(msg: string, node?: any): never;
    expandMatchChain(rawArgs: any[], inferredType: any): IRExpr;
}

/** AST read + synthesis namespace (§5.3 / §5.5 of the Strata 2.0 spec). */
declare interface CompilerAst {
    children(node: any): any[];
    span(node: any): {
        file: string;
        line: number;
        col: number;
        length: number;
    };
    doc(node: any): string;
    capture_template(node: any, kind: 'pre' | 'post'): TemplateHandle;
    clone(handle: TemplateHandle): TemplateHandle;
    substitute(handle: TemplateHandle, bindings: Record<string, any>): TemplateHandle;
    re_elaborate(handle: TemplateHandle): any;
    patch_types(handle: TemplateHandle, bindings: Map<string, SiliconType>): TemplateHandle;
    /** Return a new template with the root Definition's keyword replaced and
     *  re-stamped with the codegen hook implied by the new keyword. Used to
     *  convert a captured @generic template into an @fn (or any other) def
     *  before pushing it via module::push_definition. */
    with_keyword(handle: TemplateHandle, keyword: string): TemplateHandle;
    /** Return a new template with the root Definition's name replaced. Used
     *  by monomorphization to mangle generated instances (e.g. identity → identity$Int). */
    with_name(handle: TemplateHandle, name: string): TemplateHandle;
    /** Mutate a FunctionCall node so the lowerer resolves the call to `newName`
     *  instead of its original callee.  Used at on::call_site to redirect a
     *  generic call to its monomorph (e.g. id → id$Int). */
    rewrite_call(callNode: any, newName: string): void;
}

declare interface CompilerCtx {
    locals: {
        get(name: string): WasmValType | undefined;
        set(name: string, type: WasmValType): void;
    };
    globals: {
        get(name: string): WasmValType | undefined;
        set(name: string, type: WasmValType): void;
    };
    varNames: {
        has(name: string): boolean;
        add(name: string): void;
    };
    pendingLocals: {
        push(local: IRLocal): void;
    };
    loopStack: {
        push(id: number): void;
        pop(): number | undefined;
        peek(): number | undefined;
    };
    /** Phase 4: per-function deferred cleanup expressions. */
    deferStack: {
        push(expr: IRExpr): void;
        drain(): IRExpr[];
        length(): number;
    };
    /** Allocate the next monotonic loop/block ID. */
    nextLoopId(): number;
    functionSigs: {
        get(name: string): FunctionSig | undefined;
    };
    moduleRegistry?: ModuleRegistry;
    structTypes: {
        set(name: string, layout: StructLayout): void;
        get(name: string): StructLayout | undefined;
        has(name: string): boolean;
    };
}

/** Structured diagnostics namespace — T-5 runtime-trap model (§6). */
declare interface CompilerDiag {
    error(code: string, span: any, message: string, hint?: string): void;
    warn(code: string, span: any, message: string, hint?: string): void;
}

export declare interface CompileResult {
    readonly wat: string;
    readonly model: SemanticModel | undefined;
    readonly diagnostics: readonly Diagnostic[];
}

/** Module mutation namespace (§5.6 of the Strata 2.0 spec). */
declare interface CompilerModule {
    push_definition(def: any): void;
    push_global(name: string, type: SiliconType, init: any): void;
}

/** Types-as-data namespace (§5.4 of the Strata 2.0 spec). */
declare interface CompilerTypes {
    readonly int: SiliconType;
    readonly int64: SiliconType;
    readonly float: SiliconType;
    readonly bool: SiliconType;
    readonly string: SiliconType;
    readonly void: SiliconType;
    array(elem: SiliconType): SiliconType;
    function(params: SiliconType[], result: SiliconType): SiliconType;
    variable(name: string): SiliconType;
    equals(a: SiliconType, b: SiliconType): boolean;
    infer_args(callNode: any): SiliconType[];
    substitute(tmpl: SiliconType, bindings: Map<string, SiliconType>): SiliconType;
    format(t: SiliconType): string;
    /** Given a generic template Definition node and a concrete call site, return
     *  a Map of type-variable bindings (e.g. T → Int) suitable for ast::patch_types.
     *  Type variables are identified as parameter type annotations whose name is
     *  not a built-in Silicon type (Int, Int64, Float, Bool, String, Void).
     *  The corresponding concrete type is inferred from each call argument. */
    bind_template_args(tmplDef: any, callNode: any): Map<string, SiliconType>;
    /** Human-readable suffix for monomorph mangling: bind_template_args(...) → "Int_Float". */
    mangle_suffix(bindings: Map<string, SiliconType>): string;
}

/**
 * A comptime handler — the function invoked when the strata body interpreter
 * encounters a registered keyword/operator in expression position.  Unlike
 * lowering handlers (which build IR), a comptime handler returns a JS-level
 * value: the result of evaluating the form at compile time.
 *
 * Receives raw AST args (unevaluated) plus an `evalArg` callback so the
 * handler can decide which args to evaluate and in what order.  This is
 * what makes lazy forms like `@if` expressible.
 */
declare type ComptimeHandler = (rawArgs: any[], api: any, evalArg: (node: any) => any) => any;

declare interface Definition {
    type: 'Definition';
    keyword: string;
    name: TypedIdentifier;
    generics?: GenericParams;
    params: Parameter[];
    binding?: Binding;
    sourceLocation?: SourceLocation;
    readonly hook?: string | false;
}

declare interface DefKindEntry {
    keyword: string;
    codegenKind: CodegenKind;
    allowsParams: boolean;
    allowsBinding: boolean;
    allowsGenerics: boolean;
}

declare type DefKindRegistry = Record<string, DefKindEntry>;

export declare interface Diagnostic {
    /** Pipeline phase that produced the diagnostic. */
    phase: Phase;
    /** Stable identifier (E0001 …).  Matched by tests; never reuse a number. */
    code: string;
    /** Where in source the diagnostic points.  May be a point span. */
    span: SourceSpan;
    /** Short human-readable message.  No leading "Error:" — render layer adds. */
    message: string;
    /** Optional secondary advice ("did you mean …", "available choices: …"). */
    hint?: string;
    /** Optional related notes — already-formatted Diagnostic records. */
    notes?: Diagnostic[];
    /**
     * Optional verbatim source line for caret rendering.  When present,
     * `renderPretty` will emit the snippet and a `^` underline below the
     * message, Rust-style.  Set by the pipeline at the point closest to the
     * source text (parser or semantic model lookup).
     */
    snippet?: string;
}

declare interface DocComment {
    type: 'DocComment';
    content: string;
    sourceLocation?: SourceLocation;
}

/** The full compiled state of one source file in a Workspace. */
declare interface Document_2 {
    /** URI / path used as the key in the Workspace. */
    readonly uri: string;
    /** Current source text. */
    readonly source: string;
    /** Monotonically increasing edit counter. Starts at 1. */
    readonly version: number;
    /** Parse-phase output. */
    readonly tree: SyntaxTree;
    /** Elaborate-phase output. */
    readonly elabTree: SyntaxTree;
    /** Typecheck-phase output; queryable semantic overlay. */
    readonly model: SemanticModel;
    /** All diagnostics from every phase, in pipeline order. */
    readonly diagnostics: readonly Diagnostic[];
}
export { Document_2 as Document }

export declare interface DocumentChangeEvent {
    readonly kind: 'opened' | 'changed' | 'closed';
    readonly uri: string;
    /** The new document state (undefined when kind === 'closed'). */
    readonly document: Document_2 | undefined;
}

export declare interface ElabOptions {
    /** Extra Silicon source strings whose strata definitions are merged in. */
    extraSources?: string[];
}

/**
 * Elaborate a parsed tree — resolves operators and keywords via the strata
 * registry.  Returns a new SyntaxTree with the elaborated program.
 *
 * Never throws. Elaboration errors are captured as Diagnostic records with
 * phase='elaborate'.
 */
export declare function elaborate(tree: SyntaxTree, registry: ElaboratorRegistry, _options?: ElabOptions): ElabResult;

/**
 * Central registry mapping operator/keyword symbols to StrataNode semantics
 * and definition keywords to Def-Kind descriptors.
 *
 * Strata 2.0 additions: per-phase handler maps, annotation registry,
 * stratum metadata, pending definitions from module::push_definition, and
 * an accumulated diagnostics list (runtime-trap model, T-5).
 */
export declare interface ElaboratorRegistry {
    operators: Record<string, StrataNode>;
    keywords: Record<string, StrataNode>;
    /** Annotation token → StrataNode (Strata 2.0 §5.1). */
    annotations: Record<string, StrataNode>;
    defKinds: DefKindRegistry;
    /** Intrinsic name → IR expander fn. */
    expanders: Map<string, IRExpanderFn>;
    /** CodegenKind → IR definition expander. */
    defExpanders: Map<string, IRDefExpander>;
    handlers: {
        /** Fires for each Definition node with keyword matching the registered token. */
        decl: Map<string, PhaseHandler[]>;
        /** Fires for each call-site expression matching the registered keyword token. */
        callSite: Map<string, PhaseHandler[]>;
        /** Fires when an annotation token is applied to a Definition. Second arg is the target def. */
        annotation: Map<string, PhaseHandler[]>;
        /** Fires during IR lowering for the registered keyword/operator token. */
        lower: Map<string, PhaseHandler[]>;
        /** Fires once at end of module walk — no token discrimination. */
        moduleFinalize: PhaseHandler[];
        /** Compile-time evaluation: token (operator or keyword) → handler.
         *  Single handler per token — comptime semantics is unambiguous by
         *  construction (unlike `on::lower` which can be observed). */
        comptime: Map<string, ComptimeHandler>;
    };
    /** stratum name → StratumMeta (tier, ordering). */
    strata: Map<string, StratumMeta>;
    /** Definitions emitted by module::push_definition, appended to the module. */
    pendingDefinitions: any[];
    /** Diagnostics accumulated by diag::error / diag::warn (never throws). */
    diagnostics: Diagnostic[];
    stratumState: Map<string, Map<string, any>>;
    structTypes: Map<string, StructLayout>;
    /** `@fn` body blocks keyed by function name.  Populated by a pre-pass
     *  over program elements so that strata handlers referencing `@fn` by
     *  name can find the body at fire time, regardless of source order.
     *  `paramName` is the @fn's first parameter name (typically 'node') so
     *  the body sees the triggering AST under the binding the author wrote.
     *
     *  Phase A bridge: the body is still interpreted via compileHandlerBlock.
     *  Phase C will swap interpretation for compile-then-run.  Either way,
     *  this map is the lookup point. */
    namedHandlers: Map<string, {
        body: any;
        paramName: string;
    }>;
    /** Names of `@fn`s that have been claimed as strata handlers.  Those
     *  bodies use `&Compiler::*` calls that have no runtime meaning, so
     *  the lowerer skips them — they exist only at compile-time as
     *  interpreted handler bodies.  Phase C will lower them as real WASM
     *  functions invoked through a comptime engine. */
    strataHandlerFnNames: Set<string>;
    /** Phase C compiled-handler cache.  Populated by an opt-in async
     *  pre-compile pass (`compileStrataHandlers`).  When a handler fires,
     *  the wrapper checks this map first: if a compiled instance exists,
     *  it invokes the WASM function; otherwise it falls back to the
     *  interpreter.  Bridge pattern — both paths coexist until Phase D
     *  finishes migrating every strata to the compiled path. */
    compiledHandlers: Map<string, {
        invoke: (arg: number) => number;
    }>;
}

export declare interface ElabResult {
    readonly tree: SyntaxTree;
    readonly registry: ElaboratorRegistry;
    readonly diagnostics: readonly Diagnostic[];
}

declare interface Element_2 {
    type: 'Element';
    kind: 'item' | 'docComment';
    value: Item | DocComment;
    sourceLocation?: SourceLocation;
}

declare interface ExpressionEnd {
    type: 'ExpressionEnd';
    kind: 'literal' | 'namespace' | 'block' | 'paren' | 'variantDecl';
    value: Literal | Namespace | Block | ExpressionStart | VariantDecl;
    sourceLocation?: SourceLocation;
    readonly inferredType?: any;
}

declare interface ExpressionStart {
    type: 'ExpressionStart';
    kind: 'binOp' | 'functionCall' | 'expressionEnd';
    value: BinOp | FunctionCall | ExpressionEnd;
    sourceLocation?: SourceLocation;
    readonly inferredType?: any;
}

declare interface FloatLiteral {
    type: 'FloatLiteral';
    value: string;
    sourceLocation?: SourceLocation;
}

declare interface FnSig {
    params: WasmValType[];
    result?: WasmValType;
    siliconParams: string[];
    siliconResult?: string;
}

declare interface FunctionCall {
    type: 'FunctionCall';
    name: string | Namespace;
    isBuiltin: boolean;
    args: ExpressionStart[];
    sourceLocation?: SourceLocation;
    readonly inferredType?: any;
}

declare interface FunctionSig {
    params: SiliconType[];
    result: SiliconType;
}

declare interface GenericParams {
    type: 'GenericParams';
    params: string[];
    sourceLocation?: SourceLocation;
}

declare interface IntLiteral {
    type: 'IntLiteral';
    value: string;
    base: 'decimal' | 'binary' | 'hexadecimal' | 'octal';
    sourceLocation?: SourceLocation;
}

/**
 * Binary operation.  `op` is a backend-agnostic `AbstractOp` opcode — NOT a
 * WAT instruction string.  The WAT emitter maps it to the WAT instruction via
 * the intrinsics registry; the QBE emitter maps it to a QBE mnemonic.
 * The wasmType is the RESULT type — for comparison ops this is 'i32' even when
 * operands are 'f32'.
 */
declare interface IRBinOp {
    kind: 'BinOp';
    wasmType: WasmValType;
    op: AbstractOp;
    left: IRExpr;
    right: IRExpr;
}

/** Block expression: zero or more statements then an optional trailing value. */
declare interface IRBlock {
    kind: 'Block';
    wasmType: WasmType;
    stmts: IRStmt[];
    trailing?: IRExpr;
}

/** Branch to the enclosing loop's exit label ($brk_N). */
declare interface IRBreak {
    kind: 'Break';
    id: number;
}

declare interface IRBuilders {
    makeConst(value: number, wasmType: WasmValType): IRConst;
    makeLocalGet(name: string, wasmType: WasmValType): IRLocalGet;
    makeLocalSet(name: string, value: IRExpr): IRLocalSet;
    makeGlobalGet(name: string, wasmType: WasmValType): IRGlobalGet;
    makeGlobalSet(name: string, value: IRExpr): IRGlobalSet;
    makeBinOp(op: AbstractOp, left: IRExpr, right: IRExpr, wasmType: WasmValType): IRBinOp;
    makeCall(callee: string, args: IRExpr[], wasmType: WasmType, callKind?: 'user' | 'instr'): IRCall;
    makeBlock(stmts: IRStmt[], trailing?: IRExpr, wasmType?: WasmType): IRBlock;
    makeIf(cond: IRExpr, then: IRExpr, else_?: IRExpr, wasmType?: WasmType): IRIf;
    makeLoop(id: number, cond: IRExpr, body: IRExpr): IRLoop;
    makeBreak(id: number): IRBreak;
    makeContinue(id: number): IRContinue;
    makeReturn(value?: IRExpr): IRReturn;
    makeNop(): IRNop;
    makeUnreachable(): IRUnreachable;
    makeExport(alias: string, internalName: string, what: 'func' | 'global'): IRExport;
    makeGlobal(name: string, wasmType: WasmValType, mutable: boolean, init: IRExpr): IRGlobal;
    makeFunction(name: string, params: IRParam[], returnType: WasmType, locals: IRLocal[], body?: IRExpr): IRFunction;
    makeImport(env: string, field: string, name: string, params: WasmValType[], result?: WasmValType): IRImport;
    /** Build an IRLocal value (used by pendingLocals.push for @local hoisting). */
    makeLocal(name: string, wasmType: WasmValType): IRLocal;
    /** Explicit no-op lowering result — return from a def expander that emits nothing. */
    null(): null;
}

/**
 * Function/intrinsic call.
 *  - callKind 'user'  → `(call $callee arg0 arg1 ...)`
 *  - callKind 'instr' → args are pushed then `callee` instruction emitted inline
 */
declare interface IRCall {
    kind: 'Call';
    wasmType: WasmType;
    callee: string;
    callKind: 'user' | 'instr';
    args: IRExpr[];
}

/**
 * Indirect call through a `funcref` table slot.  Phase 5 Workstream B
 * — first-class function values.  `tableIndex` is the i32 slot in the
 * module's funcref table (typically obtained via `@fnref name`);
 * `sigKey` names the function-type entry the call must match.  Args
 * are passed in source order; the table index is emitted last in WAT
 * per the call_indirect convention.
 */
declare interface IRCallIndirect {
    kind: 'CallIndirect';
    wasmType: WasmType;
    sigKey: string;
    args: IRExpr[];
    tableIndex: IRExpr;
}

/** Literal constant. wasmType is always 'i32' or 'f32'. */
declare interface IRConst {
    kind: 'Const';
    wasmType: WasmValType;
    value: number;
}

/** Branch to the enclosing loop's header label ($cont_N). */
declare interface IRContinue {
    kind: 'Continue';
    id: number;
}

declare interface IRDefExpander {
    preScan?: (def: any, api: CompilerAPI) => void;
    expand: (def: any, name: string, api: CompilerAPI) => IRDefResult;
    postExpand?: (api: CompilerAPI) => IRDefResult | void;
}

/**
 * IR Definition Expander — pluggable lowering hook for definition keywords.
 *
 * Keyed by CodegenKind (e.g. 'type_sum'). Registered into the ElaboratorRegistry
 * so that `lowerDefinition` in lower.ts dispatches to the expander instead of
 * a hardcoded switch case. This makes definition kinds Strata-extensible: adding
 * a new @type_* or @def_* keyword requires only a new strata entry + a registered
 * IRDefExpander, with no changes to lower.ts.
 *
 * Three-phase protocol:
 *   preScan    — optional; runs before the main lowering pass so the expander
 *                can register globals/functions via api.ctx for forward-ref resolution.
 *   expand     — main lowering; returns the IR node(s) to emit into the module
 *                for one definition AST node.
 *   postExpand — optional; runs after all definitions in the module have been
 *                lowered.  Useful for strata that need to emit module-level items
 *                derived from cross-definition state (e.g. an init function that
 *                runs every registered initialiser).  Return type matches expand.
 *
 * Return shapes accepted by lowerProgram:
 *   IRGlobal[] (multiple globals, e.g. sum-type variants)
 *   IRGlobal | IRFunction | IRImport | IRExport (single node)
 *   null / void (no output, e.g. type aliases)
 */
declare type IRDefResult = IRGlobal[] | IRGlobal | IRFunction | IRImport | IRExport | null;

/**
 * IR Expander — pluggable lowering hook for builtin keyword strata.
 *
 * A strata entry whose intrinsic has a registered IRExpanderFn bypasses the
 * generic `lowerBuiltinCall` default path and runs this function instead.
 * This lets new structural keywords (@async, @spawn, …) be added purely as
 * strata entries + expander registrations without touching lower.ts.
 *
 * Parameters:
 *   rawArgs      — un-lowered AST arg nodes; call `api.lowerExpr(node)` on each
 *   api          — CompilerAPI bound to the current lowering context;
 *                  exposes `api.lowerExpr`, `api.ctx`, `api.ir`, etc.
 *   inferredType — SiliconType from the type checker (may be undefined)
 */
declare type IRExpanderFn = (rawArgs: any[], api: CompilerAPI, inferredType?: any) => IRExpr;

/** Export declaration emitted from an @export strata call. */
declare interface IRExport {
    kind: 'Export';
    alias: string;
    internalName: string;
    what: 'func' | 'global';
}

declare type IRExpr = IRConst | IRLocalGet | IRGlobalGet | IRBinOp | IRCall | IRCallIndirect | IRBlock | IRIf | IRLoop | IRBreak | IRContinue | IRReturn | IRNop | IRUnreachable;

/** A statement-position expression (result discarded). */
declare interface IRExprStmt {
    kind: 'ExprStmt';
    expr: IRExpr;
}

declare interface IRFunction {
    kind: 'Function';
    name: string;
    params: IRParam[];
    returnType: WasmType;
    /** @local variable declarations (hoisted to function preamble). */
    locals: IRLocal[];
    /** The function body, if any. Absent for @extern. */
    body?: IRExpr;
}

declare interface IRGlobal {
    kind: 'Global';
    name: string;
    wasmType: WasmValType;
    mutable: boolean;
    init: IRExpr;
}

/** Read a module-level global (@var or sum-type variant). */
declare interface IRGlobalGet {
    kind: 'GlobalGet';
    wasmType: WasmValType;
    name: string;
}

declare interface IRGlobalSet {
    kind: 'GlobalSet';
    name: string;
    value: IRExpr;
}

/**
 * If/then/else expression. When `wasmType` is not 'void', both branches must be
 * present and the emitter wraps them in `(if (result <type>) ...)`.
 */
declare interface IRIf {
    kind: 'If';
    wasmType: WasmType;
    cond: IRExpr;
    then: IRExpr;
    else_?: IRExpr;
}

declare interface IRImport {
    kind: 'Import';
    env: string;
    field: string;
    name: string;
    params: WasmValType[];
    result?: WasmValType;
}

declare interface IRLocal {
    name: string;
    wasmType: WasmValType;
}

/** Read a function parameter or @local variable. */
declare interface IRLocalGet {
    kind: 'LocalGet';
    wasmType: WasmValType;
    name: string;
}

declare interface IRLocalSet {
    kind: 'LocalSet';
    name: string;
    value: IRExpr;
}

/**
 * While-style loop. Emits:
 *   (block $brk_N (loop $cont_N (br_if $brk_N (i32.eqz cond)) body (br $cont_N)))
 */
declare interface IRLoop {
    kind: 'Loop';
    id: number;
    cond: IRExpr;
    body: IRExpr;
}

/** No-op placeholder for nodes that produce no WAT (type declarations, etc.). */
declare interface IRNop {
    kind: 'Nop';
}

declare interface IRParam {
    name: string;
    wasmType: WasmValType;
}

/** Explicit `return` from the current function. */
declare interface IRReturn {
    kind: 'Return';
    value?: IRExpr;
}

declare type IRStmt = IRLocalSet | IRGlobalSet | IRExprStmt;

/** WAT unreachable — bottom type, used as the else-arm of exhaustive match. */
declare interface IRUnreachable {
    kind: 'Unreachable';
}

declare interface Item {
    type: 'Item';
    kind: 'statement' | 'expression';
    value: Statement | ExpressionStart;
    sourceLocation?: SourceLocation;
}

declare interface KeyValuePair {
    type: 'KeyValuePair';
    key: TypedIdentifier;
    value: ExpressionStart;
    sourceLocation?: SourceLocation;
}

declare interface Literal {
    type: 'Literal';
    kind: 'array' | 'object' | 'tuple' | 'string' | 'int' | 'float' | 'boolean';
    value: ArrayLiteral | ObjectLiteral | TupleLiteral | StringLiteral | IntLiteral | FloatLiteral | BooleanLiteral;
    sourceLocation?: SourceLocation;
}

/**
 * Lower a type-checked tree to WAT.
 *
 * Never throws. Lowering errors are captured as Diagnostic records with
 * phase='lower'.
 */
export declare function lower(tree: SyntaxTree, registry: ElaboratorRegistry, model: SemanticModel, options?: LowerOptions2): LowerResult;

declare interface LowerOptions {
    /** Target runtime — controls emit-time conventions (e.g. _start export). */
    target?: LowerTarget;
}

declare interface LowerOptions2 extends LowerOptions {
    /**
     * Module registry — required for programs that use WASI or other
     * registered module APIs.  Build with `loadModules(dir)` in the CLI.
     */
    moduleRegistry?: ModuleRegistry;
    /* Excluded from this release type: _functions */
}

export declare interface LowerResult {
    readonly wat: string;
    readonly diagnostics: readonly Diagnostic[];
}

/**
 * Lower a type-checked Silicon program to an IRModule.
 * The `program` must have been through the type checker so that expression
 * nodes carry `inferredType`.
 */
/** Compilation target. Stage 0's default is the host-embed runner used by
 *  the existing test suite; 'wasix' adds the `_start` export Wasmer-WASIX
 *  invokes by name (bootstrap-plan Phase -1.E). */
declare type LowerTarget = 'host' | 'wasix';

declare interface ModuleEntry {
    name: string;
    kind: 'env' | 'user';
    functions: Map<string, FnSig>;
}

declare type ModuleRegistry = Map<string, ModuleEntry>;

declare interface Namespace {
    type: 'Namespace';
    path: string[];
    sourceLocation?: SourceLocation;
}

declare interface ObjectLiteral {
    type: 'ObjectLiteral';
    properties: KeyValuePair[];
    sourceLocation?: SourceLocation;
}

declare interface Parameter {
    type: 'Parameter';
    name: string;
    typeAnnotation?: TypeAnnotation;
    isLiteral: boolean;
    value?: Literal;
    sourceLocation?: SourceLocation;
}

/**
 * Parse Silicon source into a SyntaxTree.
 *
 * Never throws. Parse failures are captured as Diagnostic records with
 * phase='parse'.
 */
export declare function parse(source: string, options?: ParseOptions): ParseResult;

export declare interface ParseOptions {
    /** Source file name for span reporting. Defaults to '<input>'. */
    file?: string;
}

export declare interface ParseResult {
    readonly tree: SyntaxTree;
    readonly diagnostics: readonly Diagnostic[];
}

export declare type Phase = 'parse' | 'elaborate' | 'typecheck' | 'lower' | 'emit';

/**
 * A compiled handler function. Receives the matching AST node and the live
 * CompilerAPI for the current compilation unit. Returns an IR node or null.
 * Import as `any` to avoid circular dependency with compiler-api.
 */
declare type PhaseHandler = (node: any, api: any) => any;

declare interface Program {
    type: 'Program';
    elements: Element_2[];
    sourceLocation?: SourceLocation;
}

export declare class SemanticModel {
    #private;
    readonly allDiagnostics: readonly Diagnostic[];
    constructor(opts: SemanticModelOpts);
    /** Inferred SiliconType for `node`, or undefined if none was recorded. */
    typeOf(node: object): SiliconType | undefined;
    /**
     * The Symbol that `node` resolves to, if `node` is a Namespace reference
     * or any node whose identity was recorded during typechecking.
     */
    symbolAt(node: object): CaaSSymbol | undefined;
    /** Look up a symbol by its declared name. */
    symbolNamed(name: string): CaaSSymbol | undefined;
    /** All symbols defined in this tree. */
    get allSymbols(): IterableIterator<CaaSSymbol>;
    /** All AST nodes that reference `symbol`. */
    referencesTo(symbol: CaaSSymbol): readonly object[];
    /**
     * All source spans where `symbol` is referenced (call sites, uses).
     * Returns an empty array when location info was not recorded (e.g. in
     * unit-test ASTs built without going through the Ohm parser).
     */
    referenceSpans(symbol: CaaSSymbol): readonly SourceSpan[];
    /**
     * Find the symbol whose definition or a reference occupies `(line, col)`.
     *
     * Searches definition spans first, then all reference spans.  Both are
     * 1-based (matching Ohm's `getLineAndColumn()` output).
     *
     * Returns `undefined` when no span covers the position, or when location
     * info was not recorded (pre-Ohm ASTs in unit tests).
     */
    symbolAtPosition(line: number, col: number): CaaSSymbol | undefined;
    /**
     * All diagnostics whose span overlaps the given source range.
     * Pass `undefined` to get all diagnostics.
     */
    diagnosticsIn(range?: SourceRange): readonly Diagnostic[];
}

declare interface SemanticModelOpts {
    types: WeakMap<object, SiliconType>;
    /** Namespace node → resolved symbol name (for symbolAt). */
    nodeToSymbolName?: WeakMap<object, string>;
    /** Symbol name → Symbol object (for symbolNamed, symbolAt). */
    symbols?: ReadonlyMap<string, CaaSSymbol>;
    /** Symbol name → all reference nodes (for referencesTo). */
    symbolToNodes?: ReadonlyMap<string, readonly object[]>;
    /** Symbol name → source spans of all references (for referenceSpans, symbolAtPosition). */
    symbolToSpans?: ReadonlyMap<string, readonly SourceSpan[]>;
    /** All type-phase diagnostics. */
    diagnostics?: readonly Diagnostic[];
}

/**
 * Silicon Type System — Core Type Definitions
 *
 * Defines the surface-level types that Silicon exposes to programmers, the
 * WebAssembly value types they lower to, and helpers for comparison and
 * formatting.
 *
 * Design:
 * - Tagged union (`SiliconType`) keeps it easy to add parameterised types
 *   (generics, function types, object types) later without breaking existing
 *   pattern matches.
 * - Every surface type maps to a concrete WASM value type (`WasmType`).
 * - Strict equality: two types are equal only when their tag and all payload
 *   fields match. No implicit coercion is applied anywhere in this module.
 *
 * Surface syntax (grammar already supports `identifier : typename`):
 *   Int, Float, String, Bool, Array[T]
 *
 * WASM lowering:
 *   Int    → i32
 *   Float  → f32
 *   Bool   → i32   (0 = false, 1 = true)
 *   String → i32   (pointer into linear memory; length-prefixed)
 *   Array  → i32   (pointer into linear memory; length-prefixed)
 *
 * The pointer-typed values (String, Array) live on the heap and are allocated
 * via helpers in std.wat. See std.wat for the memory layout details.
 */
/**
 * The Silicon surface type. Every expression in a well-typed Silicon program
 * has exactly one SiliconType.
 */
export declare type SiliconType = {
    kind: 'Int';
} | {
    kind: 'Int64';
} | {
    kind: 'Float';
} | {
    kind: 'String';
} | {
    kind: 'Bool';
} | {
    kind: 'UInt8';
} | {
    kind: 'UInt16';
} | {
    kind: 'UInt32';
} | {
    kind: 'UInt64';
} | {
    kind: 'Array';
    element: SiliconType;
} | {
    kind: 'Function';
    params: SiliconType[];
    result: SiliconType;
} | {
    kind: 'Distinct';
    name: string;
    underlying: SiliconType;
} | {
    kind: 'Sum';
    name: string;
    variants: string[];
    typeArgs?: SiliconType[];
} | {
    kind: 'Unknown';
} | {
    kind: 'Void';
} | {
    kind: 'Variable';
    name: string;
};

declare interface SourceLocation {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
}

declare interface SourceLocation_2 {
    start: number;
    end: number;
}

/** A half-open [start, end) line/col range for diagnostic queries. */
export declare interface SourceRange {
    readonly startLine: number;
    readonly startCol: number;
    readonly endLine: number;
    readonly endCol: number;
}

export declare interface SourceSpan {
    /** File the source came from.  Empty string when unknown (synthesised nodes). */
    file: string;
    line: number;
    col: number;
    /** Byte length the diagnostic covers.  0 when the span is a point. */
    length: number;
}

/** Per-stratum or per-invocation mutable state bucket. */
declare interface StateHandle {
    get(key: string): any;
    set(key: string, value: any): this;
    has(key: string): boolean;
    each(fn: (key: string, value: any) => void): void;
}

declare interface Statement {
    type: 'Statement';
    kind: 'assignment' | 'definition';
    value: Assignment | Definition;
    sourceLocation?: SourceLocation;
}

/**
 * Typed payload stored in a StrataNode after the loader has processed
 * the strata body. The raw body AST is NOT stored here — only the derived
 * data that downstream phases (codegen, type checker) actually need.
 */
declare interface StrataData {
    /** The parameter name used to refer to the operator node (e.g. "Node"). */
    nodeParamName: string;
    /** Full WASM intrinsic name extracted from the body (e.g. "WASM::i32_add"). */
    intrinsic?: string;
    /**
     * Ordered steps extracted from the strata body. Each step is either:
     *   - a WASM/IR intrinsic call  ({ intrinsic, argRefs })
     *   - a Silicon function call   ({ userFunc, argRefs })
     *
     * Codegen emits steps in sequence. WASM steps emit inline instructions;
     * userFunc steps emit (call $name args). Steps with no argRefs consume
     * whatever is already on the WAT operand stack.
     */
    bodyTemplate?: Array<{
        intrinsic?: string;
        userFunc?: string;
        argRefs: Array<'left' | 'right' | 'unknown'>;
    }>;
    /**
     * Type signature derived at strata-load time. Populated by the strata loader
     * from the WASM intrinsic name (or, in the future, from an explicit
     * declaration in the strata body). The type checker reads this field directly
     * instead of re-deriving from the intrinsic name on every call.
     */
    typeSignature?: TypeSig;
}

declare interface StrataNode {
    type: StrataType;
    discriminant: string;
    data?: StrataData;
    sourceLocation?: SourceLocation_2;
}

declare enum StrataType {
    Keyword = 0,
    Operator = 1,
    Control = 2,
    /**
     * Definition-kind strata: drive how a definition keyword (@let, @fn, @var,
     * @extern, @type_*) is elaborated and lowered. Not to be confused with
     * code-generation optimisation hooks — that role is reserved for a future
     * StrataType.Codegen variant.
     */
    Definition = 3,
    /** Type-constrained overload of an operator or keyword for a specific operand type. */
    Constraint = 4,
    /**
     * Metadata strata: attach non-value-producing annotations to definitions
     * (@export, @test, @doc). Elaborated by the IR lowerer into module-level
     * directives rather than code-generating constructs.
     */
    Metadata = 5
}

/** Per-stratum metadata for ordering and cycle detection. */
declare interface StratumMeta {
    name: string;
    tier: StratumTier;
    /** Names of strata this one must fire BEFORE. */
    before: string[];
    /** Names of strata this one must fire AFTER. */
    after: string[];
}

/** Tier classification per Strata 2.0 §3. */
declare type StratumTier = 'T0' | 'T1' | 'T2';

declare interface StringLiteral {
    type: 'StringLiteral';
    value: string;
    sourceLocation?: SourceLocation;
}

declare interface StructFieldLayout {
    name: string;
    typeName: string;
    wasmType: 'i32' | 'f32' | 'i64';
    offset: number;
    size: number;
}

declare interface StructLayout {
    name: string;
    fields: StructFieldLayout[];
    size: number;
}

export declare type SymbolKind = 'function' | 'variable' | 'type' | 'parameter' | 'stratum';

/**
 * Immutable wrapper around a parsed Silicon program.
 *
 * Acts as the currency between pipeline stages. The `withText` method
 * re-parses new source without rebuilding the strata registry — the typical
 * incremental-edit path for an LSP or REPL:
 *
 *   const reg = buildRegistry(initialTree)
 *   // ... user edits source ...
 *   const { tree: newTree } = initialTree.withText(editedSource)
 *   const { tree: elab } = elaborate(newTree, reg)   // registry reused
 */
export declare class SyntaxTree {
    /** The underlying AST. Pass this tree between pipeline stages. */
    readonly program: Program;
    /** Original source text this tree was built from. */
    readonly source: string;
    /** File name used for diagnostic spans. */
    readonly file: string;
    constructor(program: Program, source: string, file?: string);
    /**
     * Re-parse `newSource` and return a fresh `ParseResult`.
     *
     * The registry is NOT rebuilt — callers pass the existing registry to
     * `elaborate()` for an incremental update.  Strata definitions added or
     * removed in `newSource` will be invisible until `buildRegistry` is called
     * again, which is acceptable for the common editor-edit path where strata
     * don't change.
     */
    withText(newSource: string, options?: ParseOptions): ParseResult;
}

/** Opaque handle for a captured (and cloneable) AST template. */
declare interface TemplateHandle {
    /** Deep clone of the captured AST subtree. */
    ast: any;
    /** 'pre' = captured before elaboration; 'post' = after. */
    kind: 'pre' | 'post';
}

declare interface TupleLiteral {
    type: 'TupleLiteral';
    elements: ExpressionStart[];
    sourceLocation?: SourceLocation;
}

declare interface TypeAnnotation {
    type: 'TypeAnnotation';
    typename: string;
    /** Generic type arguments, e.g. `:Option[Int]` → typeArgs = [{ name: 'Int' }].
     *  Captured at parse time; interpreted by the @type[T] monomorphization
     *  stratum.  Existing typechecker/lowerer ignore this field — undefined
     *  for non-parameterised type annotations. */
    typeArgs?: TypeArg[];
    /** Phase 5 sigil function-type (`:$fn _:R _:T1, _:T2`).  When present,
     *  `typename === '$fn'` and `typeArgs` is undefined.  The shape mirrors
     *  a function definition: `fnReturn` is the return-type slot (a
     *  typedIdentifier whose name is typically `_`), `fnParams` is the
     *  arg-type slots (each a typedIdentifier).  Empty `fnParams` means
     *  a nullary function (`:$fn _:R`). */
    fnReturn?: TypedIdentifier;
    fnParams?: TypedIdentifier[];
    sourceLocation?: SourceLocation;
}

declare interface TypeArg {
    type: 'TypeArg';
    name: string;
    /** Nested type args for forms like `List[Option[Int]]`. */
    args?: TypeArg[];
}

/**
 * Type-check an elaborated tree.  Returns a SemanticModel with queryable
 * type/symbol information plus any diagnostics.
 *
 * Never throws.
 */
export declare function typecheck(tree: SyntaxTree, registry: ElaboratorRegistry, options?: CheckOptions): CheckResult;

declare interface TypedIdentifier {
    type: 'TypedIdentifier';
    name: string;
    typeAnnotation?: TypeAnnotation;
    sourceLocation?: SourceLocation;
}

/**
 * Type signature for a strata or WASM intrinsic: param types + result type.
 * Identical in shape to FunctionSig in typechecker.ts — kept separate so
 * strataenum.ts can import it without creating a circular dependency.
 */
declare interface TypeSig {
    params: SiliconType[];
    result: SiliconType;
}

/**
 * `$Variant field:Type, ...` — sum-type variant declarator.
 * Appears inside `@type` bindings (and `@match` arm patterns).  The `$`
 * prefix marks it as a data-shape declarator, distinct from a runtime call.
 *
 * In declaration position (under `@type`), `fields` carry type annotations
 * and the elaborator generates a constructor function for the variant.
 * In pattern position (under `@match`), `fields` are bare identifiers that
 * bind the destructured field values; the typechecker rejects payloads
 * that carry type annotations in pattern position.
 */
declare interface VariantDecl {
    type: 'VariantDecl';
    name: string;
    fields: TypedIdentifier[];
    sourceLocation?: SourceLocation;
    inferredType?: any;
}

declare type WasmType = WasmValType | 'void';

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
declare type WasmValType = 'i32' | 'i64' | 'f32';

export declare class Workspace {
    #private;
    constructor(options?: WorkspaceOptions);
    /**
     * The shared strata registry for this workspace.  Built lazily from the
     * first document opened unless one was provided to the constructor.
     * `undefined` before any document is opened.
     */
    get registry(): ElaboratorRegistry | undefined;
    /** All currently open documents, keyed by URI. */
    get documents(): ReadonlyMap<string, Document_2>;
    /** Retrieve a single open document, or undefined if not open. */
    getDocument(uri: string): Document_2 | undefined;
    /**
     * Open a new document and run all compilation phases.
     *
     * If the workspace has no registry yet, one is built from `source`.
     * Fires a `'opened'` change event.
     *
     * Throws if `uri` is already open — call `editDocument` for subsequent
     * versions.
     */
    openDocument(uri: string, source: string): Document_2;
    /**
     * Apply a full-text replacement to an open document.
     *
     * Re-parses via `SyntaxTree.withText()` (reusing the existing tree's file
     * name), then re-elaborates and re-typechecks against the shared registry.
     * Fires a `'changed'` change event.
     *
     * Throws if `uri` is not open.
     */
    editDocument(uri: string, newSource: string): Document_2;
    /**
     * Close a document and remove it from the workspace.
     * Fires a `'closed'` change event.
     */
    closeDocument(uri: string): void;
    /**
     * Subscribe to document change events.
     *
     * @returns An unsubscribe function — call it to stop receiving events.
     *
     * @example
     *   const unsub = ws.onDidChange(e => console.log(e.kind, e.uri))
     *   // ... later:
     *   unsub()
     */
    onDidChange(listener: ChangeListener): () => void;
    /**
     * Find the symbol whose definition or reference occupies `(line, col)`
     * in `uri`.  Both coordinates are 1-based (matching editor conventions).
     *
     * Returns `undefined` if the document is not open or no symbol covers the
     * position.  Use `symbol.definitionSpan` to jump to the declaration.
     */
    findDefinition(uri: string, line: number, col: number): CaaSSymbol | undefined;
    /**
     * Find all reference spans for the symbol at `(line, col)` in `uri`.
     *
     * Returns an empty array if the document is not open, the position covers
     * no symbol, or location info was not available (pre-Ohm ASTs).
     */
    findReferences(uri: string, line: number, col: number): readonly SourceSpan[];
}

export declare interface WorkspaceOptions {
    /** Pre-built registry. If omitted, one is built from the first opened document. */
    registry?: ElaboratorRegistry;
}

export { }
