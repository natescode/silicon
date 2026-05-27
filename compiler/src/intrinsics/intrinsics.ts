/**
 * WebAssembly Intrinsic Registry
 *
 * Maps WASM::* names used in strata definitions to the actual WAT instruction
 * strings emitted by the IR lowerer. The IR path (lower.ts → emit.ts) is the
 * only consumer; the old Ohm codegen has been removed.
 *
 * Naming convention: underscores replace dots (i32.add → WASM::i32_add).
 */

export interface WasmIntrinsic {
    /** Full name including namespace: WASM::func_name */
    name: string
    /** The WAT instruction string emitted for this intrinsic (e.g. 'i32.add'). */
    wasmInstr: string
    /** Human-readable description for tooling and diagnostics. */
    description: string
}

export const wasmIntrinsics: Record<string, WasmIntrinsic> = {
    // -------------------------------------------------------------------------
    // Integer (i32) Arithmetic
    // -------------------------------------------------------------------------
    i32_add:   { name: 'WASM::i32_add',   wasmInstr: 'i32.add',   description: 'Add two i32 values' },
    i32_sub:   { name: 'WASM::i32_sub',   wasmInstr: 'i32.sub',   description: 'Subtract two i32 values' },
    i32_mul:   { name: 'WASM::i32_mul',   wasmInstr: 'i32.mul',   description: 'Multiply two i32 values' },
    i32_div_s: { name: 'WASM::i32_div_s', wasmInstr: 'i32.div_s', description: 'Signed i32 division' },
    i32_div_u: { name: 'WASM::i32_div_u', wasmInstr: 'i32.div_u', description: 'Unsigned i32 division' },
    i32_rem_s: { name: 'WASM::i32_rem_s', wasmInstr: 'i32.rem_s', description: 'Signed i32 remainder' },
    i32_rem_u: { name: 'WASM::i32_rem_u', wasmInstr: 'i32.rem_u', description: 'Unsigned i32 remainder' },

    // -------------------------------------------------------------------------
    // Float (f32) Arithmetic
    // -------------------------------------------------------------------------
    f32_add:  { name: 'WASM::f32_add',  wasmInstr: 'f32.add',  description: 'Add two f32 values' },
    f32_sub:  { name: 'WASM::f32_sub',  wasmInstr: 'f32.sub',  description: 'Subtract two f32 values' },
    f32_mul:  { name: 'WASM::f32_mul',  wasmInstr: 'f32.mul',  description: 'Multiply two f32 values' },
    f32_div:  { name: 'WASM::f32_div',  wasmInstr: 'f32.div',  description: 'Divide two f32 values' },
    f32_abs:  { name: 'WASM::f32_abs',  wasmInstr: 'f32.abs',  description: 'Absolute value of f32' },
    f32_neg:  { name: 'WASM::f32_neg',  wasmInstr: 'f32.neg',  description: 'Negate an f32 value' },
    f32_sqrt: { name: 'WASM::f32_sqrt', wasmInstr: 'f32.sqrt', description: 'Square root of f32' },

    // -------------------------------------------------------------------------
    // Integer Comparison (return i32 1/0)
    // -------------------------------------------------------------------------
    i32_eq:   { name: 'WASM::i32_eq',   wasmInstr: 'i32.eq',   description: 'i32 equality' },
    i32_ne:   { name: 'WASM::i32_ne',   wasmInstr: 'i32.ne',   description: 'i32 inequality' },
    i32_lt_s: { name: 'WASM::i32_lt_s', wasmInstr: 'i32.lt_s', description: 'Signed i32 less-than' },
    i32_lt_u: { name: 'WASM::i32_lt_u', wasmInstr: 'i32.lt_u', description: 'Unsigned i32 less-than' },
    i32_le_s: { name: 'WASM::i32_le_s', wasmInstr: 'i32.le_s', description: 'Signed i32 ≤' },
    i32_le_u: { name: 'WASM::i32_le_u', wasmInstr: 'i32.le_u', description: 'Unsigned i32 ≤' },
    i32_gt_s: { name: 'WASM::i32_gt_s', wasmInstr: 'i32.gt_s', description: 'Signed i32 greater-than' },
    i32_gt_u: { name: 'WASM::i32_gt_u', wasmInstr: 'i32.gt_u', description: 'Unsigned i32 greater-than' },
    i32_ge_s: { name: 'WASM::i32_ge_s', wasmInstr: 'i32.ge_s', description: 'Signed i32 ≥' },
    i32_ge_u: { name: 'WASM::i32_ge_u', wasmInstr: 'i32.ge_u', description: 'Unsigned i32 ≥' },
    i32_eqz:  { name: 'WASM::i32_eqz',  wasmInstr: 'i32.eqz',  description: 'Test if i32 is zero (logical NOT)' },

    // -------------------------------------------------------------------------
    // Float Comparison (return i32 1/0)
    // -------------------------------------------------------------------------
    f32_eq: { name: 'WASM::f32_eq', wasmInstr: 'f32.eq', description: 'f32 equality' },
    f32_ne: { name: 'WASM::f32_ne', wasmInstr: 'f32.ne', description: 'f32 inequality' },
    f32_lt: { name: 'WASM::f32_lt', wasmInstr: 'f32.lt', description: 'f32 less-than' },
    f32_le: { name: 'WASM::f32_le', wasmInstr: 'f32.le', description: 'f32 ≤' },
    f32_gt: { name: 'WASM::f32_gt', wasmInstr: 'f32.gt', description: 'f32 greater-than' },
    f32_ge: { name: 'WASM::f32_ge', wasmInstr: 'f32.ge', description: 'f32 ≥' },

    // -------------------------------------------------------------------------
    // Bitwise / Shift
    // -------------------------------------------------------------------------
    i32_and:  { name: 'WASM::i32_and',  wasmInstr: 'i32.and',  description: 'Bitwise AND' },
    i32_or:   { name: 'WASM::i32_or',   wasmInstr: 'i32.or',   description: 'Bitwise OR' },
    i32_xor:  { name: 'WASM::i32_xor',  wasmInstr: 'i32.xor',  description: 'Bitwise XOR' },
    i32_shl:  { name: 'WASM::i32_shl',  wasmInstr: 'i32.shl',  description: 'Shift left' },
    i32_shr_s:{ name: 'WASM::i32_shr_s',wasmInstr: 'i32.shr_s',description: 'Arithmetic shift right' },
    i32_shr_u:{ name: 'WASM::i32_shr_u',wasmInstr: 'i32.shr_u',description: 'Logical shift right' },
    i32_rotl: { name: 'WASM::i32_rotl', wasmInstr: 'i32.rotl', description: 'Rotate left' },
    i32_rotr: { name: 'WASM::i32_rotr', wasmInstr: 'i32.rotr', description: 'Rotate right' },
    i32_clz:  { name: 'WASM::i32_clz',  wasmInstr: 'i32.clz',  description: 'Count leading zeros' },
    i32_ctz:  { name: 'WASM::i32_ctz',  wasmInstr: 'i32.ctz',  description: 'Count trailing zeros' },
    i32_popcnt:{ name: 'WASM::i32_popcnt',wasmInstr:'i32.popcnt',description:'Count set bits' },

    // -------------------------------------------------------------------------
    // Type Conversions
    // -------------------------------------------------------------------------
    i32_trunc_f32_s: { name: 'WASM::i32_trunc_f32_s', wasmInstr: 'i32.trunc_f32_s', description: 'f32 → signed i32 (truncate)' },
    i32_trunc_f32_u: { name: 'WASM::i32_trunc_f32_u', wasmInstr: 'i32.trunc_f32_u', description: 'f32 → unsigned i32 (truncate)' },
    f32_convert_i32_s: { name: 'WASM::f32_convert_i32_s', wasmInstr: 'f32.convert_i32_s', description: 'signed i32 → f32' },
    f32_convert_i32_u: { name: 'WASM::f32_convert_i32_u', wasmInstr: 'f32.convert_i32_u', description: 'unsigned i32 → f32' },
    i64_extend_i32_s:  { name: 'WASM::i64_extend_i32_s',  wasmInstr: 'i64.extend_i32_s',  description: 'signed i32 → i64 (sign-extend)' },
    i64_extend_i32_u:  { name: 'WASM::i64_extend_i32_u',  wasmInstr: 'i64.extend_i32_u',  description: 'unsigned i32 → i64 (zero-extend)' },
    i32_wrap_i64:      { name: 'WASM::i32_wrap_i64',      wasmInstr: 'i32.wrap_i64',      description: 'i64 → i32 (drop high bits)' },

    // -------------------------------------------------------------------------
    // Integer (i64) Arithmetic
    // -------------------------------------------------------------------------
    i64_add:   { name: 'WASM::i64_add',   wasmInstr: 'i64.add',   description: 'Add two i64 values' },
    i64_sub:   { name: 'WASM::i64_sub',   wasmInstr: 'i64.sub',   description: 'Subtract two i64 values' },
    i64_mul:   { name: 'WASM::i64_mul',   wasmInstr: 'i64.mul',   description: 'Multiply two i64 values' },
    i64_div_s: { name: 'WASM::i64_div_s', wasmInstr: 'i64.div_s', description: 'Signed i64 division' },
    i64_div_u: { name: 'WASM::i64_div_u', wasmInstr: 'i64.div_u', description: 'Unsigned i64 division' },
    i64_rem_s: { name: 'WASM::i64_rem_s', wasmInstr: 'i64.rem_s', description: 'Signed i64 remainder' },
    i64_rem_u: { name: 'WASM::i64_rem_u', wasmInstr: 'i64.rem_u', description: 'Unsigned i64 remainder' },

    // -------------------------------------------------------------------------
    // Integer (i64) Comparison (return i32 1/0)
    // -------------------------------------------------------------------------
    i64_eq:   { name: 'WASM::i64_eq',   wasmInstr: 'i64.eq',   description: 'i64 equality' },
    i64_ne:   { name: 'WASM::i64_ne',   wasmInstr: 'i64.ne',   description: 'i64 inequality' },
    i64_lt_s: { name: 'WASM::i64_lt_s', wasmInstr: 'i64.lt_s', description: 'Signed i64 less-than' },
    i64_lt_u: { name: 'WASM::i64_lt_u', wasmInstr: 'i64.lt_u', description: 'Unsigned i64 less-than' },
    i64_le_s: { name: 'WASM::i64_le_s', wasmInstr: 'i64.le_s', description: 'Signed i64 ≤' },
    i64_le_u: { name: 'WASM::i64_le_u', wasmInstr: 'i64.le_u', description: 'Unsigned i64 ≤' },
    i64_gt_s: { name: 'WASM::i64_gt_s', wasmInstr: 'i64.gt_s', description: 'Signed i64 greater-than' },
    i64_gt_u: { name: 'WASM::i64_gt_u', wasmInstr: 'i64.gt_u', description: 'Unsigned i64 greater-than' },
    i64_ge_s: { name: 'WASM::i64_ge_s', wasmInstr: 'i64.ge_s', description: 'Signed i64 ≥' },
    i64_ge_u: { name: 'WASM::i64_ge_u', wasmInstr: 'i64.ge_u', description: 'Unsigned i64 ≥' },
    i64_eqz:  { name: 'WASM::i64_eqz',  wasmInstr: 'i64.eqz',  description: 'Test if i64 is zero' },

    // -------------------------------------------------------------------------
    // Bitwise / Shift (i64)
    // -------------------------------------------------------------------------
    i64_and:   { name: 'WASM::i64_and',   wasmInstr: 'i64.and',   description: 'Bitwise AND (i64)' },
    i64_or:    { name: 'WASM::i64_or',    wasmInstr: 'i64.or',    description: 'Bitwise OR (i64)' },
    i64_xor:   { name: 'WASM::i64_xor',   wasmInstr: 'i64.xor',   description: 'Bitwise XOR (i64)' },
    i64_shl:   { name: 'WASM::i64_shl',   wasmInstr: 'i64.shl',   description: 'Shift left (i64)' },
    i64_shr_s: { name: 'WASM::i64_shr_s', wasmInstr: 'i64.shr_s', description: 'Arithmetic shift right (i64)' },
    i64_shr_u: { name: 'WASM::i64_shr_u', wasmInstr: 'i64.shr_u', description: 'Logical shift right (i64)' },

    // -------------------------------------------------------------------------
    // Memory (i64)
    // -------------------------------------------------------------------------
    i64_load:  { name: 'WASM::i64_load',  wasmInstr: 'i64.load',  description: 'Load i64 from memory' },
    i64_store: { name: 'WASM::i64_store', wasmInstr: 'i64.store', description: 'Store i64 to memory' },

    // -------------------------------------------------------------------------
    // Memory
    // -------------------------------------------------------------------------
    i32_load:    { name: 'WASM::i32_load',    wasmInstr: 'i32.load',    description: 'Load i32 from memory' },
    i32_store:   { name: 'WASM::i32_store',   wasmInstr: 'i32.store',   description: 'Store i32 to memory' },
    f32_load:    { name: 'WASM::f32_load',    wasmInstr: 'f32.load',    description: 'Load f32 from memory' },
    f32_store:   { name: 'WASM::f32_store',   wasmInstr: 'f32.store',   description: 'Store f32 to memory' },
    i32_load8_s: { name: 'WASM::i32_load8_s', wasmInstr: 'i32.load8_s', description: 'Load signed byte, extend to i32' },
    i32_load8_u: { name: 'WASM::i32_load8_u', wasmInstr: 'i32.load8_u', description: 'Load unsigned byte, extend to i32' },
    i32_store8:  { name: 'WASM::i32_store8',  wasmInstr: 'i32.store8',  description: 'Store least-significant byte' },

    // -------------------------------------------------------------------------
    // Utility
    // -------------------------------------------------------------------------
    data_memory: { name: 'WASM::data_memory', wasmInstr: 'memory.size', description: 'Current memory size in pages' },
    mem_grow:    { name: 'WASM::mem_grow',    wasmInstr: 'memory.grow', description: 'Grow memory by N pages' },

    // -------------------------------------------------------------------------
    // Logical Short-Circuit (emitted as IRIf by lowerBinaryOp / lowerBuiltinCall)
    // -------------------------------------------------------------------------
    control_or:  { name: 'WASM::control_or',  wasmInstr: 'if', description: 'Short-circuit OR — IRIf cond (then 1) (else right)' },
    control_and: { name: 'WASM::control_and', wasmInstr: 'if', description: 'Short-circuit AND — IRIf cond (then right) (else 0)' },

    // -------------------------------------------------------------------------
    // Structural Control Flow (emitted as IR nodes by lowerBuiltinCall)
    // -------------------------------------------------------------------------
    control_if:       { name: 'WASM::control_if',       wasmInstr: 'if',     description: 'WAT if/then/else — used by @if stratum' },
    control_loop:     { name: 'WASM::control_loop',     wasmInstr: 'loop',   description: 'WAT block/loop — used by @loop stratum' },
    control_break:    { name: 'WASM::control_break',    wasmInstr: 'br',     description: 'Branch to loop exit — used by @break stratum' },
    control_continue: { name: 'WASM::control_continue', wasmInstr: 'br',     description: 'Branch to loop header — used by @continue stratum' },
    control_return:   { name: 'WASM::control_return',   wasmInstr: 'return', description: 'Return from function — used by @return stratum' },
    control_match:    { name: 'WASM::control_match',    wasmInstr: 'if',     description: 'Nested if/else chain — used by @match stratum' },

}

