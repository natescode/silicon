// SPDX-License-Identifier: MIT
/**
 * Module Loader
 *
 * Builds a ModuleRegistry from:
 *   A. Built-in env modules in src/strata/modules/*.si  (always available; env:: namespace)
 *   B. User modules in <projectDir>/modules/             (manually downloaded)
 *
 * Resolution order: env modules win over user modules of the same name.
 *
 * Two layouts are supported for user modules:
 *   modules/Draw.si           single-file (thin host-import wrapper)
 *   modules/Draw/Draw.si      folder form (may include impl.wat, assets, etc.)
 *
 * Module files are plain Silicon source containing only @extern declarations.
 * The folder or file name (minus .si extension) IS the module name — no @module header needed.
 */

import parse from '../parser'
import addToAstSemantics from '../ast/toAst'
import siliconGrammar from '../grammar/SiliconGrammar'
import type { WasmValType } from '../ir/nodes'
import type { FnSig, ModuleEntry, ModuleRegistry } from './registry'
import { listBuiltinModules, listUserModules } from './moduleSources'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
// The AST from the parser is wrapped in a bunch of Element/Item/Statement nodes — unwrap it to get to the actual Definition nodes.
function unwrap(node: any): any {
    if (!node) return null
    if (node.type === 'Element') return unwrap(node.value)
    if (node.type === 'Item') return unwrap(node.value)
    if (node.type === 'Statement') return unwrap(node.value)
    return node
}

// Silicon types map to WASM value types: Float → f32, Int64/u64 → i64,
// everything else (Int, Int32, Bool, String, pointer-ish, u8/u16/u32) → i32.
function siliconTypeToWasm(typename: string): WasmValType {
    if (typename === 'Float') return 'f32'
    if (typename === 'Int64' || typename === 'UInt64' || typename === 'u64' || typename === 'i64') return 'i64'
    return 'i32'
}

/**
 * Parse a module .si file (raw AST walk — no elaboration needed).
 * Extracts @extern declarations and their WASM parameter/return types.
 */
export function parseModuleDecls(source: string): Map<string, FnSig> {
    const functions = new Map<string, FnSig>()
    try {
        const match = parse(source)
        const ast = addToAstSemantics(siliconGrammar)(match).toAst() as any
        for (const el of (ast.elements ?? []) as any[]) {
            const node = unwrap(el)
            if (!node || node.type !== 'Definition' || node.keyword !== '@extern') continue
            const fnName: string = node.name?.name ?? ''
            if (!fnName) continue
            const params: WasmValType[] = []
            const siliconParams: string[] = []
            for (const p of (node.params ?? []) as any[]) {
                if (p.isLiteral || !p.typeAnnotation) continue
                const tn: string = p.typeAnnotation.typename
                params.push(siliconTypeToWasm(tn))
                siliconParams.push(tn)
            }
            let result: WasmValType | undefined
            let siliconResult: string | undefined
            const rtn: string | undefined = node.name?.typeAnnotation?.typename
            if (rtn && rtn !== 'Void') {
                result = siliconTypeToWasm(rtn)
                siliconResult = rtn
            }
            functions.set(fnName, { params, result, siliconParams, siliconResult })
        }
    } catch {
        // Malformed module file — skip
    }
    return functions
}


// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the ModuleRegistry for a compilation.
 *
 * @param projectDir  Root of the user's project (default: the process cwd, or
 *                    `''` in the browser where there is no `process`).
 *                    The loader looks for a `modules/` subdirectory here.
 *
 * Module .si discovery (built-in + user) lives in moduleSources.ts so the
 * browser build can swap it for an fs-free, inlined copy. Sorted insertion
 * order keeps the downstream WAT emit order filesystem-independent; env
 * modules win over same-named user modules.
 */
// `process` is undefined in the browser; fall back to '' (the browser's
// listUserModules ignores it). Must not reference `process` unguarded — doing
// so throws ReferenceError and breaks comptime handler compilation in-browser.
const defaultProjectDir = (): string =>
    (typeof process !== 'undefined' && typeof process.cwd === 'function') ? process.cwd() : ''

export function loadModules(projectDir: string = defaultProjectDir()): ModuleRegistry {
    const registry: ModuleRegistry = new Map()

    for (const m of listBuiltinModules()) {
        registry.set(m.name, { name: m.name, kind: 'env', functions: parseModuleDecls(m.source) })
    }

    for (const m of listUserModules(projectDir)) {
        if (registry.has(m.name)) continue  // env wins
        registry.set(m.name, { name: m.name, kind: 'user', functions: parseModuleDecls(m.source) })
    }

    return registry
}
