/**
 * Silicon to WebAssembly Code Generation
 *
 * This module transforms the AST into WebAssembly Text format (WAT). This is
 * stage 3 of the compilation pipeline.
 *
 * Architecture:
 * - Implements Ohm's semantic action pattern
 * - Walks the parse tree recursively, generating WAT instructions
 * - Handles type inference (i32 vs f32 operations)
 * - Manages memory layout and function definitions
 *
 * Output:
 * - Valid WebAssembly text format that can be assembled with wat2wasm
 * - Includes standard memory (1 page) and heap setup
 * - Each function becomes a (func ...) definition
 *
 * @example
 *   const compileSemantics = addCompileSemantics(grammar)
 *   const wat = compileSemantics(match).compile()
 *   // wat is a string containing valid WAT code
 *
 * @see std.wat - Standard library and helper functions
 */

import * as ohm from 'ohm-js'
import { isWasmIntrinsic, getWasmIntrinsic } from '../intrinsics'

/**
 * Helper function to convert Silicon identifiers to WAT function names
 * Converts :: to _ for valid WAT identifiers
 */
function toWatIdentifier(siliconName: string): string {
    return siliconName.replace(/::/g, '_')
}

/**
 * Create semantic actions for AST to WAT compilation
 *
 * @param siliconGrammar - The compiled Ohm grammar
 * @returns Ohm semantics object with 'compile' operation
 */
