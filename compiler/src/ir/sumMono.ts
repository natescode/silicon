// SPDX-License-Identifier: MIT
/**
 * F1 — native host-handle-carrying sum types (`Result[JSValue, String]`,
 * `Option[JSValue]`) under `--target=wasm-gc`.
 *
 * A host handle is an externref; externref cannot live in linear memory, so
 * the pin-id interim (`js::pin` → `Result[Int, String]`) exists.  Under
 * wasm-gc a sum is a GC struct, and a struct field CAN be an externref —
 * so a parametric sum instantiated with a JSValue/JSString type-arg can
 * carry the handle natively, no pin.
 *
 * The compiler emits ONE type-erased all-i32 sum struct (pad-to-max overlap).
 * That can't hold an externref, and a *heterogeneous* instantiation like
 * `Result[JSValue, String]` would need one overlapped slot to be both
 * externref (Ok.value) and i32 (Err.error) — impossible for a single field.
 *
 * This pass specializes such instantiations:
 *   - collects every Sum instantiation whose concrete type-args include an
 *     externref (JSValue/JSString), from fn sigs + stamped inferredTypes;
 *   - registers a per-instantiation GC struct with a **flat-union** layout —
 *     `[tag, ...flatten(each variant's resolved fields)]` — so every field
 *     has one consistent wasm type (externref where the resolved field type
 *     is a host handle, i32/i64/f32 otherwise).  No overlapped slot ⇒ no
 *     type conflict, even for heterogeneous `Result`;
 *   - emits specialized constructors (`Ok$JSValue_String`) that `struct.new`
 *     into that struct (their own fields set, other variants' slots defaulted
 *     — `ref.null extern` for an unused externref slot);
 *   - exposes the layout so call-site routing + `@match` use the specialized
 *     struct and per-field read types.
 *
 * Gated entirely on `--target=wasm-gc`; the all-i32 pad-to-max path is left
 * byte-identical for every other sum.  On a linear-mem target, an externref
 * sum payload is a hard error (E0026) — fail-fast instead of invalid wasm.
 */

import type { SiliconType } from '../types/types'
import type { WasmGcTypeRegistry, IRFunction, IRExpr, WasmGcStorageType } from './nodes'
import { extractVariants } from '../strata/defExpanders'

/** A resolved field of a specialized sum variant. */
export interface SpecField {
    name: string
    sty: SiliconType
    extern: boolean
    /** Index of this field within the specialized struct (tag is 0). */
    structFieldIdx: number
}

export interface SpecVariant {
    name: string
    tag: number
    /** Mangled constructor name (`Ok$JSValue_String`). */
    ctorName: string
    fields: SpecField[]
}

export interface SpecializedSum {
    baseName: string
    mangledName: string          // `$Result$JSValue_String` (WAT id form)
    typeArgs: SiliconType[]
    structTypeIdx: number
    /** Total struct fields incl. the leading tag. */
    fieldCount: number
    variants: SpecVariant[]
}

/** A host handle — the only payloads that force native ref fields. */
export function isExternrefType(t: SiliconType | undefined): boolean {
    return t?.kind === 'JSValue' || t?.kind === 'JSString'
}

/** Wasm value/storage type for a resolved sum field type under wasm-gc. */
function fieldStorage(t: SiliconType): WasmGcStorageType {
    if (isExternrefType(t)) return { kind: 'externref', nullable: true }
    if (t.kind === 'Int64')  return { kind: 'val', type: 'i64' }
    if (t.kind === 'Float')  return { kind: 'val', type: 'f32' }
    return { kind: 'val', type: 'i32' }   // Int/Bool/String-ptr/sum-ptr/…
}

function typeToSuffix(t: SiliconType): string {
    switch (t.kind) {
        case 'Int':    return 'Int'
        case 'Int64':  return 'Int64'
        case 'Float':  return 'Float'
        case 'Bool':   return 'Bool'
        case 'String': return 'String'
        case 'JSValue':  return 'JSValue'
        case 'JSString': return 'JSString'
        case 'Void':   return 'Void'
        case 'Sum':      return (t as any).name ?? 'Sum'
        case 'Distinct': return (t as any).name ?? 'Distinct'
        default:       return 'X'
    }
}

/** `Result` + [JSValue, String] → `Result$JSValue_String`. */
export function mangleSumName(baseName: string, typeArgs: SiliconType[]): string {
    return `${baseName}$${typeArgs.map(typeToSuffix).join('_')}`
}

/** True when this Sum type is a concrete instantiation carrying ≥1 host
 *  handle (so it needs a specialized native-ref struct).  Rejects types
 *  with unresolved Variable args (still polymorphic — not a call site). */
export function needsHandleSpecialization(t: SiliconType | undefined): boolean {
    if (!t || t.kind !== 'Sum') return false
    const args = (t as any).typeArgs as SiliconType[] | undefined
    if (!args || args.length === 0) return false
    if (args.some(a => a.kind === 'Variable' || a.kind === 'Unknown')) return false
    return args.some(isExternrefType)
}

/** Map the base @type def's generic params onto an instantiation's type-args,
 *  returning the resolved variant/field layout.  `def` is the `@type` AST. */
