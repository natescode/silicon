/**
 * Built-in IR Definition Expanders
 *
 * Each entry maps a CodegenKind to an IRDefExpander that emits the correct
 * IR node(s) for a Definition AST node. Registered into the ElaboratorRegistry
 * by strataLoader.ts so lower.ts never needs a switch case for new definition kinds.
 *
 * Each expander receives a CompilerAPI bound to the active lowering context,
 * accessed as `api.ctx.*`, `api.ir.*`, `api.watId()`. There is no direct
 * LowerCtx exposure — all context interaction goes through the API.
 *
 * To add a new definition keyword:
 *   1. Add an IR::def_ entry to irKinds.ts
 *   2. Add a strata file entry (@stratum_keyword) referencing it
 *   3. Add a def expander here (with optional preScan for forward-ref globals)
 *   4. No changes to lower.ts needed
 */

import type { IRDefExpander } from '../ir/expander'
import type { IRGlobal, IRFunction, IRStmt, IRExpr } from '../ir/nodes'

// ---------------------------------------------------------------------------
// Utilities — pure AST shape inspection, no compiler context required
// ---------------------------------------------------------------------------

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
    preScan(def, api) {
        extractSumVariants(def).forEach(v => {
            const gname = api.watId(v)
            api.ctx.globals.set(gname, 'i32')
            api.ctx.varNames.add(gname)
        })
    },

    expand(def, _name, api): IRGlobal[] {
        return extractSumVariants(def).map((v, i) => {
            const gname = api.watId(v)
            api.ctx.globals.set(gname, 'i32')
            api.ctx.varNames.add(gname)
            return api.ir.makeGlobal(gname, 'i32', false, api.ir.makeConst(i, 'i32'))
        })
    },
}

// ---------------------------------------------------------------------------
// @type — sum type with payloads.  Pad-to-max layout:
//   value = [tag:i32, field0:i32, ..., field<max-1>:i32]    (4 + 4*max bytes)
// Each variant becomes a constructor function that allocates the record,
// stores tag + supplied fields, and zero-fills unused trailing slots.
// ---------------------------------------------------------------------------

interface VariantDeclSummary {
    name: string
    fields: { name: string; typeName: string }[]
    tag: number
}

/** Walk a `|`-chain binding and collect every $VariantDecl found. */
function extractVariants(def: any): VariantDeclSummary[] {
    const binding = Array.isArray(def.binding) ? def.binding[0] : def.binding
    const expr = binding?.expression ?? binding
    const variants: VariantDeclSummary[] = []

    function collect(e: any): void {
        if (!e || typeof e !== 'object') return
        if (e.expression) return collect(e.expression)
        // ExpressionEnd { kind:'variantDecl', value:VariantDecl } — unwrap.
        if (e.type === 'ExpressionEnd' && e.kind === 'variantDecl') return collect(e.value)
        if (e.value && e.type !== 'BinaryOp' && e.type !== 'VariantDecl') return collect(e.value)
        if (e.type === 'BinaryOp' && e.operator === '|') {
            collect(e.left)
            collect(e.right)
            return
        }
        if (e.type === 'VariantDecl') {
            variants.push({
                name: e.name,
                fields: (e.fields || []).map((f: any) => ({
                    name: f.name,
                    typeName: f.typeAnnotation?.typename ?? 'Int',
                })),
                tag: variants.length,  // placeholder, overwritten below
            })
        }
    }
    collect(expr)
    // Renumber tags in source order so they're stable.
    variants.forEach((v, i) => { v.tag = i })
    return variants
}

const typeRecordExpander: IRDefExpander = {
    preScan(def, api) {
        const typeName = def.name?.name ?? ''
        const variants = extractVariants(def)
        for (const v of variants) {
            // Tag global needs to be visible to forward references.  Constructor
            // signatures are registered earlier by the typechecker pre-pass
            // (preRegisterRecordSumType in src/types/typechecker.ts).
            const tagGlobal = api.watId(`${typeName}__${v.name}_tag`)
            api.ctx.globals.set(tagGlobal, 'i32')
            api.ctx.varNames.add(tagGlobal)
        }
    },

    expand(def, _name, api): (IRGlobal | IRFunction)[] {
        const typeName = def.name?.name ?? ''
        const variants = extractVariants(def)
        if (variants.length === 0) return []
        const maxFields = variants.reduce((m, v) => Math.max(m, v.fields.length), 0)
        const recordBytes = 4 + 4 * maxFields  // tag + max fields

        const out: (IRGlobal | IRFunction)[] = []

        for (const v of variants) {
            // 1. Tag constant — i32 global Color__Red_tag = 0
            const tagGlobalName = api.watId(`${typeName}__${v.name}_tag`)
            api.ctx.globals.set(tagGlobalName, 'i32')
            api.ctx.varNames.add(tagGlobalName)
            out.push(api.ir.makeGlobal(tagGlobalName, 'i32', false, api.ir.makeConst(v.tag, 'i32')))

            // 2. Constructor function — &Circle r → allocates 12 bytes, writes [tag, r, 0]
            const ctorName = api.watId(v.name)
            const params = v.fields.map(f => ({ name: f.name, wasmType: 'i32' as const }))
            const localPtr = api.ir.makeLocal('__rec', 'i32')

            const stmts: IRStmt[] = []

            // i32.store at offset (off) of (value) into $__rec.  Emitted as
            // an ExprStmt-wrapped Call instruction (void return).
            const storeAt = (off: number, value: IRExpr): IRStmt => ({
                kind: 'ExprStmt',
                expr: {
                    kind: 'Call',
                    wasmType: 'void',
                    callee: 'i32.store',
                    callKind: 'instr',
                    args: [
                        off === 0
                            ? api.ir.makeLocalGet('__rec', 'i32')
                            : api.ir.makeBinOp('i32.add',
                                api.ir.makeLocalGet('__rec', 'i32'),
                                api.ir.makeConst(off, 'i32'),
                                'i32'),
                        value,
                    ],
                } as any,
            })

            // $__rec := call $alloc recordBytes  (user-call kind so it emits as (call $alloc ...))
            stmts.push(api.ir.makeLocalSet('__rec',
                api.ir.makeCall('alloc', [api.ir.makeConst(recordBytes, 'i32')], 'i32', 'user')))
            // tag at offset 0
            stmts.push(storeAt(0, api.ir.makeConst(v.tag, 'i32')))
            // Provided fields
            for (let i = 0; i < v.fields.length; i++) {
                stmts.push(storeAt((i + 1) * 4, api.ir.makeLocalGet(v.fields[i].name, 'i32')))
            }
            // Zero-fill unused trailing slots (deterministic — cleanup-plan §3.2 open Q #2).
            for (let i = v.fields.length; i < maxFields; i++) {
                stmts.push(storeAt((i + 1) * 4, api.ir.makeConst(0, 'i32')))
            }
            // Return $__rec (block trailing)
            const body = api.ir.makeBlock(stmts, api.ir.makeLocalGet('__rec', 'i32'), 'i32')
            const fn = api.ir.makeFunction(ctorName, params, 'i32', [localPtr], body)
            out.push(fn)
        }
        return out
    },
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const builtinDefExpanders: Record<string, IRDefExpander> = {
    'type_sum':    sumTypeExpander,
    'type_record': typeRecordExpander,
}
