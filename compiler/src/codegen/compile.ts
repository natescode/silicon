/**
 * Silicon to WebAssembly Code Generation
 *
 * Stage 3 of the compilation pipeline. Transforms a parsed Silicon program
 * into WebAssembly Text format (WAT) by walking the Ohm parse tree with
 * `addCompileSemantics`.
 *
 * Key responsibilities
 * - Emit a single `(module ...)` that inlines the Silicon standard library
 *   from `std.wat`, so the helpers (`$alloc`, `$alloc_array`, `$alloc_string`,
 *   `$print_int`, `$print_float`, `$print_bool`, `$print_string`) are
 *   callable from user code.
 * - Lower Silicon's primitive literals to their WASM value-type constants
 *   (Int/Bool → i32.const, Float → f32.const).
 * - Arrays and strings live on the heap as length-prefixed blocks; see
 *   `std.wat` for the layout.
 *
 * Type-system integration
 * - The type checker runs before codegen and annotates expression nodes with
 *   inferred types. This module currently falls back to lexical sniffing
 *   (does any sub-expression mention `f32.const`?) for picking i32 vs f32
 *   operator variants. That heuristic works for today's simple programs and
 *   will be replaced once the AST-walker codegen lands alongside the IR.
 *
 * Output
 * - A single WAT string that `wat2wasm` can assemble.
 *
 * @see std.wat - Silicon's runtime / standard library
 * @see ../types - Type checker that validates this AST before compilation
 */

import * as ohm from 'ohm-js'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { isWasmIntrinsic, getWasmIntrinsic } from '../intrinsics'
import { type ElaboratorRegistry, lookupOperator, lookupDefKindEntry, lookupKeyword } from '../elaborator/registry'
import { wasmTypeOf } from '../types/types'
import type { FunctionSig } from '../types/typechecker'

// Resolve std.wat relative to this source file so the path works under
// both `bun run` and compiled TS.
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const STD_WAT_PATH = join(__dirname, 'std.wat')

/**
 * Load the Silicon runtime (std.wat) once per process. Cached to avoid
 * repeated disk reads when compiling many programs in a test run.
 */
let cachedStdWat: string | null = null
function loadStdWat(): string {
    if (cachedStdWat === null) {
        cachedStdWat = readFileSync(STD_WAT_PATH, 'utf-8')
    }
    return cachedStdWat
}

/**
 * Helper function to convert Silicon identifiers to WAT function names
 * Converts :: to _ for valid WAT identifiers
 */
function toWatIdentifier(siliconName: string): string {
    return siliconName.replace(/::/g, '_')
}

function siliconTypeToWat(typeName: string): string {
    return typeName === 'Float' ? 'f32' : 'i32'
}

/**
 * Look up the WAT instruction for a user-defined operator via the stratum
 * registry. For float context, attempts to swap the i32 intrinsic for its
 * f32 counterpart. Returns undefined if the operator isn't in the registry.
 */
function stratumInstrFor(op: string, isFloat: boolean, reg: ElaboratorRegistry | undefined): string | undefined {
    if (!reg) return undefined
    const stratum = lookupOperator(reg, op)
    if (!stratum?.data?.intrinsic) return undefined
    if (!isFloat) {
        return getWasmIntrinsic(stratum.data.intrinsic)?.wasmInstr
    }
    // Float context: swap i32_ prefix for f32_. Signed/unsigned suffixes (_s, _u)
    // don't exist on f32 instructions, so strip them too.
    const f32Base = stratum.data.intrinsic.replace(/^WASM::i32_/, 'WASM::f32_')
    return (
        getWasmIntrinsic(f32Base) ??
        getWasmIntrinsic(f32Base.replace(/_[su]$/, '')) ??
        getWasmIntrinsic(stratum.data.intrinsic)
    )?.wasmInstr
}

/**
 * Simple static-data allocator used for string literals. Strings are laid out
 * as length-prefixed byte blocks in the `0..1023` region that sits below the
 * `$heap` starting address, so the dynamic allocator never collides with
 * them.
 *
 * This allocator is reset per compilation.
 */
interface StaticData {
    // Next free offset in the 0..1023 static region.
    nextOffset: number
    // Emitted WAT `(data ...)` directives in order.
    dataDirectives: string[]
}

function createStaticData(): StaticData {
    // Skip the first four bytes so that offset 0 remains a sentinel ("null
    // string") address. Leaves 1020 bytes for static string literals, which
    // is plenty for POC programs.
    return { nextOffset: 4, dataDirectives: [] }
}

