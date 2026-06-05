// SPDX-License-Identifier: MIT
/**
 * Low-level compiler pipeline surface for first-party tools (the playground).
 *
 * The stable, semver-tracked public API lives at the package root
 * (`@silicon/compiler`, see `api.ts`).  This `@silicon/compiler/pipeline`
 * subpath intentionally exposes the raw pipeline stages — parse → elaborate →
 * typecheck → codegen — plus module/platform loading, for first-party tools
 * that need step-by-step access the high-level `compile()` facade abstracts
 * away (e.g. the playground, which surfaces WAT, WASM, and per-export type
 * info side by side).  It is NOT part of the stable surface and may change
 * with the compiler internals.
 */

export { parse } from './parser/index'
export { addToAstSemantics, type ASTNode, type Program } from './ast'
export { compileToWat, compileToWasm } from './codegen'
export { watToWasm } from './codegen/toWasm'
export { elaborate, buildStrataRegistry } from './elaborator'
export {
    typecheck,
    formatTypeError,
    formatType,
    wasmTypeOf,
    type FunctionSig,
} from './types'
export { siliconGrammar } from './grammar'
export { loadModules } from './modules'
export { inlineStdlibUses } from './modules/inlineUses'
export { loadPlatform, getRequiredExports, type PlatformConfig } from './platforms'
