/**
 * Intrinsics Module - Main Entry Point
 *
 * This module exports the WASM intrinsic system for Silicon. Intrinsics are
 * built-in functions that provide direct access to WebAssembly capabilities
 * and cannot be defined within Silicon itself.
 *
 * Usage:
 * - Check if a function is an intrinsic: isWasmIntrinsic('WASM::i32_add')
 * - Get intrinsic details: getWasmIntrinsic('WASM::i32_add')
 * - List all intrinsics: listWasmIntrinsics()
 */

export {
    wasmIntrinsics,
    isWasmIntrinsic,
    getWasmIntrinsic,
    getWasmIntrinsicByShortName,
    listWasmIntrinsics,
    type WasmIntrinsic,
} from './intrinsics'
