import * as ohm from 'ohm-js'
import { IndentStyle } from 'typescript';

/*
These are the semantics for compiling Silicon into Web Assembly. This version
c[semantics wrapper for Silicon]ompiles to WAT (Web Assembly text format). Tools like Wat2Wasm.
Mac:
    #install
    brew install wabt
    #convert WAT to WASM
    wat2wasm main.wat -o main.wasm
*/
export default function addCompileSemantics(siliconGrammar: ohm.Grammar) {
    // Helper function
    function getTypeSize(type: string): number {
        switch (type) {
            case 'i32':
            case 'f32':
                return 4;
            default:
                return 4; // default to 4 bytes
        }
    }

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
            // Ignore doc comments in WAT
            return '';
        },
        Item_statement(stmt) {
            return stmt.compile();
        },
        Item(exp) {
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
            const value = exp.compile();
            return `(global.set $${name} ${value})`;
        },
        Definition(kw, typedId, generics, params, binding) {
            const name = typedId.compile();
            const paramList = params.children.map(p => p.compile()).join(' ');
            const body = binding ? binding.compile() : '';
            return `(func $${name} ${paramList} (local $addr i32)\n${body}\n)`;
        },
        ExpressionStart_binOp(left, op, right) {
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
            const argList = args ? args.compile() : '';
            return `(call $${funcName} ${argList})`;
        },
        Args(exps) {
            return exps.children.map(e => e.compile()).join(' ');
        },
        ExpressionEnd_literal(lit) {
            return lit.compile();
        },
        ExpressionEnd_namespace(ns) {
            return `(global.get $${ns.compile()})`;
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
        Block(_open, items, _close) {
            const body = items.children.map(i => i.compile()).filter(s => s).join('\n');
            return `(block\n${body}\n)`;
        },
        namespace(id, rest) {
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
        decLiteral() {
            const raw = this.sourceString.replace(/_/g, '');
            const n = parseInt(raw, 10);
            return `i32.const ${n}`;
        },
        binLiteral() {
            const raw = this.sourceString.slice(2).replace(/_/g, '');
            const n = parseInt(raw, 2);
            return `i32.const ${n}`;
        },
        hexLiteral() {
            const raw = this.sourceString.slice(2).replace(/_/g, '');
            const n = parseInt(raw, 16);
            return `i32.const ${n}`;
        },
        octLiteral() {
            const raw = this.sourceString.slice(2).replace(/_/g, '');
            const n = parseInt(raw, 8);
            return `i32.const ${n}`;
        },
        floatLiteral() {
            const raw = this.sourceString.replace(/_/g, '');
            const v = parseFloat(raw);
            return `f32.const ${v}`;
        },
        booleanLiteral() {
            return this.sourceString === '@true' ? 'i32.const 1' : 'i32.const 0';
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