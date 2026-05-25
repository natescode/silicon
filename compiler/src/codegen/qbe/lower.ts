/**
 * Silicon typed AST → QBE IR text  (direct lowering, no WASM IR intermediate)
 *
 * This pass receives the same type-checked program that the WASM lowerer
 * (src/ir/lower.ts) would receive, but produces QBE IR text directly without
 * ever constructing IRModule / IRExpr / IRStmt nodes.
 *
 * Design rationale: the Silicon IR (IRModule) is WASM-shaped — it stores WAT
 * instruction strings in BinOp.instr, models globals as WAT globals, uses
 * WASM linear memory offsets for data segments, and carries funcref table
 * state.  None of that applies to a native QBE target.  By lowering straight
 * to QBE we avoid inheriting those assumptions.
 *
 * Pipeline position:
 *   TypedAST (+ ElaboratorRegistry + FunctionSigs)
 *     ──[this file]──▶ QBE IR text (string)
 *
 * Story coverage:
 *   8-1 — module skeleton: top-level @fn / @extern / @var declarations,
 *          function signatures, placeholder bodies
 *   8-2 — expression lowering: literals, binary ops, local reads/writes
 *   8-3 — call lowering: user function calls, @extern, @return
 *   8-4 — control flow: if/else as conditional jumps; loop/break/continue
 *          as basic blocks with labeled jumps
 *   8-5 — globals: @var data declarations, load/store for reads/writes
 */

import type { Program } from '../../ast/astNodes'
import type { ElaboratorRegistry } from '../../elaborator/registry'
import type { FunctionSig } from '../../types/typechecker'
import type { SiliconType } from '../../types/types'
import { siliconTypeToQbe, siliconTypeToQbeReturn, lookupOpToQbe } from './types'
import type { QbeType, QbeReturnType } from './types'

// ---------------------------------------------------------------------------
// Lowering context
// ---------------------------------------------------------------------------

/**
 * Module-level accumulator.  Sections are built up as the program is walked
 * and joined into the final QBE IR text by `emitQbeModule`.
 *
 * Per-function state (temps, labels, local map, instruction lines) lives in
 * `QbeFnCtx` and is discarded after each function is emitted.
 */
interface QbeModCtx {
    /** Lines of # comments for WASM imports / @extern declarations. */
    externs: string[]
    /** `data $name = ...` declarations for string literals and other statics. */
    dataDecls: string[]
    /** `data $name = align N { type value }` for @var globals. */
    globalData: string[]
    /** Fully-formed QBE function strings ready to be concatenated. */
    funcs: string[]

    /** Module-level global variable types — for load/store code-gen. */
    globalTypes: Map<string, QbeType>
    /** Function signatures from the type checker. */
    functionSigs: Map<string, FunctionSig>

    /** Data-segment label counter (for string literals). */
    dataLabelN: number
    /** String literal dedup cache: content → label. */
    stringCache: Map<string, string>
}

/**
 * Per-function emission state.  Created fresh for each @fn body; the results
 * are flushed into `QbeModCtx.funcs` when the function is complete.
 */
interface QbeFnCtx {
    mod: QbeModCtx

    /** Instructions for the current basic block, prefixed with `\t`. */
    lines: string[]
    /** Current block label (written as `@label` at the start of a block). */
    currentBlock: string
    /** Index into lines[] where the current basic block started (after the label line). */
    blockStart: number

    /** Monotonically increasing temp counter: %t0, %t1, … */
    tempN: number
    /** Monotonically increasing label counter: @lbl0, @lbl1, … */
    labelN: number

    /** Local variable QBE types — parameters + @local declarations. */
    locals: Map<string, QbeType>
    /** Stack of active loop label pairs — innermost last. */
    loopStack: Array<{ exit: string; cont: string }>
    /** LIFO stack of deferred cleanup expression emitters (for @defer). */
    deferStack: Array<() => void>

    /** Return type of the current function. */
    returnType: QbeReturnType
}

function freshMod(functionSigs: Map<string, FunctionSig>): QbeModCtx {
    return {
        externs: [], dataDecls: [], globalData: [], funcs: [],
        globalTypes: new Map(), functionSigs,
        dataLabelN: 0, stringCache: new Map(),
    }
}

function freshFn(mod: QbeModCtx, returnType: QbeReturnType): QbeFnCtx {
    return {
        mod, lines: [], currentBlock: '@start', blockStart: 0,
        tempN: 0, labelN: 0,
        locals: new Map(), loopStack: [], deferStack: [],
        returnType,
    }
}

