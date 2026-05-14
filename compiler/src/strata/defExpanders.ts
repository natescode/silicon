/**
 * Built-in IR Definition Expanders
 *
 * Each entry maps a CodegenKind to an IRDefExpander that emits the correct
 * IR node(s) for a Definition AST node.  Registered into the ElaboratorRegistry
 * by strataLoader.ts so lower.ts never needs a switch case for new definition kinds.
 *
 * To add a new definition keyword:
 *   1. Add an IR::def_ entry to irKinds.ts
 *   2. Add a strata file entry (@stratum_keyword) referencing it
 *   3. Add a def expander here (with optional preScan for forward-ref globals)
 *   4. No changes to lower.ts needed
 */

import type { IRDefExpander } from '../ir/expander'
import type { IRGlobal, IRConst } from '../ir/nodes'

// ---------------------------------------------------------------------------
// Utilities (local copies to avoid circular imports with lower.ts)
// ---------------------------------------------------------------------------

function watId(s: string): string {
    return s.replace(/::/g, '_')
}

function extractSumVariants(def: any): string[] {
    const typeName: string = def.name?.name ?? ''
    const binding = Array.isArray(def.binding) ? def.binding[0] : def.binding
    const expr = binding?.expression ?? binding

    function collect(e: any): string[] {
        if (!e || typeof e !== 'object') return []
        if (e.expression) return collect(e.expression)
        if (e.value && e.type !== 'BinaryOp') return collect(e.value)
        if (e.type === 'BinaryOp' && e.operator === '|') {
            return [...collect(e.left), ...collect(e.right)]
        }
        if (e.type === 'Namespace' && Array.isArray(e.path) && e.path.length > 0) {
            return [`${typeName}::${e.path[e.path.length - 1]}`]
        }
        return []
    }
    return collect(expr)
}

// ---------------------------------------------------------------------------
// @type_sum — emit one immutable i32 global per variant (0, 1, 2, …)
// ---------------------------------------------------------------------------

const sumTypeExpander: IRDefExpander = {
    preScan(def, ctx) {
        extractSumVariants(def).forEach(v => {
            const gname = watId(v)
            ctx.globals.set(gname, 'i32')
            ctx.varNames.add(gname)
        })
    },

    expand(def, _name, ctx): IRGlobal[] {
        return extractSumVariants(def).map((v, i) => {
            const gname = watId(v)
            ctx.globals.set(gname, 'i32')
            ctx.varNames.add(gname)
            const init: IRConst = { kind: 'Const', wasmType: 'i32', value: i }
            return { kind: 'Global' as const, name: gname, wasmType: 'i32' as const, mutable: false, init }
        })
    },
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const builtinDefExpanders: Record<string, IRDefExpander> = {
    'type_sum': sumTypeExpander,
}
