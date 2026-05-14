/**
 * Sigil Playground Server
 *
 * Bun HTTP server that compiles Silicon source code and returns WAT + WASM binary.
 * Serves the playground UI from playground/index.html.
 *
 * Routes:
 *   GET  /          → playground/index.html
 *   POST /compile   → { success, wat, wasm (base64), exports, error }
 */

import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import parse from '../src/parser'
import { addToAstSemantics, type ASTNode, type Program } from '../src/ast'
import { compileToWat } from '../src/codegen'
import { watToWasm } from '../src/codegen/toWasm'
import { elaborate, buildStrataRegistry } from '../src/elaborator'
import { typecheck, formatTypeError, formatType, wasmTypeOf } from '../src/types'
import { siliconGrammar } from '../src/grammar'

const __dir = dirname(fileURLToPath(import.meta.url))
const HTML_PATH = join(__dir, 'index.html')

// ---------------------------------------------------------------------------
// Export info extraction
// ---------------------------------------------------------------------------

interface ExportInfo {
    name: string
    params: { name: string; type: string; wasmType: string }[]
    result: string
    wasmResult: string
}

/** Recursively unwrap Element/Item/Statement wrappers to reach a Definition node. */
function extractDef(el: any): any {
    if (!el || typeof el !== 'object') return null
    if (el.type === 'Definition') return el
    if (el.type === 'Element' || el.type === 'Item') return extractDef(el.value)
    if (el.type === 'Statement' && el.kind === 'definition') return el.value
    return null
}

function collectExports(program: Program, _functions: Map<string, FunctionSig>): ExportInfo[] {
    const elements = program.elements as any[]

    // Build a map of function name → {params, returnType} from @let/@fn definitions.
    // We read directly from the AST rather than the functions map because @export
    // processing overwrites it with empty params + Unknown result.
    //
    // def.inferredType  = the function's return type (set by the typechecker)
    // def.params[].typeAnnotation.typename = surface type name for each param
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
        if (!fn) continue  // skip non-function exports (globals, etc.)

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

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

async function compileSilicon(source: string) {
    const match = parse(source)
    const ast: ASTNode = addToAstSemantics(siliconGrammar)(match).toAst()
    const registry = buildStrataRegistry(ast as Program)
    const { program: elaborated, errors: elabErrors } = elaborate(ast as Program, registry)

    if (elabErrors.length > 0) {
        return { success: false, error: elabErrors.map(e => e.message).join('\n') }
    }

    const { program: typed, errors: typeErrors, functions } = typecheck(elaborated, registry)

    if (typeErrors.length > 0) {
        return { success: false, error: typeErrors.map(formatTypeError).join('\n') }
    }

    const wat = compileToWat(typed, registry, functions)
    const wasmBytes = await watToWasm(wat)
    const wasm = Buffer.from(wasmBytes).toString('base64')
    const exports = collectExports(typed, functions)

    return { success: true, wat, wasm, exports }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 3000)

const server = Bun.serve({
    port: PORT,
    async fetch(req) {
        const url = new URL(req.url)

        // Serve playground UI.
        if (req.method === 'GET' && url.pathname === '/') {
            return new Response(Bun.file(HTML_PATH), {
                headers: { 'Content-Type': 'text/html; charset=utf-8' },
            })
        }

        // Compile endpoint.
        if (req.method === 'POST' && url.pathname === '/compile') {
            let source: string
            try {
                const body = await req.json() as { source: string }
                source = body.source ?? ''
            } catch {
                return json({ success: false, error: 'Invalid request body' }, 400)
            }

            try {
                const result = await compileSilicon(source)
                return json(result)
            } catch (e) {
                return json({ success: false, error: String(e) })
            }
        }

        return new Response('Not Found', { status: 404 })
    },
})

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    })
}

console.log(`Sigil Playground → http://localhost:${server.port}`)