function freshTemp(fn: QbeFnCtx): string {
    return `%t${fn.tempN++}`
}

function freshLabel(fn: QbeFnCtx, prefix = 'lbl'): string {
    return `@${prefix}${fn.labelN++}`
}

/** Emit one instruction line into the current function block. */
function emit(fn: QbeFnCtx, line: string): void {
    fn.lines.push(`\t${line}`)
}

/** True if the current basic block already ends with a terminator instruction. */
function isTerminated(fn: QbeFnCtx): boolean {
    for (let i = fn.lines.length - 1; i >= fn.blockStart; i--) {
        const t = fn.lines[i].trim()
        if (t === '' || t.startsWith('#')) continue
        return t.startsWith('jmp') || t.startsWith('ret') || t.startsWith('jnz')
    }
    return false
}

/** Switch to a new basic block: record the label line then update currentBlock. */
function startBlock(fn: QbeFnCtx, label: string): void {
    fn.lines.push(label)
    fn.currentBlock = label
    fn.blockStart = fn.lines.length  // instructions after this index belong to the new block
}

// ---------------------------------------------------------------------------
// Identifier normalisation
// ---------------------------------------------------------------------------

/**
 * Map a Silicon identifier to a legal QBE symbol name.  QBE function and
 * global names are prefixed with `$`; temporaries with `%`.  This helper
 * produces just the bare name (caller adds the sigil).
 *
 * Silicon allows names like `my_fn`, `add`, `Vec__push` — all legal in QBE.
 * The :: namespace separator is replaced with `__` to flatten it.
 */
function qbeName(name: string): string {
    return name.replace(/::/g, '__')
}

/** Unwrap the legacy element/item/statement wrappers the parser emits. */
function unwrap(node: any): any {
    if (!node || typeof node !== 'object') return node
    if (node.type === 'Element') return unwrap(node.element)
    if (node.type === 'Item')    return unwrap(node.item)
    if (node.type === 'Statement') return unwrap(node.statement)
    return node
}

// ---------------------------------------------------------------------------
// Module-level entry point  (Story 8-1)
// ---------------------------------------------------------------------------

/**
 * Lower a type-checked Silicon program to a QBE IR string.
 *
 * Walks `program.elements` in two passes:
 *   1. Pre-scan: register global names + types so forward references in
 *      function bodies resolve correctly (mirrors lowerProgram's pre-scan).
 *   2. Emit: produce QBE text for each top-level definition.
 *
 * Returns the concatenated QBE IR text, ready to pipe into `qbe`.
 */
export function lowerToQbe(
    program: Program,
    _registry: ElaboratorRegistry,
    functionSigs: Map<string, FunctionSig>,
): string {
    const mod = freshMod(functionSigs)

    // Pass 1: register global variable names/types for forward-reference resolution.
    for (const el of (program as any).elements as any[]) {
        const node = unwrap(el)
        if (!node || node.type !== 'Definition') continue
        if (node.keyword === '@var' || node.hook === 'global') {
            const rawName = node.name?.name ?? node.name ?? ''
            const name = qbeName(rawName)
            const sig = functionSigs.get(name)
            const qt = sig ? siliconTypeToQbe(sig.result) : 'w'
            mod.globalTypes.set(name, qt)
        }
    }

    // Pass 2: emit each top-level definition.
    for (const el of (program as any).elements as any[]) {
        const node = unwrap(el)
        if (!node) continue
        lowerTopLevel(node, mod)
    }

    return emitQbeModule(mod)
}

// ---------------------------------------------------------------------------
// Top-level definition dispatch  (Story 8-1)
// ---------------------------------------------------------------------------

function lowerTopLevel(node: any, mod: QbeModCtx): void {
    if (!node || node.type !== 'Definition') return

    const kw: string = node.keyword ?? ''
    const hook: string = node.hook ?? ''

    if (kw === '@fn' || hook === 'function') {
        lowerFunctionDef(node, mod)
        return
    }

    if (kw === '@extern' || hook === 'extern') {
        lowerExternDef(node, mod)
        return
    }

    if (kw === '@var' || hook === 'global') {
        lowerGlobalVarDef(node, mod)
        return
    }

    // @type, @struct, @enum, @type_sum — no QBE output at top level;
    // their constructors/accessors are emitted as @fn definitions.
}

// ---------------------------------------------------------------------------
// @fn  (Story 8-1: signature + placeholder body)
// ---------------------------------------------------------------------------

