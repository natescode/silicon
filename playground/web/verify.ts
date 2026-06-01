// SPDX-License-Identifier: MIT
/**
 * Headless smoke test for the static playground: bundle entry.ts exactly as
 * the browser build does (so it exercises the inlined-asset .browser modules
 * and wabt — never the filesystem), then compile a real program and
 * instantiate the emitted WASM. A DOM-free proxy for "does it work in a tab".
 *
 *   bun run playground/web/verify.ts
 */

import { join, dirname, basename } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'
import type { BunPlugin } from 'bun'

const WEB = dirname(fileURLToPath(import.meta.url))
const BROWSER_SOURCES = /[\\/](grammarSource|strataSource|stdWatSource|moduleSources|platformSource)$/

const browserSwap: BunPlugin = {
    name: 'browser-source-swap',
    setup(build) {
        build.onResolve({ filter: BROWSER_SOURCES }, args => ({
            path: join(dirname(args.importer), basename(args.path) + '.browser.ts'),
        }))
        build.onResolve({ filter: /^(node:)?(fs|path|url|os|child_process|crypto)$/ }, args => ({
            errors: [{ text: `Node builtin "${args.path}" reached the browser bundle (via ${args.importer}).` }],
        }))
    },
}

const outdir = join(tmpdir(), 'silicon-playground-verify')
const result = await Bun.build({
    entrypoints: [join(WEB, 'entry.ts')],
    target: 'browser',
    outdir,
    plugins: [browserSwap],
})
if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
}

// Importing the bundle sets globalThis.SiliconCompiler (after wabt's TLA).
await import(result.outputs[0].path)
const SiliconCompiler = (globalThis as any).SiliconCompiler as {
    compile(req: { source: string; platform?: string; features?: string[] }): Promise<any>
}
if (!SiliconCompiler) throw new Error('globalThis.SiliconCompiler was not set by the bundle')

const SOURCE = `\\\\ add (Int, Int)
@fn add a, b := { a + b };

\\\\ roll ()
@fn roll := { 42 };

@export add;
@export roll;`

const data = await SiliconCompiler.compile({ source: SOURCE, platform: 'web', features: [] })

if (!data.success) {
    console.error('✗ compile failed:\n' + data.error)
    process.exit(1)
}
console.log(`✓ compiled — ${data.exports.length} exports: ${data.exports.map((e: any) => e.name).join(', ')}`)
console.log(`✓ WAT emitted (${data.wat.length} chars), wasm ${data.wasm.length} b64 chars`)

// Decode base64 → bytes, then validate + instantiate with stub env imports.
const bytes = Uint8Array.from(atob(data.wasm), c => c.charCodeAt(0))
if (!WebAssembly.validate(bytes)) {
    console.error('✗ emitted wasm failed WebAssembly.validate')
    process.exit(1)
}
const stubNamespace = new Proxy({}, { get: () => (..._a: unknown[]) => 0 })
const importObject = new Proxy({}, { get: () => stubNamespace })
const { instance } = await WebAssembly.instantiate(bytes, importObject as WebAssembly.Imports)

const { add, roll } = instance.exports as any
if (typeof add !== 'function' || typeof roll !== 'function') {
    console.error('✗ exports add/roll are not callable on the instance')
    process.exit(1)
}
const sum = add(2, 3)
const r = roll()
if (sum !== 5 || r !== 42) {
    console.error(`✗ wrong results: add(2,3)=${sum} (want 5), roll()=${r} (want 42)`)
    process.exit(1)
}
console.log(`✓ instantiated and ran: add(2,3)=${sum}, roll()=${r}`)
console.log('\nPLAYGROUND VERIFY: PASS')
