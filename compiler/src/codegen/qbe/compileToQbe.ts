// SPDX-License-Identifier: MIT
/**
 * compileToQbe — front-end + QBE IR lowering as one call.
 *
 * Mirrors `compile()` (the wasm path) for the native backend: runs
 * parse → elaborate → typecheck, then lowers to QBE IR text with a `main`
 * wrapper injected.  Returns at the first phase that produces diagnostics.
 */

import {
    parse, buildRegistry, elaborate, typecheck,
    type ParseOptions, type ElabOptions, type CheckOptions, type Diagnostic,
} from '../../caas/index'
import { lowerToQbe } from './lower'
import { injectMainWrapper } from './wrapper'

export interface QbeResult {
    readonly qbeIr: string
    readonly diagnostics: readonly Diagnostic[]
}

export function compileToQbe(
    source: string,
    options: ParseOptions & ElabOptions & CheckOptions = {},
): QbeResult {
    const parseResult = parse(source, options)
    if (parseResult.diagnostics.length > 0) return { qbeIr: '', diagnostics: parseResult.diagnostics }

    const registry = buildRegistry(parseResult.tree, options.extraSources)
    const elabResult = elaborate(parseResult.tree, registry, options)
    if (elabResult.diagnostics.length > 0) return { qbeIr: '', diagnostics: elabResult.diagnostics }

    const checkResult = typecheck(elabResult.tree, elabResult.registry, options)
    if (checkResult.diagnostics.length > 0) return { qbeIr: '', diagnostics: checkResult.diagnostics }

    try {
        const ir = injectMainWrapper(
            lowerToQbe(checkResult.tree.program, elabResult.registry, checkResult._functions),
        )
        return { qbeIr: ir, diagnostics: [] }
    } catch (err) {
        const diag: Diagnostic = {
            phase: 'lower', code: 'E0010',
            span: { file: options.file ?? '<input>', line: 1, col: 1, length: 0 },
            message: err instanceof Error ? err.message : String(err),
        }
        return { qbeIr: '', diagnostics: [diag] }
    }
}