function lowerFunctionDef(node: any, mod: QbeModCtx): void {
    const rawName: string = node.name?.name ?? node.name ?? 'unknown'
    const name = qbeName(rawName)

    // Use the type-checker's signature as the authoritative source for types.
    const sig = mod.functionSigs.get(name)
    const returnType: QbeReturnType = sig
        ? siliconTypeToQbeReturn(sig.result)
        : 'void'

    // Collect parameter names and their QBE types.
    // Prefer sig.params[i] (typechecker-resolved) over AST annotation strings.
    const params: Array<{ name: string; qt: QbeType }> = []
    if (node.params) {
        for (let i = 0; i < (node.params as any[]).length; i++) {
            const pNode = unwrap((node.params as any[])[i])
            const pName = qbeName(pNode?.name?.name ?? pNode?.name ?? `p${i}`)
            const sigType: SiliconType | undefined = sig?.params[i]
            const pType = pNode?.typeAnnotation?.typeName ?? pNode?.inferredType
            const astType: SiliconType | undefined =
                typeof pType === 'string'
                    ? resolveTypeName(pType)
                    : (pType as SiliconType | undefined)
            params.push({ name: pName, qt: siliconTypeToQbe(sigType ?? astType) })
        }
    }

    const fn = freshFn(mod, returnType)

    // Register params as locals so body emission (8-2+) can type them.
    for (const { name: pn, qt } of params) {
        fn.locals.set(pn, qt)
    }

    // Build the function header line.
    const paramStr = params.map(p => `${p.qt} %${p.name}`).join(', ')
    const retPrefix = returnType !== 'void' ? `${returnType} ` : ''
    const header = `function ${retPrefix}$${name}(${paramStr}) {`

    // Emit the entry block — startBlock records the blockStart index.
    startBlock(fn, '@start')

    // Lower the body expression if present; placeholder if not.
    // AST layout: node.binding.expression holds the body (after ':=').
    const bodyExpr = node.binding?.expression ?? node.body ?? null
    if (bodyExpr) {
        const trailing = lowerExpr(bodyExpr, fn)
        if (!isTerminated(fn)) {
            if (returnType !== 'void' && trailing) {
                emit(fn, `ret ${trailing}`)
            } else {
                emit(fn, 'ret')
            }
        }
    } else {
        emit(fn, `# TODO(8-2): body for $${name}`)
        emit(fn, returnType !== 'void' ? `ret 0` : 'ret')
    }

    const funcText = [header, ...fn.lines, '}'].join('\n')
    mod.funcs.push(funcText)
}

// ---------------------------------------------------------------------------
// @extern  (Story 8-1)
// ---------------------------------------------------------------------------

function lowerExternDef(node: any, mod: QbeModCtx): void {
    const rawName: string = node.name?.name ?? node.name ?? 'unknown'
    const name = qbeName(rawName)

    const sig = mod.functionSigs.get(name)
    const params = (sig?.params ?? []).map((p, i) => `${siliconTypeToQbe(p)} %p${i}`).join(', ')
    const retPrefix = sig ? `${siliconTypeToQbeReturn(sig.result)} ` : ''

    // QBE has no import declaration — extern functions are resolved by the
    // linker.  Emit as a comment so the QBE source is self-documenting.
    mod.externs.push(`# extern function ${retPrefix}$${name}(${params})`)
}

// ---------------------------------------------------------------------------
// @var global  (Story 8-1 / 8-5)
// ---------------------------------------------------------------------------

function lowerGlobalVarDef(node: any, mod: QbeModCtx): void {
    const rawName: string = node.name?.name ?? node.name ?? 'unknown'
    const name = qbeName(rawName)

    const qt = mod.globalTypes.get(name) ?? 'w'
    // Story 8-5 will lower the init expression; for now use 0.
    mod.globalData.push(`data $${name} = align 4 { ${qt} 0 }`)
}

// ---------------------------------------------------------------------------
// Expression lowering  (Story 8-1: stubs; 8-2+ fills in)
// ---------------------------------------------------------------------------

/**
 * Lower a typed AST expression node into the current function context.
 * Returns the QBE value string for the expression's result:
 *   - A literal integer/float: `42`, `s_3.14`
 *   - A local/parameter reference: `%name`
 *   - A fresh temporary that holds the result: `%t0`
 *   - An empty string for void/no-value expressions
 *
 * Story 8-1 provides the dispatch skeleton with stubs; stories 8-2 through
 * 8-4 fill in each case.
 */
