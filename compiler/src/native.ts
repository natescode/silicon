// SPDX-License-Identifier: MIT
/**
 * Silicon native backend (QBE) — public surface.
 *
 * Imported as `@silicon/compiler/native`.  This is the *pure* half of the
 * native path: front-end + QBE IR generation, no subprocesses.  The toolchain
 * drivers that locate/invoke `qbe` and `cc` live in the CLI package
 * (cli/src/native/) — the compiler library never shells out.
 */

// Front-end + QBE IR lowering as one call (mirrors compile() for native).
export { compileToQbe, type QbeResult } from './codegen/qbe/compileToQbe'

// Lower-level QBE IR transforms (pure).
export { lowerToQbe } from './codegen/qbe/lower'
export { injectMainWrapper, hasQbeMain } from './codegen/qbe/wrapper'
