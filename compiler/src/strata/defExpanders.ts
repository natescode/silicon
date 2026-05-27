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
import type { StructLayout, StructFieldLayout } from '../elaborator/registry'

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
        const recordBytes = 4 + 4 * maxFields  // tag + max fields (mvp path)
        const isWasmGc = api.ctx.target === 'wasm-gc'

        // Phase 9d-7: under wasm-gc, register the sum type as a single
        // WasmGC struct: (struct (field (mut i32)) (field (mut i32)) … )
        // — tag at field 0, pad-to-max payload at fields 1..maxFields.
        // Same shape as the mvp pad-to-max record, just emitted as a
        // managed struct instead of bytes.
        let sumTypeIdx = -1
        const sumTypeWat = `$${typeName}`
        if (isWasmGc) {
            // Nominal intern — Sigil sums are nominal types, so two sums
            // with identical pad-to-max layouts must remain distinct
            // WasmGC type-section entries.  See nodes.ts:internNominal.
            sumTypeIdx = api.ctx.wasmGcTypes.internNominal({
                name: sumTypeWat,
                spec: {
                    kind: 'struct',
                    fields: Array.from({ length: 1 + maxFields }, () => ({
                        storage: { kind: 'val' as const, type: 'i32' as const },
                        mutable: true,
                    })),
                },
            })
        }

        const out: (IRGlobal | IRFunction)[] = []

        for (const v of variants) {
            // 1. Tag constant — i32 global Color__Red_tag = 0
            const tagGlobalName = api.watId(`${typeName}__${v.name}_tag`)
            api.ctx.globals.set(tagGlobalName, 'i32')
            api.ctx.varNames.add(tagGlobalName)
            out.push(api.ir.makeGlobal(tagGlobalName, 'i32', false, api.ir.makeConst(v.tag, 'i32')))

            const ctorName = api.watId(v.name)
            const params = v.fields.map(f => ({ name: f.name, wasmType: 'i32' as const }))

            if (isWasmGc) {
                // 2-gc. Constructor — `struct.new $Foo (i32.const tag) v0 v1 …`
                // Tag first, then user-supplied fields in source order,
                // then zero-fill the pad-to-max trailing slots.
                const args: IRExpr[] = [api.ir.makeConst(v.tag, 'i32')]
                for (const f of v.fields) args.push(api.ir.makeLocalGet(f.name, 'i32'))
                for (let i = v.fields.length; i < maxFields; i++) {
                    args.push(api.ir.makeConst(0, 'i32'))
                }
                const body: IRExpr = {
                    kind: 'StructNew',
                    wasmType: 'i32',
                    typeIdx: sumTypeIdx,
                    typeName: sumTypeWat,
                    args,
                }
                // Phase 9d-7 fix-3: the wasm-level result is `(ref $Foo)`,
                // not `i32`.  Setting `refResult` makes the function-type
                // entry emit the ref form (0x63 + sleb typeidx) instead of
                // valtype.  Without this the wasm validator rejects with
                // "(ref $Foo) is not a I32" on the constructor's tail.
                const fn = api.ir.makeFunction(ctorName, params, 'i32', [], body)
                fn.refResult = { localTypeIdx: sumTypeIdx, nullable: false }
                out.push(fn)
                continue
            }

            // 2-mvp. Constructor function — &Circle r → allocates 12 bytes, writes [tag, r, 0]
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
                            : api.ir.makeBinOp('i32_add',
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
// @struct — flat record type with named fields and no variant tag.
//
// Declaration syntax:  @struct Point x:Int, y:Int;
// Fields come from def.params — same position as function parameters.
// Layout: contiguous, each field 4 bytes (i32/f32) or 8 bytes (i64).
// Constructor function: $Point(x: i32, y: i32): i32
//   allocates size bytes via alloc(), stores fields, returns pointer.
// ---------------------------------------------------------------------------

function fieldWasmType(typeName: string): 'i32' | 'f32' | 'i64' {
    if (typeName === 'Float') return 'f32'
    if (typeName === 'Int64' || typeName === 'i64') return 'i64'
    return 'i32'
}

function fieldSize(wasmType: 'i32' | 'f32' | 'i64'): number {
    return wasmType === 'i64' ? 8 : 4
}

function extractStructFields(def: any): StructFieldLayout[] {
    const fields: StructFieldLayout[] = []
    let offset = 0
    for (const p of def.params ?? []) {
        const param = p.value ?? p  // unwrap Parameter wrapper if present
        const name: string = param.name ?? ''
        const typeName: string = param.typeAnnotation?.typename ?? 'Int'
        const wt = fieldWasmType(typeName)
        const size = fieldSize(wt)
        fields.push({ name, typeName, wasmType: wt, offset, size })
        offset += size
    }
    return fields
}

const structExpander: IRDefExpander = {
    preScan(def, api) {
        const structName = def.name?.name ?? ''
        const ctorName = api.watId(structName)
        api.ctx.globals.set(ctorName, 'i32')
    },

    expand(def, _name, api): IRFunction {
        const structName = def.name?.name ?? ''
        const fields = extractStructFields(def)
        const totalSize = fields.reduce((acc, f) => acc + f.size, 0)

        // Register the struct layout so field-access lowering can look it up.
        const layout: StructLayout = { name: structName, fields, size: totalSize }
        api.ctx.structTypes.set(structName, layout)

        // Constructor: allocate memory, store each field, return pointer.
        const ctorName = api.watId(structName)
        const params = fields.map(f => ({ name: f.name, wasmType: f.wasmType }))
        const localPtr = api.ir.makeLocal('__rec', 'i32')
        const stmts: IRStmt[] = []

        const storeAt = (off: number, wt: 'i32' | 'f32' | 'i64', value: IRExpr): IRStmt => {
            const instr = wt === 'f32' ? 'f32.store' : wt === 'i64' ? 'i64.store' : 'i32.store'
            const ptrExpr: IRExpr = off === 0
                ? api.ir.makeLocalGet('__rec', 'i32')
                : api.ir.makeBinOp('i32_add',
                    api.ir.makeLocalGet('__rec', 'i32'),
                    api.ir.makeConst(off, 'i32'),
                    'i32')
            return {
                kind: 'ExprStmt',
                expr: {
                    kind: 'Call',
                    wasmType: 'void',
                    callee: instr,
                    callKind: 'instr',
                    args: [ptrExpr, value],
                } as any,
            }
        }

        stmts.push(api.ir.makeLocalSet('__rec',
            api.ir.makeCall('alloc', [api.ir.makeConst(totalSize, 'i32')], 'i32', 'user')))

        for (const f of fields) {
            stmts.push(storeAt(f.offset, f.wasmType, api.ir.makeLocalGet(f.name, f.wasmType)))
        }

        const body = api.ir.makeBlock(stmts, api.ir.makeLocalGet('__rec', 'i32'), 'i32')
        return api.ir.makeFunction(ctorName, params, 'i32', [localPtr], body)
    },
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Function def expander — equivalent to the legacy LetDef body
 * (`&IR::def_function; ...`).  Used by the engine's synthetic
 * `@fn handlerName n:Int := body` lowering when @fn is still legacy
 * (or as a fallback when other callers construct a function with
 * `hook: 'function'` directly).
 *
 * D-D-11b note: with @fn/@let migrated to the new @stratum form via
 * register::keyword, normal `@let foo :=`/`@fn foo :=` Definitions
 * route through LetOrFn_lower (Silicon-side).  This expander only
 * fires for callers that explicitly set hook='function' — chiefly
 * `src/comptime/engine.ts` building its synthesised @fn for handler
 * compilation, which cannot recursively trigger LetOrFn_lower (would
 * be chicken-and-egg).
 */
const functionExpander: IRDefExpander = {
    expand(def, name, api): IRFunction {
        const params = api.lowerParams(def)
        const { body, locals } = api.lowerFunctionBody(def, params)
        const returnType = api.resolveFunctionReturnType(def, name, body)
        api.ctx.globals.set(name, 'i32')
        return api.ir.makeFunction(name, params, returnType, locals, body)
    },
}

export const builtinDefExpanders: Record<string, IRDefExpander> = {
    'function':    functionExpander,
    'type_sum':    sumTypeExpander,
    'type_record': typeRecordExpander,
    'struct':      structExpander,
}

/** Exposed for D-D-11d migrations and the compiler_expandStruct comptime hook. */
export { sumTypeExpander, typeRecordExpander, structExpander }