/**
 * Encode a JS string into its length-prefixed WAT `(data ...)` directive and
 * return the base address. The first four bytes at that address hold the byte
 * length; the payload follows immediately.
 */
function allocStaticString(sd: StaticData, s: string): number {
    const bytes = new TextEncoder().encode(s)
    const base = sd.nextOffset
    const len = bytes.length

    // Encode length as four little-endian bytes followed by the payload.
    // WAT supports the `\XX` escape inside double-quoted data strings.
    const lenBytes = [
        len & 0xff,
        (len >> 8) & 0xff,
        (len >> 16) & 0xff,
        (len >> 24) & 0xff,
    ]
    const all = [...lenBytes, ...bytes]
    const encoded = all.map(b => {
        // Printable ASCII, except `"` and `\`, passes through literally;
        // everything else uses the `\XX` form.
        if (b >= 0x20 && b <= 0x7e && b !== 0x22 && b !== 0x5c) {
            return String.fromCharCode(b)
        }
        return '\\' + b.toString(16).padStart(2, '0')
    }).join('')

    sd.dataDirectives.push(`(data (i32.const ${base}) "${encoded}")`)
    sd.nextOffset += 4 + len
    return base
}

/**
 * Create semantic actions for AST to WAT compilation
 *
 * @param siliconGrammar - The compiled Ohm grammar
 * @returns Ohm semantics object with 'compile' operation
 */
