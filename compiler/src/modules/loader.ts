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

import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join, basename, extname, dirname } from 'path'
import { fileURLToPath } from 'url'
import parse from '../parser'
import addToAstSemantics from '../ast/toAst'
import siliconGrammar from '../grammar/SiliconGrammar'
import type { WasmValType } from '../ir/nodes'
import type { FnSig, ModuleEntry, ModuleRegistry } from './registry'

const __filename = fileURLToPath(import.meta.url)
const __dir = dirname(__filename)
const BUILTIN_MODULES_DIR = join(__dir, '../strata/modules')

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

function loadModuleFile(filePath: string, name: string, kind: 'env' | 'user'): ModuleEntry {
    const source = readFileSync(filePath, 'utf-8')
    return { name, kind, functions: parseModuleDecls(source) }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the ModuleRegistry for a compilation.
 *
 * @param projectDir  Root of the user's project (default: process.cwd()).
 *                    The loader looks for a `modules/` subdirectory here.
 */
export function loadModules(projectDir: string = process.cwd()): ModuleRegistry {
    const registry: ModuleRegistry = new Map()

    // Phase A: built-in env modules. Sorted so registry insertion order
    // (and therefore WAT emit order downstream) is filesystem-independent.
    if (existsSync(BUILTIN_MODULES_DIR)) {
        for (const filename of readdirSync(BUILTIN_MODULES_DIR).sort()) {
            // Only Silicon source files — skip .wat, .json, etc.
            if (extname(filename) !== '.si') continue
            const modName = basename(filename, '.si')
            const entry = loadModuleFile(join(BUILTIN_MODULES_DIR, filename), modName, 'env')
            registry.set(modName, entry)
        }
    }

    // Phase B: user modules (env modules take priority — skip duplicates).
    // Sorted for the same reason.
    const userModulesDir = join(projectDir, 'modules')
    if (existsSync(userModulesDir)) {
        for (const name of readdirSync(userModulesDir).sort()) {
            if (registry.has(name.replace(/\.si$/, ''))) continue  // env wins

            const entryPath = join(userModulesDir, name)
            const stat = statSync(entryPath)

            if (stat.isFile() && extname(name) === '.si') {
                // Single-file: modules/Draw.si
                const modName = basename(name, '.si')
                registry.set(modName, loadModuleFile(entryPath, modName, 'user'))
            } else if (stat.isDirectory()) {
                // Folder: modules/Draw/Draw.si
                const modName = name
                const siFile = join(entryPath, `${modName}.si`)
                if (existsSync(siFile)) {
                    registry.set(modName, loadModuleFile(siFile, modName, 'user'))
                }
            }
        }
    }

    return registry
}
