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
import { join, dirname, basename } from 'path'
import { fileURLToPath } from 'url'
import type { BunPlugin } from 'bun'

const WEB = dirname(fileURLToPath(import.meta.url))          // playground/web
const UI = join(WEB, '..', 'playground')                    // playground/playground (UI source)
const OUT = join(WEB, '..', 'dist')

const BROWSER_SOURCES = /[\\/](grammarSource|strataSource|stdWatSource|moduleSources|platformSource)$/

const browserSwap: BunPlugin = {
    name: 'browser-source-swap',
    setup(build) {
        // ./xSource  →  ./xSource.browser.ts  (sibling of the importing module)
        build.onResolve({ filter: BROWSER_SOURCES }, args => ({
            path: join(dirname(args.importer), basename(args.path) + '.browser.ts'),
        }))
        // Tripwire: nothing on the browser graph may import a Node builtin.
        build.onResolve({ filter: /^(node:)?(fs|path|url|os|child_process|crypto)$/ }, args => ({
            errors: [{
                text: `Node builtin "${args.path}" reached the browser bundle (via ${args.importer}). ` +
                    `Isolate its use behind a *Source module with a .browser variant.`,
            }],
        }))
    },
}

const result = await Bun.build({
    entrypoints: [join(WEB, 'entry.ts')],
    target: 'browser',
    minify: true,
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

// Inline web-env.js (a classic global IIFE script).
if (!out.includes('<script src="/web-env.js"></script>')) {
    throw new Error('Could not find the web-env.js script tag to inline')
}
out = out.replace('<script src="/web-env.js"></script>', `<script>\n${webEnv}\n</script>`)

// Inject the compiler bundle as its own module before the app's module script.
out = out.replace('<script type="module">', `<script type="module">\n${bundleJs}\n</script>\n<script type="module">`)

// Replace the network round-trip with the in-browser compiler.
const fetchBlock = /const res = await fetch\('\/compile',[\s\S]*?data = await res\.json\(\)/
if (!fetchBlock.test(out)) {
    throw new Error('Could not find the fetch(\'/compile\') block to replace')
}
out = out.replace(fetchBlock,
    `data = await window.SiliconCompiler.compile({ source, platform: 'web', features: activeFeatures })`)

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'index.html'), out)

console.log(`Built ${join(OUT, 'index.html')} — bundle ${(bundleJs.length / 1024).toFixed(0)} KiB, ` +
    `page ${(out.length / 1024).toFixed(0)} KiB`)