export function getWasmIntrinsic(name: string): WasmIntrinsic | undefined {
    const m = name.match(/^WASM::(.+)$/)
    if (!m) return undefined
    return wasmIntrinsics[m[1]]
}

/**
 * Resolve an intrinsic name (either `WASM::foo` or `IR::foo`) to its WAT
 * instruction string.  IR::foo is an alias for WASM::foo at the instruction
 * level — strata use `IR::` to signal that the construct lives at the IR
 * layer, while the underlying WAT instruction is the same.
 */
export function resolveIntrinsicWasmInstr(name: string): string | undefined {
    if (name.startsWith('WASM::')) return wasmIntrinsics[name.slice(6)]?.wasmInstr
    if (name.startsWith('IR::'))   return wasmIntrinsics[name.slice(4)]?.wasmInstr
    return undefined
}

/**
 * Resolve an intrinsic name (`WASM::foo` or `IR::foo`) to its AbstractOp key.
 * Returns the registry key (e.g. `'i32_add'`) for binary ops that map to
 * IRBinOp.  Returns undefined for memory/control/unary ops that map to IRCall.
 */
export function resolveIntrinsicAbstractOp(name: string): string | undefined {
    const key = name.startsWith('WASM::') ? name.slice(6)
              : name.startsWith('IR::')   ? name.slice(4)
              : undefined
    if (!key || !wasmIntrinsics[key]) return undefined
    return key
}
