// SPDX-License-Identifier: MIT
/**
 * Browser entry for the static playground.
 *
 * This replaces the old Bun `/compile` HTTP endpoint (server.ts): the whole
 * Silicon compiler runs client-side. The build (web/build.ts) aliases the
 * compiler's filesystem-reading `*Source` modules to their `.browser`
 * variants, so this bundle never touches `fs` — every asset (grammar, strata,
 * std.wat, modules, web platform) is inlined.
 *
 * Exposes `globalThis.SiliconCompiler.compile(...)`, returning the exact same
 * shape the old endpoint did, so playground/index.html is unchanged except for
 * swapping `fetch('/compile')` for a direct call.
 */

import {
    parse, type Program,
    compileToWat,
    compileToWasm,
    elaborate, buildStrataRegistry,
    typecheck, formatTypeError, formatType, wasmTypeOf, type FunctionSig,
    loadModules,
    loadPlatform, getRequiredExports, type PlatformConfig,
} from '@silicon/compiler/pipeline'

interface ExportInfo {
    name: string
    params: { name: string; type: string; wasmType: string }[]
    result: string
    wasmResult: string
}

interface CompileRequest {
    source: string
    platform?: string
    features?: string[]
    /** Compilation target: 'host' (default, linear memory) | 'wasm-gc'. */
    target?: string
}

// Built-in modules only (no project dir in the browser).
const fallbackModuleRegistry = loadModules('')

/** Recursively unwrap Element/Item/Statement wrappers to reach a Definition. */
function extractDef(el: any): any {
    if (!el || typeof el !== 'object') return null
    if (el.type === 'Definition') return el
    if (el.type === 'Element' || el.type === 'Item') return extractDef(el.value)
    if (el.type === 'Statement' && el.kind === 'definition') return el.value
    return null
}

function collectExports(program: Program): ExportInfo[] {
    const elements = program.elements as any[]
    const fnDefs = new Map<string, { params: { name: string; type: string; wasmType: string }[]; resultType: any }>()

    for (const el of elements) {
        const def = extractDef(el)
        if (!def) continue
        if (def.keyword !== '@let' && def.keyword !== '@fn') continue
        const name: string = def.name?.name
        if (!name) continue

        const params: { name: string; type: string; wasmType: string }[] = []
        for (const p of (def.params ?? []) as any[]) {
            if (p.isLiteral || !p.typeAnnotation) continue
            const typename: string = p.typeAnnotation.typename
            params.push({
                name: p.name ?? 'p',
                type: typename,
                wasmType: typename === 'Float' ? 'f32' : 'i32',
            })
        }
        fnDefs.set(name, { params, resultType: def.inferredType })
    }

    const result: ExportInfo[] = []
    for (const el of elements) {
        const def = extractDef(el)
        if (!def || def.keyword !== '@export') continue
        const name: string = def.name?.name
        if (!name) continue
        const fn = fnDefs.get(name)
        if (!fn) continue
        const rt = fn.resultType
        result.push({
            name,
            params: fn.params,
            result: rt ? formatType(rt) : 'void',
            wasmResult: rt ? String(wasmTypeOf(rt)) : 'void',
        })
    }
    return result
}

/** Base64-encode wasm bytes without blowing the call stack on large modules. */
function toBase64(bytes: Uint8Array): string {
    let binary = ''
    const CHUNK = 0x8000
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
    }
    return btoa(binary)
}

async function compile(req: CompileRequest) {
    const source = req.source ?? ''
    const platformConfig: PlatformConfig | undefined = req.platform
        ? { platform: req.platform as PlatformConfig['platform'], features: req.features ?? [] }
        : undefined

    try {
        const moduleRegistry = platformConfig ? loadPlatform(platformConfig) : fallbackModuleRegistry

        const ast = parse(source)
        const registry = buildStrataRegistry(ast as Program)
        const { program: elaborated, errors: elabErrors } = elaborate(ast as Program, registry)
        if (elabErrors.length > 0) {
            return { success: false, error: elabErrors.map(e => e.message).join('\n') }
        }

        const { program: typed, errors: typeErrors, functions } = typecheck(elaborated, registry, moduleRegistry)
        if (typeErrors.length > 0) {
            return { success: false, error: typeErrors.map(formatTypeError).join('\n') }
        }

        if (platformConfig) {
            const required = getRequiredExports(platformConfig)
            if (required.size > 0) {
                const exportedNames = new Set(collectExports(typed).map(e => e.name))
                const missing: string[] = []
                for (const [feature, exportName] of required) {
                    if (!exportedNames.has(exportName)) {
                        missing.push(`Platform feature '${feature}' requires an exported function named '${exportName}'`)
                    }
                }
                if (missing.length > 0) return { success: false, error: missing.join('\n') }
            }
        }

        // WAT for the display panel (pure string emission, no wabt); the
        // executable bytes come from the compiler's own direct binary emitter
        // (no wabt/binaryen), so the bundle stays pure-MIT.
        const options = req.target && req.target !== 'host' ? { target: req.target as any } : undefined
        const wat = compileToWat(typed, registry, functions as Map<string, FunctionSig>, moduleRegistry, options)
        const wasmBytes = compileToWasm(typed, registry, functions as Map<string, FunctionSig>, moduleRegistry, options)
        return {
            success: true,
            wat,
            wasm: toBase64(new Uint8Array(wasmBytes)),
            exports: collectExports(typed),
            platform: platformConfig?.platform ?? 'web',
            features: platformConfig?.features ?? [],
        }
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
}

;(globalThis as any).SiliconCompiler = { compile }
