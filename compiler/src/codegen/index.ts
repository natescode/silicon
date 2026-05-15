/**
 * Code Generation Module
 *
 * Stage 3 of the compilation pipeline: lower the type-annotated AST to an
 * IRModule, then emit WebAssembly Text format (WAT).
 *
 * @see ../ir - IR nodes, lowering, and emission
 * @see std.wat - Silicon runtime (alloc, print helpers, memory layout)
 */

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { lowerProgram, emitModule } from '../ir'
import type { Program } from '../ast/astNodes'
import type { ElaboratorRegistry } from '../elaborator/registry'
import type { FunctionSig } from '../types/typechecker'
import type { ModuleRegistry } from '../modules/registry'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const STD_WAT_PATH = join(__dirname, 'std.wat')

let cachedStdWat: string | null = null

/** Load the Silicon runtime (std.wat) once per process. */
export function loadStdWat(): string {
    if (!cachedStdWat) {
        cachedStdWat = readFileSync(STD_WAT_PATH, 'utf-8')
    }
    return cachedStdWat
}

/**
 * Compile a type-checked Silicon program to a WAT string.
 *
 * Calls lowerProgram → emitModule with the inlined Silicon runtime.
 * Throws IRLowerError on any IR lowering failure.
 */
export function compileToWat(
    program: Program,
    registry: ElaboratorRegistry,
    functionSigs: Map<string, FunctionSig>,
    moduleRegistry?: ModuleRegistry,
): string {
    const irModule = lowerProgram(program, registry, functionSigs, moduleRegistry)
    return emitModule(irModule, loadStdWat())
}
