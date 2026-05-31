// SPDX-License-Identifier: MIT
// QBE backend — pure compiler surface (IR generation + text transforms).
// Toolchain drivers that shell out to `qbe` / `cc` live in the CLI package
// (cli/src/native/), not here — the compiler library never spawns a subprocess.
export { lowerToQbe } from './lower'
export { siliconTypeToQbe, siliconTypeToQbeReturn, watInstrToQbeInstr, lookupOpToQbe, abstractOpToQbe } from './types'
export type { QbeType, QbeReturnType } from './types'
export { hasQbeMain, injectMainWrapper } from './wrapper'
export { compileToQbe, type QbeResult } from './compileToQbe'
