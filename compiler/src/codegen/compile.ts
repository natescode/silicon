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
        Element(docComment) {
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
        ExpressionStart_binChain(left, op, right) {
            const left_wat = left.compile();
            const right_wat = right.compile();
            const op_wat = op.compile();

            // if (op_wat === '.') {
            //     // Member access: assume right is int literal for field index (0-based)
            //     const indexMatch = right_wat.match(/i32\.const (\d+)/);
            //     if (!indexMatch) {
            //         throw new Error('Member access right side must be an integer literal for field index');
            //     }
            //     const index = parseInt(indexMatch[1]);
            //     const offset = index * 4;
            //     return `${left_wat} (i32.const ${offset}) i32.add i32.load`;
            // }

            // Detect type from WAT
            const isFloat = /f32\.const/.test(left_wat) || /f32\.const/.test(right_wat);

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
                    default: throw new Error(`Unsupported operator: ${op_wat}`);
                }
            }

            return `${left_wat}\n${right_wat}\n${instr}`;
        },
        ExpressionStart_functionCall(call) {
            return call.compile();
        },
        ExpressionStart(expEnd) {
            return expEnd.compile();
        },
        BinOp(op) {
            return op.sourceString;
        },
        FunctionCall(_sigil, body) {
            return body.compile();
        },
        FunctionCallBody_builtinFunctionCall(kw, args) {
            const funcName = kw.compile();
            const argList = args ? args.compile() : '';
            return `(call $${funcName} ${argList})`;
        },
        FunctionCallBody_userFunctionCall(ns, args) {
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
        Assign(_eq, exp) {
            return exp.compile();
        },
        Binding(_bind, exp) {
            return exp.compile();
        },
        Block(_open, items, _semi, _close) {
            const body = items.children.map(i => i.compile()).filter(s => s).join('\n');
            return `(block\n${body}\n)`;
        },
        namespace(first, _colon, rest) {
            return this.sourceString;
        },
        Literal_array(arr) {
            return arr.compile();
        },
        Literal_object(obj) {
            throw new Error('Object literals not supported in WAT compilation yet');
        },
        Literal_tuple(tup) {
            throw new Error('Tuple literals not supported in WAT compilation yet');
        },
        Literal_string(str) {
            return 'i32.const 0'; // Placeholder
        },
        Literal_int(int) {
            return int.compile();
        },
        Literal_float(flt) {
            return flt.compile();
        },
        Literal_bool(bool) {
            return bool.compile();
        },
        // use STD allocator for arrays
        ArrayLiteral(_sigil, exps, _close) {
            // Allocate array in linear memory
            let size = exps.children.length;
            // use STD allocator for arrays
            let alloc = `(call $alloc_array (i32.const ${size})) ;; allocate array of size ${size}`;
            let stores = exps.children.map((e, i) => {
                return `${alloc}\n${e.compile()}\ni32.store offset=${i * 4}`;
            }).join('\n');
            return `${alloc}\n${stores}\ni32.const ${size}\n`; // Return pointer and size
        },
        /// ${name: type = value, ...}
        ObjectLiteral(_sigil, pairs, _close) {
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
        TupleLiteral(_sigil, exps, _close) {
            throw new Error('Tuples not supported');
        },
        KeyValuePair(id, _eq, exp) {
            // Not used directly
            return '';
        },
        stringLiteral(_quote, chars, _quote2) {
            return 'i32.const 0';
        },
        intLiteral_dec(dec) {
            return dec.compile();
        },
        intLiteral_bin(bin) {
            return bin.compile();
        },
        intLiteral_hex(hex) {
            return hex.compile();
        },
        intLiteral_oct(oct) {
            return oct.compile();
        },
        decLiteral(lit) {
            const raw = lit.sourceString.replace(/_/g, '');
            const n = parseInt(raw, 10);
            return `i32.const ${n}`;
        },
        binLiteral(_prefix, bits, _rest) {
            const raw = _prefix.sourceString + bits.sourceString + (_rest ? _rest.sourceString : '');
            const n = parseInt(raw.slice(2).replace(/_/g, ''), 2);
            return `i32.const ${n}`;
        },
        hexLiteral(_prefix, digits, _rest) {
            const raw = _prefix.sourceString + digits.sourceString + (_rest ? _rest.sourceString : '');
            const n = parseInt(raw.slice(2).replace(/_/g, ''), 16);
            return `i32.const ${n}`;
        },
        octLiteral(_prefix, digits, _rest) {
            const raw = _prefix.sourceString + digits.sourceString + (_rest ? _rest.sourceString : '');
            const n = parseInt(raw.slice(2).replace(/_/g, ''), 8);
            return `i32.const ${n}`;
        },
        floatLiteral(intPart, _rest, fracPart) {
            const raw = intPart.sourceString + _rest.sourceString + fracPart.sourceString;
            const v = parseFloat(raw.replace(/_/g, ''));
            return `f32.const ${v}`;
        },
        booleanLiteral(lit) {
            return lit.sourceString === '@true' ? 'i32.const 1' : 'i32.const 0';
        },
        GenericParams(_open, ids, _close) {
            return ''; // Ignore generics for now
        },
        ParamLiteral_typed(typedId) {
            return `(param $${typedId.compile()} i32)`; // Assume i32 for now
        },
        ParamLiteral_literal(lit) {
            return lit.compile();
        },
        Params(id, rest) {
            const params = [id].concat(rest.children).map(p => `(param $${p.compile()} i32)`).join(' ');
            return params;
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
        discard() {
            return '_';
        },
        identifier() {
            return this.sourceString;
        }
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