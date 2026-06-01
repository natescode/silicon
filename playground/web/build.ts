// SPDX-License-Identifier: MIT
/**
 * Build the static, single-file playground.
 *
 *   1. Bundle web/entry.ts for the browser with Bun, aliasing the compiler's
 *      filesystem `*Source` modules to their inlined `.browser` variants.
 *      Any leaked Node builtin (fs/path/url/…) fails the build loudly.
 *   2. Inline the bundle + web-env.js into playground/index.html and swap the
 *      old `fetch('/compile')` for the in-browser compiler.
 *   3. Emit a single self-contained dist/index.html (CodeMirror still loads
 *      from its CDN; everything else is inlined).
 *
 * Run `bun run compiler/scripts/gen-web-assets.ts` first so the inlined assets
 * are current. The `build` npm script does both in order.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import type { BunPlugin } from 'bun'

const WEB = dirname(fileURLToPath(import.meta.url))          // playground/web
const UI = join(WEB, '..', 'playground')                    // playground/playground (UI source)
const OUT = join(WEB, '..', 'dist')

// Modules with a `.browser.ts` twin that the browser build must use instead.
const BROWSER_SOURCES = /[\\/](strataSource|stdWatSource|moduleSources|platformSource)$/
// Disallowed on the browser graph: Node builtins and binaryen. `wabt` is
// marked external below (the compiler emits WASM directly from IR and never
// calls the WAT→WASM assembler in the browser), so it's intentionally not
// bundled and not listed here.
const DISALLOWED = /^(node:)?(fs|path|url|os|child_process|crypto)$|^binaryen$/

const browserSwap: BunPlugin = {
    name: 'browser-source-swap',
    setup(build) {
        // ./x  →  ./x.browser.ts  (resolved relative to the importer, handles
        // nested specifiers like '../codegen/toWasm').
        build.onResolve({ filter: BROWSER_SOURCES }, args => ({
            path: join(dirname(args.importer), args.path + '.browser.ts'),
        }))
        build.onResolve({ filter: DISALLOWED }, args => ({
            errors: [{
                text: `Disallowed dependency "${args.path}" reached the browser bundle (via ${args.importer}). ` +
                    `Isolate it behind a *Source/.browser module.`,
            }],
        }))
    },
}

const result = await Bun.build({
    entrypoints: [join(WEB, 'entry.ts')],
    target: 'browser',
    minify: true,
    external: ['wabt'],   // WAT→WASM assembler; never called in-browser
    plugins: [browserSwap],
})

if (!result.success) {
    console.error('Bundle failed:')
    for (const log of result.logs) console.error(log)
    process.exit(1)
}

const bundleJs = await result.outputs[0].text()

// ---- Assemble the single-file HTML -----------------------------------------
const html = readFileSync(join(UI, 'index.html'), 'utf-8')
const webEnv = readFileSync(join(UI, 'web-env.js'), 'utf-8')

let out = html

// NOTE: all replacements below use a *function* replacer. The inserted content
// (minified JS, web-env.js) is full of `$` characters, and String.replace
// treats `$&`, `$'`, `` $` ``, `$n` specially in a *string* replacement —
// which would splice chunks of the document into the bundle and corrupt it.
// A function replacer inserts the value verbatim.

// Inline web-env.js (a classic global IIFE script).
if (!out.includes('<script src="/web-env.js"></script>')) {
    throw new Error('Could not find the web-env.js script tag to inline')
}
out = out.replace('<script src="/web-env.js"></script>', () => `<script>\n${webEnv}\n</script>`)

// Inject the compiler bundle as its own module before the app's module script.
out = out.replace('<script type="module">', () => `<script type="module">\n${bundleJs}\n</script>\n<script type="module">`)

// Replace the network round-trip with the in-browser compiler.
const fetchBlock = /const res = await fetch\('\/compile',[\s\S]*?data = await res\.json\(\)/
if (!fetchBlock.test(out)) {
    throw new Error('Could not find the fetch(\'/compile\') block to replace')
}
out = out.replace(fetchBlock,
    () => `data = await window.SiliconCompiler.compile({ source, platform: 'web', features: activeFeatures })`)

// Guard against inlining corruption (e.g. a `$`-substitution splicing document
// fragments into the bundle): there must be exactly two module scripts (bundle
// + app) and the bundle's global must survive intact.
const moduleOpens = out.split('<script type="module">').length - 1
if (moduleOpens !== 2) {
    throw new Error(`Inlining corrupted: expected 2 module scripts, found ${moduleOpens} ` +
        `(a $-replacement likely spliced HTML into the bundle).`)
}
if (!out.includes('globalThis.SiliconCompiler')) {
    throw new Error('Inlining corrupted: the bundle no longer sets globalThis.SiliconCompiler.')
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'index.html'), out)

// Ship the open-source attribution alongside the deployed page.
writeFileSync(join(OUT, 'THIRD-PARTY-NOTICES.md'), readFileSync(join(WEB, '..', 'THIRD-PARTY-NOTICES.md'), 'utf-8'))

console.log(`Built ${join(OUT, 'index.html')} — bundle ${(bundleJs.length / 1024).toFixed(0)} KiB, ` +
    `page ${(out.length / 1024).toFixed(0)} KiB (+ THIRD-PARTY-NOTICES.md)`)