function resolveVariants(
    def: any,
    typeArgs: SiliconType[],
): { name: string; tag: number; fields: { name: string; sty: SiliconType }[] }[] {
    const generics: string[] = def?.generics?.params ?? []
    const subst = new Map<string, SiliconType>()
    generics.forEach((g, i) => { if (typeArgs[i]) subst.set(g, typeArgs[i]) })
    const i32: SiliconType = { kind: 'Int' }
    const resolveField = (typeName: string): SiliconType => {
        const bound = subst.get(typeName)
        if (bound) return bound
        // A concrete builtin field type (`String`, `Int`, …) — map by name.
        switch (typeName) {
            case 'Int':    return { kind: 'Int' }
            case 'Int64':  return { kind: 'Int64' }
            case 'Float':  return { kind: 'Float' }
            case 'Bool':   return { kind: 'Bool' }
            case 'String': return { kind: 'String' }
            case 'JSValue':  return { kind: 'JSValue' }
            case 'JSString': return { kind: 'JSString' }
            default:       return i32   // sum/struct pointer, distinct, …
        }
    }
    return extractVariants(def).map(v => ({
        name: v.name,
        tag: v.tag,
        fields: v.fields.map(f => ({ name: f.name, sty: resolveField(f.typeName) })),
    }))
}

/**
 * Register the specialized GC struct + compute the flat-union layout for one
 * instantiation.  Idempotent per (registry, mangledName).
 */
export function buildSpecializedSum(
    baseName: string,
    typeArgs: SiliconType[],
    def: any,
    reg: WasmGcTypeRegistry,
): SpecializedSum {
    const mangledName = '$' + mangleSumName(baseName, typeArgs)
    const resolved = resolveVariants(def, typeArgs)

    // Flat-union: tag at 0, then each variant's fields in declaration order.
    const fields: WasmGcStorageType[] = [{ kind: 'val', type: 'i32' }]   // tag
    const variants: SpecVariant[] = []
    for (const v of resolved) {
        const specFields: SpecField[] = []
        for (const f of v.fields) {
            const structFieldIdx = fields.length
            fields.push(fieldStorage(f.sty))
            specFields.push({ name: f.name, sty: f.sty, extern: isExternrefType(f.sty), structFieldIdx })
        }
        variants.push({
            name: v.name,
            tag: v.tag,
            ctorName: `${v.name}$${typeArgs.map(typeToSuffix).join('_')}`,
            fields: specFields,
        })
    }

    const structTypeIdx = reg.internNominal({
        name: mangledName,
        spec: { kind: 'struct', fields: fields.map(storage => ({ storage, mutable: true })) },
    })

    return { baseName, mangledName, typeArgs, structTypeIdx, fieldCount: fields.length, variants }
}

/** Default value IR for a flat-union slot a constructor doesn't populate. */
function defaultFor(storage: WasmGcStorageType): IRExpr {
    if (storage.kind === 'externref') return { kind: 'RefNullExtern', wasmType: 'i32' }
    if (storage.kind === 'val' && storage.type === 'i64')
        return { kind: 'Const', wasmType: 'i64', value: 0 } as IRExpr
    if (storage.kind === 'val' && storage.type === 'f32')
        return { kind: 'Const', wasmType: 'f32', value: 0 } as IRExpr
    return { kind: 'Const', wasmType: 'i32', value: 0 } as IRExpr
}

const paramWasmType = (sty: SiliconType): 'i32' | 'i64' | 'f32' =>
    sty.kind === 'Int64' ? 'i64' : sty.kind === 'Float' ? 'f32' : 'i32'

/**
 * Emit the specialized constructor functions for an instantiation.  Each
 * `struct.new`s the specialized struct, setting its own variant's fields and
 * defaulting the rest (per the flat-union layout).
 */
export function emitSpecializedConstructors(spec: SpecializedSum): IRFunction[] {
    // Storage type per struct field index — rebuilt from the variants so a
    // default can be chosen for slots another variant owns.
    const slotStorage: WasmGcStorageType[] = new Array(spec.fieldCount)
    slotStorage[0] = { kind: 'val', type: 'i32' }   // tag
    for (const v of spec.variants)
        for (const f of v.fields) slotStorage[f.structFieldIdx] = fieldStorage(f.sty)

    const fns: IRFunction[] = []
    for (const v of spec.variants) {
        const params = v.fields.map(f => ({ name: f.name, wasmType: paramWasmType(f.sty) }))
        const refParams = new Map<number, any>()
        v.fields.forEach((f, i) => {
            if (f.extern) refParams.set(i, { localTypeIdx: 0, nullable: true, extern: true })
        })

        // struct.new args, slot by slot.
        const ownByIdx = new Map(v.fields.map(f => [f.structFieldIdx, f]))
        const args: IRExpr[] = [{ kind: 'Const', wasmType: 'i32', value: v.tag } as IRExpr]
        for (let slot = 1; slot < spec.fieldCount; slot++) {
            const own = ownByIdx.get(slot)
            args.push(own
                ? { kind: 'LocalGet', wasmType: paramWasmType(own.sty), name: own.name } as IRExpr
                : defaultFor(slotStorage[slot]))
        }

        const fn = {
            kind: 'Function',
            name: v.ctorName,
            params,
            result: 'i32',
            locals: [],
            body: {
                kind: 'StructNew', wasmType: 'i32',
                typeIdx: spec.structTypeIdx, typeName: spec.mangledName, args,
            } as IRExpr,
            refResult: { localTypeIdx: spec.structTypeIdx, nullable: false },
            ...(refParams.size > 0 ? { refParams } : {}),
        } as unknown as IRFunction
        fns.push(fn)
    }
    return fns
}
