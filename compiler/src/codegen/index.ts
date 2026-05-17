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
import type { LowerOptions } from '../ir/lower'
import type { Program } from '../ast/astNodes'
import type { ElaboratorRegistry } from '../elaborator/registry'
import type { FunctionSig } from '../types/typechecker'
import type { ModuleRegistry } from '../modules/registry'

export type { LowerTarget, LowerOptions } from '../ir/lower'

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
 * Strip the `env::print` / `env::read` imports and any helper functions
 * that reference them from std.wat.  Boot programs (target=wasix) run
 * under a WASI host that doesn't provide these; the host-embed targets
 * still want them so the playground / Bun runners keep working.
 */
function stripHostPrintImports(wat: string): string {
    let out = wat
        .replace(/^\(import "env" "print".*\)$\r?\n/m, '')
        .replace(/^\(import "env" "read".*\)$\r?\n/m, '')
    // Strip the four print helpers (each is a top-level (func ...) that
    // references $print or $read).  Walk paren depth so we land on the
    // matching close-paren regardless of internal structure.
    for (const name of ['$print_int', '$print_bool', '$print_float', '$print_string']) {
        const startMarker = `(func ${name}`
        const start = out.indexOf(startMarker)
        if (start < 0) continue
        let depth = 0
        let i = start
        for (; i < out.length; i++) {
            const c = out[i]
            if (c === '(') depth++
            else if (c === ')') { depth--; if (depth === 0) { i++; break } }
        }
        // Also gobble the trailing newline.
        while (i < out.length && (out[i] === '\r' || out[i] === '\n')) i++
        out = out.slice(0, start) + out.slice(i)
    }
    return out
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
    options: LowerOptions = {},
): string {
    const irModule = lowerProgram(program, registry, functionSigs, moduleRegistry, options)
    let std = loadStdWat()
    if (options.target === 'wasix') std = stripHostPrintImports(std)
    return emitModule(irModule, std)
}