export default function addCompileSemantics(siliconGrammar: ohm.Grammar) {
    const semantics = siliconGrammar.createSemantics().addOperation('compile', {
        Program(elements) {
            const body = elements.children.map(el => el.compile()).filter(s => s).join('\n');
            return `(module
(memory 1)
(global $heap (mut i32) (i32.const 1024))
${body}
)`;
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
        Assignment(ns, _eq, exp) {
            const name = ns.compile();
            const watName = toWatIdentifier(name);
            const value = exp.compile();
            return `(global.set $${watName} ${value})`;
        },
        Definition(kw, typedId, generics, params, binding) {
            const name = typedId.compile();
            const watName = toWatIdentifier(name);
            const paramList = params.children.map(p => p.compile()).join(' ');
            const body = binding ? binding.compile() : '';
            return `(func $${watName} ${paramList} (local $addr i32)\n${body}\n)`;
        },
        ExpressionStart_binChain(left, binOps, endOps) {
            let result = left.compile();
            // binOps is iteration of BinOp
            // endOps is iteration of ExpressionEnd
            if (binOps.children && binOps.children.length > 0) {
                for (let i = 0; i < binOps.children.length; i++) {
                    const op = binOps.children[i];
                    const right = endOps.children[i];
                    const right_wat = right.compile();
                    const op_wat = op.compile();

                    // Detect type from WAT
                    const isFloat = /f32\.const/.test(result) || /f32\.const/.test(right_wat);

                    let instr = '';
                    if (isFloat) {
                        switch (op_wat) {
                            case '+': instr = 'f32.add'; break;
                            case '-': instr = 'f32.sub'; break;
                            case '*': instr = 'f32.mul'; break;
                            case '/': instr = 'f32.div'; break;
                            default: throw new Error(`Unsupported operator for f32: ${op_wat}`);
                        }
                    } else {
                        switch (op_wat) {
                            case '+': instr = 'i32.add'; break;
                            case '-': instr = 'i32.sub'; break;
                            case '*': instr = 'i32.mul'; break;
                            case '/': instr = 'i32.div_s'; break;
                            case '%': instr = 'i32.rem_s'; break;
                            case '==': instr = 'i32.eq'; break;
                            case '!=': instr = 'i32.ne'; break;
                            case '<': instr = 'i32.lt_s'; break;
                            case '>': instr = 'i32.gt_s'; break;
                            case '<=': instr = 'i32.le_s'; break;
                            case '>=': instr = 'i32.ge_s'; break;
                            default: throw new Error(`Unsupported operator: ${op_wat}`);
                        }
                    }
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
            const argList = args ? args.compile() : '';
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
            return `(global.get $${watName})`;
        },
        ExpressionEnd_block(block) {
            return block.compile();
        },
        ExpressionEnd_paren(_open, exp, _close) {
            return exp.compile();
        },
        Binding(_bind, exp) {
            return exp.compile();
        },
        Block(_open, items, _semis, _close) {
            const body = items.children.map(i => i.compile()).filter(s => s).join('\n');
            return `(block\n${body}\n)`;
        },
        namespace(first, _seps, rest) {
            return this.sourceString;
        },
        Literal(lit) {
            return lit.compile();
        },

        NonemptyListOf(first, _seps, rest) {
            // This handles expressions in arrays/objects/tuples
            const results = [first.compile()];
            if (rest.children) {
                rest.children.forEach((item: any) => {
                    results.push(item.children[1].compile());
                });
            }
            return results.join(' ');
        },

        EmptyListOf() {
            return '';
        },

        ArrayLiteral(_bracket, exps, _close) {
            // Allocate array in linear memory
            let size = exps.children.length;
            // use STD allocator for arrays
            let alloc = `(call $alloc_array (i32.const ${size})) ;; allocate array of size ${size}`;
            let stores = exps.children.map((e, i) => {
                return `${alloc}\n${e.compile()}\ni32.store offset=${i * 4}`;
            }).join('\n');
            return `${alloc}\n${stores}\ni32.const ${size}\n`; // Return pointer and size
        },
        ObjectLiteral(_bracket, pairs, _close) {
            const fields = pairs.children.map(pair => {
                const typedId = pair.children[0];
                const exp = pair.children[2];
                return {
                    type: typedId.type(),
                    value: exp.compile()
                };
            });

            let offset = 0;
            const stores = fields.map(field => {
                const storeInstr = field.type === 'f32' ? 'f32.store' : 'i32.store';
                const store = `(local.get $addr) (i32.const ${offset}) i32.add ${field.value} ${storeInstr}`;
            }).join('\n');

            const size = offset;
            const alloc = `(call $alloc_array (i32.const ${size}))`;

            return `(block (result i32)\n  (local $addr i32)\n  ${alloc}\n  (local.set $addr)\n  ${stores}\n  (local.get $addr)\n)`;
        },
        TupleLiteral(_bracket, exps, _close) {
            throw new Error('Tuples not supported');
        },
        KeyValuePair(id, _eq, exp) {
            // Not used directly
            return '';
        },
        stringLiteral(_quote, chars, _closedQuote) {
            return 'i32.const 0';
        },
        decLiteral(digits, _seps, _rest) {
            const raw = digits.sourceString.replace(/_/g, '');
            const n = parseInt(raw, 10);
            return `i32.const ${n}`;
        },

        binLiteral(_prefix, bits, _seps, _rest) {
            const raw = _prefix.sourceString + bits.sourceString + (_rest?.sourceString ? _rest.sourceString : '');
            const n = parseInt(raw.slice(2).replace(/_/g, ''), 2);
            return `i32.const ${n}`;
        },

        hexLiteral(_prefix, digits, _seps, _rest) {
            const raw = _prefix.sourceString + digits.sourceString + (_rest?.sourceString ? _rest.sourceString : '');
            const n = parseInt(raw.slice(2).replace(/_/g, ''), 16);
            return `i32.const ${n}`;
        },

        octLiteral(_prefix, digits, _seps, _rest) {
            const raw = _prefix.sourceString + digits.sourceString + (_rest?.sourceString ? _rest.sourceString : '');
            const n = parseInt(raw.slice(2).replace(/_/g, ''), 8);
            return `i32.const ${n}`;
        },

        floatLiteral(intDigits, _intSep, _dot, fracDigits, _fracSep) {
            const intStr = intDigits.sourceString + (_intSep?.sourceString ? _intSep.sourceString : '');
            const fracStr = fracDigits.sourceString + (_fracSep?.sourceString ? _fracSep.sourceString : '');
            const v = parseFloat(intStr.replace(/_/g, '') + '.' + fracStr.replace(/_/g, ''));
            return `f32.const ${v}`;
        },
        booleanLiteral(lit) {
            return lit.sourceString === '@true' ? 'i32.const 1' : 'i32.const 0';
        },
        GenericParams(_open, ids, _close) {
            return ''; // Ignore generics for now
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
            return type.children.length > 0 ? type.type() : 'i32';
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
    })
    return semantics;
}