function lowerExpr(node: any, fn: QbeFnCtx): string {
    if (!node) return ''
    const n = unwrap(node)
    if (!n) return ''

    switch (n.type) {

        // -- Literals --------------------------------------------------------
        case 'IntLiteral':
            return String(n.value ?? 0)

        case 'FloatLiteral':
            return `s_${n.value ?? 0}`

        case 'BooleanLiteral':
            return n.value === true || n.value === 'true' ? '1' : '0'

        // -- Identifier / variable reference ---------------------------------
        // Parser wraps variable refs in a Namespace node with a path array.
        case 'Namespace': {
            const varName = qbeName((n.path as string[])?.[0] ?? n.name ?? '')
            if (fn.locals.has(varName)) return `%${varName}`
            if (fn.mod.globalTypes.has(varName)) {
                const qt = fn.mod.globalTypes.get(varName)!
                const tmp = freshTemp(fn)
                emit(fn, `${tmp} =${qt} load${qt} $${varName}`)
                return tmp
            }
            // Probably a zero-arg function call
            return lowerCall(varName, [], fn)
        }

        case 'Identifier': {
            const varName = qbeName(n.name ?? '')
            if (fn.locals.has(varName)) return `%${varName}`
            if (fn.mod.globalTypes.has(varName)) {
                const qt = fn.mod.globalTypes.get(varName)!
                const tmp = freshTemp(fn)
                emit(fn, `${tmp} =${qt} load${qt} $${varName}`)
                return tmp
            }
            return lowerCall(n.name ?? '', [], fn)
        }

        // -- Binary operators ------------------------------------------------
        case 'BinaryOp':
            return lowerBinaryOp(n, fn)

        // -- Function calls --------------------------------------------------
        case 'FunctionCall':
            return lowerFunctionCall(n, fn)

        // -- Block -----------------------------------------------------------
        case 'Block': {
            const stmts: any[] = n.items ?? n.statements ?? n.stmts ?? []
            for (const s of stmts) lowerExpr(s, fn)
            const trail = n.trailing ?? n.expression ?? n.result
            return trail ? lowerExpr(trail, fn) : ''
        }

        // -- Assignment (x = val) -------------------------------------------
        // Parser produces target as a Namespace node, not a plain name field.
        case 'Assignment': {
            const targetNode = n.target ?? n.name
            const varName = qbeName(
                Array.isArray(targetNode?.path)
                    ? (targetNode.path as string[])[0] ?? ''
                    : targetNode?.name ?? targetNode ?? ''
            )
            const val = lowerExpr(n.value, fn)
            const qt = fn.locals.get(varName) ?? fn.mod.globalTypes.get(varName) ?? 'w'
            if (fn.mod.globalTypes.has(varName)) {
                emit(fn, `store${qt} ${val}, $${varName}`)
            } else {
                // Registers local on first assignment if not already declared.
                fn.locals.set(varName, qt)
                emit(fn, `%${varName} =${qt} copy ${val}`)
            }
            return ''
        }

        // -- Definition inside a function body (@local, etc.) ----------------
        case 'Definition':
            return lowerLocalDef(n, fn)

        // -- Stubs for story 8-3 / 8-4 ---------------------------------------
        default:
            emit(fn, `# TODO(qbe): ${n.type ?? 'unknown'} not yet lowered`)
            return '0'
    }
}

// ---------------------------------------------------------------------------
// Binary operator lowering  (Story 8-2)
// ---------------------------------------------------------------------------

function lowerBinaryOp(node: any, fn: QbeFnCtx): string {
    const op: string = node.operator ?? ''

    // Assignment form `x = val` parsed as BinaryOp in expression tail position
    if (op === '=') {
        const varName = qbeName(
            node.left?.path?.[0] ?? node.left?.name ?? node.left?.identifier?.name ?? ''
        )
        const val = lowerExpr(node.right, fn)
        const qt = fn.locals.get(varName) ?? fn.mod.globalTypes.get(varName) ?? 'w'
        if (fn.mod.globalTypes.has(varName)) {
            emit(fn, `store${qt} ${val}, $${varName}`)
        } else {
            emit(fn, `%${varName} =${qt} copy ${val}`)
        }
        return ''
    }

    const left  = lowerExpr(node.left, fn)
    const right = lowerExpr(node.right, fn)

    // Determine the operand type kind for instruction selection.
    // Strata 2.0 operators use on::lower handlers — the registry doesn't store
    // WAT intrinsic strings.  We resolve directly via lookupOpToQbe.
    const leftType: SiliconType | undefined = node.left?.inferredType as any
    const isBitwise = ['|', '^', '<<', '>>'].includes(op)
    const typeKind =
        isBitwise                             ? 'Int'
        : leftType?.kind === 'Int64'          ? 'Int64'
        : leftType?.kind === 'UInt64'         ? 'UInt64'
        : leftType?.kind === 'Float'          ? 'Float'
        :                                       'Int'

    const entry = lookupOpToQbe(op, typeKind)
    if (entry) {
        const tmp = freshTemp(fn)
        emit(fn, `${tmp} =${entry.qt} ${entry.instr} ${left}, ${right}`)
        return tmp
    }

    emit(fn, `# TODO(qbe): operator '${op}' (typeKind=${typeKind})`)
    return '0'
}