export default function addCompileSemantics(
    siliconGrammar: ohm.Grammar,
    registry?: ElaboratorRegistry,
    functionSigs?: Map<string, FunctionSig>
) {
    // Static data and heap layout state lives per semantics object. Each
    // call to `addCompileSemantics` yields an isolated compilation unit so
    // tests don't bleed state into each other.
    const staticData = createStaticData()
    let loopCount = 0
    // Names of the current function's parameters AND @local variables so
    // namespace refs inside the function use local.get / local.set.
    let currentParams: Set<string> = new Set()
    // WAT type for each @local variable declared inside the current function.
    // Populated as @local bindings are compiled; flushed into the function
    // preamble by compileFunction.  Saved/restored on function entry/exit.
    let currentLocals: Map<string, string> = new Map()
    // WAT identifiers of every module-level global emitted so far (from @var
    // and @type_sum variants). Used by ExpressionEnd_namespace to decide
    // whether to emit global.get rather than (call ...).
    const compiledGlobals: Set<string> = new Set()
    // WAT identifiers of zero-arg functions emitted at module level (from
    // zero-param @let / @fn). References use (call $name) not global.get.
    const compiledZeroArgFuncs: Set<string> = new Set()
    // True when the current node is in expression position (its value is consumed by
    // a caller). Used by IfExpr to decide whether to emit (result type).
    let inExprPosition: boolean = false

    // Emit a WAT (func ...) for the 'function' Def-Kind.
    // Extracted so the Definition action can delegate cleanly.
    function compileFunction(typedId: any, params: any, binding: any): string {
        const name = typedId.compile()
        const watName = toWatIdentifier(name)

        const hasParams = params.asIteration().children.length > 0
        // A zero-param function at module level (not nested inside another
        // function) is tracked so namespace references emit (call $name).
        if (!hasParams && currentParams.size === 0) {
            compiledZeroArgFuncs.add(watName)
        }

        const paramNames: Set<string> = new Set()
        params.asIteration().children.forEach((p: any) => {
            const raw = p.sourceString.split(':')[0].trim()
            if (raw) paramNames.add(toWatIdentifier(raw))
        })

        // Save and reset function-level state for this new function scope.
        const prevParams = currentParams
        const prevLocals = currentLocals
        currentParams = paramNames
        currentLocals = new Map()

        const paramList = params.asIteration().children.map((p: any) => p.compile()).join(' ')
        const body = binding.children.length > 0 ? binding.children[0].compile() : ''

        // Collect @local variable declarations accumulated during body compilation.
        const localsDecl = [...currentLocals.entries()]
            .map(([n, t]) => `(local $${n} ${t})`)
            .join('\n')

        // Restore outer function state.
        currentParams = prevParams
        currentLocals = prevLocals

        const retTypeName = typedId.type()
        const hasBinding = binding.children.length > 0
        let resultDecl: string
        if (retTypeName) {
            resultDecl = `(result ${siliconTypeToWat(retTypeName)})`
        } else if (hasBinding) {
            const sig = functionSigs?.get(watName)
            if (sig && sig.result.kind !== 'Unknown') {
                resultDecl = `(result ${wasmTypeOf(sig.result)})`
            } else {
                // Fallback: sniff for f32 instructions in the compiled body.
                resultDecl = body.includes('f32.') ? '(result f32)' : '(result i32)'
            }
        } else {
            resultDecl = ''
        }

        const preamble = ['(local $addr i32)', localsDecl].filter(s => s).join('\n')
        const funcDecl = `(func $${watName} ${paramList} ${resultDecl} ${preamble}\n${body}\n)`
        const exportDecl = `(export "${watName}" (func $${watName}))`
        return `${funcDecl}\n${exportDecl}`
    }

    // Emit local.set + update tracking state for the 'local' Def-Kind.
    // The (local $name type) declaration is accumulated in currentLocals and
    // flushed into the function preamble by compileFunction.
    function compileLocal(typedId: any, binding: any): string {
        const name = typedId.compile()
        const watName = toWatIdentifier(name)
        const retTypeName = typedId.type()
        const watType = retTypeName ? siliconTypeToWat(retTypeName) : 'i32'

        // Register this local so the function preamble includes its declaration.
        currentLocals.set(watName, watType)
        // Register in currentParams so subsequent references emit local.get.
        currentParams.add(watName)

        const prev = inExprPosition
        inExprPosition = true
        const initExpr = binding.children.length > 0
            ? binding.children[0].compile()
            : `(${watType}.const 0)`
        inExprPosition = prev

        return `${initExpr}\nlocal.set $${watName}`
    }

    // Emit a WAT (import "env" ...) declaration for the 'extern' Def-Kind.
    // @extern name:ReturnType param1:T1, param2:T2;
    // → (import "env" "name" (func $name (param i32 ...) (result i32)?))
    function compileExtern(typedId: any, params: any): string {
        const name = typedId.compile()
        const watName = toWatIdentifier(name)
        const paramList = params.asIteration().children.map((p: any) => p.compile()).join(' ')
        const retTypeName = typedId.type()
        const resultDecl = retTypeName ? `(result ${siliconTypeToWat(retTypeName)})` : ''
        const sig = [paramList, resultDecl].filter(s => s).join(' ')
        return `(import "env" "${watName}" (func $${watName} ${sig}))`
    }

    // Emit immutable i32 globals for each variant of a @type_sum.
    // `binding` is the Binding? node; its sourceString gives us the raw
    // `Variant1 | Variant2 | ...` text without triggering a compile walk of
    // the unregistered `|` operator.
    function compileSumType(typedId: any, binding: any): string {
        if (binding.children.length === 0) return ''
        // Binding = ":=" ExpressionStart — children[1] is the ExpressionStart.
        const exprSource: string = binding.children[0].children[1].sourceString
        const typeName = toWatIdentifier(typedId.compile())
        const variants = exprSource.split('|').map((s: string) => s.trim()).filter(Boolean)
        return variants
            .map((v: string, i: number) => {
                const watName = toWatIdentifier(`${typeName}::${v}`)
                compiledGlobals.add(watName)
                return `(global $${watName} i32 (i32.const ${i}))`
            })
            .join('\n')
    }

    // Emit a WAT (global ...) mutable global for the 'global' Def-Kind.
    function compileGlobal(typedId: any, binding: any): string {
        const name = typedId.compile()
        const watName = toWatIdentifier(name)
        compiledGlobals.add(watName)
        const retTypeName = typedId.type()
        const watType = retTypeName ? siliconTypeToWat(retTypeName) : 'i32'
        const initExpr = binding.children.length > 0
            ? binding.children[0].compile()
            : `(${watType}.const 0)`
        return `(global $${watName} (mut ${watType}) ${initExpr})`
    }

    const semantics = siliconGrammar.createSemantics().addOperation('compile', {
        Program(elements) {
            const imports: string[] = []
            const funcs: string[] = []
            const topLevelCode: string[] = []

            for (const el of elements.children) {
                const compiled = el.compile()
                if (!compiled) continue
                if (el.isDefinition()) {
                    if (compiled.startsWith('(import')) {
                        imports.push(compiled)
                    } else {
                        funcs.push(compiled)
                    }
                } else {
                    topLevelCode.push(compiled)
                }
            }

            const stdWat = loadStdWat()
            const dataSection = staticData.dataDirectives.join('\n')

            const startFunc = topLevelCode.length > 0
                ? `(func $__start (local $addr i32)\n${topLevelCode.join('\n')}\n)\n(export "__start" (func $__start))`
                : ''

            return `(module\n${imports.join('\n')}\n${stdWat}\n${dataSection}\n${funcs.join('\n')}\n${startFunc}\n)`
        },
        Element_item(item, _semi) {
            return item.compile();
        },
        Element_elaboration(elaboration, _semi) {
            return elaboration.compile();
        },
        Element_docComment(docComment) {
            return '';
        },
        Item_statement(stmt) {
            return stmt.compile();
        },
        Item_expressionStart(exp) {
            return exp.compile();
        },
        Statement_assignment(assgn) {
            return assgn.compile();
        },
        Statement_definition(def) {
            return def.compile();
        },
        DocComment(_hashhash, chars) {
            return '';
        },
        Elaboration(_stratum, strataDef) {
            // Elaborations (stratum definitions) don't generate code; they
            // are processed during the elaboration phase.
            return '';
        },
        StrataDefinition(def) {
            return '';
        },
        OperatorDefinition(name, _open, _op, _comma1, symbol, _comma2, nodeParam, _close, _eq, body) {
            return '';
        },
        KeywordDefinition(name, _open, _kw, _comma1, keywordName, _comma2, nodeParam, _close, _eq, body) {
            return '';
        },
        OperatorSymbol(stringLit) {
            return stringLit.compile();
        },
        KeywordName(stringLit) {
            return stringLit.compile();
        },
        StrataBody(open, items, _semis, close) {
            const body = items.children.map(i => i.compile()).filter(s => s).join('\n');
            return body;
        },
        Assignment(ns, _eq, exp) {
            const name = ns.compile();
            const watName = toWatIdentifier(name);
            const value = exp.compile();
            // Inside a function body, parameters use locals; otherwise module globals.
            const setter = currentParams.has(watName) ? 'local.set' : 'global.set';
            return `${value}\n${setter} $${watName}`;
        },
        Definition(kw, typedId, generics, params, binding) {
            const keyword = '@' + kw.compile()
            const entry = registry ? lookupDefKindEntry(registry, keyword) : undefined
            if (!entry) throw new Error(`Unknown definition keyword: ${keyword}`)

            // Dispatch to the appropriate codegen handler for this Def-Kind.
            // Currently only 'function' exists; future kinds add cases here.
            switch (entry.codegenKind) {
                case 'function':
                    return compileFunction(typedId, params, binding)
                case 'global':
                    return compileGlobal(typedId, binding)
                case 'extern':
                    return compileExtern(typedId, params)
                case 'local':
                    return compileLocal(typedId, binding)
                case 'type_alias':
                case 'type_distinct':
                    // Type declarations are compile-time only; they produce no WAT.
                    return ''
                case 'type_sum':
                    return compileSumType(typedId, binding)
                default:
                    throw new Error(`Unhandled codegenKind: ${(entry as any).codegenKind}`)
            }
        },
        ExpressionStart_binChain(left, binOps, endOps) {
            let result = left.compile();
            if (binOps.children && binOps.children.length > 0) {
                for (let i = 0; i < binOps.children.length; i++) {
                    const op = binOps.children[i];
                    const right = endOps.children[i];
                    const right_wat = right.compile();
                    const op_wat = op.compile();

                    const isFloat = /f32\./.test(result) || /f32\./.test(right_wat);
                    const instr = stratumInstrFor(op_wat, isFloat, registry)
                    if (!instr) throw new Error(`Unknown operator: ${op_wat}`)
                    result = result + '\n' + right_wat + '\n' + instr;
                }
            }
            return result;
        },

        ExpressionStart(exp) {
            return exp.compile();
        },
        BinOp(op) {
            return op.sourceString;
        },
        FunctionCall(_sigil, body) {
            return body.compile();
        },
        FunctionCallBody_builtin(kw, args) {
            const funcName = kw.compile();
            const kwEntry = registry ? lookupKeyword(registry, '@' + funcName) : undefined;
            const intrinsicName = kwEntry?.data?.intrinsic;

            if (intrinsicName) {
                const intr = getWasmIntrinsic(intrinsicName);
                if (intr?.emitStructured) {
                    const argWats: string[] = args.compileArgList();
                    return intr.emitStructured(argWats, {
                        inExprPosition,
                        nextLoopId: () => loopCount++,
                    });
                }
            }

            const argList = args.compile();
            return `(call $${funcName} ${argList})`;
        },

        FunctionCallBody_user(ns, args) {
            const funcName = ns.compile();
            const watName = toWatIdentifier(funcName);
            const argList = args ? args.compile() : '';

            // For WASM intrinsics, emit the instruction directly instead of a call
            if (isWasmIntrinsic(funcName)) {
                const intrinsic = getWasmIntrinsic(funcName)!;
                const instrWithArgs = argList ? `${argList} ${intrinsic.wasmInstr}` : intrinsic.wasmInstr;
                return instrWithArgs;
            }

            return `(call $${watName} ${argList})`;
        },
        Args(exps) {
            return exps.children.map(e => e.compile()).join(' ');
        },

        CallArgs(_ampersand, args) {
            return args.compile();
        },

        CallNoArgs(_lookahead) {
            return '';
        },

        CallArgsOrEnd(argsOrEnd) {
            return argsOrEnd.compile();
        },

        ExpressionEnd_literal(lit) {
            return lit.compile();
        },
        ExpressionEnd_namespace(ns) {
            const name = ns.compile();
            const watName = toWatIdentifier(name);
            // 1. Function parameters and @local variables → local.get
            if (currentParams.has(watName)) {
                return `(local.get $${watName})`;
            }
            // 2. Known WAT globals (@var, @type_sum variants) → global.get
            if (compiledGlobals.has(watName)) {
                return `(global.get $${watName})`;
            }
            // 3. Zero-arg function (zero-param @let / @fn) → call
            if (compiledZeroArgFuncs.has(watName)) {
                return `(call $${watName})`;
            }
            // 4. Fallback: assume global (implicit assignments, forward refs)
            return `(global.get $${watName})`;
        },
        ExpressionEnd_block(block) {
            return block.compile();
        },
        ExpressionEnd_paren(_open, exp, _close) {
            return exp.compile();
        },
        Binding(_bind, exp) {
            // The bound expression is always in expression position — its value is the function body.
            const prev = inExprPosition
            inExprPosition = true
            const result = exp.compile()
            inExprPosition = prev
            return result
        },
        Block(_open, items, _semis, trailing, _close) {
            // Statements are void; only the trailing expression is in expression position.
            const prev = inExprPosition
            inExprPosition = false
            const stmts = items.children.map((i: any) => i.compile()).filter((s: string) => s).join('\n');
            inExprPosition = true
            const trailingWat = trailing.children.length > 0 ? trailing.children[0].compile() : '';
            inExprPosition = prev
            return [stmts, trailingWat].filter(s => s).join('\n');
        },
        namespace(first, _seps, rest) {
            return this.sourceString;
        },
        Literal(lit) {
            return lit.compile();
        },

        NonemptyListOf(first, _seps, rest) {
            // Handles expressions in arrays/objects/tuples.
            const results = [first.compile()];
            if (rest && rest.children) {
                rest.children.forEach((item: any) => {
                    if (item.children && item.children.length > 1) {
                        results.push(item.children[1].compile());
                    } else if (item.compile) {
                        results.push(item.compile());
                    }
                });
            }
            return results.join(' ');
        },

        EmptyListOf() {
            return '';
        },

        ArrayLiteral(_bracket, exps, _close) {
            // Emit a length-prefixed i32 array. Layout (matches std.wat):
            //   [length:i32][elem0:i32][elem1:i32] ...
            //
            // Uses $alloc_array(count, elem_bytes=4) to allocate, then stores
            // each element into (base + 4 + i*4). The whole block has an i32
            // result — the base pointer.
            //
            // Element coercion: for this POC we assume every element compiles
            // to an i32 value. The type checker catches Float arrays; when we
            // need Array[Float] support at runtime, we'll branch on element
            // type here and emit f32.store / $alloc_array(count, 8 … or use a
            // per-element-size call).
            const count = exps.children.length;
            const elemBytes = 4;

            // Collect per-element stores. Each store needs the base pointer
            // duplicated on the stack; we stash the base in a new local.
            const stores: string[] = [];
            for (let i = 0; i < count; i++) {
                const elemWat = exps.children[i].compile();
                stores.push(
                    `(i32.store offset=${4 + i * elemBytes} (local.get $addr) ${elemWat})`
                );
            }

            return `(block (result i32)
  (local.set $addr (call $alloc_array (i32.const ${count}) (i32.const ${elemBytes})))
  ${stores.join('\n  ')}
  (local.get $addr)
)`;
        },
        ObjectLiteral(_bracket, pairs, _close) {
            // Minimal placeholder: objects aren't in the surface type system
            // for this pass. Emit a zero pointer so codegen doesn't crash.
            return `(i32.const 0)`;
        },
        TupleLiteral(_bracket, exps, _close) {
            // Tuples are not yet supported in the type system.
            return `(i32.const 0)`;
        },
        KeyValuePair(id, _eq, exp) {
            return '';
        },
        stringLiteral(_quote, chars, _closedQuote) {
            // Allocate the string in the static data region and emit its
            // base address. The first four bytes at that address hold the
            // byte length; the payload (UTF-8 bytes) follows.
            const content = chars.sourceString;
            const addr = allocStaticString(staticData, content);
            return `(i32.const ${addr})`;
        },
        decLiteral(digits, _seps, _rest) {
            const raw = digits.sourceString.replace(/_/g, '');
            const n = parseInt(raw, 10);
            return `(i32.const ${n})`;
        },

        binLiteral(_prefix, bits, _seps, _rest) {
            const raw = _prefix.sourceString + bits.sourceString + (_rest?.sourceString ? _rest.sourceString : '');
            const n = parseInt(raw.slice(2).replace(/_/g, ''), 2);
            return `(i32.const ${n})`;
        },

        hexLiteral(_prefix, digits, _seps, _rest) {
            const raw = _prefix.sourceString + digits.sourceString + (_rest?.sourceString ? _rest.sourceString : '');
            const n = parseInt(raw.slice(2).replace(/_/g, ''), 16);
            return `(i32.const ${n})`;
        },

        octLiteral(_prefix, digits, _seps, _rest) {
            const raw = _prefix.sourceString + digits.sourceString + (_rest?.sourceString ? _rest.sourceString : '');
            const n = parseInt(raw.slice(2).replace(/_/g, ''), 8);
            return `(i32.const ${n})`;
        },

        floatLiteral(intDigits, _intSep, _dot, fracDigits, _fracSep) {
            const intStr = intDigits.sourceString + (_intSep?.sourceString ? _intSep.sourceString : '');
            const fracStr = fracDigits.sourceString + (_fracSep?.sourceString ? _fracSep.sourceString : '');
            const v = parseFloat(intStr.replace(/_/g, '') + '.' + fracStr.replace(/_/g, ''));
            return `(f32.const ${v})`;
        },
        booleanLiteral(lit) {
            return lit.sourceString === '@true' ? '(i32.const 1)' : '(i32.const 0)';
        },
        GenericParams(_open, ids, _close) {
            return '';
        },
        ParamLiteral_typedId(typedId) {
            const name = typedId.compile();
            const watName = toWatIdentifier(name);
            const typeName = typedId.type();
            const watType = typeName ? siliconTypeToWat(typeName) : 'i32';
            return `(param $${watName} ${watType})`;
        },
        ParamLiteral_literal(_lit) {
            return '';
        },
        defKw(_at, id) {
            return id.sourceString;
        },
        keyword(_at, id) {
            return id.sourceString;
        },
        typedIdentifier(id, type) {
            return id.sourceString;
        },
        type(_colon, id) {
            return '';
        },
        identifier_normal(letter, rest) {
            return letter.sourceString + rest.sourceString;
        },
        identifier_underscoreStart(underscore, rest) {
            return underscore.sourceString + rest.sourceString;
        },
    }).addOperation('type', {
        typedIdentifier(id, type) {
            return type.children.length > 0 ? type.children[0].type() : '';
        },
        type(_colon, id) {
            return id.sourceString;
        },
        // Default for other rules
        _terminal() {
            return '';
        },
        _nonterminal() {
            return '';
        }
    }).addOperation('isDefinition', {
        Element_item(item, _semi) { return item.isDefinition() },
        Element_elaboration(_elab, _semi) { return false },
        Element_docComment(_dc) { return false },
        Item_statement(stmt) { return stmt.isDefinition() },
        Item_expressionStart(_exp) { return false },
        Statement_definition(_def) { return true },
        Statement_assignment(_assgn) { return false },
    }).addOperation('compileArgList', {
        CallArgsOrEnd(argsOrEnd) { return argsOrEnd.compileArgList(); },
        CallArgs(_amp, args) { return args.compileArgList(); },
        CallNoArgs(_lookahead) { return []; },
        Args(exps) { return exps.asIteration().children.map((e: any) => e.compile()); },
        _nonterminal(..._args: any[]) { return []; },
        _terminal() { return []; },
        _iter(..._args: any[]) { return []; },
    })
    return semantics;
}
