/**
 * Shared compilation helpers for property tests.
 *
 * Mirrors src/e2e/e2e.test.ts's compileSource but returns just what each
 * property test needs (WAT, AST, IR, registry) so tests can focus on assertions.
 */

import { join } from 'path'
import { parse } from '../../src/parser/index.ts'
import { addToAstSemantics, type ASTNode, type Program } from '../../src/ast/index.ts'
import { compileToWat } from '../../src/codegen/index.ts'
import { buildStrataRegistry, elaborate, type ElaboratorRegistry } from '../../src/elaborator/index.ts'
import { typecheck, formatTypeError, type FunctionSig } from '../../src/types/index.ts'
import { siliconGrammar } from '../../src/grammar/index.ts'
import { loadModules, type ModuleRegistry } from '../../src/modules/index.ts'
import { lowerProgram, type IRModule } from '../../src/ir/index.ts'

const PROJECT_ROOT = join(import.meta.dirname, '../..')

/**
 * Compile Silicon source to WAT. Throws with the first error class encountered.
 * Each call loads its own ModuleRegistry so we exercise the disk-read path.
 */
export function compileToWatString(source: string): string {
    const { typedAST, registry, functions, moduleRegistry } = compileToTyped(source)
    return compileToWat(typedAST, registry, functions, moduleRegistry)
}

export interface TypedCompileResult {
    rawAST: Program
    typedAST: Program
    registry: ElaboratorRegistry
    functions: Map<string, FunctionSig>
    moduleRegistry: ModuleRegistry
}

/**
 * Run the pipeline up through type-checking. Returns the raw + typed AST,
 * the strata registry, function signatures, and the module registry. Throws
 * on parse / elaboration / type errors so the caller only ever sees a clean
 * tree.
 */
export function compileToTyped(source: string): TypedCompileResult {
    const moduleRegistry = loadModules(PROJECT_ROOT)
    const match = parse(source)
    const rawAST = addToAstSemantics(siliconGrammar)(match).toAst() as Program
    const registry = buildStrataRegistry(rawAST)

    const { program: elabAST, errors: elabErrors } = elaborate(rawAST, registry)
    if (elabErrors.length > 0) {
        throw new Error('elab: ' + elabErrors.map(e => e.message).join('; '))
    }

    const { program: typedAST, errors: typeErrors, functions } = typecheck(elabAST, registry)
    if (typeErrors.length > 0) {
        throw new Error('type: ' + typeErrors.map(formatTypeError).join('; '))
    }

    return { rawAST, typedAST, registry, functions, moduleRegistry }
}

/**
 * Run the pipeline through IR lowering. Returns the lowered IRModule plus
 * everything compileToTyped returned. Throws on any pre-IR error.
 */
export function compileToIR(source: string): TypedCompileResult & { ir: IRModule } {
    const result = compileToTyped(source)
    const ir = lowerProgram(result.typedAST, result.registry, result.functions, result.moduleRegistry)
    return { ...result, ir }
}
