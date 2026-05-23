/**
 * Intrinsics Module - Main Entry Point
 *
 * This module exports the WASM intrinsic system for Silicon. Intrinsics are
 * built-in functions that provide direct access to WebAssembly capabilities
 * and cannot be defined within Silicon itself.
 *
 * Usage:
 * - Get intrinsic details: getWasmIntrinsic('WASM::i32_add')
 */

export {
    getWasmIntrinsic,
    resolveIntrinsicWasmInstr,
    type WasmIntrinsic,
} from './intrinsics'
