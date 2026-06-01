// SPDX-License-Identifier: MIT
/**
 * Headless smoke test for the static playground: bundle entry.ts exactly as
 * the browser build does (so it exercises the inlined-asset .browser modules
 * and wabt — never the filesystem), then compile a real program and
 * instantiate the emitted WASM. A DOM-free proxy for "does it work in a tab".
 *
 *   bun run playground/web/verify.ts
 */

import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'
import type { BunPlugin } from 'bun'

const WEB = dirname(fileURLToPath(import.meta.url))
const BROWSER_SOURCES = /[\\/](strataSource|stdWatSource|moduleSources|platformSource)$/
const DISALLOWED = /^(node:)?(fs|path|url|os|child_process|crypto)$|^binaryen$/

const browserSwap: BunPlugin = {
    name: 'browser-source-swap',
    setup(build) {
        build.onResolve({ filter: BROWSER_SOURCES }, args => ({
            path: join(dirname(args.importer), args.path + '.browser.ts'),
        }))
        build.onResolve({ filter: DISALLOWED }, args => ({
            errors: [{ text: `Disallowed dependency "${args.path}" reached the browser bundle (via ${args.importer}).` }],
        }))
    },
}

const outdir = join(tmpdir(), 'silicon-playground-verify')
const result = await Bun.build({
    entrypoints: [join(WEB, 'entry.ts')],
    target: 'browser',
    outdir,
    external: ['wabt'],
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

// funcref / call_indirect — the path that used to require wabt. Proves the
// in-browser direct emitter assembles the table/element/call_indirect sections.
const FUNCREF = `\\\\ add_one (Int) -> Int
@fn add_one x := x + 1;
\\\\ call_via_ref () -> Int
@fn call_via_ref := {
    @local cb := &@fnref add_one;
    &@call_indirect cb, 41
};
@export call_via_ref;`

const fr = await SiliconCompiler.compile({ source: FUNCREF, platform: 'web', features: [] })
if (!fr.success) {
    console.error('✗ funcref compile failed:\n' + fr.error)
    process.exit(1)
}
const frBytes = Uint8Array.from(atob(fr.wasm), c => c.charCodeAt(0))
const frInst = (await WebAssembly.instantiate(frBytes, importObject as WebAssembly.Imports)).instance
const out = (frInst.exports as any).call_via_ref()
if (out !== 42) {
    console.error(`✗ funcref call_via_ref() = ${out} (want 42)`)
    process.exit(1)
}
console.log(`✓ funcref/call_indirect ran in-browser: call_via_ref() = ${out}`)
console.log('\nPLAYGROUND VERIFY: PASS')
