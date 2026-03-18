/**
 * WebAssembly Intrinsic Functions for Silicon
 * 
 * These intrinsics provide direct access to WebAssembly operations from within
 * Silicon code. They are namespaced under WASM (e.g., WASM::i32_add).
 * 
 * Design:
 * - Named with underscores replacing dots (i32.add -> i32_add)
 * - Minimal set needed to bootstrap the language
 * - Organized by category: arithmetic, comparison, memory, conversion, bitwise
 */

export interface WasmIntrinsic {
    /** Full name including namespace: WASM::func_name */
    name: string
    /** The underlying WebAssembly instruction or instruction sequence */
    wasmInstr: string
    /** Whether this is a binary operator (takes 2 operands) */
    binary: boolean
    /** Whether this is a unary operator (takes 1 operand) */
    unary: boolean
    /** Number of value stack inputs required */
    inputs: number
    /** Number of value stack outputs produced */
    outputs: number
    /** Description of what this intrinsic does */
    description: string
}

export const wasmIntrinsics: Record<string, WasmIntrinsic> = {
    // ============================================================================
    // Integer (i32) Arithmetic Operations
    // ============================================================================
    i32_add: {
        name: 'WASM::i32_add',
        wasmInstr: 'i32.add',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Add two i32 values'
    },
    i32_sub: {
        name: 'WASM::i32_sub',
        wasmInstr: 'i32.sub',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Subtract two i32 values'
    },
    i32_mul: {
        name: 'WASM::i32_mul',
        wasmInstr: 'i32.mul',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Multiply two i32 values'
    },
    i32_div_s: {
        name: 'WASM::i32_div_s',
        wasmInstr: 'i32.div_s',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Divide two signed i32 values'
    },
    i32_div_u: {
        name: 'WASM::i32_div_u',
        wasmInstr: 'i32.div_u',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Divide two unsigned i32 values'
    },
    i32_rem_s: {
        name: 'WASM::i32_rem_s',
        wasmInstr: 'i32.rem_s',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Remainder of dividing two signed i32 values'
    },
    i32_rem_u: {
        name: 'WASM::i32_rem_u',
        wasmInstr: 'i32.rem_u',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Remainder of dividing two unsigned i32 values'
    },

    // ============================================================================
    // Float (f32) Arithmetic Operations
    // ============================================================================
    f32_add: {
        name: 'WASM::f32_add',
        wasmInstr: 'f32.add',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Add two f32 values'
    },
    f32_sub: {
        name: 'WASM::f32_sub',
        wasmInstr: 'f32.sub',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Subtract two f32 values'
    },
    f32_mul: {
        name: 'WASM::f32_mul',
        wasmInstr: 'f32.mul',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Multiply two f32 values'
    },
    f32_div: {
        name: 'WASM::f32_div',
        wasmInstr: 'f32.div',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Divide two f32 values'
    },
    f32_abs: {
        name: 'WASM::f32_abs',
        wasmInstr: 'f32.abs',
        binary: false,
        unary: true,
        inputs: 1,
        outputs: 1,
        description: 'Absolute value of an f32'
    },
    f32_neg: {
        name: 'WASM::f32_neg',
        wasmInstr: 'f32.neg',
        binary: false,
        unary: true,
        inputs: 1,
        outputs: 1,
        description: 'Negate an f32 value'
    },
    f32_sqrt: {
        name: 'WASM::f32_sqrt',
        wasmInstr: 'f32.sqrt',
        binary: false,
        unary: true,
        inputs: 1,
        outputs: 1,
        description: 'Square root of an f32'
    },

    // ============================================================================
    // Integer Comparison Operations (return 1 for true, 0 for false)
    // ============================================================================
    i32_eq: {
        name: 'WASM::i32_eq',
        wasmInstr: 'i32.eq',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Test if two i32 values are equal'
    },
    i32_ne: {
        name: 'WASM::i32_ne',
        wasmInstr: 'i32.ne',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Test if two i32 values are not equal'
    },
    i32_lt_s: {
        name: 'WASM::i32_lt_s',
        wasmInstr: 'i32.lt_s',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Test if first signed i32 is less than second'
    },
    i32_lt_u: {
        name: 'WASM::i32_lt_u',
        wasmInstr: 'i32.lt_u',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Test if first unsigned i32 is less than second'
    },
    i32_le_s: {
        name: 'WASM::i32_le_s',
        wasmInstr: 'i32.le_s',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Test if first signed i32 is less than or equal to second'
    },
    i32_le_u: {
        name: 'WASM::i32_le_u',
        wasmInstr: 'i32.le_u',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Test if first unsigned i32 is less than or equal to second'
    },
    i32_gt_s: {
        name: 'WASM::i32_gt_s',
        wasmInstr: 'i32.gt_s',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Test if first signed i32 is greater than second'
    },
    i32_gt_u: {
        name: 'WASM::i32_gt_u',
        wasmInstr: 'i32.gt_u',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Test if first unsigned i32 is greater than second'
    },
    i32_ge_s: {
        name: 'WASM::i32_ge_s',
        wasmInstr: 'i32.ge_s',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Test if first signed i32 is greater than or equal to second'
    },
    i32_ge_u: {
        name: 'WASM::i32_ge_u',
        wasmInstr: 'i32.ge_u',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Test if first unsigned i32 is greater than or equal to second'
    },

    // ============================================================================
    // Float Comparison Operations (return 1 for true, 0 for false)
    // ============================================================================
    f32_eq: {
        name: 'WASM::f32_eq',
        wasmInstr: 'f32.eq',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Test if two f32 values are equal'
    },
    f32_ne: {
        name: 'WASM::f32_ne',
        wasmInstr: 'f32.ne',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Test if two f32 values are not equal'
    },
    f32_lt: {
        name: 'WASM::f32_lt',
        wasmInstr: 'f32.lt',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Test if first f32 is less than second'
    },
    f32_le: {
        name: 'WASM::f32_le',
        wasmInstr: 'f32.le',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Test if first f32 is less than or equal to second'
    },
    f32_gt: {
        name: 'WASM::f32_gt',
        wasmInstr: 'f32.gt',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Test if first f32 is greater than second'
    },
    f32_ge: {
        name: 'WASM::f32_ge',
        wasmInstr: 'f32.ge',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Test if first f32 is greater than or equal to second'
    },

    // ============================================================================
    // Bitwise Operations
    // ============================================================================
    i32_and: {
        name: 'WASM::i32_and',
        wasmInstr: 'i32.and',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Bitwise AND of two i32 values'
    },
    i32_or: {
        name: 'WASM::i32_or',
        wasmInstr: 'i32.or',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Bitwise OR of two i32 values'
    },
    i32_xor: {
        name: 'WASM::i32_xor',
        wasmInstr: 'i32.xor',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Bitwise XOR of two i32 values'
    },
    i32_shl: {
        name: 'WASM::i32_shl',
        wasmInstr: 'i32.shl',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Shift i32 value left by specified number of bits'
    },
    i32_shr_s: {
        name: 'WASM::i32_shr_s',
        wasmInstr: 'i32.shr_s',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Arithmetic shift i32 value right'
    },
    i32_shr_u: {
        name: 'WASM::i32_shr_u',
        wasmInstr: 'i32.shr_u',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Logical shift i32 value right'
    },
    i32_rotl: {
        name: 'WASM::i32_rotl',
        wasmInstr: 'i32.rotl',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Rotate i32 value left'
    },
    i32_rotr: {
        name: 'WASM::i32_rotr',
        wasmInstr: 'i32.rotr',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 1,
        description: 'Rotate i32 value right'
    },

    // ============================================================================
    // Unary Integer Operations
    // ============================================================================
    i32_clz: {
        name: 'WASM::i32_clz',
        wasmInstr: 'i32.clz',
        binary: false,
        unary: true,
        inputs: 1,
        outputs: 1,
        description: 'Count leading zeros in i32'
    },
    i32_ctz: {
        name: 'WASM::i32_ctz',
        wasmInstr: 'i32.ctz',
        binary: false,
        unary: true,
        inputs: 1,
        outputs: 1,
        description: 'Count trailing zeros in i32'
    },
    i32_popcnt: {
        name: 'WASM::i32_popcnt',
        wasmInstr: 'i32.popcnt',
        binary: false,
        unary: true,
        inputs: 1,
        outputs: 1,
        description: 'Count number of 1-bits in i32'
    },

    // ============================================================================
    // Type Conversions
    // ============================================================================
    i32_trunc_f32_s: {
        name: 'WASM::i32_trunc_f32_s',
        wasmInstr: 'i32.trunc_f32_s',
        binary: false,
        unary: true,
        inputs: 1,
        outputs: 1,
        description: 'Convert f32 to signed i32 by truncation'
    },
    i32_trunc_f32_u: {
        name: 'WASM::i32_trunc_f32_u',
        wasmInstr: 'i32.trunc_f32_u',
        binary: false,
        unary: true,
        inputs: 1,
        outputs: 1,
        description: 'Convert f32 to unsigned i32 by truncation'
    },
    f32_convert_i32_s: {
        name: 'WASM::f32_convert_i32_s',
        wasmInstr: 'f32.convert_i32_s',
        binary: false,
        unary: true,
        inputs: 1,
        outputs: 1,
        description: 'Convert signed i32 to f32'
    },
    f32_convert_i32_u: {
        name: 'WASM::f32_convert_i32_u',
        wasmInstr: 'f32.convert_i32_u',
        binary: false,
        unary: true,
        inputs: 1,
        outputs: 1,
        description: 'Convert unsigned i32 to f32'
    },

    // ============================================================================
    // Memory Operations
    // ============================================================================
    i32_load: {
        name: 'WASM::i32_load',
        wasmInstr: 'i32.load',
        binary: false,
        unary: true,
        inputs: 1,
        outputs: 1,
        description: 'Load i32 from linear memory at address'
    },
    i32_store: {
        name: 'WASM::i32_store',
        wasmInstr: 'i32.store',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 0,
        description: 'Store i32 to linear memory at address'
    },
    f32_load: {
        name: 'WASM::f32_load',
        wasmInstr: 'f32.load',
        binary: false,
        unary: true,
        inputs: 1,
        outputs: 1,
        description: 'Load f32 from linear memory at address'
    },
    f32_store: {
        name: 'WASM::f32_store',
        wasmInstr: 'f32.store',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 0,
        description: 'Store f32 to linear memory at address'
    },
    i32_load8_s: {
        name: 'WASM::i32_load8_s',
        wasmInstr: 'i32.load8_s',
        binary: false,
        unary: true,
        inputs: 1,
        outputs: 1,
        description: 'Load signed byte from linear memory and extend to i32'
    },
    i32_load8_u: {
        name: 'WASM::i32_load8_u',
        wasmInstr: 'i32.load8_u',
        binary: false,
        unary: true,
        inputs: 1,
        outputs: 1,
        description: 'Load unsigned byte from linear memory and extend to i32'
    },
    i32_store8: {
        name: 'WASM::i32_store8',
        wasmInstr: 'i32.store8',
        binary: true,
        unary: false,
        inputs: 2,
        outputs: 0,
        description: 'Store least significant byte of i32 to linear memory'
    },

    // ============================================================================
    // Utility / Control
    // ============================================================================
    data_memory: {
        name: 'WASM::data_memory',
        wasmInstr: 'memory.size',
        binary: false,
        unary: false,
        inputs: 0,
        outputs: 1,
        description: 'Get current size of linear memory in pages'
    },
    mem_grow: {
        name: 'WASM::mem_grow',
        wasmInstr: 'memory.grow',
        binary: false,
        unary: true,
        inputs: 1,
        outputs: 1,
        description: 'Grow linear memory by specified number of pages'
    },
}

/**
 * Check if a function name (with WASM:: namespace) is a known intrinsic
 */
export function isWasmIntrinsic(name: string): boolean {
    const match = name.match(/^WASM::(.+)$/)
    if (!match) return false
    return match[1] in wasmIntrinsics
}

/**
 * Get intrinsic metadata by full name (with WASM:: namespace)
 */
export function getWasmIntrinsic(name: string): WasmIntrinsic | undefined {
    const match = name.match(/^WASM::(.+)$/)
    if (!match) return undefined
    return wasmIntrinsics[match[1]]
}

/**
 * Get intrinsic metadata by short name (without WASM:: namespace)
 */
export function getWasmIntrinsicByShortName(shortName: string): WasmIntrinsic | undefined {
    return wasmIntrinsics[shortName]
}

/**
 * List all available WASM intrinsics with their full names
 */
export function listWasmIntrinsics(): string[] {
    return Object.values(wasmIntrinsics).map(intr => intr.name)
}