// ---------------------------------------------------------------------------
// Function call lowering  (Story 8-3)
// ---------------------------------------------------------------------------

function lowerFunctionCall(node: any, fn: QbeFnCtx): string {
    // Callee is a Namespace node { path: ['name'] } or a plain string.
    const nameNode = node.name ?? node.callee
    const callee: string =
        Array.isArray(nameNode?.path)
            ? qbeName((nameNode.path as string[])[0] ?? '')
            : qbeName(typeof nameNode === 'string' ? nameNode : (nameNode?.name ?? ''))

    const args: any[] = node.args ?? node.arguments ?? []

    // Builtin keywords that map to QBE control instructions.
    if (node.isBuiltin) return lowerBuiltinCall(callee, args, fn)

    return lowerCall(callee, args, fn, node)
}

function lowerBuiltinCall(callee: string, args: any[], fn: QbeFnCtx): string {
    switch (callee) {
        case '@return': {
            if (args.length > 0) {
                const val = lowerExpr(args[0], fn)
                emit(fn, `ret ${val}`)
            } else {
                emit(fn, 'ret')
            }
            return ''
        }

        case '@if':
            return lowerIf(args, fn)

        case '@loop':
            return lowerLoop(args, fn)

        case '@break': {
            const top = fn.loopStack[fn.loopStack.length - 1]
            if (top) emit(fn, `jmp ${top.exit}`)
            else emit(fn, '# @break outside loop')
            return ''
        }

        case '@continue': {
            const top = fn.loopStack[fn.loopStack.length - 1]
            if (top) emit(fn, `jmp ${top.cont}`)
            else emit(fn, '# @continue outside loop')
            return ''
        }

        default:
            emit(fn, `# TODO(qbe): builtin '${callee}'`)
            return ''
    }
}

function lowerCall(callee: string, args: any[], fn: QbeFnCtx, callNode?: any): string {
    const argVals = args.map(a => lowerExpr(a, fn))

    // Build typed argument list for QBE: `w %x`, `s s_1.0`, …
    const typedArgs = argVals.map((v, i) => {
        const argType: SiliconType | undefined = args[i]?.inferredType as any
        return `${siliconTypeToQbe(argType)} ${v}`
    }).join(', ')

    // Return type: prefer the typechecker's function sig, fall back to the
    // call site's inferred type (populated by the typechecker for all calls).
    const sig = fn.mod.functionSigs.get(callee)
    const callSiteType: SiliconType | undefined = callNode?.inferredType as any
    const retType: QbeReturnType = sig
        ? siliconTypeToQbeReturn(sig.result)
        : siliconTypeToQbeReturn(callSiteType)

    if (retType === 'void') {
        emit(fn, `call $${callee}(${typedArgs})`)
        return ''
    }
    const tmp = freshTemp(fn)
    emit(fn, `${tmp} =${retType} call $${callee}(${typedArgs})`)
    return tmp
}

// ---------------------------------------------------------------------------
// @if lowering  (Story 8-4)
//
// args[0] = condition expr
// args[1] = then-Block
// args[2] = else-Block (optional)
//
// Value-returning @if (used in expression position) emits phi at merge.
// Statement-level @if (result discarded) avoids the phi overhead.
// ---------------------------------------------------------------------------

function lowerIf(args: any[], fn: QbeFnCtx): string {
    const cond      = args[0]
    const thenBlock = args[1]
    const elseBlock = args[2]

    const hasElse = !!elseBlock

    const condVal = lowerExpr(cond, fn)

    const thenLabel  = freshLabel(fn, 'then')
    const elseLabel  = hasElse ? freshLabel(fn, 'else') : ''
    const mergeLabel = freshLabel(fn, 'end')

    emit(fn, `jnz ${condVal}, ${thenLabel}, ${hasElse ? elseLabel : mergeLabel}`)

    // Then arm
    startBlock(fn, thenLabel)
    const thenVal = lowerExpr(thenBlock, fn)
    const thenExit = fn.currentBlock
    if (!isTerminated(fn)) emit(fn, `jmp ${mergeLabel}`)

    // Else arm (if present)
    let elseVal = ''
    let elseExit = ''
    if (hasElse) {
        startBlock(fn, elseLabel)
        elseVal = lowerExpr(elseBlock, fn)
        elseExit = fn.currentBlock
        if (!isTerminated(fn)) emit(fn, `jmp ${mergeLabel}`)
    }

    startBlock(fn, mergeLabel)

    // Emit phi if both arms produced a value and we're in expression position.
    if (hasElse && thenVal && elseVal && thenVal !== '' && elseVal !== '') {
        const resultType: SiliconType | undefined = thenBlock?.inferredType as any
        const qt = siliconTypeToQbe(resultType)
        const tmp = freshTemp(fn)
        emit(fn, `${tmp} =${qt} phi ${thenExit} ${thenVal}, ${elseExit} ${elseVal}`)
        return tmp
    }

    return ''
}

// ---------------------------------------------------------------------------
// @loop lowering  (Story 8-4)
//
// args[0] = loop body Block
//
// Emits:
//   jmp @head
//   @head
//     <body>
//     jmp @head
//   @exit
// ---------------------------------------------------------------------------

function lowerLoop(args: any[], fn: QbeFnCtx): string {
    const bodyBlock = args[0]

    const headLabel = freshLabel(fn, 'loop')
    const exitLabel = freshLabel(fn, 'loop_exit')

    // Fall into the loop head.
    emit(fn, `jmp ${headLabel}`)
    startBlock(fn, headLabel)

    fn.loopStack.push({ cont: headLabel, exit: exitLabel })
    lowerExpr(bodyBlock, fn)
    fn.loopStack.pop()

    // Back-edge (only if the block doesn't already end with a jump).
    if (!isTerminated(fn)) emit(fn, `jmp ${headLabel}`)

    startBlock(fn, exitLabel)
    return ''
}

// ---------------------------------------------------------------------------
// Local definition inside a function body  (Story 8-2 / 8-3)
// ---------------------------------------------------------------------------

function lowerLocalDef(node: any, fn: QbeFnCtx): string {
    const kw: string = node.keyword ?? ''

    // @local x:Int := val  — declare a typed local and initialise it
    if (kw === '@local' || kw === '@let') {
        const varName = qbeName(node.name?.name ?? node.name ?? '')
        // Type from type annotation or inferred type on the node/binding
        const annot: SiliconType | undefined =
            (node.inferredType as SiliconType | undefined) ??
            (node.binding?.expression?.inferredType as SiliconType | undefined)
        const qt = siliconTypeToQbe(annot)
        fn.locals.set(varName, qt)
        const bodyExpr = node.binding?.expression ?? node.body ?? null
        if (bodyExpr) {
            const val = lowerExpr(bodyExpr, fn)
            emit(fn, `%${varName} =${qt} copy ${val}`)
        }
        return ''
    }

    emit(fn, `# TODO(qbe): local def keyword '${kw}'`)
    return ''
}

// ---------------------------------------------------------------------------
// Type name → SiliconType  (for parameter annotation strings)
// ---------------------------------------------------------------------------

function resolveTypeName(name: string): SiliconType | undefined {
    switch (name) {
        case 'Int':   case 'Int32': return { kind: 'Int' }
        case 'Int64':               return { kind: 'Int64' }
        case 'Float':               return { kind: 'Float' }
        case 'Bool':                return { kind: 'Bool' }
        case 'String':              return { kind: 'String' }
        default:                    return undefined
    }
}

// ---------------------------------------------------------------------------
// Final QBE text assembly
// ---------------------------------------------------------------------------

function emitQbeModule(mod: QbeModCtx): string {
    const sections: string[] = []
    if (mod.externs.length)    sections.push(mod.externs.join('\n'))
    if (mod.dataDecls.length)  sections.push(mod.dataDecls.join('\n'))
    if (mod.globalData.length) sections.push(mod.globalData.join('\n'))
    if (mod.funcs.length)      sections.push(mod.funcs.join('\n\n'))
    return sections.join('\n\n').trim()
}
